/**
 * Reading a JSONL accounting ledger back.
 *
 * THE TRADE THESE PIN. A ledger can be torn by a disk filling, concatenated by
 * hand, or written by a version of this package that had fewer fields. Refusing
 * the whole file over any of those would make the diagnostic useless exactly
 * when it is needed, so the reader skips what it cannot parse and REPORTS the
 * count -- a silent skip would be the real defect, because then a reader cannot
 * tell a quiet session from a corrupt ledger.
 */

import { describe, it, expect, afterAll } from '@jest/globals';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { looksLikeRecord, readLedger } from '../../../src/inspect/ledger.js';
import type { AccountingRecord } from '../../../src/proxy/accounting.js';

const made: string[] = [];
afterAll(async () => {
  for (const directory of made) await rm(directory, { recursive: true, force: true });
});

function record(index: number): AccountingRecord {
  return {
    ts: new Date(1_700_000_000_000 + index * 1000).toISOString(),
    path: `/v1/messages?n=${index}`,
    status: 200,
    compressed: true,
    beforeBytes: 1000,
    afterBytes: 400,
    usage: { input_tokens: index },
  };
}

async function ledgerOf(lines: readonly string[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'inspect-ledger-'));
  made.push(directory);
  const path = join(directory, 'ledger.jsonl');
  await writeFile(path, lines.join('\n'), 'utf8');
  return path;
}

const indexOf = (entry: AccountingRecord): number => Number(entry.path.split('=')[1]);

describe('recognising a record', () => {
  it('accepts one carrying only the fields a renderer dereferences', () => {
    expect(
      looksLikeRecord({
        ts: 'x',
        path: '/p',
        status: 200,
        compressed: false,
        beforeBytes: 1,
        afterBytes: 1,
      })
    ).toBe(true);
  });

  it('rejects what is not an object', () => {
    for (const value of [null, 42, 'a line', [], undefined])
      expect(looksLikeRecord(value)).toBe(false);
    // The control: the shape it is meant to accept is still accepted.
    expect(looksLikeRecord(record(0))).toBe(true);
  });

  it('rejects a record missing a field the renderer would dereference', () => {
    for (const missing of ['ts', 'path', 'status', 'compressed', 'beforeBytes', 'afterBytes']) {
      const partial: Record<string, unknown> = { ...record(0) };
      delete partial[missing];
      expect(looksLikeRecord(partial)).toBe(false);
    }
  });

  it('accepts a record missing only the OPTIONAL fields', () => {
    // An older version of this package wrote no `timing` and no `elisions`, and
    // that ledger is exactly the one someone reads when something went wrong.
    const lean: Record<string, unknown> = { ...record(0) };
    delete lean.usage;
    delete lean.elisions;
    expect(looksLikeRecord(lean)).toBe(true);
  });
});

describe('reading a ledger', () => {
  it('returns the LAST n records, oldest first', async () => {
    const path = await ledgerOf([0, 1, 2, 3, 4].map((i) => JSON.stringify(record(i))));
    const read = await readLedger(path, 2);
    expect(read.records.map(indexOf)).toEqual([3, 4]);
    expect(read.skipped).toBe(0);
  });

  it('returns everything when the file is shorter than the window', async () => {
    const path = await ledgerOf([0, 1].map((i) => JSON.stringify(record(i))));
    expect((await readLedger(path, 10)).records.map(indexOf)).toEqual([0, 1]);
  });

  it('skips a torn line and says how many it skipped', async () => {
    const path = await ledgerOf([
      JSON.stringify(record(0)),
      '{"ts":"x","path":"/p","stat',
      JSON.stringify(record(1)),
    ]);
    const read = await readLedger(path, 10);
    expect(read.records.map(indexOf)).toEqual([0, 1]);
    expect(read.skipped).toBe(1);
  });

  it('skips well-formed JSON that is not a record', async () => {
    const path = await ledgerOf([
      '{"hello":"world"}',
      '[1,2,3]',
      JSON.stringify(record(0)),
    ]);
    const read = await readLedger(path, 10);
    expect(read.records.map(indexOf)).toEqual([0]);
    expect(read.skipped).toBe(2);
  });

  it('does not count a blank line as unreadable', async () => {
    const path = await ledgerOf([JSON.stringify(record(0)), '', '   ', '']);
    const read = await readLedger(path, 10);
    expect(read.records).toHaveLength(1);
    expect(read.skipped).toBe(0);
  });

  it('reads a ledger written with CRLF line endings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'inspect-ledger-crlf-'));
    made.push(directory);
    const path = join(directory, 'ledger.jsonl');
    await writeFile(path, [0, 1].map((i) => JSON.stringify(record(i))).join('\r\n'), 'utf8');
    const read = await readLedger(path, 10);
    expect(read.records.map(indexOf)).toEqual([0, 1]);
    expect(read.skipped).toBe(0);
  });

  it('returns an empty read for an empty ledger, not a failure', async () => {
    const path = await ledgerOf([]);
    const read = await readLedger(path, 10);
    expect(read.records).toEqual([]);
    expect(read.skipped).toBe(0);
  });

  it('rejects a path that does not exist, naming it', async () => {
    const path = join(tmpdir(), 'inspect-ledger-absent', 'nothing.jsonl');
    await expect(readLedger(path, 1)).rejects.toThrow(/nothing\.jsonl/);
  });

  it('treats a nonsense window as asking for one record', async () => {
    const path = await ledgerOf([0, 1, 2].map((i) => JSON.stringify(record(i))));
    expect((await readLedger(path, 0)).records.map(indexOf)).toEqual([2]);
    expect((await readLedger(path, -4)).records.map(indexOf)).toEqual([2]);
  });
});
