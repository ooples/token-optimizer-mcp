/**
 * The MCP server answers `initialize` and `tools/list` without loading the
 * heavy per-tool dependencies, and those tools still work when called.
 *
 * WHY. Claude Code waits for the server to connect before composing a
 * session's first prompt. Measured on 2026-11-08: 2,243 ms to connect, about
 * 2 s of it module loading -- typescript-estree (~560 ms), graphlib + lodash
 * (~320 ms), the tiktoken WASM encoder (~210 ms), yaml (~135 ms) -- all for
 * tools that had not been called. Each now loads on first use. A static import
 * added back anywhere in the startup graph fails the first test here.
 */

import { afterAll, describe, expect, it } from '@jest/globals';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SERVER = join(process.cwd(), 'dist', 'server', 'index.js');
const work = mkdtempSync(join(tmpdir(), 'startup-deps-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** How long the server runs after answering, so its post-handshake imports finish. */
const SETTLE_MS = 3000;

const HEAVY = ['@typescript-eslint', 'graphlib', 'lodash', 'yaml', '@iarna', '@babel', 'tiktoken'];

/** Runs the server for `calls`, then closes stdin and returns replies plus every CJS module it loaded. */
function session(name, calls, env = {}) {
  const dump = join(work, `${name}-modules.json`);
  const preload = join(work, `${name}-preload.cjs`);
  // The preload is constant text; the dump path reaches it through the
  // environment, so no path is ever spliced into code.
  writeFileSync(
    preload,
    "process.on('exit', () => require('fs').writeFileSync(process.env.STARTUP_DEPS_MODULE_DUMP, JSON.stringify(Object.keys(require.cache))));\n"
  );
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'startup-test', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ...calls.map((params, i) => ({ jsonrpc: '2.0', id: 10 + i, method: 'tools/call', params })),
  ];
  const expected = new Set([1, 2, ...calls.map((_, i) => 10 + i)]);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--require', preload, SERVER], {
      cwd: work,
      env: {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: '',
        TOKEN_OPTIMIZER_STATE_DIR: join(work, `${name}-state`),
        TOKEN_OPTIMIZER_LOG_DIR: join(work, `${name}-logs`),
        TOKEN_OPTIMIZER_WIKI_DIR: join(work, `${name}-wiki`),
        TOKEN_OPTIMIZER_SHARED_DIR: join(work, `${name}-wiki`),
        STARTUP_DEPS_MODULE_DUMP: dump,
        ...env,
      },
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const replies = new Map();
    let buffer = '';
    let closing = false;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`server did not answer: ${[...expected].filter((id) => !replies.has(id))}`));
    }, 60_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (expected.has(message.id)) replies.set(message.id, message);
        } catch {
          /* not a JSON-RPC line */
        }
      }
      // NOT AT ONCE: the server starts background work right after its handshake
      // (routing maintenance, telemetry flush), each a dynamic import. Closing
      // stdin the moment the replies arrived raced those imports, so a slow
      // machine exited before they loaded anything and passed, while CI's Linux
      // runners failed: routing maintenance pulled in @babel/parser through
      // supervisor.ts -> server.ts. Waiting lets the dump see what a real
      // session's server holds.
      if (!closing && [...expected].every((id) => replies.has(id))) {
        closing = true;
        setTimeout(() => child.stdin.end(), SETTLE_MS);
      }
    });
    child.on('exit', () => {
      clearTimeout(timer);
      try {
        resolve({ replies, modules: JSON.parse(readFileSync(dump, 'utf8')) });
      } catch (error) {
        reject(error);
      }
    });
    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
  });
}

const loaded = (modules, name) =>
  modules.some((path) => path.replace(/\\/g, '/').includes(`/node_modules/${name}/`));

const payload = (reply) => {
  expect(reply.result?.isError).not.toBe(true);
  return reply.result.content.map((part) => part.text).join('\n');
};

describe('MCP server startup', () => {
  it('answers initialize and tools/list without loading a per-tool dependency', async () => {
    const { replies, modules } = await session('startup', [], { TOKEN_OPTIMIZER_TOOL_PROFILE: 'full' });
    expect(replies.get(2).result.tools.length).toBeGreaterThan(100);
    // Positive control: the dump really records node_modules packages.
    expect(loaded(modules, '@modelcontextprotocol')).toBe(true);
    expect(HEAVY.filter((name) => loaded(modules, name))).toEqual([]);
  }, 90_000);

  it('still loads each dependency when its tool is called', async () => {
    writeFileSync(join(work, 'settings.yaml'), 'service:\n  port: 8080\n  name: api\n');
    const { replies, modules } = await session(
      'calls',
      [
        { name: 'smart_config_read', arguments: { path: join(work, 'settings.yaml') } },
        {
          name: 'knowledge_graph',
          arguments: {
            operation: 'build-graph',
            graphId: 'g',
            entities: [
              { id: 'a', type: 'n', properties: {} },
              { id: 'b', type: 'n', properties: {} },
              { id: 'c', type: 'n', properties: {} },
            ],
            relations: [
              { from: 'a', to: 'b', type: 'r' },
              { from: 'b', to: 'c', type: 'r' },
            ],
          },
        },
        { name: 'knowledge_graph', arguments: { operation: 'find-paths', graphId: 'g', sourceId: 'a', targetId: 'c' } },
      ],
      { TOKEN_OPTIMIZER_TOOL_PROFILE: 'full' }
    );
    expect(payload(replies.get(10))).toContain('8080');
    payload(replies.get(11));
    const path = payload(replies.get(12));
    expect(path).toMatch(/"a"[\s\S]*"b"[\s\S]*"c"/);
    expect(loaded(modules, 'yaml')).toBe(true);
    expect(loaded(modules, 'graphlib')).toBe(true);
  }, 90_000);
});
