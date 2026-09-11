import { describe, it, expect, afterEach } from '@jest/globals';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  scanUsage,
  tapUsage,
  accountingPath,
  appendRecord,
  type RequestUsage,
} from '../../../src/proxy/accounting.js';

/**
 * The token ledger, which exists to explain a cost the benchmark could not.
 *
 * The proxy's first end-to-end run cost $0.58 against control's $0.43 while
 * spending one extra turn in thirty-five. Turns barely moved, so the money went
 * somewhere per-turn, and only the provider knows whether a token was billed as
 * a 0.1x cache read, a 1.25x cache write, or a 1.0x input. These tests pin the
 * reading of that, because a measurement instrument that is wrong produces
 * confident wrong conclusions -- the most expensive kind.
 */

const LEDGERS: string[] = [];
const ledger = (): string => {
  const path = join(
    tmpdir(),
    `token-ledger-${Math.random().toString(36).slice(2)}.jsonl`
  );
  LEDGERS.push(path);
  return path;
};

afterEach(() => {
  for (const path of LEDGERS.splice(0)) {
    if (existsSync(path)) rmSync(path, { force: true });
  }
});

describe('reading usage out of a response', () => {
  it('reads every token class from a non-streaming body', () => {
    const usage: RequestUsage = {};
    scanUsage(
      '{"usage":{"input_tokens":11,"output_tokens":22,' +
        '"cache_creation_input_tokens":33,"cache_read_input_tokens":44}}',
      usage
    );

    expect(usage).toEqual({
      input_tokens: 11,
      output_tokens: 22,
      cache_creation_input_tokens: 33,
      cache_read_input_tokens: 44,
    });
  });

  it('does not read a cache field as a plain input field', () => {
    // `cache_read_input_tokens` CONTAINS `input_tokens`. An unanchored pattern
    // reads 44 as the input count, which would make a request that was almost
    // entirely cheap cache reads look like an expensive one -- inverting the
    // exact conclusion this ledger is being built to reach.
    const usage: RequestUsage = {};
    scanUsage('{"cache_read_input_tokens":44}', usage);

    expect(usage.cache_read_input_tokens).toBe(44);
    expect(usage.input_tokens).toBeUndefined();
  });

  it('keeps the last output count, because a stream reports it cumulatively', () => {
    // message_delta repeats output_tokens as it grows. An earlier occurrence is
    // a partial count, so first-wins would under-report every streamed reply.
    const usage: RequestUsage = {};
    scanUsage(
      'event: message_delta\ndata: {"usage":{"output_tokens":5}}\n\n' +
        'event: message_delta\ndata: {"usage":{"output_tokens":9}}\n\n' +
        'event: message_delta\ndata: {"usage":{"output_tokens":31}}\n\n',
      usage
    );

    expect(usage.output_tokens).toBe(31);
  });
});

describe('watching a live response stream', () => {
  const collect = async (
    chunks: readonly string[]
  ): Promise<{ usage: RequestUsage; delivered: string }> => {
    const source = Readable.from(chunks.map((c) => Buffer.from(c, 'utf8')));
    const seen: RequestUsage = {};
    let resolveDone: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    tapUsage(source, (usage) => {
      Object.assign(seen, usage);
      resolveDone();
    });

    // Stand in for the `pipe` the proxy does: the tap must not have eaten it.
    let delivered = '';
    source.on('data', (c: Buffer) => (delivered += c.toString('utf8')));
    await done;
    return { usage: seen, delivered };
  };

  it('delivers every byte it watched', async () => {
    // THE PROPERTY THE PROXY RESTS ON. This is a byte-faithful proxy and an SSE
    // stream must arrive as produced; an instrument that consumed a chunk to
    // measure it would break the response it was measuring.
    const chunks = [
      'event: message_start\ndata: {"usage":{"input_tokens":7,',
      '"cache_read_input_tokens":100}}\n\n',
      'event: message_delta\ndata: {"usage":{"output_tokens":12}}\n\n',
    ];

    const { delivered } = await collect(chunks);

    expect(delivered).toBe(chunks.join(''));
  });

  it('reads a usage object split across two chunks', async () => {
    // The carry-over exists for exactly this: `input_tokens` arrives in one
    // chunk and its value in the next, and without the overlap neither chunk
    // contains a complete match.
    const { usage } = await collect([
      'event: message_start\ndata: {"usage":{"input_tokens":7,',
      '"cache_read_input_tokens":100}}\n\n',
      'event: message_delta\ndata: {"usage":{"output_tokens":12}}\n\n',
    ]);

    expect(usage.input_tokens).toBe(7);
    expect(usage.cache_read_input_tokens).toBe(100);
    expect(usage.output_tokens).toBe(12);
  });

  it('still reports what a failed stream had already billed', async () => {
    const source = new Readable({ read() {} });
    let resolveDone: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    const seen: RequestUsage = {};
    tapUsage(source, (usage) => {
      Object.assign(seen, usage);
      resolveDone();
    });
    source.on('error', () => {});

    source.push(Buffer.from('{"usage":{"input_tokens":5}}', 'utf8'));
    source.destroy(new Error('upstream went away'));
    await done;

    expect(seen.input_tokens).toBe(5);
  });
});

