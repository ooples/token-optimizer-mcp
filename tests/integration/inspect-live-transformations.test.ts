/**
 * End to end: a request goes through the proxy, and `inspect` can see what it
 * did to it.
 *
 * WHY THIS IS NOT COVERED BY THE UNIT TESTS. Those drive `main()` with an
 * injected `live`, which proves the rendering and the exit statuses and nothing
 * at all about the four joints between here and there: the ring being filled on
 * the request path, the supervisor holding one ring per listener, the control
 * endpoint serialising them, and the client reading them back. Every one of
 * those is a place where a window could come back empty while every unit test
 * stayed green.
 *
 * NOTHING HERE IS CONFIGURED. No ledger path, no capture directory, no flag --
 * which is the claim being tested as much as any assertion below: the records
 * exist because the proxy served a request, not because someone opted in.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createServer, request, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureRoute,
  runSupervisor,
  supervisorTransformations,
} from '../../src/proxy/supervisor.js';
import { main } from '../../src/inspect/cli.js';

let upstream: Server;
let upstreamUrl: string;
let home: string;
let env: NodeJS.ProcessEnv;
let supervisor: Awaited<ReturnType<typeof runSupervisor>> | null = null;

function freePort(): Promise<number> {
  const probe = createServer();
  return new Promise((resolve) =>
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    })
  );
}

/** One POST through the proxy, big enough that the compressor has an opinion. */
function send(url: string, body: string): Promise<number> {
  const target = new URL('/v1/messages', url);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: target.hostname,
        port: Number(target.port),
        path: target.pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      },
      (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve(res.statusCode ?? 0));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

function conversation(turns: number): string {
  const messages = [];
  for (let i = 0; i < turns; i++) {
    messages.push({ role: 'user', content: `please read ${i} ${'x'.repeat(400)}` });
    messages.push({ role: 'assistant', content: `reading ${i} ${'y'.repeat(400)}` });
  }
  return JSON.stringify({ model: 'claude-opus-4', messages, stream: false });
}

beforeEach(async () => {
  upstream = createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      // The usage block is what `tapUsage` is reading out of the response, and
      // it is the half of every row that the proxy cannot compute itself.
      res.end(
        JSON.stringify({
          usage: {
            input_tokens: 2413,
            output_tokens: 806,
            cache_read_input_tokens: 115002,
          },
        })
      );
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  home = mkdtempSync(join(tmpdir(), 'inspect-live-home-'));
  env = {
    ...process.env,
    TOKEN_OPTIMIZER_HOME: home,
    TOKEN_OPTIMIZER_PROXY_CONTROL_PORT: String(await freePort()),
    TOKEN_OPTIMIZER_MODE: 'assist',
    // THE POINT OF THE TEST: no ledger, no capture, nothing opted into.
    TOKEN_OPTIMIZER_PROXY_ACCOUNTING: '',
    TOKEN_OPTIMIZER_PROXY_CAPTURE: '',
  };
  supervisor = null;
});

afterEach(async () => {
  if (supervisor) await supervisor.close();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  rmSync(home, { recursive: true, force: true });
});

describe('inspecting a live proxy', () => {
  it('records what it did to a request nobody asked it to record', async () => {
    supervisor = await runSupervisor(env);
    const url = await ensureRoute(upstreamUrl, env);
    if (url === null) throw new Error('no route');
    expect(await send(url, conversation(12))).toBe(200);

    const windows = await supervisorTransformations(env);
    if (windows === null) throw new Error('no supervisor answered');
    expect(windows).toHaveLength(1);
    const [only] = windows;
    expect(only.port).toBe(Number(new URL(url).port));
    expect(only.upstream).toBe(upstreamUrl);
    expect(only.dropped).toBe(0);
    expect(only.records).toHaveLength(1);

    const [record] = only.records;
    expect(record.path).toBe('/v1/messages');
    expect(record.status).toBe(200);
    expect(record.beforeBytes).toBeGreaterThan(1000);
    expect(record.afterBytes).toBeGreaterThan(0);
    // Read off the RESPONSE, which is the half the proxy cannot compute: a
    // regression that stopped attaching the tap would leave this empty while
    // every byte count above stayed correct.
    expect(record.usage.input_tokens).toBe(2413);
    expect(record.usage.cache_read_input_tokens).toBe(115002);
    expect(record.usage.output_tokens).toBe(806);
    expect(record.timing?.transformMs).toBeGreaterThanOrEqual(0);
  }, 30_000);

  it('keeps the newest requests when asked for fewer than it holds', async () => {
    supervisor = await runSupervisor(env);
    const url = await ensureRoute(upstreamUrl, env);
    if (url === null) throw new Error('no route');
    for (let i = 0; i < 4; i++) expect(await send(url, conversation(4 + i))).toBe(200);

    const all = await supervisorTransformations(env);
    const two = await supervisorTransformations(env, { last: 2 });
    if (all === null || two === null) throw new Error('no supervisor answered');
    expect(all[0].records).toHaveLength(4);
    expect(two[0].records).toHaveLength(2);
    // `held` reports the whole window even when the caller asked for a slice,
    // so a reader can tell "there are only two" from "you asked for two".
    expect(two[0].held).toBe(4);
    expect(two[0].records.map((r) => r.beforeBytes)).toEqual(
      all[0].records.slice(2).map((r) => r.beforeBytes)
    );
  }, 30_000);

  it('filters to one listener by port, and finds nothing for another', async () => {
    supervisor = await runSupervisor(env);
    const url = await ensureRoute(upstreamUrl, env);
    if (url === null) throw new Error('no route');
    expect(await send(url, conversation(6))).toBe(200);
    const port = Number(new URL(url).port);

    const mine = await supervisorTransformations(env, { port });
    expect(mine).toHaveLength(1);
    // The control for the filter: a port nothing is listening on returns an
    // empty list rather than everything, which is what a filter applied to the
    // wrong side of the comparison would do.
    const other = await supervisorTransformations(env, { port: port + 1 });
    expect(other).toEqual([]);
  }, 30_000);

  it('renders the real window through the command the operator runs', async () => {
    supervisor = await runSupervisor(env);
    const url = await ensureRoute(upstreamUrl, env);
    if (url === null) throw new Error('no route');
    expect(await send(url, conversation(10))).toBe(200);

    const out: string[] = [];
    const code = await main([], {
      write: (text) => out.push(text),
      live: (options) => supervisorTransformations(env, options),
    });
    const text = out.join('');
    expect(code).toBe(0);
    expect(text).toContain(`proxy on port ${new URL(url).port}`);
    expect(text).toContain(upstreamUrl);
    expect(text).toContain('/v1/messages');
    expect(text).toContain('115,002');
    expect(text).toContain('1 request,');
  }, 30_000);
});
