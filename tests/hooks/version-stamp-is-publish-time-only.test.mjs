/**
 * The package version is stamped at publish time and never committed.
 *
 * WHY THIS IS A GUARD AND NOT A PREFERENCE. A version literal written into a
 * generated-and-committed file makes "generated output == committed file" an
 * invariant that CANNOT hold across a release: release-please bumps
 * package.json without regenerating, so the release commit is born drifted.
 * `publish-npm` then fails its drift gate -- and because that job checks out the
 * TAG, no repair on master can rescue the release that is already cut.
 *
 * This repository has paid for that invariant three times. v5.4.0 and v5.4.1
 * were tagged with GitHub Releases and neither reached npm; the post-mortem is
 * written into scripts/pin-mcp-version.mjs and scripts/generate-client-configs.mjs,
 * which removed the version from nine configs and named the remedy: pin at
 * publish time only, so the tarball carries an exact version while git carries
 * none. The stamp was then reintroduced by a different generator, into 48 files,
 * and v5.7.1 was tagged and never reached npm either.
 *
 * So the rule is asserted rather than remembered.
 */

import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { serviceVersion } from '../../hooks-core/observability.mjs';

const ROOT = process.cwd();
const GENERATED_DIRS = ['plugin', 'integrations'];
const STAMP = /TOKEN_OPTIMIZER_VERSION = '/;
const SKIP = new Set(['node_modules', 'dist', '.git']);

/**
 * Every generated .mjs under `dir`, INCLUDING the `lib` directories.
 *
 * `walk` in tests/fixtures/source-scan.mjs deliberately skips `lib`, because for
 * a reachability scan the vendored copies would make every function look used by
 * its own duplicate. Reusing it here made this scan vacuous: `lib` is exactly
 * where the eleven vendored observability.mjs copies live, so the check that was
 * meant to catch a reintroduced stamp could never see one. Caught by mutation.
 */
function generatedFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP.has(entry)) generatedFiles(full, out);
    } else if (entry.endsWith('.mjs')) {
      out.push(full);
    }
  }
  return out;
}

// A version that exists nowhere else, so a stamp found in the output can only
// have come from the package.json this fixture controls.
const FIXTURE_VERSION = '9.9.9-fixture';

let sandbox;

/** A minimal ROOT the generators can run against without touching the repo. */
beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'version-stamp-'));
  mkdirSync(join(sandbox, 'scripts'), { recursive: true });
  cpSync(join(ROOT, 'scripts', 'lib'), join(sandbox, 'scripts', 'lib'), { recursive: true });
  cpSync(join(ROOT, 'hooks-core'), join(sandbox, 'hooks-core'), { recursive: true });
  for (const script of ['sync-hook-core.mjs', 'generate-client-entries.mjs']) {
    cpSync(join(ROOT, 'scripts', script), join(sandbox, 'scripts', script));
  }
  writeFileSync(
    join(sandbox, 'package.json'),
    JSON.stringify({ name: 'fixture', version: FIXTURE_VERSION })
  );
});

afterAll(() => {
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* windows can hold a handle briefly */
  }
});

