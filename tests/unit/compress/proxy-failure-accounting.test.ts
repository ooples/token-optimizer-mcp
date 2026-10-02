import { test, expect } from '@jest/globals';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProxy } from '../../../src/proxy/server.js';

test('connection resets, HTTP failures and success each retain exactly one ledger entry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'proxy-failure-ledger-'));
  const previous = process.env.TOKEN_OPTIMIZER_PROXY_ACCOUNTING;
  const ledger = join(directory, 'ledger.jsonl');
  process.env.TOKEN_OPTIMIZER_PROXY_ACCOUNTING = ledger;
  const upstream = createServer((req, res) => {
    if (req.url?.endsWith('/reset')) {
      req.socket.destroy();
      return;
    }
    res.writeHead(req.url?.endsWith('/unavailable') ? 503 : 200, {
      'content-type': 'application/json',
    });
    res.end(
      req.url?.endsWith('/unavailable')
        ? '{"error":"unavailable"}'
        : '{"usage":{"input_tokens":100,"output_tokens":2,"cached_input_tokens":0}}'
    );
  });
  let proxy: Awaited<ReturnType<typeof startProxy>> | undefined;
  const close = (server: Server) =>
    new Promise<void>((resolve) => server.close(() => resolve()));
  try {
    await new Promise<void>((resolve) =>
      upstream.listen(0, '127.0.0.1', resolve)
    );
    const address = upstream.address();
    if (!address || typeof address === 'string')
      throw Error('No upstream port');
    proxy = await startProxy({
      port: 0,
      upstream: `http://127.0.0.1:${address.port}`,
    });
    const proxyAddress = proxy.server.address();
    if (!proxyAddress || typeof proxyAddress === 'string')
      throw Error('No proxy port');
    for (const [path, status] of [
      ['reset', 502],
      ['unavailable', 503],
      ['ok', 200],
    ] as const) {
      const response = await fetch(
        `http://127.0.0.1:${proxyAddress.port}/${path}`,
        { method: 'POST', body: '{}' }
      );
      expect(response.status).toBe(status);
      await response.text();
    }
    // THE LEDGER IS OWED LINES AT THIS POINT, not missing them. A token count
    // runs beside the upstream round trip, and a loopback upstream answers
    // faster than the count lands, so the two requests with a body have not
    // been written yet -- which is why this read used to find only the
    // ECONNRESET row, the one request with nothing to count.
    await proxy.ledgerSettled();
    const records = (await readFile(ledger, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records).toHaveLength(3);
    expect(records.map((r) => r.status)).toEqual([0, 503, 200]);
    expect(records[0].transportError).toBe('ECONNRESET');
    expect(records[0].usage).toEqual({});
    expect(records[1].usage).toEqual({});
    expect(records[2].usage.input_tokens).toBe(100);
    for (const record of records) {
      expect(record.timing.transformMs).toBeGreaterThanOrEqual(0);
      expect(record.timing.upstreamMs).toBeGreaterThanOrEqual(0);
    }
    expect(records[0].timing.upstreamHeadersMs).toBeUndefined();
    expect(records[2].timing.upstreamMs).toBeGreaterThanOrEqual(
      records[2].timing.upstreamHeadersMs
    );
  } finally {
    if (proxy) await close(proxy.server);
    await close(upstream);
    if (previous === undefined)
      delete process.env.TOKEN_OPTIMIZER_PROXY_ACCOUNTING;
    else process.env.TOKEN_OPTIMIZER_PROXY_ACCOUNTING = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test('a clean stop writes the lines it still owed, with no help from the caller', async () => {
  /*
   * WHAT A CLEAN STOP USED TO COST. The token count for a request runs beside
   * the upstream round trip, so a request whose upstream answers first leaves
   * the ledger line owed rather than written. Stopping the server fired the
   * counting thread's shutdown straight away and flushed the rollup window
   * immediately after, so a clean stop dropped the tail of both -- and a short
   * ledger is indistinguishable from a quiet period to everything that reads
   * it. Nothing below asks the proxy to settle first: the stop has to do it.
   *
   * The count itself is NOT asserted here. Jest runs against `src`, where the
   * counting thread's sibling file is still TypeScript, so every count in this
   * environment comes back `worker-failed`; `dist` carries the `.js` the
   * shipped proxy loads. The line's existence is the property this test is
   * about, and it does not depend on the thread succeeding.
   */
  const directory = await mkdtemp(join(tmpdir(), 'proxy-stop-ledger-'));
  const previous = process.env.TOKEN_OPTIMIZER_PROXY_ACCOUNTING;
  const ledger = join(directory, 'ledger.jsonl');
  process.env.TOKEN_OPTIMIZER_PROXY_ACCOUNTING = ledger;
  const upstream = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"usage":{"input_tokens":100,"output_tokens":2}}');
  });
  let proxy: Awaited<ReturnType<typeof startProxy>> | undefined;
  const close = (server: Server) =>
    new Promise<void>((resolve) => server.close(() => resolve()));
  try {
    await new Promise<void>((resolve) =>
      upstream.listen(0, '127.0.0.1', resolve)
    );
    const address = upstream.address();
    if (!address || typeof address === 'string') throw Error('No upstream port');
    proxy = await startProxy({
      port: 0,
      upstream: `http://127.0.0.1:${address.port}`,
    });
    const proxyAddress = proxy.server.address();
    if (!proxyAddress || typeof proxyAddress === 'string')
      throw Error('No proxy port');
    const body = JSON.stringify({
      model: 'claude-sonnet-5',
      messages: [{ role: 'user', content: 'measure me' }],
    });
    for (const path of ['one', 'two', 'three']) {
      const response = await fetch(
        `http://127.0.0.1:${proxyAddress.port}/${path}`,
        { method: 'POST', body }
      );
      expect(response.status).toBe(200);
      await response.text();
    }

    // HOW MANY LINES ARE STILL OWED HERE IS NOT ASSERTED, deliberately. It is
    // whatever the race happens to leave -- the earlier requests' counts settle
    // while the later ones are issued -- and pinning a number would make this
    // test pass or fail on scheduling rather than on the behaviour below. That
    // the stop is what completes the ledger was verified the only way it can
    // be: by reverting the drain and watching this test go red.

    // STOPPED WITHOUT WAITING. No `ledgerSettled` from here.
    await close(proxy.server);
    proxy = undefined;

    const lines = await waitForLines(ledger, 3);
    expect(lines).toHaveLength(3);
    expect(lines.map((r) => r.path)).toEqual(['/one', '/two', '/three']);
  } finally {
    if (proxy) await close(proxy.server);
    await close(upstream);
    if (previous === undefined)
      delete process.env.TOKEN_OPTIMIZER_PROXY_ACCOUNTING;
    else process.env.TOKEN_OPTIMIZER_PROXY_ACCOUNTING = previous;
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

/**
 * The ledger once it holds `want` lines, or whatever it holds when time is up.
 *
 * A BOUNDED POLL, NOT A FIXED SLEEP. The stop drains asynchronously, so there
 * is nothing to await from outside it; a sleep long enough to be reliable on a
 * loaded box is time this suite pays on every green run, and one short enough
 * to be cheap is the flake. Returning what it found on timeout lets the
 * assertion report the shortfall rather than a timeout.
 *
 * A MISSING FILE IS ZERO LINES, NOT AN ERROR. The ledger is created by its
 * first append, and on a Linux runner no append had happened yet when this was
 * first called -- so the poll died on ENOENT before it could poll, and reported
 * a missing file where the fact under test is how many lines arrive. The
 * distinction is kept: nothing here creates the file, so a ledger that is never
 * written still fails, on the line count, with the count it actually had.
 */
async function waitForLines(
  ledger: string,
  want: number
): Promise<Record<string, unknown>[]> {
  const deadline = Date.now() + 5000;
  let lines: Record<string, unknown>[] = [];
  for (;;) {
    const text = await readFile(ledger, 'utf8').then(
      (body) => body.trim(),
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      }
    );
    lines =
      text === ''
        ? []
        : text.split(String.fromCharCode(10)).map((line) => JSON.parse(line));
    if (lines.length >= want || Date.now() > deadline) return lines;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
