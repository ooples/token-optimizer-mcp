import { describe, it, expect } from '@jest/globals';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { CLIENT_CAPABILITIES } from '../../hooks-core/capabilities.mjs';

const pause = (ms) => new Promise((done) => setTimeout(done, ms));
// THE WAIT BUDGET ONE `until` MAY SPEND. Exported as a constant because the
// per-case timeout below is derived from it; moving one has to move the other.
const UNTIL_TIMEOUT_MS = 20_000;
async function until(check, timeout = UNTIL_TIMEOUT_MS) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const value = await check();
      if (value) return value;
    } catch {
      /* not ready */
    }
    await pause(100);
  }
  throw new Error('Timed out waiting for proxy recovery');
}
async function listen(server) {
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return server.address().port;
}
const close = (server) => new Promise((done) => server.close(done));

/** Sequential `until` waits in one case; see the note on the case timeout. */
const UNTIL_WAITS_PER_CASE = 6;
/** Spawning the client, the 2s exit race and the retrying temp-dir removal. */
const SPAWN_AND_TEARDOWN_MS = 15_000;

describe('a connected MCP session survives a dead background proxy', () => {
  it.each([
    ...['SIGKILL', 'SIGTERM'].map((signal) => ({
      signal,
      client: 'codex',
      hasClaude: true,
    })),
    ...Object.keys(CLIENT_CAPABILITIES).map((client) => ({
      signal: 'SIGKILL',
      client,
      hasClaude: false,
    })),
  ])(
    '$client recovers after $signal without reconnecting MCP (Claude settings: $hasClaude)',
    async ({ signal, client, hasClaude }) => {
      const home = mkdtempSync(join(tmpdir(), 'proxy-crash-'));
      const upstream = createServer((req, res) => {
        req.resume();
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ recovered: true }));
      });
      const upstreamUrl = `http://127.0.0.1:${await listen(upstream)}`;
      const probe = createServer();
      const port = await listen(probe);
      await close(probe);
      const settings = join(home, 'settings.json');
      const profile = join(home, 'profile.ps1');
      const body = `function global:codex { & 'node' '${join(home, 'removed-old-package/scripts/run-client.mjs')}' codex @args }`;
      const hash = createHash('sha256').update(body).digest('hex');
      writeFileSync(
        profile,
        `# >>> token-optimizer managed clients >>>\n${body}\n# token-optimizer sha256: ${hash}\n# <<< token-optimizer managed clients <<<\n`
      );
      const stale = 'http://127.0.0.1:1';
      writeFileSync(
        settings,
        JSON.stringify({ env: { ANTHROPIC_BASE_URL: stale } })
      );
      writeFileSync(
        join(home, 'default-routing.json'),
        JSON.stringify({
          schema: 1,
          entries: {
            [settings]: {
              variable: 'ANTHROPIC_BASE_URL',
              value: stale,
              upstream: upstreamUrl,
              previous: upstreamUrl,
            },
          },
        })
      );
      const daemonPids = new Set();
      const state = () =>
        JSON.parse(readFileSync(join(home, 'proxy-supervisor.json'), 'utf8'));
      if (!hasClaude) {
        rmSync(settings);
        rmSync(join(home, 'default-routing.json'));
        const routeProbe = createServer();
        const routePort = await listen(routeProbe);
        await close(routeProbe);
        writeFileSync(
          join(home, 'proxy-supervisor.json'),
          JSON.stringify({
            schema: 1,
            pid: 0,
            controlUrl: `http://127.0.0.1:${port}`,
            routes: [
              {
                upstream: upstreamUrl,
                project: null,
                port: routePort,
                url: `http://127.0.0.1:${routePort}`,
              },
            ],
          })
        );
      }
      const child = spawn(
        process.execPath,
        [
          process.env.TOKEN_OPTIMIZER_TEST_SERVER ||
            resolve('dist/server/index.js'),
        ],
        {
          cwd: home,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            TOKEN_OPTIMIZER_HOME: home,
            TOKEN_OPTIMIZER_SETTINGS: settings,
            TOKEN_OPTIMIZER_PROXY_CONTROL_PORT: String(port),
            TOKEN_OPTIMIZER_PROXY_AUTOSTART: '1',
            TOKEN_OPTIMIZER_DEFAULT_ROUTING: '1',
            TOKEN_OPTIMIZER_PROXY: '1',
            TOKEN_OPTIMIZER_MODE: 'assist',
            TOKEN_OPTIMIZER_WIKI_DIR: join(home, 'wiki'),
            TOKEN_OPTIMIZER_CLIENT: client,
            TOKEN_OPTIMIZER_SHELL_PROFILES: JSON.stringify([profile]),
            TOKEN_OPTIMIZER_AUTO_REPAIR: '1',
            TOKEN_OPTIMIZER_VERSION: '',
            TOKEN_OPTIMIZER_MANAGED_CLIENTS: '',
          },
        }
      );
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
      });
      child.stderr.resume();
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: client, version: '1' } } })}\n`
      );
      try {
        await until(() => output.includes('"id":1'));
        const first = await until(() => {
          const value = state();
          return value.pid > 0 && value.routes.length && value;
        });
        daemonPids.add(first.pid);
        const url = first.routes[0].url;
        if (hasClaude)
          await until(
            () =>
              JSON.parse(readFileSync(settings, 'utf8')).env
                .ANTHROPIC_BASE_URL === url
          );
        const request = () =>
          fetch(`${url}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              model: 'test',
              messages: [{ role: 'user', content: 'hello' }],
            }),
            signal: AbortSignal.timeout(2000),
          }).then((res) => res.json());
        expect(await request()).toEqual({ recovered: true });
        // Abrupt death leaves stale state, just as observed on Windows. No MCP restart follows.
        process.kill(first.pid, signal);
        const recovered = await until(() => {
          const value = state();
          if (value.pid !== first.pid) daemonPids.add(value.pid);
          return value.pid !== first.pid && value.routes.length && value;
        });
        expect(recovered.routes[0].url).toBe(url);
        expect(await request()).toEqual({ recovered: true });
        expect(child.exitCode).toBe(null);
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`
        );
        await until(() => output.includes('"id":2'));
        const response = output
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .find((message) => message.id === 2);
        expect(response.result.tools.length).toBeGreaterThan(0);
        if (!hasClaude) expect(existsSync(settings)).toBe(false);
        await until(() =>
          readFileSync(profile, 'utf8').includes(
            resolve('.').replaceAll('\\', '/')
          )
        );
      } finally {
        const exited = new Promise((done) => child.once('exit', done));
        child.stdin.end();
        await Promise.race([exited, pause(2000)]);
        if (child.exitCode === null) {
          child.kill();
          await exited;
        }
        try {
          daemonPids.add(state().pid);
        } catch {
          /* startup failed */
        }
        for (const pid of daemonPids) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            /* exited */
          }
        }
        await close(upstream);
        await pause(200);
        rmSync(home, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 200,
        });
      }
    },
    // A CASE NEEDS A BUDGET BIGGER THAN WHAT IT IS ALLOWED TO WAIT FOR. One
    // case awaits `until` six times -- for the handshake, the first proxy, the
    // port release, the recovered proxy, the second response and the profile
    // write -- and each of those may legally spend UNTIL_TIMEOUT_MS before any
    // assertion is reached. At a flat 45s the budget sat below that ceiling, so
    // the case passed on an idle machine (~11s) and could only fail under load
    // with a timeout rather than an assertion, which says nothing about what
    // went wrong. Derived, the two stay in step.
    UNTIL_WAITS_PER_CASE * UNTIL_TIMEOUT_MS + SPAWN_AND_TEARDOWN_MS
  );
});
