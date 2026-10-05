/**
 * THE GUIDANCE HAS TO REACH THE WIRE, AND THE FIRST ATTEMPT DID NOT.
 *
 * Wired inside the compression strategy -- beside the knowledge block, which is
 * where it belongs by subject and is the one place it cannot work -- the block
 * appeared on no request at all: that injection sits downstream of an early
 * return taken by every request with nothing compressible, which includes the
 * first request of every session. The flag was on, the unit tests passed, and
 * the system prompt went out byte-identical to the flag being off.
 *
 * So the test that matters is not "does batchGuidance() return a string". It is
 * "does the body the upstream received contain it". These drive a real proxy
 * against a stub upstream and read what arrived.
 */
import { afterAll, afterEach, describe, expect, it } from '@jest/globals';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProxy } from '../../../src/proxy/server.js';
import { BATCH_GUIDANCE_ENV } from '../../../src/compress/batch-guidance.js';

const servers: Server[] = [];

/**
 * A root with no findings, so the knowledge block has nothing to inject.
 *
 * Against this repository's own root the proxy appends its wiki findings to
 * `system`, which is correct behaviour and would swamp the thing under test:
 * the first version of this file read that block as the guidance arriving while
 * the flag was off.
 */
const EMPTY_PROJECT = mkdtempSync(join(tmpdir(), 'batch-guidance-'));

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  delete process.env[BATCH_GUIDANCE_ENV];
});

afterAll(() => {
  rmSync(EMPTY_PROJECT, { recursive: true, force: true });
});

/** A stub upstream that records every body it is handed. */
async function upstream(): Promise<{ url: string; bodies: string[] }> {
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }));
    });
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, bodies });
    });
  });
}

const payload = (turn: number) => ({
  model: 'claude-sonnet-4-5-20250929',
  system: 'You are a coding assistant.',
  messages: [
    { role: 'user', content: [{ type: 'text', text: `turn ${turn}` }] },
  ],
});

const systemOf = (body: string): unknown =>
  (JSON.parse(body) as { system?: unknown }).system;

async function proxyTo(
  url: string,
  onSummary?: (summary: { compressed: boolean }) => void
): Promise<number> {
  const proxy = await startProxy({
    upstream: url,
    projectRoot: EMPTY_PROJECT,
    onSummary,
  });
  servers.push(proxy.server);
  return proxy.port;
}

async function send(port: number, path: string, turn: number): Promise<void> {
  await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload(turn)),
  });
}

