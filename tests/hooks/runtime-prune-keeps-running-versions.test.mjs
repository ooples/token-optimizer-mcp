/**
 * A background refresh must not delete the runtime a live session is using.
 *
 * THE BUG THIS PINS. `launch.mjs` documents, in its own header, that a refresh
 * "never mutates files a running server may still be lazy-require-ing" -- and
 * then `pruneOldVersions` deleted every version directory except the newest,
 * including the one a server was executing from. Deleting is the most extreme
 * mutation available, so the file broke the invariant it advertised.
 *
 * WHY IT WENT UNNOTICED. A running server has already imported its eager
 * modules and they stay in memory, so it keeps answering normally after its
 * directory is gone. Only a path resolved at CALL time notices, and exactly one
 * area does that: the wiki tools import hooks-core lazily through `coreUrl()`.
 * Observed 2026-08-28 -- a session that outlived one refresh got
 * `Cannot find module .../versions/6.0.0/.../hooks-core/wiki.mjs` from every
 * wiki_write call for the rest of the session while every other tool worked, so
 * it read as a packaging bug in the published tarball. It was not: 6.0.1 ships
 * hooks-core/wiki.mjs and 6.0.0 had it too. The directory had been deleted
 * underneath the process. The refresh interval is six hours, so an ordinary
 * working session outlives one routinely.
 *
 * WHY EACH CASE SPAWNS A PROCESS. `launch.mjs` reads its runtime path and its
 * retention count from the environment at IMPORT time, which is correct for a
 * launcher that is a fresh process every time. Importing it repeatedly inside
 * one jest worker does not re-read them -- the module is cached, so later cases
 * silently operated on the first case's (already deleted) directory and nothing
 * was pruned. Every case therefore gets its own node process, which is also how
 * the shim genuinely runs.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';

const LAUNCHER = pathToFileURL(
  resolve(process.cwd(), 'plugin', 'launch.mjs')
).href;

let runtime;
let versionsDir;

/** A version directory holding a file, aged `minutesOld` minutes. */
function makeVersion(name, minutesOld) {
  const dir = join(versionsDir, name);
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  writeFileSync(join(dir, 'marker.txt'), name);
  const when = new Date(Date.now() - minutesOld * 60_000);
  utimesSync(dir, when, when);
}

/**
 * Prune in a fresh process and return the surviving version directories.
 *
 * `TOKEN_OPTIMIZER_LAUNCH_IMPORT_ONLY` is what stops `main()` from running;
 * without it, importing the launcher starts a real MCP server.
 */
function pruneInFreshProcess(keepVersion, keepCount, alsoKeep) {
  const script = `
    const { pruneOldVersions } = await import(${JSON.stringify(LAUNCHER)});
    pruneOldVersions(${JSON.stringify(keepVersion)}, ${JSON.stringify(alsoKeep ?? null)});
    const { readdirSync } = await import('fs');
    let left = [];
    try { left = readdirSync(${JSON.stringify(versionsDir)}); } catch {}
    console.log(JSON.stringify(left));
  `;

  const env = {
    ...process.env,
    TOKEN_OPTIMIZER_LAUNCH_IMPORT_ONLY: '1',
    TOKEN_OPTIMIZER_RUNTIME: runtime,
  };
  if (keepCount === undefined) delete env.TOKEN_OPTIMIZER_RUNTIME_KEEP;
  else env.TOKEN_OPTIMIZER_RUNTIME_KEEP = String(keepCount);

  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', script],
    { env, encoding: 'utf8' }
  );

  if (result.status !== 0) {
    throw new Error(
      `prune process failed (${result.status}): ${result.stderr || result.stdout}`
    );
  }
  return JSON.parse(result.stdout.trim().split('\n').pop());
}

beforeEach(() => {
  runtime = mkdtempSync(join(tmpdir(), 'runtime-prune-'));
  versionsDir = join(runtime, 'versions');
  mkdirSync(versionsDir, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(runtime, { recursive: true, force: true });
  } catch {
    /* windows can hold a handle briefly */
  }
});

describe('pruning the managed runtime', () => {
  it('keeps the version a live session is still running from', () => {
    // THE REGRESSION. `6.0.0` is what a running server is executing from when
    // the refresh installs `6.0.2`. Before this fix it was deleted outright and
    // the running server lost every file it had not already imported.
    makeVersion('6.0.0', 30);
    makeVersion('6.0.1', 20);
    makeVersion('6.0.2', 10);

    const left = pruneInFreshProcess('6.0.2');

    expect(left.sort()).toEqual(['6.0.0', '6.0.1', '6.0.2']);
  }, 60_000);

  it('still deletes versions old enough that nothing can be using them', () => {
    // Retention, not hoarding: a grace period, not every version ever installed.
    makeVersion('5.9.0', 5000);
    makeVersion('6.0.0', 400);
    makeVersion('6.0.1', 30);
    makeVersion('6.0.2', 20);
    makeVersion('6.0.3', 10);

    const left = pruneInFreshProcess('6.0.3');

    expect(left.sort()).toEqual(['6.0.1', '6.0.2', '6.0.3']);
  }, 60_000);

  it('keeps the version it was told to keep even when it is not the newest', () => {
    // `keepVersion` is what the NEXT launch will use. If unrelated directories
    // happen to have newer mtimes, sorting alone would evict the one that
    // matters most.
    makeVersion('6.0.5', 1);
    makeVersion('6.0.6', 2);
    makeVersion('6.0.7', 3);
    makeVersion('6.0.1', 400);

    const left = pruneInFreshProcess('6.0.1', 1);

    expect(left).toContain('6.0.1');
  }, 60_000);

  it('refuses to retain only one version, however it is configured', () => {
    // REVIEW CAUGHT THIS, AND THIS TEST USED TO ASSERT THE BUG. It pinned
    // `keep: 1` as leaving exactly one directory -- but a refresh prunes with
    // the version it has just INSTALLED, so keeping one deletes the version the
    // live session is running from and puts the original defect straight back.
    // A retention of one is never a coherent setting here, so it floors at two.
    makeVersion('6.0.0', 400);
    makeVersion('6.0.1', 10);

    const left = pruneInFreshProcess('6.0.1', 1);

    expect(left.sort()).toEqual(['6.0.0', '6.0.1']);
  }, 60_000);

  it('keeps the previously-pointed version by name, not by luck', () => {
    // `prev` is what a live session is executing from. Passing it explicitly
    // matters because mtime ordering does not guarantee it survives: a
    // reinstall can freshen unrelated directories, pushing the one that is
    // actually in use out of the newest few.
    makeVersion('6.0.0', 9000); // the live one, and by far the oldest
    makeVersion('6.0.1', 30);
    makeVersion('6.0.2', 20);
    makeVersion('6.0.3', 10);

    const left = pruneInFreshProcess('6.0.3', 2, '6.0.0');

    expect(left.sort()).toEqual(['6.0.0', '6.0.3']);
  }, 60_000);

  it('honours a retention count set by the environment', () => {
    makeVersion('6.0.0', 40);
    makeVersion('6.0.1', 30);
    makeVersion('6.0.2', 20);
    makeVersion('6.0.3', 10);

    const left = pruneInFreshProcess('6.0.3', 2);

    expect(left.sort()).toEqual(['6.0.2', '6.0.3']);
  }, 60_000);

  it('survives a versions directory that is not there', () => {
    rmSync(versionsDir, { recursive: true, force: true });

    expect(() => pruneInFreshProcess('6.0.2')).not.toThrow();
  }, 60_000);
});
