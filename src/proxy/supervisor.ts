/**
 * A long-lived proxy supervisor, so compression is on by default rather than only inside
 * `token-optimizer-run`.
 *
 * WHY THIS EXISTS. `startProxy` binds port 0 and lives as long as the launcher that started it, so
 * the only way to have a client routed was to launch it through us. A client started any other way
 * -- the documented `/plugin` install, an IDE, a shell alias -- talked straight to the provider and
 * saved nothing, while `install_doctor` reported that as a failure of the installation.
 *
 * ONE LISTENER PER UPSTREAM, NOT ONE PORT FOR EVERYTHING. A proxy forwards to a single upstream and
 * refuses paths that upstream does not serve (see `defaultUpstreamServes`), and the ten routable
 * clients do not share a provider: Claude Code speaks to Anthropic, Codex and friends to an
 * OpenAI-compatible endpoint, Gemini to Google, Copilot and Amp to their own. A single shared port
 * would therefore have to guess, and guessing wrong does not degrade politely -- it forwards one
 * provider's credentials to another. Callers name the upstream they are already using and get back
 * a loopback URL bound to it.
 *
 * THE CALLER'S CURRENT ENDPOINT IS THE UPSTREAM. A user who has already pointed a client at Azure,
 * a corporate gateway or a local model must keep reaching it; we insert ourselves in front of
 * whatever they configured, never in place of it.
 *
 * FAIL OPEN, ALWAYS. Every entry point here answers `null` when the supervisor cannot be reached or
 * started. A caller that gets `null` leaves the client's endpoint alone, so the worst outcome is
 * the behaviour users have today -- uncompressed traffic -- and never a client pointed at a port
 * with nothing behind it.
 */

import { createServer, request, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startProxy } from './server.js';

/** Where the supervisor records what it is serving, for callers and for the doctor. */
export function supervisorStateFile(
  env: NodeJS.ProcessEnv = process.env
): string {
  return join(
    env.TOKEN_OPTIMIZER_HOME || join(homedir(), '.token-optimizer'),
    'proxy-supervisor.json'
  );
}

/**
 * The control port.
 *
 * FIXED, because a caller has to find the supervisor without being told where it is, and an
 * ephemeral port would put that answer only in a file a stale reader could mis-read. 45710 sits in
 * the IANA dynamic range and is not a registered service.
 */
export function controlPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.TOKEN_OPTIMIZER_PROXY_CONTROL_PORT || '').trim();
  if (!raw) return 45710;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `TOKEN_OPTIMIZER_PROXY_CONTROL_PORT must be a port number, not '${raw}'`
    );
  }
  return port;
}

/** Ceilings for the control API. Small: our own client sends one short JSON object per launch. */
const MAX_CONTROL_BODY = 8 * 1024;
const MAX_ROUTES = 32;

export interface SupervisorRoute {
  readonly upstream: string;
  readonly url: string;
  readonly port: number;
  /**
   * The project this route serves knowledge for, or null.
   *
   * TRUSTED BECAUSE THE CALLER IS OURS. It arrives over the loopback control API from a launcher
   * that was started inside that directory; it is never read out of a model request. A request can
   * say anything, and a request that could choose a project could read another project's findings
   * into its own prompt and send them to the provider.
   */
  readonly project: string | null;
}

/**
 * The port a given upstream should be served on, derived from the upstream itself.
 *
 * WHY NOT PORT 0. An ephemeral port is fine while the only consumer is a launcher that learns it at
 * startup. It is not fine once a client's own configuration names the URL: that file outlives the
 * supervisor, so a restart on a fresh port would leave a client pointed at a port nothing is
 * listening on -- the one failure mode worse than saving nothing, because the client cannot reach
 * its provider at all.
 *
 * Derived rather than assigned so it survives the state file being lost, and taken from the IANA
 * dynamic range just above the control port. A collision with something else on the machine is
 * handled by the caller, which falls back to any free port and republishes.
 */
export function routePort(
  upstream: string,
  env: NodeJS.ProcessEnv = process.env
): number {
  // CLAMPED, because controlPort accepts up to 65535: base would then exceed the port range and
  // `base + hash % span` would derive an unlistenable port. Backing off leaves a usable window
  // below the ceiling wherever the control port sits.
  const ceiling = 65535;
  const span = 1000;
  const base = Math.min(controlPort(env) + 2, ceiling - span);
  // FNV-1a: a few lines, stable across Node versions, and nothing here is security-sensitive.
  let hash = 0x811c9dc5;
  for (const character of upstream) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return base + (hash % span);
}

/** Can we bind this port right now? A refusal is an answer, not an error. */
function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

export interface SupervisorState {
  readonly schema: 1;
  readonly pid: number;
  readonly startedAt: string;
  readonly controlUrl: string;
  readonly routes: readonly SupervisorRoute[];
}

/**
 * SYNCHRONOUS ON PURPOSE, against `n/no-sync`, for the reason accounting.ts records: two routes can
 * start at once, and each publishes the whole file. Awaited writes would let those two interleave,
 * so the rename that landed last could carry the state that was read first -- a route missing from
 * the file a caller then reads. The payload is a few hundred bytes, and write-then-rename is what
 * makes a reader see either the old file or the new one and never half of one.
 */
