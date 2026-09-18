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
  runSupervisor,
  supervisorHealth,
  supervisorStateFile,
} from '../../src/proxy/supervisor.js';

let upstream: Server;
let upstreamUrl: string;
let seen: string[];
let supervisor: { server: Server; close: () => Promise<void> } | null;
let home: string;
let env: NodeJS.ProcessEnv;

/** A free port, released before it is handed out -- good enough for a test's own control port. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function get(url: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(path, url);
    const req = request(
      { host: target.hostname, port: target.port, path: target.pathname, method: 'POST' },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
        );
      }
    );
    req.on('error', reject);
    req.end('{}');
  });
}

beforeEach(async () => {
  seen = [];
  upstream = createServer((req, res) => {
    seen.push(req.url || '');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
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
    await new Promise<void>((resolve) => second.listen(0, '127.0.0.1', resolve));
    const secondUrl = `http://127.0.0.1:${(second.address() as { port: number }).port}`;
    try {
      supervisor = await runSupervisor(env);
      const a = await ensureRoute(upstreamUrl, env);
      const b = await ensureRoute(secondUrl, env);
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(a).not.toBe(b);
      const state = readSupervisorState(env);
      expect(state?.routes.map((r) => r.upstream).sort()).toEqual([upstreamUrl, secondUrl].sort());
    } finally {
      await new Promise<void>((resolve) => second.close(() => resolve()));
    }
  }, 30_000);

  it('records what it serves where the doctor can read it', async () => {
    supervisor = await runSupervisor(env);
    await ensureRoute(upstreamUrl, env);
    const state = readSupervisorState(env);
    expect(state?.schema).toBe(1);
    expect(state?.pid).toBe(process.pid);
    expect(state?.controlUrl).toBe(`http://127.0.0.1:${controlPort(env)}`);
    expect(existsSync(supervisorStateFile(env))).toBe(true);
    expect(JSON.parse(readFileSync(supervisorStateFile(env), 'utf8')).routes).toHaveLength(1);
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

  it.each(['0', 'false', 'no', 'off'])('never starts a background service when autostart is %s', (value) => {
    expect(autostartAllowed({ TOKEN_OPTIMIZER_PROXY_AUTOSTART: value })).toBe(false);
  });

  it('starts one by default, and for any other value', () => {
    expect(autostartAllowed({})).toBe(true);
    expect(autostartAllowed({ TOKEN_OPTIMIZER_PROXY_AUTOSTART: '1' })).toBe(true);
  });

  it('rejects a control port that is not a port', () => {
    expect(() => controlPort({ TOKEN_OPTIMIZER_PROXY_CONTROL_PORT: 'http://x' })).toThrow(
      /must be a port number/
    );
    expect(controlPort({})).toBe(45710);
  });
});