describe('the batching guidance on the wire', () => {
  it('is absent when the operator has not asked for it', async () => {
    const provider = await upstream();
    const port = await proxyTo(provider.url);
    await send(port, '/v1/messages', 1);
    expect(provider.bodies).toHaveLength(1);
    expect(String(systemOf(provider.bodies[0]))).toBe(
      'You are a coding assistant.'
    );
  });

  it('reaches the upstream on the very first request when enabled', async () => {
    process.env[BATCH_GUIDANCE_ENV] = '1';
    const provider = await upstream();
    const port = await proxyTo(provider.url);
    await send(port, '/v1/messages', 1);
    // THE FIRST REQUEST, specifically. An instruction that arrives later moves
    // the cached prefix mid-session and charges a write on everything behind
    // it, which costs more than it can save.
    expect(provider.bodies).toHaveLength(1);
    expect(String(systemOf(provider.bodies[0]))).toContain(
      'multiple tool calls in one message'
    );
    expect(String(systemOf(provider.bodies[0]))).toContain(
      'You are a coding assistant.'
    );
  });

  it('is byte-identical turn to turn, so the prefix holds', async () => {
    process.env[BATCH_GUIDANCE_ENV] = '1';
    const provider = await upstream();
    const port = await proxyTo(provider.url);
    await send(port, '/v1/messages', 1);
    await send(port, '/v1/messages', 2);
    expect(provider.bodies).toHaveLength(2);
    // The cost of injection is a re-serialisation paid ONCE. If the block moved
    // or re-rendered between turns it would re-price the prefix every turn
    // instead, which is the failure this pins.
    expect(systemOf(provider.bodies[1])).toEqual(systemOf(provider.bodies[0]));
  });

  it('leaves a token count alone, because that answer is the client own', async () => {
    process.env[BATCH_GUIDANCE_ENV] = '1';
    const provider = await upstream();
    const port = await proxyTo(provider.url);
    await send(port, '/v1/messages/count_tokens', 1);
    expect(provider.bodies).toHaveLength(1);
    expect(String(systemOf(provider.bodies[0]))).toBe(
      'You are a coding assistant.'
    );
  });

  it('is off for every value an operator would use to mean off', async () => {
    const provider = await upstream();
    for (const value of ['', '0', 'false', 'off', 'OFF', ' false ']) {
      process.env[BATCH_GUIDANCE_ENV] = value;
      const port = await proxyTo(provider.url);
      const before = provider.bodies.length;
      await send(port, '/v1/messages', 1);
      expect(String(systemOf(provider.bodies[before]))).toBe(
        'You are a coding assistant.'
      );
    }
  });
  it('survives compression, which runs on the body after the injection', async () => {
    process.env[BATCH_GUIDANCE_ENV] = '1';
    const provider = await upstream();
    // A POSITIVE CONTROL, because a transform that did nothing would pass this
    // test for the wrong reason. `compressed` has to be true on the request
    // below, or "the block survived compression" means "no compression ran".
    const compressed: boolean[] = [];
    const port = await proxyTo(provider.url, (summary) =>
      compressed.push(summary.compressed)
    );
    // THE EMPTY PAYLOADS ABOVE COMPRESS TO NOTHING, so they cannot tell
    // whether the block survives the transform that runs right after the
    // injection. This one is large and repetitive enough that the compressor
    // has something to do, and the assertion is that it did not do it to us.
    // A LOG BLOCK, which is what the compressor is for, and A BREAKPOINT ON
    // BOTH TURNS. Three earlier versions of this test read `compressed: false`
    // with the reason "compression did not pay": sixty one-line messages have
    // no redundancy to find, and -- the one that took longest -- a first turn
    // with no `cache_control` records no anchor, so the second turn has no
    // previous breakpoint and the frontier finds nothing compressible after
    // it. With both fixed, 17,497 bytes become 2,817.
    const logBlock = (rows: number) =>
      Array.from(
        { length: rows },
        (_, i) =>
          `2026-10-05T10:${String(i % 60).padStart(2, '0')}:00Z INFO handler=src/server.ts request=${i} status=200 duration=${i * 3}ms user=alice@example.com region=us-east-1 cache=hit bytes=4096 trace=abcdef0123456789`
      ).join(String.fromCharCode(10));
    const ephemeral = { cache_control: { type: 'ephemeral' } };
    const turn = (rows: number | null) => ({
      model: 'claude-sonnet-4-5-20250929',
      system: 'You are a coding assistant.',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'read the log',
              ...(rows === null ? ephemeral : {}),
            },
          ],
        },
        ...(rows === null
          ? []
          : [
              {
                role: 'user',
                content: [{ type: 'text', text: logBlock(rows), ...ephemeral }],
              },
            ]),
      ],
    });
    for (const rows of [null, 200]) {
      await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(turn(rows)),
      });
    }
    expect(provider.bodies).toHaveLength(2);
    expect(compressed[1]).toBe(true);
    expect(String(systemOf(provider.bodies[1]))).toContain(
      'multiple tool calls in one message'
    );
  });

  it('does not cost the outgoing prefix more than once', async () => {
    // THE WHOLE CLAIM FOR PUTTING IT HERE. Injection re-serialises the body,
    // so our bytes stop matching the client's -- that is accepted, and paid
    // once. What must NOT happen is our own stream losing its prefix turn to
    // turn, because then the write is charged again on every request and the
    // block costs far more than the residency it was priced at.
    const prefixLength = (a: string, b: string): number => {
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
      return i;
    };
    const growing = (turn: number) => ({
      model: 'claude-sonnet-4-5-20250929',
      system: 'You are a coding assistant.',
      messages: Array.from({ length: turn }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: [{ type: 'text', text: `step ${i} of the conversation` }],
      })),
    });
    const run = async (): Promise<number> => {
      const provider = await upstream();
      const port = await proxyTo(provider.url);
      for (const turn of [4, 5]) {
        await fetch(`http://127.0.0.1:${port}/v1/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(growing(turn)),
        });
      }
      expect(provider.bodies).toHaveLength(2);
      return prefixLength(provider.bodies[0], provider.bodies[1]);
    };
    delete process.env[BATCH_GUIDANCE_ENV];
    const without = await run();
    process.env[BATCH_GUIDANCE_ENV] = '1';
    const withBlock = await run();
    // The shared prefix grows by the block rather than shrinking: the block
    // sits ahead of the messages, so everything stable stays stable.
    expect(withBlock).toBeGreaterThan(without);
  });
});
