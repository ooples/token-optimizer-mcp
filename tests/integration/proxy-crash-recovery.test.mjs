import { describe, it, expect } from '@jest/globals';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

/**
 * One route window per jest worker, so a parallel run cannot have two supervisors deriving from
 * the same thousand ports. 18000 upward leaves the 17000 default to production, and the top
 * worker stays below 31768 -- the window has to END beneath the 32768 ephemeral floor.
 */
const ROUTE_BASE_FOR_WORKER =
  18000 + (Number(process.env.JEST_WORKER_ID || '1') - 1) * 1000;
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
/**
 * WAITING FOR A SUPERVISOR TO PUBLISH IS QUANTIZED AND NEEDS ITS OWN BUDGET.
 *
 * Two waits in a case end only once a background supervisor has booted and
 * published a route: the first proxy coming up, and the recovery after the kill.
 * Both are driven by the client's periodic probe, so their latency arrives in
 * whole steps of that period rather than in a smooth spread. Measured over the
 * 18 recovery waits on an idle box: every single one landed in one of two
 * clusters, 5.2-5.5s or 10.1-10.4s, and nothing fell between or above them.
 *
 * A flat 20s therefore sat inside the tail of that distribution, and each of the
 * two waits has since failed there on a case whose product behaviour was fine --
 * `Timed out waiting for proxy recovery` on an isolated run, and `Timed out
 * waiting for the first proxy to publish a route` on the first case of a
 * full-suite run, which starts while the other 422 suites are still finishing.
 * This budget covers four of the measured steps with slop; a genuine stall still
 * fails it. The other four waits in a case are a line of stdio or a local file
 * and keep the flat budget.
 */
const SUPERVISOR_TIMEOUT_MS = 45_000;
/**
 * A TIMEOUT WITHOUT A DIAGNOSIS IS NOT A TEST RESULT.
 *
 * Every wait here ends on a condition some other process has to bring about, so
 * a bare `Timed out waiting for X` says only that it did not happen -- and the
 * run is over, the temp home is gone and the daemons are killed before anyone
 * can look. `diagnose` is called once, on the timeout, and whatever it reports
 * is carried in the failure message, which is the only thing a CI log keeps.
 */
async function until(what, check, timeout = UNTIL_TIMEOUT_MS, diagnose) {
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
  let detail = '';
  if (diagnose) {
    try {
      detail = ` -- ${await diagnose()}`;
    } catch (error) {
      detail = ` -- the diagnosis itself failed: ${error.message}`;
    }
  }
  throw new Error(`Timed out waiting for ${what}${detail}`);
}

/** What the state file says, or why it could not say anything. */
const describeState = (state) => {
  try {
    const value = state();
    return `pid ${value.pid} (${liveness(value.pid)}), ${value.routes.length} route(s)`;
  } catch (error) {
    return `unreadable: ${error.message}`;
  }
};

/** What the control port says, or why it said nothing. */
const describeControl = async (port) => {
  try {
    const res = await fetch(
      `http://127.0.0.1:${port}/__token-optimizer/health`,
      { signal: AbortSignal.timeout(2000) }
    );
    return `${res.status} ${await res.text()}`;
  } catch (error) {
    return `silent (${error.message})`;
  }
};

/** 'alive' / 'dead', so a report can name what a pid was doing. */
const liveness = (pid) => {
  try {
    process.kill(pid, 0);
    return `alive`;
  } catch {
    return `dead`;
  }
};
async function listen(server) {
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return server.address().port;
}
const close = (server) => new Promise((done) => server.close(done));

/**
 * rmSync's OWN RETRY DOES NOT REACH THIS ONE.
 *
 * Teardown removed the temp home with `maxRetries: 5, retryDelay: 200` and
 * still failed with EPERM on the temp home itself, failing a case whose every
 * assertion had already passed -- which reads as the product failing to recover
 * when nothing of the sort happened. Raising the retries to 10 did not help.
 *
 * Measured across all 18 cases: the first removal fails EPERM every single
 * time, with every daemon pid already dead and the control port refusing
 * connections, and a second attempt 100ms later succeeds every single time
 * (18/18, ~110ms in total). So nothing is holding the directory -- Windows
 * keeps it for a moment after its last child is unlinked -- and node's own
 * retry does not cover that last rmdir. The retry has to live out here.
 */
