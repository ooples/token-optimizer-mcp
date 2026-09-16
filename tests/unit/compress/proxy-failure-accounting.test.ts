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
