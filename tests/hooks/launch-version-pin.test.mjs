/**
 * The launch shim must be pinnable to an exact version.
 *
 * Without a pin the shim resolves what to serve from two places that are
 * outside anyone's control: `current` in the managed runtime, and -- when the
 * runtime is cold -- whatever copy happens to sit in the npx cache. That second
 * path is the damaging one. Observed on a machine with 6.0.2 installed
 * globally, a cold runtime made the shim log
 *
 *   first run: serving npx-cached 6.0.0; populating managed runtime in the background
 *
 * and serve 6.0.0. The served version is therefore a property of the machine's
 * npx cache rather than of the install, so a first session can silently run a
 * build that is several releases old, and no environment variable could stop
 * it: TOKEN_OPTIMIZER_REFRESH_INTERVAL_MS only throttles the BACKGROUND
 * refresh, it does not choose what is served now.
 *
 * These tests are hermetic. They seed fake version trees and never reach the
 * network, so they assert the RESOLUTION RULE rather than npm's behaviour.
 */

import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LAUNCH = join(HERE, '..', '..', 'plugin', 'launch.mjs');
const PACKAGE_DIR = join('node_modules', '@ooples', 'token-optimizer-mcp');

let runtime;

/**
 * Writes a fake installed copy of the package that announces which version it
 * is and exits, so the test can read the served version off stdout.
 */
function seedVersion(root, version) {
  const pkgDir = join(root, PACKAGE_DIR);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({
      name: '@ooples/token-optimizer-mcp',
      version,
      main: 'server.js',
    })
  );
  writeFileSync(
    join(pkgDir, 'server.js'),
    `process.stdout.write('SERVED ${version}');\n`
  );
}

function launch(env) {
  return spawnSync(process.execPath, [LAUNCH], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      TOKEN_OPTIMIZER_RUNTIME: runtime,
      // Large enough that the background refresh can never be what makes a
      // test pass or fail.
      TOKEN_OPTIMIZER_REFRESH_INTERVAL_MS: '999999999999',
      ...env,
    },
  });
}

beforeEach(() => {
  runtime = mkdtempSync(join(tmpdir(), 'to-launch-'));
  mkdirSync(join(runtime, 'versions'), { recursive: true });
  // A recent marker, because refreshDueNow() treats an unreadable one as "due".
  writeFileSync(join(runtime, '.last-refresh'), String(Date.now()));
});

afterEach(() => rmSync(runtime, { recursive: true, force: true }));

