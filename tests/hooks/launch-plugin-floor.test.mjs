/**
 * #393 and #394: the launch shim after a plugin update, and after a failed refresh.
 *
 * Observed 2026-09-17: `/plugin` installed 7.0.1 and `/reload-plugins` restarted the server, yet the
 * runtime still served 6.0.2 -- the shim never looked at its own plugin's version, and its only way
 * forward was a background refresh throttled to six hours that takes effect on the launch after.
 * A manual `--refresh` then failed while npm was still propagating 7.0.1, and that failure stamped
 * the six-hour throttle anyway.
 *
 * Hermetic: a fake `npm` on PATH installs only the versions a test allows, after an optional delay,
 * and logs every call. Each case runs a copy of the shim inside a fake plugin root so the plugin's
 * version is under test control. LAUNCH_UNDER_TEST points the suite at another shim (the control arm).
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LAUNCH = process.env.LAUNCH_UNDER_TEST || join(HERE, '..', '..', 'plugin', 'launch.mjs');
const PACKAGE_DIR = join('node_modules', '@ooples', 'token-optimizer-mcp');

let root;
let runtime;
let bin;
let npmLog;

const FAKE_NPM = `
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(args) + '\\n');
const spec = (args.find((a) => a.startsWith('@ooples/token-optimizer-mcp@')) || '').split('@').pop();
const prefix = args[args.indexOf('--prefix') + 1];
const version = spec === 'latest' ? process.env.FAKE_NPM_LATEST : spec;
const delay = Number(process.env.FAKE_NPM_DELAY_MS || 0);
if (delay) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
if (!version || !(process.env.FAKE_NPM_AVAILABLE || '').split(',').includes(version)) {
  process.stderr.write('npm error code ETARGET\\n');
  process.exit(1);
}
const dir = join(prefix, 'node_modules', '@ooples', 'token-optimizer-mcp');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@ooples/token-optimizer-mcp', version, main: 'server.js' }));
writeFileSync(join(dir, 'server.js'), "process.stdout.write('SERVED " + version + "');\\n");
`;

function seedVersion(version) {
  const dir = join(runtime, 'versions', version, PACKAGE_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'),
    JSON.stringify({ name: '@ooples/token-optimizer-mcp', version, main: 'server.js' }));
  writeFileSync(join(dir, 'server.js'), `process.stdout.write('SERVED ${version}');\n`);
}

function setCurrent(version) {
  writeFileSync(join(runtime, 'current'), version);
}

function readCurrent() {
  return existsSync(join(runtime, 'current')) ? readFileSync(join(runtime, 'current'), 'utf8').trim() : null;
}

/** A plugin root holding a copy of the shim and a plugin.json claiming `version`. */
function pluginWith(version) {
  const plugin = join(root, `plugin-${version || 'none'}`);
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
  copyFileSync(LAUNCH, join(plugin, 'launch.mjs'));
  if (version) {
    writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'token-optimizer', version }));
  }
  return join(plugin, 'launch.mjs');
}

function pathWithFakeNpm() {
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  return { key, value: `${bin}${delimiter}${process.env[key] || ''}` };
}

function run(shim, args = [], env = {}) {
  const path = pathWithFakeNpm();
  const started = Date.now();
  const result = spawnSync(process.execPath, [shim, ...args], {
    encoding: 'utf8',
    timeout: 90_000,
    env: {
      ...process.env,
      [path.key]: path.value,
      TOKEN_OPTIMIZER_RUNTIME: runtime,
      TOKEN_OPTIMIZER_VERSION: '',
      FAKE_NPM_LOG: npmLog,
      FAKE_NPM_AVAILABLE: '',
      FAKE_NPM_LATEST: '',
      npm_config_cache: join(root, 'empty-npm-cache'),
      TOKEN_OPTIMIZER_REFRESH_INTERVAL_MS: '999999999999',
      ...env,
    },
  });
  return { ...result, elapsed: Date.now() - started, served: /SERVED (\S+)/.exec(result.stdout || '')?.[1] ?? null };
}

function npmCalls() {
  return existsSync(npmLog)
    ? readFileSync(npmLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];
}

async function waitFor(predicate, ms = 30_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return predicate();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'to-floor-'));
  runtime = join(root, 'runtime');
  mkdirSync(join(runtime, 'versions'), { recursive: true });
  writeFileSync(join(runtime, '.last-refresh'), String(Date.now()));
  bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'fake-npm.mjs'), FAKE_NPM);
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\nexec node "$(dirname "$0")/fake-npm.mjs" "$@"\n');
  chmodSync(join(bin, 'npm'), 0o755);
  // Resolves its script through %~dp0 exactly as the real npm.cmd resolves npm-cli.js, so an invocation
  // that breaks %~dp0 (a quoted command name found on PATH) fails here as it would for users.
  writeFileSync(join(bin, 'npm.cmd'), '@node "%~dp0fake-npm.mjs" %*\r\n');
  npmLog = join(root, 'npm-calls.log');
});

