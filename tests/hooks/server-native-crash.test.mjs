/**
 * A server that crashes in native code is named, not just lost.
 *
 * On one Windows machine the optimizer MCP server never connected for five
 * weeks (2026-09-26 to 2026-10-30: 38 failed starts, 0 calls): better-sqlite3
 * 13.0.3 crashes with 0xC0000005 opening a database under Node 22.2.0 through
 * 22.13.x. Claude Code reported only "Connection closed". The launcher now
 * records the crash with the Node version, and SessionStart tells the session
 * what to change while that Node version is still the one running.
 */

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isNativeCrash } from '../../plugin/launch.mjs';
import { serverCrashNotice } from '../../hooks-core/server-crash.mjs';

const ROOT = process.cwd();
const LAUNCH = join(ROOT, 'plugin', 'launch.mjs');
const SESSION_START = join(ROOT, 'plugin', 'hooks', 'session-start.mjs');
const PACKAGE_DIR = join('node_modules', '@ooples', 'token-optimizer-mcp');

let runtime;

beforeEach(() => {
  runtime = mkdtempSync(join(tmpdir(), 'to-crash-'));
  mkdirSync(join(runtime, 'versions'), { recursive: true });
  writeFileSync(join(runtime, '.last-refresh'), String(Date.now()));
});

afterEach(() => rmSync(runtime, { recursive: true, force: true }));

/** A runtime version whose server exits the way the given body makes it. */
function seedServer(version, body) {
  const pkgDir = join(runtime, 'versions', version, PACKAGE_DIR);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: '@ooples/token-optimizer-mcp', version, main: 'server.js' })
  );
  writeFileSync(join(pkgDir, 'server.js'), body);
  writeFileSync(join(runtime, 'current'), version);
}

function env(extra = {}) {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('TOKEN_OPTIMIZER_')) out[k] = v;
  }
  return {
    ...out,
    TOKEN_OPTIMIZER_RUNTIME: runtime,
    TOKEN_OPTIMIZER_REFRESH_INTERVAL_MS: '999999999999',
    TOKEN_OPTIMIZER_REFRESH_RECHECK_MS: '0',
    ...extra,
  };
}

const launch = () =>
  spawnSync(process.execPath, [LAUNCH], { encoding: 'utf8', timeout: 60_000, env: env() });

// The crash as each platform reports it: Windows an exit code, POSIX a signal.
const NATIVE_CRASH =
  process.platform === 'win32'
    ? 'process.exit(-1073741819);\n' // 0xC0000005, STATUS_ACCESS_VIOLATION
    : "process.kill(process.pid, 'SIGSEGV');\n";

const crashFile = () => join(runtime, '.server-crash.json');

describe('isNativeCrash', () => {
  test.each([
    [3221225477, null, true], // 0xC0000005 as Node reports it on Windows
    [null, 'SIGSEGV', true],
    [139, null, true], // 128 + SIGSEGV through a shell
    [1, null, false], // a thrown JavaScript error
    [0, null, false],
    [null, 'SIGTERM', false], // the host shutting the server down
  ])('code %p signal %p -> %p', (code, signal, expected) => {
    expect(isNativeCrash(code, signal)).toBe(expected);
  });
});

describe('the launcher records a native crash', () => {
  test('a crashing server leaves a record with the Node version and a named cause', () => {
    seedServer('9.9.9', NATIVE_CRASH);
    const r = launch();
    expect(r.stderr).toContain(`server crashed in native code`);
    expect(r.stderr).toContain(`Node ${process.versions.node}`);
    const record = JSON.parse(readFileSync(crashFile(), 'utf8'));
    expect(record).toMatchObject({ node: process.versions.node, version: '9.9.9' });
  });

  test('an ordinary JavaScript failure is not recorded as a crash', () => {
    seedServer('9.9.9', "throw new Error('boom');\n");
    launch();
    expect(existsSync(crashFile())).toBe(false);
  });

  test('a clean exit clears an earlier record', () => {
    writeFileSync(crashFile(), JSON.stringify({ node: process.versions.node, exit: '0xC0000005' }));
    seedServer('9.9.9', 'process.exit(0);\n');
    launch();
    expect(existsSync(crashFile())).toBe(false);
  });
});

describe('SessionStart names the crash', () => {
  function sessionStart() {
    const r = spawnSync(process.execPath, [SESSION_START], {
      encoding: 'utf8',
      timeout: 60_000,
      cwd: runtime,
      input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'crash', cwd: runtime }),
      env: env({
        TOKEN_OPTIMIZER_STATE_DIR: join(runtime, '.state'),
        TOKEN_OPTIMIZER_WIKI_DIR: join(runtime, '.wiki'),
        TOKEN_OPTIMIZER_SHARED_DIR: join(runtime, '.shared'),
      }),
    });
    expect(r.status).toBe(0);
    return r.stdout;
  }

  test('a crash under this Node version is reported with the remedy', () => {
    seedServer('9.9.9', NATIVE_CRASH);
    launch();
    const out = sessionStart();
    expect(out).toContain('MCP server crashed at startup');
    expect(out).toContain('22.14.0');
  });

  test('a crash under another Node version says nothing', () => {
    writeFileSync(crashFile(), JSON.stringify({ node: '22.2.0-other', exit: '0xC0000005' }));
    expect(sessionStart()).not.toContain('crashed at startup');
    expect(serverCrashNotice({ TOKEN_OPTIMIZER_RUNTIME: runtime }, '22.2.0-other')).toContain(
      '0xC0000005'
    );
  });
});