describe('an explicit version pin decides what is served', () => {
  test('the pin wins over the runtime `current` marker', () => {
    seedVersion(join(runtime, 'versions', '9.9.8'), '9.9.8');
    seedVersion(join(runtime, 'versions', '9.9.9'), '9.9.9');
    writeFileSync(join(runtime, 'current'), '9.9.8');

    const r = launch({ TOKEN_OPTIMIZER_VERSION: '9.9.9' });
    expect(r.stdout).toContain('SERVED 9.9.9');
  });

  test('the pin wins over a newer copy in the npx cache', () => {
    // The reported failure in miniature: a cold managed runtime plus a
    // populated npx cache. The pinned build must win even though the cache
    // holds a different version and would otherwise be served verbatim.
    const npxCache = mkdtempSync(join(tmpdir(), 'to-npx-'));
    seedVersion(join(npxCache, '_npx', 'deadbeef'), '9.9.7');
    seedVersion(join(runtime, 'versions', '9.9.9'), '9.9.9');

    const r = launch({
      TOKEN_OPTIMIZER_VERSION: '9.9.9',
      npm_config_cache: npxCache,
    });
    rmSync(npxCache, { recursive: true, force: true });

    expect(r.stdout).toContain('SERVED 9.9.9');
    expect(r.stdout).not.toContain('SERVED 9.9.7');
  });

  test('the pin is found in the npx cache even when a newer copy is cached too', () => {
    // findCachedEntry() returned only the HIGHEST cached version, so a pin that
    // was present alongside a newer one was rejected rather than used: the
    // lookup handed back 10.0.0, the pin declined it, and an offline launch
    // failed with the requested build sitting right there in the cache.
    const npxCache = mkdtempSync(join(tmpdir(), 'to-npx-'));
    seedVersion(join(npxCache, '_npx', 'aaaa'), '9.9.9');
    seedVersion(join(npxCache, '_npx', 'bbbb'), '10.0.0');

    const r = launch({
      TOKEN_OPTIMIZER_VERSION: '9.9.9',
      npm_config_cache: npxCache,
    });
    rmSync(npxCache, { recursive: true, force: true });

    expect(r.stdout).toContain('SERVED 9.9.9');
    expect(r.stdout).not.toContain('SERVED 10.0.0');
  });

  // Invalid SemVer as well as ranges and tags. npm will never publish `01.2.3`
  // or `1.2.3-alpha.`, so accepting them here only moved the failure to install
  // time, where it surfaces as a registry error instead of the clear message
  // this check exists to give.
  test.each([
    ['^9.0.0'], ['~9.9.0'], ['latest'], ['next'], ['>=9.9.9'], ['v9.9.9'],
    ['01.2.3'], ['1.02.3'], ['9.9.9-01'], ['9.9.9-alpha.'], ['9.9.9-'],
  ])(
    'a pin of %s is rejected before anything is installed',
    (spec) => {
      // npm would happily accept all of these, and resolve each to whatever the
      // registry decides -- so the recorded value would be the spec rather than
      // the version that actually landed. A pin that cannot be verified
      // afterwards is not a pin, so these fail up front rather than silently
      // serving something else.
      seedVersion(join(runtime, 'versions', '9.9.9'), '9.9.9');
      const r = launch({ TOKEN_OPTIMIZER_VERSION: spec });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('must be an exact version');
      expect(r.stdout).not.toContain('SERVED');
    }
  );

  test('an exact pre-release pin is accepted', () => {
    // The guard must reject ranges without also rejecting legitimate exact
    // versions that merely look unusual.
    seedVersion(join(runtime, 'versions', '9.9.9-rc.1'), '9.9.9-rc.1');
    const r = launch({ TOKEN_OPTIMIZER_VERSION: '9.9.9-rc.1' });
    expect(r.stdout).toContain('SERVED 9.9.9-rc.1');
  });

  test('a lock held by a refresh does not strand a pinned launch', () => {
    // The lock is shared with runRefresh(), which installs `latest` rather than
    // this pin. A launch that only watched for the pinned directory would sit
    // through its whole 60s budget and exit, even though the refresh was never
    // going to produce the pinned version. Here the directory appears partway
    // through, standing in for another pinned launch finishing first, and this
    // one must notice rather than block to the end.
    mkdirSync(join(runtime, '.refresh.lock'), { recursive: true });

    // A DETACHED PROCESS, not setTimeout: `launch()` uses spawnSync, which
    // blocks this thread's event loop, so an in-process timer could never fire
    // and the first version of this test waited the full 60s for a directory
    // nothing was ever going to create.
    const pkgDir = join(runtime, 'versions', '9.9.9', PACKAGE_DIR).replace(/\\/g, '/');
    const helper = spawn(
      process.execPath,
      [
        '-e',
        `setTimeout(() => {
           const fs = require('fs');
           fs.mkdirSync(${JSON.stringify(pkgDir)}, { recursive: true });
           fs.writeFileSync(${JSON.stringify(pkgDir)} + '/package.json',
             JSON.stringify({ name: '@ooples/token-optimizer-mcp', version: '9.9.9', main: 'server.js' }));
           fs.writeFileSync(${JSON.stringify(pkgDir)} + '/server.js',
             "process.stdout.write('SERVED 9.9.9');");
         }, 800);`,
      ],
      { detached: true, stdio: 'ignore' }
    );
    helper.unref();

    const started = Date.now();
    const r = launch({ TOKEN_OPTIMIZER_VERSION: '9.9.9' });

    expect(r.stdout).toContain('SERVED 9.9.9');
    // Well inside the 60s budget: proves it polled and noticed rather than
    // waiting the loop out.
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  test('without a pin the runtime `current` marker still decides', () => {
    // Guards against over-correction: pinning is opt-in, and the default
    // resolution order must be untouched for everyone who sets nothing.
    seedVersion(join(runtime, 'versions', '9.9.8'), '9.9.8');
    seedVersion(join(runtime, 'versions', '9.9.9'), '9.9.9');
    writeFileSync(join(runtime, 'current'), '9.9.8');

    const r = launch({});
    expect(r.stdout).toContain('SERVED 9.9.8');
  });
});