afterEach(async () => {
  // A detached install may still hold files for a moment on Windows.
  for (let i = 0; i < 20; i++) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
});

describe('#393 the plugin version is a floor for what is served', () => {
  test('a plugin newer than the runtime is installed and served on the same launch', () => {
    seedVersion('6.0.2');
    setCurrent('6.0.2');
    const r = run(pluginWith('7.0.1'), [], { FAKE_NPM_AVAILABLE: '7.0.1' });
    expect(r.served).toBe('7.0.1');
    expect(readCurrent()).toBe('7.0.1');
    expect(npmCalls().some((args) => args.includes('@ooples/token-optimizer-mcp@7.0.1'))).toBe(true);
  });

  test('an already-installed plugin version is adopted without npm', () => {
    seedVersion('6.0.2');
    seedVersion('7.0.1');
    setCurrent('6.0.2');
    const r = run(pluginWith('7.0.1'));
    expect(r.served).toBe('7.0.1');
    expect(readCurrent()).toBe('7.0.1');
    expect(npmCalls()).toHaveLength(0);
  });

  test('a plugin version npm does not have yet falls back fast, and later launches do not wait again', async () => {
    seedVersion('6.0.2');
    setCurrent('6.0.2');
    const shim = pluginWith('7.0.1');
    const first = run(shim, [], { TOKEN_OPTIMIZER_PLUGIN_UPGRADE_WAIT_MS: '20000' });
    expect(first.served).toBe('6.0.2');
    expect(first.elapsed).toBeLessThan(15_000);
    expect(readCurrent()).toBe('6.0.2');
    const callsAfterFirst = npmCalls().length;
    expect(callsAfterFirst).toBe(1);

    const second = run(shim, [], { TOKEN_OPTIMIZER_PLUGIN_UPGRADE_WAIT_MS: '20000' });
    expect(second.served).toBe('6.0.2');
    expect(second.elapsed).toBeLessThan(5_000);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(npmCalls()).toHaveLength(callsAfterFirst);

    // Once the backoff has passed, the next launch tries again and succeeds.
    const third = run(shim, [], { TOKEN_OPTIMIZER_PLUGIN_RETRY_MS: '0', FAKE_NPM_AVAILABLE: '7.0.1' });
    expect(third.served).toBe('7.0.1');
  });

  test('a slow install serves the old runtime now and the new one on the next launch', async () => {
    seedVersion('6.0.2');
    setCurrent('6.0.2');
    const shim = pluginWith('7.0.1');
    const env = { FAKE_NPM_AVAILABLE: '7.0.1', FAKE_NPM_DELAY_MS: '4000', TOKEN_OPTIMIZER_PLUGIN_UPGRADE_WAIT_MS: '1000' };
    const first = run(shim, [], env);
    expect(first.served).toBe('6.0.2');
    expect(await waitFor(() => readCurrent() === '7.0.1')).toBe(true);
    const second = run(shim, [], env);
    expect(second.served).toBe('7.0.1');
  });

  test('a stable plugin outranks a prerelease runtime with the same numbers', () => {
    // Numeric-only comparison called 7.0.1 and 7.0.1-beta.1 equal, so the release was never served.
    seedVersion('7.0.1-beta.1');
    setCurrent('7.0.1-beta.1');
    seedVersion('7.0.1');
    const r = run(pluginWith('7.0.1'));
    expect(r.served).toBe('7.0.1');
    expect(readCurrent()).toBe('7.0.1');
  });

  test('a prerelease plugin does not pull back a stable runtime', () => {
    seedVersion('7.0.1');
    setCurrent('7.0.1');
    const r = run(pluginWith('7.0.1-beta.1'), [], { FAKE_NPM_AVAILABLE: '7.0.1-beta.1' });
    expect(r.served).toBe('7.0.1');
    expect(npmCalls()).toHaveLength(0);
  });

  test('a runtime already newer than the plugin is left alone', () => {
    seedVersion('7.0.2');
    setCurrent('7.0.2');
    const r = run(pluginWith('7.0.1'), [], { FAKE_NPM_AVAILABLE: '7.0.1' });
    expect(r.served).toBe('7.0.2');
    expect(readCurrent()).toBe('7.0.2');
    expect(npmCalls()).toHaveLength(0);
  });

  test.each([null, 'latest', '7.0'])('no usable plugin version (%s) keeps the previous behaviour', (version) => {
    seedVersion('6.0.2');
    setCurrent('6.0.2');
    const r = run(pluginWith(version), [], { FAKE_NPM_AVAILABLE: '7.0.1' });
    expect(r.served).toBe('6.0.2');
    expect(npmCalls()).toHaveLength(0);
  });

  test('an explicit version pin still wins over the plugin floor', () => {
    seedVersion('6.0.2');
    setCurrent('6.0.2');
    const r = run(pluginWith('7.0.1'), [], { TOKEN_OPTIMIZER_VERSION: '6.0.2', FAKE_NPM_AVAILABLE: '7.0.1' });
    expect(r.served).toBe('6.0.2');
    expect(npmCalls()).toHaveLength(0);
  });
});

