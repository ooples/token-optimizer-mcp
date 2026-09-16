import { afterEach, expect, test } from '@jest/globals';
import { createServer, request } from 'node:http';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { compressBody, startProxy } from '../../../src/proxy/server.js';
import { scanUsage, tapUsage } from '../../../src/proxy/accounting.js';
import type { RequestUsage } from '../../../src/proxy/accounting.js';

const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
});
const log = Array.from({ length: 200 }, (_, i) =>
  i === 87
    ? '2026-09-15T12:00:00Z ERROR request=req-87 reason=pool_exhausted'
    : '2026-09-15T12:00:00Z INFO heartbeat healthy'
).join('\n');
const spill = () => '/tmp/recoverable-log.txt';
const tool = {
  type: 'custom_tool_call_output',
  call_id: 'call-1',
  output: log,
};

test('Responses output compression preserves protocol items and the error needle', () => {
  delete process.env.TOKEN_OPTIMIZER_PROXY_NULL;
  const untouched = [
    {
      type: 'additional_tools',
      tools: [{ name: 'shell', description: 'Do not rewrite me' }],
    },
    { type: 'reasoning', encrypted_content: 'signed encrypted bytes' },
    {
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: log }],
    },
    {
      type: 'custom_tool_call',
      call_id: 'call-1',
      name: 'shell',
      input: 'cat service.log',
    },
  ];
  const original = {
    model: 'test',
    instructions: 'fixed instructions',
    input: [...untouched, tool],
  };
  const result = compressBody(Buffer.from(JSON.stringify(original)), spill);
  expect(result.summary.compressed).toBe(true);
  const decoded = JSON.parse(result.body.toString());
  expect(decoded.instructions).toBe(original.instructions);
  expect(decoded.input.slice(0, 4)).toEqual(untouched);
  expect(decoded.input[4].call_id).toBe('call-1');
  expect(decoded.input[4].output).toContain(
    'request=req-87 reason=pool_exhausted'
  );
  expect(result.body.length).toBeLessThan(
    Buffer.byteLength(JSON.stringify(original))
  );
});

test('appending a different user query does not rewrite previously compressed output', () => {
  delete process.env.TOKEN_OPTIMIZER_PROXY_NULL;
  const input = [tool];
  const first = JSON.parse(
    compressBody(Buffer.from(JSON.stringify({ input })), spill).body.toString()
  );
  const later = JSON.parse(
    compressBody(
      Buffer.from(
        JSON.stringify({
          input: [
            ...input,
            { role: 'user', content: 'Now find a different event' },
          ],
        })
      ),
      spill
    ).body.toString()
  );
  expect(later.input[0]).toEqual(first.input[0]);
});

test('function output multimodal content preserves images and unknown metadata', () => {
  delete process.env.TOKEN_OPTIMIZER_PROXY_NULL;
  const image = { type: 'input_image', image_url: 'data:image/png;base64,abc' };
  const original = {
    input: [
      {
        type: 'function_call_output',
        call_id: 'f1',
        output: [{ type: 'input_text', text: log, extra: 1 }, image],
      },
    ],
  };
  const result = JSON.parse(
    compressBody(Buffer.from(JSON.stringify(original)), spill).body.toString()
  );
  expect(result.input[0].output[0].text).toContain('request=req-87');
  expect(result.input[0].output[0].extra).toBe(1);
  expect(result.input[0].output[1]).toEqual(image);
});

test('null mode forwards Responses bytes exactly', () => {
  process.env.TOKEN_OPTIMIZER_PROXY_NULL = '1';
  const body = Buffer.from(JSON.stringify({ input: [tool] }, null, 2));
  expect(compressBody(body, spill).body).toBe(body);
});

test('Responses cache reads remain a subset of input, distinct from Anthropic classes', () => {
  const usage: RequestUsage = {};
  scanUsage(
    '{"usage":{"input_tokens":100,"input_tokens_details":{"cached_tokens":80},"output_tokens":5}}',
    usage
  );
  expect(usage).toEqual({
    input_tokens: 100,
    cached_input_tokens: 80,
    output_tokens: 5,
  });
  expect(usage.cache_read_input_tokens).toBeUndefined();
});

test('zstd-compressed Responses usage is decoded without consuming the response', async () => {
  const bytes = zstdCompressSync(
    Buffer.from(
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":100,"input_tokens_details":{"cached_tokens":80},"output_tokens":5}}}\n\n'
    )
  );
  const stream = Readable.from([bytes.subarray(0, 8), bytes.subarray(8)]);
  const chunks: Buffer[] = [];
  const seen = new Promise<RequestUsage>((resolve) =>
    tapUsage(stream, resolve, 'zstd')
  );
  stream.on('data', (chunk) => chunks.push(chunk));
  expect(await seen).toEqual({
    input_tokens: 100,
    cached_input_tokens: 80,
    output_tokens: 5,
  });
  expect(Buffer.concat(chunks)).toEqual(bytes);
});

test('Codex disconnect after terminal SSE settles the ledger and closes upstream', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'responses-proxy-'));
  process.env.TOKEN_OPTIMIZER_PROXY_NULL = '1';
  process.env.TOKEN_OPTIMIZER_PROXY_ACCOUNTING = join(dir, 'ledger.jsonl');
  process.env.TOKEN_OPTIMIZER_PROXY_CAPTURE = dir;
  let upstreamClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    upstreamClosed = resolve;
  });
  const upstream = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":100,"input_tokens_details":{"cached_tokens":80},"output_tokens":5}}}\n\n'
    );
    res.once('close', upstreamClosed);
    // Deliberately stay open, as observed against the live Codex endpoint.
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, '127.0.0.1', resolve)
  );
  const address = upstream.address();
  if (!address || typeof address === 'string') throw Error('missing address');
  const proxy = await startProxy({
    upstream: `http://127.0.0.1:${address.port}`,
  });
  const path = '/backend-api/codex/responses';
  try {
    await new Promise<void>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: proxy.port, path, method: 'POST' },
        (res) => {
          res.once('data', () => {
            res.destroy();
            resolve();
          });
        }
      );
      req.on('error', reject);
      req.end('{"input":[]}');
    });
    await closed;
    // Ledger append is synchronous; capture uses the serialized async queue.
    let ledger = '';
    for (let i = 0; i < 50; i++) {
      try {
        ledger = await readFile(join(dir, 'ledger.jsonl'), 'utf8');
        if (ledger) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(JSON.parse(ledger).usage).toEqual({
      input_tokens: 100,
      cached_input_tokens: 80,
      output_tokens: 5,
    });
    const capture = JSON.parse(
      (await readFile(join(dir, 'requests.jsonl'), 'utf8')).trim()
    );
    expect(capture.path).toBe(path);
    expect(capture.body).toBe('{"input":[]}');
  } finally {
    proxy.server.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([
      new Promise<void>((r) => proxy.server.close(() => r())),
      new Promise<void>((r) => upstream.close(() => r())),
    ]);
    await rm(dir, { recursive: true, force: true });
  }
});