const removeHome = async (home) => {
  const end = Date.now() + 20_000;
  for (;;) {
    try {
      rmSync(home, { recursive: true, force: true });
      return;
    } catch (error) {
      if (Date.now() >= end) throw error;
      await pause(100);
    }
  }
};

/**
 * Sequential `until` waits in one case, split by what each one waits on; see
 * the note on the case timeout.
 */
const SUPERVISOR_WAITS_PER_CASE = 2;
const OTHER_WAITS_PER_CASE = 4;
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
            // A WINDOW OF THIS WORKER'S OWN. The route window is 1000 ports wide, and every
            // jest worker on the runner derives from the same one by default -- so two
            // supervisors collide, the loser falls back to an ephemeral port, and a route URL
            // can answer from somebody else's supervisor. That is what "not a supervisor route"
            // was: a 404 from a control server that had never heard of this route.
            TOKEN_OPTIMIZER_PROXY_ROUTE_BASE: String(ROUTE_BASE_FOR_WORKER),
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
        await until('the initialize response', () => output.includes('"id":1'));
        const first = await until(
          'the first proxy to publish a route',
          () => {
            const value = state();
            return value.pid > 0 && value.routes.length && value;
          },
          SUPERVISOR_TIMEOUT_MS,
          // A supervisor that never started, one that started and never published, and a
          // client that never asked for a route all look the same from out here.
          async () =>
            `the state file names ${describeState(state)}; the control port answers ${await describeControl(port)}; the client has said ${JSON.stringify(output.slice(-400))}`
        );
        daemonPids.add(first.pid);
        const url = first.routes[0].url;
        if (hasClaude)
          await until(
            'the client settings to point at the proxy',
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
        const recovered = await until(
          'proxy recovery',
          () => {
            const value = state();
            if (value.pid !== first.pid) daemonPids.add(value.pid);
            return value.pid !== first.pid && value.routes.length && value;
          },
          SUPERVISOR_TIMEOUT_MS,
          // Three facts separate the ways this can fail: a replacement that never
          // started, one that started and never published, and one that published a
          // route table the wait would not accept.
          async () =>
            `the killed pid ${first.pid} is ${liveness(first.pid)}; the state file names ${describeState(state)}; the control port answers ${await describeControl(port)}`
        );
        expect(recovered.routes[0].url).toBe(url);
        expect(await request()).toEqual({ recovered: true });
        expect(child.exitCode).toBe(null);
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`
        );
        await until('the tools/list response', () => output.includes('"id":2'));
        const response = output
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .find((message) => message.id === 2);
        expect(response.result.tools.length).toBeGreaterThan(0);
        if (!hasClaude) expect(existsSync(settings)).toBe(false);
        await until('the project profile to be written', () =>
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
        await removeHome(home);
      }
    },
    // A CASE NEEDS A BUDGET BIGGER THAN WHAT IT IS ALLOWED TO WAIT FOR. One
    // case awaits `until` six times -- for the handshake, the first proxy, the
    // port release, the recovered proxy, the second response and the profile
    // write -- and each of those may legally spend its budget before any
    // assertion is reached. At a flat 45s the budget sat below that ceiling, so
    // the case passed on an idle machine (~11s) and could only fail under load
    // with a timeout rather than an assertion, which says nothing about what
    // went wrong. Derived, the two stay in step.
    SUPERVISOR_WAITS_PER_CASE * SUPERVISOR_TIMEOUT_MS +
      OTHER_WAITS_PER_CASE * UNTIL_TIMEOUT_MS +
      SPAWN_AND_TEARDOWN_MS
  );
});