describe('#394 a failed refresh does not silence retries', () => {
  test('--refresh that cannot install exits non-zero and leaves the throttle stamp alone', () => {
    const stamp = String(Date.now() - 7 * 60 * 60 * 1000);
    writeFileSync(join(runtime, '.last-refresh'), stamp);
    const r = run(pluginWith(null), ['--refresh'], { FAKE_NPM_LATEST: '7.0.1' });
    expect(r.status).not.toBe(0);
    expect(readFileSync(join(runtime, '.last-refresh'), 'utf8')).toBe(stamp);
    expect(readCurrent()).toBeNull();
  });

  test('a successful --refresh stamps the throttle and flips current', () => {
    const r = run(pluginWith(null), ['--refresh'], { FAKE_NPM_LATEST: '7.0.1', FAKE_NPM_AVAILABLE: '7.0.1' });
    expect(r.status).toBe(0);
    expect(readCurrent()).toBe('7.0.1');
    expect(Date.now() - Number(readFileSync(join(runtime, '.last-refresh'), 'utf8'))).toBeLessThan(60_000);
  });

  test('after a failure the background refresh retries on the short backoff, not the full interval', async () => {
    seedVersion('6.0.2');
    setCurrent('6.0.2');
    writeFileSync(join(runtime, '.last-refresh'), String(Date.now() - 7 * 60 * 60 * 1000));
    const shim = pluginWith(null);
    const env = { TOKEN_OPTIMIZER_REFRESH_INTERVAL_MS: String(6 * 60 * 60 * 1000), FAKE_NPM_LATEST: '7.0.1' };

    expect(run(shim, ['--refresh'], env).status).not.toBe(0);
    const failedCalls = npmCalls().length;

    // Within the backoff: the launch serves and starts no refresh.
    expect(run(shim, [], env).served).toBe('6.0.2');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(npmCalls()).toHaveLength(failedCalls);

    // Past the backoff: the launch refreshes in the background, and it now succeeds.
    const retry = { ...env, TOKEN_OPTIMIZER_REFRESH_RETRY_MS: '0', FAKE_NPM_AVAILABLE: '7.0.1' };
    expect(run(shim, [], retry).served).toBe('6.0.2');
    expect(await waitFor(() => readCurrent() === '7.0.1')).toBe(true);
  });

  test('a recent success does not delay the retry after a later failure', async () => {
    // The failure decides: a refresh that succeeded an hour ago and failed a minute later must
    // retry on the short backoff, not wait out the interval from that success.
    seedVersion('6.0.2');
    setCurrent('6.0.2');
    const shim = pluginWith(null);
    const env = { TOKEN_OPTIMIZER_REFRESH_INTERVAL_MS: String(6 * 60 * 60 * 1000), FAKE_NPM_LATEST: '7.0.1' };

    expect(run(shim, ['--refresh'], env).status).not.toBe(0);
    // A success one hour old, and the failure just recorded, aged past the retry window.
    writeFileSync(join(runtime, '.last-refresh'), String(Date.now() - 60 * 60 * 1000));
    const failure = JSON.parse(readFileSync(join(runtime, '.refresh-failed'), 'utf8'));
    writeFileSync(join(runtime, '.refresh-failed'), JSON.stringify({ ...failure, at: Date.now() - 20 * 60 * 1000 }));
    const before = npmCalls().length;

    expect(run(shim, [], { ...env, FAKE_NPM_AVAILABLE: '7.0.1' }).served).toBe('6.0.2');
    expect(await waitFor(() => readCurrent() === '7.0.1')).toBe(true);
    expect(npmCalls().length).toBeGreaterThan(before);
  });

  test('installing through npm prints no DEP0190 warning', () => {
    const r = run(pluginWith(null), ['--refresh'], { FAKE_NPM_LATEST: '7.0.1', FAKE_NPM_AVAILABLE: '7.0.1' });
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/DEP0190/);
  });
});
