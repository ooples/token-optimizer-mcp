/**
 * The supervisor is what makes compression on by default, so these tests are about the two
 * properties that decide whether it can be switched on for everyone:
 *
 *   1. a caller gets back a loopback URL that really reaches THAT caller's upstream, and
 *   2. every failure answers null, because a client pointed at a dead port cannot talk to its
 *      provider at all -- a worse outcome than saving nothing.
 *
 * Hermetic: the "provider" is a local server this file starts, and the control port is an
 * unused one picked per test, so nothing here touches a real endpoint or the user's own daemon.
 */

import { describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import { createServer, type Server } from 'node:http';
import { request } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  autostartAllowed,
  controlPort,
  ensureRoute,
  readSupervisorState,
  routePort,
  runSupervisor,
  supervisorHealth,
  supervisorStateFile,
} from '../../src/proxy/supervisor.js';

let upstream: Server;
let upstreamUrl: string;
let seen: string[];
let bodies: string[];
let supervisor: { server: Server; close: () => Promise<void> } | null;
let home: string;
let env: NodeJS.ProcessEnv;

it('retains an occupied saved port and retries it without client registration', async () => {
  supervisor = await runSupervisor(env);
  const url = await ensureRoute(upstreamUrl, env);
  const port = Number(new URL(url!).port);
  await supervisor!.close();
  supervisor = null;
  const blocker = createServer();
  await new Promise<void>((done) => blocker.listen(port, '127.0.0.1', done));
  try {
    supervisor = await runSupervisor(env);
    expect(readSupervisorState(env)?.routes[0].url).toBe(url);
    expect(await ensureRoute(upstreamUrl, env)).toBeNull();
  } finally {
    await new Promise<void>((done) => blocker.close(() => done()));
  }
  const deadline = Date.now() + 8000;
  while (!(await supervisorHealth(env))?.routes.length && Date.now() < deadline)
    await new Promise((done) => setTimeout(done, 100));
  expect((await supervisorHealth(env))?.routes[0]?.url).toBe(url);
  expect((await get(url!, '/v1/messages')).status).toBe(200);
}, 15000);

it('does not mistake unrelated HTTP JSON for a healthy supervisor', async () => {
  const other = createServer((_req, res) => res.end('{}'));
  await new Promise<void>((done) =>
    other.listen(controlPort(env), '127.0.0.1', done)
  );
  try {
    expect(await supervisorHealth(env)).toBeNull();
  } finally {
    await new Promise<void>((done) => other.close(() => done()));
  }
});

it('bounds a control response that keeps trickling bytes', async () => {
  const other = createServer((_req, res) => {
    res.writeHead(200);
    res.write('{');
    const timer = setInterval(() => res.write(' '), 20);
    res.on('close', () => clearInterval(timer));
  });
  await new Promise<void>((done) =>
    other.listen(controlPort(env), '127.0.0.1', done)
  );
  try {
    expect(await supervisorHealth(env)).toBeNull();
  } finally {
    other.closeAllConnections();
    await new Promise<void>((done) => other.close(() => done()));
  }
}, 5000);

