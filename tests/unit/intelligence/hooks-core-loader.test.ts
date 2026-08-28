/**
 * The wiki tools must not answer a deleted runtime with an ESM stack trace.
 *
 * `loadHooksCore` is the only place in the server that resolves a path at CALL
 * time. Everything else imports eagerly at startup and is already in memory, so
 * when the directory the server is running from disappears -- which it did,
 * because `plugin/launch.mjs` pruned the version a live session was using --
 * every other tool kept working and only the wiki tools failed. They failed
 * with `Cannot find module .../versions/6.0.0/.../hooks-core/wiki.mjs`, which
 * names an internal path and an ESM error code, and reads as a broken package.
 * It cost real time and produced a confident, wrong conclusion: "hooks-core is
 * missing from the published tarball". It is not, and never was.
 *
 * So this covers the two things that answer is missing: SAY what happened, and
 * where a compatible copy exists, keep working instead of giving up.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ORIGINAL_RUNTIME = process.env.TOKEN_OPTIMIZER_RUNTIME;
let runtime: string;

/** A managed runtime holding one version, optionally with a hooks-core module. */
function makeRuntime(
  version: string,
  options: { withModule?: string; packageVersion?: string } = {}
): void {
  const packageDir = join(
    runtime,
    'versions',
    version,
    'node_modules',
    '@ooples',
    'token-optimizer-mcp'
  );
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({
      name: '@ooples/token-optimizer-mcp',
      version: options.packageVersion ?? version,
    })
  );
  if (options.withModule) {
    const core = join(packageDir, 'hooks-core');
    mkdirSync(core, { recursive: true });
    writeFileSync(
      join(core, options.withModule),
      'export const marker = "from-runtime";\n'
    );
  }
  writeFileSync(join(runtime, 'current'), version);
}

async function loader() {
  const module = await import(
    `../../../src/tools/intelligence/hooks-core-loader.js?t=${Date.now()}`
  );
  return module as typeof import('../../../src/tools/intelligence/hooks-core-loader.js');
}

beforeEach(() => {
  runtime = mkdtempSync(join(tmpdir(), 'hooks-core-loader-'));
  process.env.TOKEN_OPTIMIZER_RUNTIME = runtime;
});

afterEach(() => {
  if (ORIGINAL_RUNTIME === undefined) delete process.env.TOKEN_OPTIMIZER_RUNTIME;
  else process.env.TOKEN_OPTIMIZER_RUNTIME = ORIGINAL_RUNTIME;
  try {
    rmSync(runtime, { recursive: true, force: true });
  } catch {
    /* windows can hold a handle briefly */
  }
});

