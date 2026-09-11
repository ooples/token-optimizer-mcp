import { describe, it, expect, afterEach } from '@jest/globals';
import { Readable } from 'node:stream';
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