function writeState(state: SupervisorState, env: NodeJS.ProcessEnv): void {
  const file = supervisorStateFile(env);
  // eslint-disable-next-line n/no-sync -- see above
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  // eslint-disable-next-line n/no-sync -- see above
  writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  // eslint-disable-next-line n/no-sync -- see above
  renameSync(temporary, file);
}

export function readSupervisorState(
  env: NodeJS.ProcessEnv = process.env
): SupervisorState | null {
  try {
    // Sync so the doctor and any other reporter can ask what is being served without becoming
    // async themselves; the file is small and written atomically by writeState.
    // eslint-disable-next-line n/no-sync -- see above
    const parsed = JSON.parse(readFileSync(supervisorStateFile(env), 'utf8'));
    return parsed?.schema === 1 ? (parsed as SupervisorState) : null;
  } catch {
    return null;
  }
}

/** A JSON request to the control server, or null when it is not answering. */
async function control<T>(
  path: string,
  body: unknown,
  env: NodeJS.ProcessEnv,
  timeoutMs = 2000
): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    let settled = false;
    const done = (value: T | null) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const payload =
      body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = request(
      {
        host: '127.0.0.1',
        port: controlPort(env),
        path,
        method: payload ? 'POST' : 'GET',
        timeout: timeoutMs,
        headers: payload
          ? {
              'content-type': 'application/json',
              'content-length': payload.length,
            }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) return done(null);
          try {
            done(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T);
          } catch {
            done(null);
          }
        });
      }
    );
    req.on('error', () => done(null));
    req.on('timeout', () => {
      req.destroy();
      done(null);
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/** The supervisor's own report, or null when nothing is listening. */
export async function supervisorHealth(
  env: NodeJS.ProcessEnv = process.env
): Promise<{ ok: true; pid: number; routes: SupervisorRoute[] } | null> {
  return control<{ ok: true; pid: number; routes: SupervisorRoute[] }>(
    '/__token-optimizer/health',
    undefined,
    env
  );
}

/**
 * Serve the control API and the per-upstream proxies until the process is stopped.
 *
 * Refuses to start a second time: an already-answering supervisor owns the port, and two of them
 * would each publish a different route for the same upstream.
 */
export async function runSupervisor(
  env: NodeJS.ProcessEnv = process.env
): Promise<{
  server: Server;
  port: number;
  close: () => Promise<void>;
} | null> {
  if (await supervisorHealth(env)) return null;

  const routes = new Map<string, SupervisorRoute>();
  // Held so shutdown can close them. Without this the listeners outlive every caller: a test run
  // never exits, and a supervisor asked to stop keeps the ports bound.
  const listeners = new Set<Server>();
  const publish = () =>
    writeState(
      {
        schema: 1,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        controlUrl: `http://127.0.0.1:${controlPort(env)}`,
        routes: [...routes.values()],
      },
      env
    );

  // Keyed by upstream AND project, because those are two different listeners: the graph a proxy
  // serves is bound when it starts, so one route cannot answer for two projects.
  const keyOf = (upstream: string, project: string | null) =>
    JSON.stringify([upstream, project]);
  const starting = new Map<string, Promise<SupervisorRoute | null>>();
  const routeFor = async (
    upstream: string,
    project: string | null
  ): Promise<SupervisorRoute | null> => {
    const key = keyOf(upstream, project);
    const existing = routes.get(key);
    if (existing) return existing;
    const pending = starting.get(key);
    if (pending) return pending;
    const attempt = (async () => {
      try {
        // The derived port first, so a client's stored URL keeps working across restarts. Falling
        // back to any free port keeps an occupied port from costing the user compression entirely;
        // the caller republishes and the client's configuration is corrected at its next start.
        //
        // Probed with a bare listener rather than by letting startProxy fail, because a startProxy
        // that rejects has already created its spill directory and has no close event to remove it.
        const preferred = routePort(key, env);
        const { server: listener, port } = await startProxy({
          upstream,
          port: (await portIsFree(preferred)) ? preferred : 0,
          // THE PROJECT IS THE CALLER'S, OR THERE IS NONE.
          //
          // `startProxy` binds the graph root once, from `projectRoot` or `process.cwd()`. The cwd
          // of a detached daemon is whatever directory happened to spawn it, so without a project
          // from the caller this listener must inject nothing: one project's findings in every other
          // project's sessions was measured at 69% wrong-project advice in
          // bench/thol/manifests/token-optimizer-proxy-knowledge, charged to the cached prefix and
          // re-read every turn.
          //
          // Reading the project out of the request body was tried and removed. A model request is
          // not an authority on which project it belongs to: any prompt naming another checkout on
          // this machine would have had that project's findings loaded and sent to the provider.
          ...(project ? { projectRoot: project } : { knowledge: false }),
        });
        listeners.add(listener);
        const route: SupervisorRoute = {
          upstream,
          url: `http://127.0.0.1:${port}`,
          port,
          project,
        };
        routes.set(key, route);
        publish();
        return route;
      } catch {
        // An unsafe or unreachable upstream is the caller's problem to report; the supervisor
        // stays up for the upstreams that do work.
        return null;
      } finally {
        starting.delete(key);
      }
    })();
    starting.set(key, attempt);
    return attempt;
  };

  const server = createServer((req, res) => {
    void (async () => {
      const path = (req.url || '').split('?')[0];
      const reply = (status: number, body: unknown) => {
        const text = JSON.stringify(body);
        res.writeHead(status, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(text),
        });
        res.end(text);
      };
      if (path === '/__token-optimizer/health') {
        return reply(200, {
          ok: true,
          pid: process.pid,
          routes: [...routes.values()],
        });
      }
      if (path === '/__token-optimizer/route' && req.method === 'POST') {
        // A PAGE IN A BROWSER CAN POST HERE WITHOUT CORS PERMISSION. `text/plain` is a simple
        // request type, so no preflight protects this listener: any site the user visits could ask
        // us to stand up loopback proxies until the machine runs out of ports or disk. Three cheap
        // conditions close that, and our own client already satisfies all of them:
        //   - an `Origin` header means a browser sent it, and nothing of ours ever sets one;
        //   - `application/json` is not a simple content type, so a cross-site POST must preflight;
        //   - a bounded body means a crafted upstream string cannot be unbounded either.
        if (req.headers.origin !== undefined)
          return reply(403, {
            error: 'cross-origin requests are not accepted',
          });
        const contentType = String(req.headers['content-type'] || '')
          .split(';')[0]
          .trim()
          .toLowerCase();
        if (contentType !== 'application/json')
          return reply(415, { error: 'content-type must be application/json' });

        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += (chunk as Buffer).length;
          if (size > MAX_CONTROL_BODY)
            return reply(413, { error: 'request body is too large' });
          chunks.push(chunk as Buffer);
        }
        let upstream = '';
        let project: string | null = null;
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          upstream = String(body?.upstream ?? '');
          project =
            typeof body?.project === 'string' && body.project.trim()
              ? body.project
              : null;
        } catch {
          return reply(400, { error: 'body must be JSON naming an upstream' });
        }
        if (!upstream) return reply(400, { error: 'upstream is required' });
        // Counted WITH the in-flight starts, or a burst of distinct upstreams races past the cap
        // while each one is still binding its listener.
        const key = keyOf(upstream, project);
        if (
          !routes.has(key) &&
          !starting.has(key) &&
          routes.size + starting.size >= MAX_ROUTES
        )
          return reply(429, { error: 'too many upstreams are already routed' });
        const route = await routeFor(upstream, project);
        return route
          ? reply(200, route)
          : reply(502, { error: `cannot serve ${upstream}` });
      }
      reply(404, { error: 'not a supervisor route' });
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // LOOPBACK ONLY. This forwards provider credentials; it must never be reachable off-box.
    server.listen(controlPort(env), '127.0.0.1', resolve);
  });
  publish();

  const close = async () => {
    const all = [server, ...listeners];
    listeners.clear();
    routes.clear();
    await Promise.all(
      all.map(
        (one) => new Promise<void>((resolve) => one.close(() => resolve()))
      )
    );
  };
  return { server, port: controlPort(env), close };
}

/**
 * May we start a background supervisor on this machine?
 *
 * Someone who does not want a long-lived local service gets to say so, and a test that must not
 * leave one behind says the same thing. An already-running supervisor is still used either way.
 */
export function autostartAllowed(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return !/^(0|false|no|off)$/i.test(
    (env.TOKEN_OPTIMIZER_PROXY_AUTOSTART || '').trim()
  );
}

/** Spawn a detached supervisor and wait for it to answer, or give up. */
export async function ensureSupervisor(
  env: NodeJS.ProcessEnv = process.env,
  waitMs = 5000
): Promise<boolean> {
  if (await supervisorHealth(env)) return true;
  if (!autostartAllowed(env)) return false;
  try {
    const entry = join(
      dirname(fileURLToPath(import.meta.url)),
      'supervisor-cli.js'
    );
    const child = spawn(process.execPath, [entry], {
      detached: true,
      stdio: 'ignore',
      env: { ...env },
      windowsHide: true,
    });
    child.unref();
  } catch {
    return false;
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (await supervisorHealth(env)) return true;
  }
  return false;
}

/**
 * The loopback URL a client should use to reach `upstream` through compression, or null.
 *
 * Null is the fail-open answer: the caller leaves the client pointed where it already was.
 */
export async function ensureRoute(
  upstream: string,
  env: NodeJS.ProcessEnv = process.env,
  project: string | null = null
): Promise<string | null> {
  if (!upstream) return null;
  if (!(await ensureSupervisor(env))) return null;
  const route = await control<SupervisorRoute>(
    '/__token-optimizer/route',
    { upstream, ...(project ? { project } : {}) },
    env,
    15000
  );
  return route?.url ?? null;
}