describe('loading hooks-core', () => {
  it('loads the bundled module when it is there', async () => {
    // The ordinary path: hooks-core sits beside the running build. Asserted so
    // the fallback machinery cannot be masking a broken happy path.
    const { loadHooksCore } = await loader();

    const wiki = await loadHooksCore('wiki.mjs');

    expect(wiki).toBeTruthy();
    expect(typeof wiki).toBe('object');
  }, 30_000);

  it('explains a pruned runtime instead of surfacing an ESM error', async () => {
    // The message a human actually needs: what happened, that nothing was lost,
    // and what to do about it. A module name that does not exist stands in for
    // a hooks-core directory that has been deleted.
    const { loadHooksCore, HooksCoreUnavailableError } = await loader();

    await expect(loadHooksCore('definitely-not-a-real-module.mjs')).rejects.toThrow(
      HooksCoreUnavailableError
    );

    const error = await loadHooksCore('definitely-not-a-real-module.mjs').catch(
      (caught: Error) => caught
    );

    // The bundled directory DOES exist here, so it must say so rather than
    // blaming a prune that did not happen. Guessing the cause is what produced
    // the wrong "missing from the tarball" conclusion in the first place.
    expect(error.message).toContain('genuinely missing or unreadable file');
    expect(error.message).not.toContain('has been removed');
  }, 30_000);

  it('names the recovery when the runtime it started from is gone', async () => {
    // Constructed directly, because making the real bundled hooks-core vanish
    // mid-test would break every other suite sharing this worker.
    const { HooksCoreUnavailableError } = await loader();

    const error = new HooksCoreUnavailableError('wiki.mjs', new Error('ENOENT'));

    expect(error.name).toBe('HooksCoreUnavailableError');
    expect(error.message).toContain('wiki.mjs');
    expect(error.message).toContain('ENOENT');
  }, 30_000);

  it('recovers from the current runtime when the bundled copy is gone', async () => {
    // THE POINT OF THE FALLBACK, and the case the others only bound. Without
    // this the feature stays dead for the whole session: the server keeps
    // running happily from memory while every wiki call fails, and a session
    // routinely outlives the six-hour refresh that removed its directory.
    //
    // `runningPackageDir()` resolves to this repository, so its own version
    // supplies the major that the runtime copy has to match.
    const { version } = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf8')
    ) as { version: string };
    const sameMajor = `${version.split('.')[0]}.999.999`;

    makeRuntime(sameMajor, {
      withModule: 'definitely-not-a-real-module.mjs',
      packageVersion: sameMajor,
    });

    const { loadHooksCore } = await loader();
    const recovered = await loadHooksCore('definitely-not-a-real-module.mjs');

    expect(recovered.marker).toBe('from-runtime');
  }, 30_000);

  it('refuses a fallback whenever either version is unknown', async () => {
    // THE GUARD, ASSERTED DIRECTLY. Reached through `fallbackDir` this is
    // unreachable: any fixture that makes the running version unknown also
    // makes the candidate unreadable, so the candidate check fires first --
    // which is why a mutation flipping this to fail-open survived every other
    // test here. A null running version is exactly what a PRUNED runtime
    // produces, so failing open there disables the guard in the only situation
    // the fallback exists for.
    const { fallbackIsCompatible } = await loader();

    expect(fallbackIsCompatible(null, '6.0.1')).toBe(false);
    expect(fallbackIsCompatible('6.0.1', null)).toBe(false);
    expect(fallbackIsCompatible('6.0.1', '7.0.0')).toBe(false);
    expect(fallbackIsCompatible('6.0.1', '6.9.9')).toBe(true);
  }, 30_000);

  it('refuses to fall back when it cannot establish its own version', async () => {
    // REVIEW CAUGHT THIS, AND IT FAILED OPEN IN THE ONLY CASE THAT MATTERS.
    // The major check originally read the running version inside the fallback
    // and skipped the comparison when it came back null -- but null is exactly
    // what a PRUNED runtime produces, which is the situation the fallback
    // exists for. A live v6 server could then have loaded v7 hooks-core and
    // written the shared wiki store with incompatible code.
    //
    // The version is captured at module load now, so this asserts the guard
    // from the other side: a candidate whose own manifest is unreadable can
    // never be accepted, whatever the running version is.
    const packageDir = join(
      runtime,
      'versions',
      '6.0.9',
      'node_modules',
      '@ooples',
      'token-optimizer-mcp'
    );
    mkdirSync(join(packageDir, 'hooks-core'), { recursive: true });
    writeFileSync(
      join(packageDir, 'hooks-core', 'definitely-not-a-real-module.mjs'),
      'export const marker = "from-runtime";\n'
    );
    // A manifest that cannot be parsed: no version can be established.
    writeFileSync(join(packageDir, 'package.json'), 'not json at all');
    writeFileSync(join(runtime, 'current'), '6.0.9');

    const { loadHooksCore } = await loader();

    await expect(
      loadHooksCore('definitely-not-a-real-module.mjs')
    ).rejects.toThrow(/could not load|has been removed/);
  }, 30_000);

  it('does not fall back across a major version', async () => {
    // A cross-major fallback would load one release's hooks-core into another
    // release's server, and these modules share a persisted wiki store: a
    // mismatch there writes bad data instead of failing loudly, which is
    // strictly worse than not answering.
    makeRuntime('99.0.0', {
      withModule: 'definitely-not-a-real-module.mjs',
      packageVersion: '99.0.0',
    });

    const { loadHooksCore } = await loader();

    await expect(
      loadHooksCore('definitely-not-a-real-module.mjs')
    ).rejects.toThrow(/could not load|has been removed/);
  }, 30_000);

  it('ignores a runtime whose current pointer names nothing', async () => {
    writeFileSync(join(runtime, 'current'), 'nope-not-installed');

    const { loadHooksCore } = await loader();

    await expect(
      loadHooksCore('definitely-not-a-real-module.mjs')
    ).rejects.toThrow(/could not load|has been removed/);
  }, 30_000);
});
