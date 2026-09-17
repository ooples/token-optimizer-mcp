#!/usr/bin/env node
/**
 * Proves a PUBLISHED release actually starts through the plugin's own launcher.
 *
 * v7.0.0 was tagged and released with no package on npm, and 7.0.1 reached npm while installed
 * plugins kept serving 6.0.2 -- both found by users, after the release, because nothing exercised
 * the artifact people install along the path they install it by. This does, from a clean runtime:
 *
 *   1. package.json and plugin/.claude-plugin/plugin.json both name the version under test;
 *   2. the registry serves that exact version (waits for propagation, bounded);
 *   3. plugin/launch.mjs, pinned to it, installs it through the real npm and serves it;
 *   4. an MCP initialize answers with that version and tools/list returns the core tools;
 *   5. the launcher printed no Node deprecation warning (DEP0190 regressed once).
 *
 * Usage: node scripts/verify-published-launch.mjs --version 7.0.2 [--wait-minutes 15]
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = '@ooples/token-optimizer-mcp';
const REQUIRED_TOOLS = ['smart_read', 'smart_grep', 'smart_edit', 'install_doctor'];

function argument(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : String(process.argv[index + 1] ?? '');
}

function fail(message) {
  console.error(`verify-published-launch: FAIL - ${message}`);
  process.exit(1);
}

const version = argument('version');
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) fail(`--version must be an exact version (got "${version}")`);
const waitMinutes = Number(argument('wait-minutes', '15'));

// 1. The two committed version stamps agree with the release.
const packageVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const pluginVersion = JSON.parse(readFileSync(join(ROOT, 'plugin', '.claude-plugin', 'plugin.json'), 'utf8')).version;
if (packageVersion !== version || pluginVersion !== version) {
  fail(`version stamps disagree: package.json ${packageVersion}, plugin.json ${pluginVersion}, release ${version}`);
}

// 2. The registry serves it. `npm view` resolves the full manifest, which is what `npm install`
// needs; the abbreviated dist-tag can name a version minutes before it is installable.
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const deadline = Date.now() + waitMinutes * 60_000;
for (;;) {
  // One command string (the version is validated above): a shell with an argument list is what
  // Node reports as DEP0190.
  const view = spawnSync(`${npm} view ${PACKAGE}@${version} version --prefer-online`, {
    encoding: 'utf8',
    shell: true,
    windowsHide: true,
  });
  if (view.status === 0 && view.stdout.trim() === version) break;
  if (Date.now() > deadline) fail(`${PACKAGE}@${version} is not installable after ${waitMinutes} minutes`);
  console.log(`waiting for ${PACKAGE}@${version} on the registry...`);
  await new Promise((resolve) => setTimeout(resolve, 20_000));
}

// 3-5. Launch through the shipped shim, pinned, in a runtime that has never seen this package.
const runtime = mkdtempSync(join(tmpdir(), 'verify-published-launch-'));
const result = await new Promise((resolve) => {
  const child = spawn(process.execPath, [join(ROOT, 'plugin', 'launch.mjs')], {
    env: {
      ...process.env,
      TOKEN_OPTIMIZER_RUNTIME: runtime,
      TOKEN_OPTIMIZER_VERSION: version,
      // A clean npx cache lookup: the pinned path must install, not borrow a local copy.
      npm_config_cache: join(runtime, 'npm-cache'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const outcome = { server: null, tools: [], stderr: '' };
  let buffer = '';
  const timer = setTimeout(() => {
    outcome.timedOut = true;
    child.kill();
  }, 5 * 60_000);
  child.stderr.on('data', (chunk) => {
    outcome.stderr += chunk;
  });
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id === 1) {
        outcome.server = message.result?.serverInfo ?? null;
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
      } else if (message.id === 2) {
        outcome.tools = (message.result?.tools ?? []).map((tool) => tool.name);
        child.kill();
      }
    }
  });
  child.on('exit', () => {
    clearTimeout(timer);
    resolve(outcome);
  });
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'release-verification', version } },
  })}\n`);
});

try {
  rmSync(runtime, { recursive: true, force: true, maxRetries: 5 });
} catch {
  /* a Windows handle may linger; the temp directory is disposable */
}

if (result.timedOut) fail(`the launcher did not answer within five minutes\n${result.stderr}`);
if (result.server?.version !== version) {
  fail(`the launcher served ${result.server?.version ?? 'nothing'} instead of ${version}\n${result.stderr}`);
}
const missing = REQUIRED_TOOLS.filter((name) => !result.tools.includes(name));
if (missing.length) fail(`tools/list is missing ${missing.join(', ')} (got ${result.tools.length} tools)`);
if (/DEP0\d{3}|DeprecationWarning/.test(result.stderr)) fail(`the launcher printed a deprecation warning:\n${result.stderr}`);

console.log(`verify-published-launch: OK - ${PACKAGE}@${version} installed and served through plugin/launch.mjs with ${result.tools.length} tools`);
