/**
 * Loading hooks-core from a runtime that may have been deleted underneath us.
 *
 * WHY THIS IS NOT JUST `import(path)`. The wiki tools are the only place in the
 * server that resolves a path at CALL time; everything else imports eagerly at
 * startup and is therefore already in memory. That difference is invisible
 * until the directory the server is running from disappears -- and it does
 * disappear: `plugin/launch.mjs` used to prune every runtime version except the
 * newest, including the one a live session was executing from. Observed
 * 2026-08-28, a session that outlived one six-hour refresh got
 * `Cannot find module .../versions/6.0.0/.../hooks-core/wiki.mjs` from every
 * wiki call for the rest of its life, while all ~65 other tools worked
 * perfectly. Knowledge capture was silently dead and nothing else looked wrong.
 *
 * The prune is fixed. This exists because a bare `import()` failure is still
 * the wrong shape of answer:
 *
 *   - it names an internal path and an ESM error code, which reads as a broken
 *     package rather than a missing runtime -- that misreading cost real time,
 *     including a confident and wrong "hooks-core is missing from the published
 *     tarball" (it is not, and never was);
 *   - and it gives up while a perfectly good copy of hooks-core usually sits
 *     next door, under the runtime version the launcher now points at.
 *
 * So: try the bundled copy, fall back to the pointed-at runtime when that is
 * safe, and only then fail -- with a message that says what happened and what
 * to do about it.
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const here = dirname(fileURLToPath(import.meta.url));

/** hooks-core as shipped beside the running build (dist/tools/intelligence/..). */
function bundledDir(): string {
  return path.join(here, '..', '..', '..', 'hooks-core');
}

/** The managed runtime root, matching plugin/launch.mjs. */
function runtimeRoot(): string {
  return (
    process.env.TOKEN_OPTIMIZER_RUNTIME ||
    path.join(homedir(), '.token-optimizer', 'runtime')
  );
}

function readVersionOf(packageDir: string): string | null {
  try {
    const manifest = JSON.parse(
      readFileSync(path.join(packageDir, 'package.json'), 'utf8')
    ) as { version?: string };
    return manifest.version ?? null;
  } catch {
    return null;
  }
}

/** The package directory this server is actually running out of, if identifiable. */
function runningPackageDir(): string | null {
  // here === <pkg>/dist/tools/intelligence
  const candidate = path.join(here, '..', '..', '..');
  return existsSync(path.join(candidate, 'package.json')) ? candidate : null;
}

const major = (version: string): string => version.split('.')[0] ?? '';

/**
 * hooks-core under the runtime `current` points at, when it is safe to use.
 *
 * SAME MAJOR ONLY, DELIBERATELY. Falling back across a major version would load
 * one release's hooks-core into another release's server, and these modules
 * share a persisted wiki store -- a mismatch there writes bad data rather than
 * failing loudly, which is strictly worse than not answering. Within a major,
 * the package's own semver promise is exactly the promise being relied on.
 */
function fallbackDir(): { dir: string; version: string } | null {
  const root = runtimeRoot();
  const currentFile = path.join(root, 'current');
  if (!existsSync(currentFile)) return null;

  let version: string;
  try {
    version = readFileSync(currentFile, 'utf8').trim();
  } catch {
    return null;
  }
  if (!version) return null;

  const packageDir = path.join(
    root,
    'versions',
    version,
    'node_modules',
    '@ooples',
    'token-optimizer-mcp'
  );
  const dir = path.join(packageDir, 'hooks-core');
  if (!existsSync(dir)) return null;

  const running = runningPackageDir();
  const runningVersion = running ? readVersionOf(running) : null;
  const candidateVersion = readVersionOf(packageDir);
  if (!candidateVersion) return null;
  if (runningVersion && major(runningVersion) !== major(candidateVersion)) {
    return null;
  }

  return { dir, version: candidateVersion };
}

/** Reported once per process, so a degraded session says so without spamming. */
let announcedFallback = false;

export class HooksCoreUnavailableError extends Error {
  constructor(moduleName: string, cause: unknown) {
    const bundled = path.join(bundledDir(), moduleName);
    const gone = !existsSync(bundledDir());
    super(
      gone
        ? `The token-optimizer runtime this server is running from has been removed ` +
            `(${bundledDir()}), so the wiki tools cannot load "${moduleName}". ` +
            `This happens when a background refresh prunes the version a live session ` +
            `is using. Restart the MCP server (in Claude Code: /mcp reconnect, or restart ` +
            `the session) to pick up the current runtime. ` +
            `Nothing was written, and no stored knowledge was lost. ` +
            `Original error: ${cause instanceof Error ? cause.message : String(cause)}`
        : `The wiki tools could not load "${moduleName}" from ${bundled}. The runtime ` +
            `directory exists, so this is a genuinely missing or unreadable file rather ` +
            `than a pruned runtime. ` +
            `Original error: ${cause instanceof Error ? cause.message : String(cause)}`
    );
    this.name = 'HooksCoreUnavailableError';
  }
}

/**
 * Import a hooks-core module by file name, e.g. `wiki.mjs`.
 *
 * Throws `HooksCoreUnavailableError` only when neither the bundled copy nor a
 * compatible runtime copy can be loaded.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadHooksCore<T = any>(moduleName: string): Promise<T> {
  const bundled = pathToFileURL(path.join(bundledDir(), moduleName)).href;
  try {
    return (await import(bundled)) as T;
  } catch (bundledError) {
    const fallback = fallbackDir();
    if (fallback) {
      try {
        const loaded = (await import(
          pathToFileURL(path.join(fallback.dir, moduleName)).href
        )) as T;
        if (!announcedFallback) {
          announcedFallback = true;
          // stderr only: stdout is the MCP JSON-RPC channel.
          process.stderr.write(
            `[token-optimizer] the runtime this server started from is gone; ` +
              `wiki tools are using ${fallback.version} instead. ` +
              `Restart the session to run entirely on the current runtime.\n`
          );
        }
        return loaded;
      } catch {
        // Fall through to the diagnostic below, which describes the ORIGINAL
        // failure -- the fallback missing too is not the interesting fact.
      }
    }
    throw new HooksCoreUnavailableError(moduleName, bundledError);
  }
}