function generate(script, ...flags) {
  const result = spawnSync(process.execPath, [join(sandbox, 'scripts', script), ...flags], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  expect([script, result.status]).toEqual([script, 0]);
  return result;
}

const sandboxFile = (...parts) => readFileSync(join(sandbox, ...parts), 'utf8');

describe('generated output carries no version by default', () => {
  test('the vendored core is version-free even when package.json has one', () => {
    generate('sync-hook-core.mjs');
    // The fixture package.json says 9.9.9-fixture. If the generator reads it into
    // the output at all, this fails.
    expect(sandboxFile('plugin', 'hooks', 'lib', 'observability.mjs')).not.toMatch(STAMP);
  });

  test('the client entry points are version-free too', () => {
    generate('generate-client-entries.mjs');
    expect(sandboxFile('plugin', 'hooks', 'stop.mjs')).not.toMatch(STAMP);
  });

  test('no committed generated file carries a version literal', () => {
    // The repository-wide form of the same rule: it is the committed files that
    // the release commit strands, so they are what must stay clean.
    const offenders = [];
    for (const dir of GENERATED_DIRS) {
      for (const file of generatedFiles(join(ROOT, dir))) {
        if (STAMP.test(readFileSync(file, 'utf8'))) offenders.push(file.slice(ROOT.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the publish-time stamp is real', () => {
  // The defect class this repository keeps producing is correct code that
  // nothing calls, so the flag is exercised rather than assumed to work.
  test('--stamp writes the exact version into the vendored core', () => {
    generate('sync-hook-core.mjs', '--stamp');
    expect(sandboxFile('plugin', 'hooks', 'lib', 'observability.mjs')).toContain(
      `TOKEN_OPTIMIZER_VERSION = '${FIXTURE_VERSION}'`
    );
  });

  test('--stamp writes it into every client entry point', () => {
    generate('generate-client-entries.mjs', '--stamp');
    expect(sandboxFile('plugin', 'hooks', 'stop.mjs')).toContain(
      `TOKEN_OPTIMIZER_VERSION = '${FIXTURE_VERSION}'`
    );
  });

  test('npm run stamp:version applies both generators', () => {
    const { scripts } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(scripts['stamp:version']).toContain('sync-hook-core.mjs --stamp');
    expect(scripts['stamp:version']).toContain('generate-client-entries.mjs --stamp');
  });
});

describe('the release workflow applies it, in the only window that works', () => {
  const workflow = () => readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');

  test('publish-npm runs the stamp', () => {
    expect(workflow()).toContain('npm run stamp:version');
  });

  test('after the drift check, so the check sees the committed tree', () => {
    const text = workflow();
    // Without this, a MISSING step passes every ordering test: indexOf returns
    // -1, and -1 is less than every real index. Caught by mutation.
    expect(text).toContain('npm run stamp:version');
    expect(text.indexOf('npm run sync:hooks:check')).toBeLessThan(
      text.indexOf('npm run stamp:version')
    );
  });

  test('before the checksums, which hash exactly what ships', () => {
    // A stamp applied after this point would ship files the checksums disown.
    const text = workflow();
    // Without this, a MISSING step passes every ordering test: indexOf returns
    // -1, and -1 is less than every real index. Caught by mutation.
    expect(text).toContain('npm run stamp:version');
    expect(text.indexOf('npm run stamp:version')).toBeLessThan(
      text.indexOf('scripts/checksums.mjs')
    );
  });

  test('and before the publish itself', () => {
    const text = workflow();
    // Without this, a MISSING step passes every ordering test: indexOf returns
    // -1, and -1 is less than every real index. Caught by mutation.
    expect(text).toContain('npm run stamp:version');
    expect(text.indexOf('npm run stamp:version')).toBeLessThan(text.indexOf('npm publish'));
  });
});

describe('removing the stamp did not cost the version', () => {
  // The stamp was added to make dashboard evidence carry a real version, and
  // taking it out of git must not quietly regress that to 'unknown'. Inside the
  // tarball the walk finds the package's own package.json; a marketplace plugin
  // install finds .claude-plugin/plugin.json, which release-please keeps correct.
  const withEnv = (values, body) => {
    const saved = {
      TOKEN_OPTIMIZER_VERSION: process.env.TOKEN_OPTIMIZER_VERSION,
      npm_package_version: process.env.npm_package_version,
    };
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      body();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };

  test('resolves from the nearest manifest when nothing is stamped', () => {
    withEnv({ TOKEN_OPTIMIZER_VERSION: undefined, npm_package_version: undefined }, () => {
      const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
      expect(serviceVersion()).toBe(version);
    });
  });

  test('the publish-time stamp still wins when present', () => {
    withEnv({ TOKEN_OPTIMIZER_VERSION: 'stamped-1.2.3' }, () => {
      expect(serviceVersion()).toBe('stamped-1.2.3');
    });
  });
});