/** A free port, released before it is handed out -- good enough for a test's own control port. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function get(
  url: string,
  path: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(path, url);
    const req = request(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        );
      }
    );
    req.on('error', reject);
    req.end('{}');
  });
}

beforeEach(async () => {
  seen = [];
  bodies = [];
  upstream = createServer((req, res) => {
    seen.push(req.url || '');
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, '127.0.0.1', resolve)
  );
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  home = mkdtempSync(join(tmpdir(), 'supervisor-home-'));
  env = {
    ...process.env,
    TOKEN_OPTIMIZER_HOME: home,
    TOKEN_OPTIMIZER_PROXY_CONTROL_PORT: String(await freePort()),
    TOKEN_OPTIMIZER_MODE: 'assist',
  };
  supervisor = null;
});

afterEach(async () => {
  // close() stops the per-upstream listeners too; closing only the control server leaves them
  // bound and the process alive.
  if (supervisor) await supervisor.close();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  rmSync(home, { recursive: true, force: true });
});

describe('the proxy supervisor', () => {
  it('serves a caller its own upstream, and reuses one listener for it', async () => {
    supervisor = await runSupervisor(env);
    expect(supervisor).not.toBeNull();

    const first = await ensureRoute(upstreamUrl, env);
    expect(first).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(first).not.toBe(upstreamUrl);

    // The point of the whole feature: a request to the route reaches THAT upstream.
    const answer = await get(first!, '/v1/messages');
    expect(answer.status).toBe(200);
    expect(seen).toContain('/v1/messages');

    const again = await ensureRoute(upstreamUrl, env);
    expect(again).toBe(first);
  }, 30_000);

  it('gives different upstreams different listeners, never one shared port', async () => {
    // Two providers must not share a listener: a proxy forwards to exactly one upstream, so a
    // shared port would send one provider's credentials to the other.
    const second = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((resolve) =>
      second.listen(0, '127.0.0.1', resolve)
    );
    const secondUrl = `http://127.0.0.1:${(second.address() as { port: number }).port}`;
    try {
      supervisor = await runSupervisor(env);
      const a = await ensureRoute(upstreamUrl, env);
      const b = await ensureRoute(secondUrl, env);
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(a).not.toBe(b);
      const state = readSupervisorState(env);
      expect(state?.routes.map((r) => r.upstream).sort()).toEqual(
        [upstreamUrl, secondUrl].sort()
      );
    } finally {
      await new Promise<void>((resolve) => second.close(() => resolve()));
    }
  }, 30_000);

  it('restores every route and a collision-assigned port before clients register again', async () => {
    let occupied = createServer();
    let project = home;
    let preferred = 0;
    // Windows reserves some derived ports. Find one we can occupy rather than assuming a
    // particular hash lands outside its excluded ranges, and handle listen errors explicitly.
    for (let attempt = 0; attempt < 64; attempt++) {
      project = join(home, `collision-${attempt}`);
      preferred = routePort(JSON.stringify([upstreamUrl, project]), env);
      occupied = createServer();
      const bound = await new Promise<boolean>((done) => {
        occupied.once('error', () => done(false));
        occupied.listen(preferred, '127.0.0.1', () => done(true));
      });
      if (bound) break;
    }
    expect(occupied.listening).toBe(true);
    try {
      supervisor = await runSupervisor(env);
      const first = await ensureRoute(upstreamUrl, env, project);
      const other = await ensureRoute(upstreamUrl, env, home);
      expect(first).not.toBe(`http://127.0.0.1:${preferred}`);
      await supervisor!.close();
      supervisor = null;
      await new Promise<void>((done) => occupied.close(() => done()));
      supervisor = await runSupervisor(env);
      // No ensureRoute calls: both already-running clients keep their original URLs.
      expect(
        (await supervisorHealth(env))?.routes.map((route) => route.url).sort()
      ).toEqual([first, other].sort());
      expect((await get(first!, '/v1/messages')).status).toBe(200);
      expect((await get(other!, '/v1/messages')).status).toBe(200);
    } finally {
      if (occupied.listening)
        await new Promise<void>((done) => occupied.close(() => done()));
    }
  }, 30000);

  it('serves an upstream on the same port after a restart', async () => {
    // A client's own configuration names this URL and outlives the supervisor. An ephemeral port
    // would therefore leave that client pointed at nothing after a reboot -- unable to reach its
    // provider at all, which is worse than never having compressed anything.
    supervisor = await runSupervisor(env);
    const first = await ensureRoute(upstreamUrl, env);
    await supervisor!.close();
    supervisor = await runSupervisor(env);
    expect(await ensureRoute(upstreamUrl, env)).toBe(first);
    // The port is DERIVED, so it survives the restart. Asserting the derived value for a bare
    // upstream would pin the key shape instead of the property; routePort has its own test.
    expect(first).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  }, 30_000);

  it('derives a route port that is stable, in range, and specific to the upstream', () => {
    expect(routePort('https://api.anthropic.com', env)).toBe(
      routePort('https://api.anthropic.com', env)
    );
    expect(routePort('https://api.anthropic.com', env)).not.toBe(
      routePort('https://generativelanguage.googleapis.com', env)
    );
    const port = routePort('https://api.anthropic.com', env);
    expect(port).toBeGreaterThan(controlPort(env));
    expect(port).toBeLessThanOrEqual(65535);
  });

  /**
   * A request body shaped so injection would really fire.
   *
   * A short body proves nothing: an earlier version sent 48 bytes and passed with injection
   * deliberately switched ON, because the block is only added to a request carrying a `system`
   * field that is large enough to be worth rewriting. A control arm that cannot fail is not one.
   */
  const ask = (): string =>
    JSON.stringify({
      system: 'You are a coding agent.',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'context line' + String.fromCharCode(10).repeat(600),
            },
          ],
        },
      ],
    });

  const post = async (route: string, body: string): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      const target = new URL(route);
      const req = request(
        {
          host: target.hostname,
          port: target.port,
          path: '/v1/messages',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        },
        (res) => {
          res.on('data', () => {});
          res.on('end', () => resolve());
        }
      );
      req.on('error', reject);
      req.end(body);
    });
  };

  /** A throwaway project with one verified finding, so this suite never reads the ambient graph. */
  async function seededProject(): Promise<string> {
    const root = mkdtempSync(join(tmpdir(), 'supervisor-project-'));
    const wiki = await import('../../hooks-core/wiki.mjs');
    const dir = join(root, '.token-optimizer', 'wiki');
    wiki.putNode(dir, {
      kind: 'finding',
      key: 'seeded-marker',
      claim: 'SEEDED_PROJECT_MARKER is the finding this test looks for.',
      type: 'failure',
      confidence: 0.95,
      confidenceLabel: 'verified',
      scope: 'project',
    });
    return root;
  }

  it('injects the findings of the project the CALLER named', async () => {
    // THE POINT OF THE GRAPH: a session working in a project gets that project's own lessons in the
    // cached prefix. The project arrives over the loopback control API from a launcher started in
    // that directory -- a trusted caller -- and never from the request body.
    const project = await seededProject();
    try {
      supervisor = await runSupervisor(env);
      const route = await ensureRoute(upstreamUrl, env, project);
      await post(route!, ask());
      expect(seen).toContain('/v1/messages');
      expect(bodies.join('')).toContain('SEEDED_PROJECT_MARKER');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  }, 30_000);

  it('injects nothing when the caller named no project', async () => {
    // The default-routing path has no trusted project identity, so it must add nothing. Falling back
    // to the daemon's own cwd is the wrong-project failure this design exists to prevent.
    supervisor = await runSupervisor(env);
    const route = await ensureRoute(upstreamUrl, env);
    const body = ask();
    await post(route!, body);
    const forwarded = bodies.join('');
    expect(forwarded).not.toContain('Already established');
    expect(JSON.parse(forwarded).system).toBe('You are a coding agent.');
    expect(JSON.parse(forwarded).messages).toEqual(JSON.parse(body).messages);
  }, 30_000);

  it('gives two projects two listeners on one upstream', async () => {
    const a = await seededProject();
    const b = await seededProject();
    try {
      supervisor = await runSupervisor(env);
      const ra = await ensureRoute(upstreamUrl, env, a);
      const rb = await ensureRoute(upstreamUrl, env, b);
      expect(ra).not.toBeNull();
      expect(rb).not.toBeNull();
      // One listener binds one graph, so two projects cannot share a route.
      expect(ra).not.toBe(rb);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  }, 30_000);

  it('refuses a control request a browser could have sent', async () => {
    // text/plain is a simple request type, so a page the user visits could POST here without any
    // CORS permission and make us bind loopback proxies until the machine runs out.
    supervisor = await runSupervisor(env);
    const port = controlPort(env);
    const send = (headers: Record<string, string>) =>
      new Promise<number>((resolve, reject) => {
        const req = request(
          {
            host: '127.0.0.1',
            port,
            path: '/__token-optimizer/route',
            method: 'POST',
            headers,
          },
          (res) => {
            res.on('data', () => {});
            res.on('end', () => resolve(res.statusCode ?? 0));
          }
        );
        req.on('error', reject);
        req.end(JSON.stringify({ upstream: upstreamUrl }));
      });
    expect(await send({ 'content-type': 'text/plain' })).toBe(415);
    expect(
      await send({
        'content-type': 'application/json',
        origin: 'https://evil.example',
      })
    ).toBe(403);
  }, 30_000);

  it('records what it serves where the doctor can read it', async () => {
    supervisor = await runSupervisor(env);
    await ensureRoute(upstreamUrl, env);
    const state = readSupervisorState(env);
    expect(state?.schema).toBe(1);
    expect(state?.pid).toBe(process.pid);
    expect(state?.controlUrl).toBe(`http://127.0.0.1:${controlPort(env)}`);
    expect(existsSync(supervisorStateFile(env))).toBe(true);
    expect(
      JSON.parse(readFileSync(supervisorStateFile(env), 'utf8')).routes
    ).toHaveLength(1);
  }, 30_000);

  it('refuses to run twice on one control port', async () => {
    supervisor = await runSupervisor(env);
    expect(await runSupervisor(env)).toBeNull();
    // And the port is released on shutdown, so the next session can start one.
    await supervisor!.close();
    expect(await supervisorHealth(env)).toBeNull();
    supervisor = null;
  }, 30_000);

  it('answers null rather than routing a client at an upstream it cannot serve', async () => {
    supervisor = await runSupervisor(env);
    // http off loopback would put provider credentials on the wire in cleartext; startProxy
    // refuses it, and the caller must be told nothing rather than a URL that drops traffic.
    expect(await ensureRoute('http://example.com', env)).toBeNull();
  }, 30_000);

  it('answers null when no supervisor can be reached', async () => {
    // Autostart off, so this asserts the fail-open answer rather than starting a real background
    // supervisor -- which, with dist/ built, this test would otherwise leave running on the machine.
    const offline = {
      ...env,
      TOKEN_OPTIMIZER_PROXY_CONTROL_PORT: String(await freePort()),
      TOKEN_OPTIMIZER_PROXY_AUTOSTART: '0',
    };
    expect(await supervisorHealth(offline)).toBeNull();
    expect(await ensureRoute(upstreamUrl, offline)).toBeNull();
  }, 30_000);

  it.each(['0', 'false', 'no', 'off'])(
    'never starts a background service when autostart is %s',
    (value) => {
      expect(autostartAllowed({ TOKEN_OPTIMIZER_PROXY_AUTOSTART: value })).toBe(
        false
      );
    }
  );

  it('starts one by default, and for any other value', () => {
    expect(autostartAllowed({})).toBe(true);
    expect(autostartAllowed({ TOKEN_OPTIMIZER_PROXY_AUTOSTART: '1' })).toBe(
      true
    );
  });

  it('rejects a control port that is not a port', () => {
    expect(() =>
      controlPort({ TOKEN_OPTIMIZER_PROXY_CONTROL_PORT: 'http://x' })
    ).toThrow(/must be a port number/);
    expect(controlPort({})).toBe(45710);
  });
});