describe('the ledger itself', () => {
  it('is off unless a path is named', () => {
    expect(accountingPath({})).toBeNull();
    expect(
      accountingPath({ TOKEN_OPTIMIZER_PROXY_ACCOUNTING: '   ' })
    ).toBeNull();
    expect(
      accountingPath({ TOKEN_OPTIMIZER_PROXY_ACCOUNTING: '/tmp/ledger.jsonl' })
    ).toBe('/tmp/ledger.jsonl');
  });

  it('writes one joinable line per request', () => {
    const path = ledger();
    appendRecord(path, {
      ts: '2026-09-11T00:00:00.000Z',
      path: '/v1/messages',
      status: 200,
      compressed: true,
      beforeBytes: 4000,
      afterBytes: 1200,
      usage: { input_tokens: 10, cache_read_input_tokens: 900 },
    });

    const [line] = readFileSync(path, 'utf8').trim().split('\n');
    const record = JSON.parse(line) as Record<string, unknown>;

    // Both halves on one line is the whole point: what compression did, beside
    // what it was billed as, for the same turn.
    expect(record.beforeBytes).toBe(4000);
    expect(record.afterBytes).toBe(1200);
    expect(record.usage).toEqual({
      input_tokens: 10,
      cache_read_input_tokens: 900,
    });
  });

  it('never throws when the ledger cannot be written', () => {
    // Instrumentation must not cost the agent its response.
    expect(() =>
      appendRecord(join(tmpdir(), 'no-such-dir-here', 'x', 'ledger.jsonl'), {
        ts: '2026-09-11T00:00:00.000Z',
        path: '/v1/messages',
        status: 200,
        compressed: false,
        beforeBytes: 1,
        afterBytes: 1,
        usage: {},
      })
    ).not.toThrow();
  });
});

describe('a compressed response body is decoded before it is scanned', () => {
  // WHY THIS WAS NOT CAUGHT BY THE TESTS ABOVE. They feed the tap plaintext
  // SSE, which is what a stand-in upstream sends. The real provider answers
  // gzipped, because this proxy forwards the client's `accept-encoding`
  // untouched -- byte-faithful passthrough is the point. So the first live run
  // recorded 23 requests with correct byte counts and `usage: {}` on every one:
  // the scanner was reading compressed bytes as UTF-8 and matching nothing.
  const sse =
    'event: message_start\ndata: {"usage":{"input_tokens":31,' +
    '"cache_creation_input_tokens":120,"cache_read_input_tokens":9000}}\n\n' +
    'event: message_delta\ndata: {"usage":{"output_tokens":44}}\n\n';

  const through = (
    body: Buffer,
    encoding?: string
  ): Promise<{ usage: RequestUsage; delivered: number }> =>
    new Promise((resolve) => {
      // Chunked, as a socket delivers it, so the decoder has to span chunks.
      const chunks: Buffer[] = [];
      for (let i = 0; i < body.length; i += 97)
        chunks.push(body.subarray(i, i + 97));
      const stream = Readable.from(chunks);
      let delivered = 0;
      stream.on('data', (c: Buffer) => (delivered += c.length));
      tapUsage(stream, (usage) => resolve({ usage, delivered }), encoding);
    });

  it('reads usage out of a gzipped body', async () => {
    const { usage } = await through(gzipSync(Buffer.from(sse, 'utf8')), 'gzip');

    expect(usage.input_tokens).toBe(31);
    expect(usage.cache_creation_input_tokens).toBe(120);
    expect(usage.cache_read_input_tokens).toBe(9000);
    expect(usage.output_tokens).toBe(44);
  });

  it('still delivers every byte of a gzipped body', async () => {
    // The decoder sits BESIDE the response, never in it. If it consumed the
    // stream the client would get a truncated reply -- a measurement that
    // breaks the thing it measures.
    const body = gzipSync(Buffer.from(sse, 'utf8'));
    const { delivered } = await through(body, 'gzip');

    expect(delivered).toBe(body.length);
  });

  it('matches the encoding case-insensitively', async () => {
    const { usage } = await through(gzipSync(Buffer.from(sse, 'utf8')), 'GZIP');
    expect(usage.input_tokens).toBe(31);
  });

  it('reads a plain body when no encoding is declared', async () => {
    const { usage } = await through(Buffer.from(sse, 'utf8'));
    expect(usage.input_tokens).toBe(31);
  });

  it('reports nothing rather than guessing at an unknown encoding', async () => {
    // A wrong decoder yields garbage, and garbage that happens to parse as a
    // number is worse than no number -- it would be a confident, wrong cost
    // attribution, which is the failure this ledger exists to prevent. So an
    // unrecognised encoding falls back to scanning the bytes as they arrive,
    // and on a body that really is encoded that finds nothing.
    const body = gzipSync(Buffer.from(sse, 'utf8'));
    const { usage, delivered } = await through(body, 'some-future-encoding');

    expect(usage).toEqual({});
    // And the response is untouched regardless.
    expect(delivered).toBe(body.length);
  });

  it('does not lose the record when the body will not decode', async () => {
    // A truncated or mislabelled body must still settle: the response has
    // already reached the client by then, and a tap that never calls back
    // would drop the ledger line for that request entirely.
    const { delivered } = await through(
      Buffer.from('not gzip at all', 'utf8'),
      'gzip'
    );
    expect(delivered).toBe('not gzip at all'.length);
  });
});
