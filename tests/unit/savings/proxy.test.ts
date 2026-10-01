/**
 * WHAT A TOTAL-ONLY TEST WOULD MISS HERE. The report returns a number for every
 * field no matter which rows it folded, and the mistakes that move a figure an
 * operator reads are all invisible to a sum: a nested window silently becoming
 * a partition, a denominator drawn from a wider population than its numerator,
 * and an unbilled row quietly joining the saving. Each is pinned with a control
 * that moves the other way.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createProxyAggregator,
  loadProxyInput,
  PROXY_INPUT,
  readProxySavings,
} from '../../../src/savings/proxy.js';
import type { AccountingRecord } from '../../../src/proxy/accounting.js';
import { MODEL_PRICE_CATALOG } from '../../../src/analytics/provider-pricing.js';

const METHOD = 'tiktoken-gpt-4-compatible-local-estimate';
const NOW = new Date('2026-10-01T15:00:00.000Z');
const UNPRICED_OPENAI = 'gpt-0-not-a-model';
const UNPRICED_GEMINI = 'gemini-0-not-a-model';

function record(over: Partial<AccountingRecord> = {}): AccountingRecord {
  return {
    ts: NOW.toISOString(),
    path: '/v1/messages',
    status: 200,
    compressed: true,
    beforeBytes: 4000,
    afterBytes: 1000,
    model: 'gpt-5.6-sol',
    usage: { input_tokens: 240 },
    tokens: {
      measured: true,
      beforeTokens: 1000,
      afterTokens: 250,
      method: METHOD,
    },
    ...over,
  };
}

function reportOf(records: readonly AccountingRecord[], now: Date = NOW) {
  const aggregator = createProxyAggregator(now);
  for (const one of records) aggregator.add(one);
  return aggregator.report();
}

describe('folding proxy ledger rows into windows', () => {
  it('counts every row and names the ones that prove nothing', () => {
    const report = reportOf([
      record(),
      record({ status: 429 }),
      record({ tokens: { measured: false, reason: 'worker-failed' } }),
    ]);
    expect(report.totalRecords).toBe(3);
    expect(report.measuredRecords).toBe(1);
    expect(report.unbilledRecords).toBe(1);
    expect(report.uncountedRecords).toBe(1);
  });

  it('keeps an unbilled row out of the saving it is counted beside', () => {
    const withRefusal = reportOf([record(), record({ status: 503 })]);
    const alone = reportOf([record()]);
    const all = (report: ReturnType<typeof reportOf>) =>
      report.windows[report.windows.length - 1];
    // Same saving either way; the 503 moved the request count and nothing else.
    expect(all(withRefusal).tokensSaved).toBe(all(alone).tokensSaved);
    expect(all(withRefusal).requests).toBe(2);
    expect(all(withRefusal).billedRequests).toBe(1);
  });

  it('draws the percentage denominator from the rows it credited', () => {
    // One measured row saving 750 of 1000, beside a billed row with no count.
    const report = reportOf([
      record(),
      record({ tokens: { measured: false, reason: 'queue-full' } }),
    ]);
    const all = report.windows[report.windows.length - 1];
    expect(all.tokensBefore).toBe(1000);
    expect(all.savingsPercent).toBeCloseTo(75, 6);
    // THE CONTROL: had the denominator come from every billed row it would have
    // been 2000 and this figure would read 37.5%.
    expect(all.savingsPercent).not.toBeCloseTo(37.5, 6);
  });

  it('nests the windows rather than partitioning them', () => {
    const lastWeek = new Date(NOW.getTime() - 3 * 86_400_000).toISOString();
    const report = reportOf([record(), record({ ts: lastWeek })]);
    const [today, week, , all] = report.windows;
    expect(today.tokensSaved).toBe(750);
    expect(week.tokensSaved).toBe(1500);
    expect(all.tokensSaved).toBe(1500);
  });

  it('places a row with an unreadable stamp in no dated window', () => {
    const report = reportOf([record({ ts: 'not a date' })]);
    const [today, , , all] = report.windows;
    expect(today.requests).toBe(0);
    // Positive control: all-time has no boundary to fail, so the row is there.
    expect(all.requests).toBe(1);
  });
});

describe('what the report says about its own instrument', () => {
  it('sums both counts of the bodies we sent, over the rows that have both', () => {
    const report = reportOf([record(), record(), record({ usage: {} })]);
    const all = report.windows[report.windows.length - 1];
    expect(all.calibratedRequests).toBe(2);
    expect(all.oursTokens).toBe(500);
    expect(all.billedTokens).toBe(480);
    // The third row is still counted as a saving; only the check is missing.
    expect(all.countedRequests).toBe(3);
  });

  it('prices only the rows whose model the catalog knows', () => {
    const report = reportOf([record(), record({ model: UNPRICED_OPENAI })]);
    const all = report.windows[report.windows.length - 1];
    expect(all.pricedRequests).toBe(1);
    expect(all.costUsd).not.toBeNull();
    expect(all.countedRequests).toBe(2);
  });

  it('reports no cost at all rather than zero when nothing was priced', () => {
    const report = reportOf([record({ model: undefined })]);
    const all = report.windows[report.windows.length - 1];
    expect(all.costUsd).toBeNull();
    // The control: a row that names a catalog model does produce a figure.
    expect(
      reportOf([record()]).windows[report.windows.length - 1].costUsd
    ).not.toBeNull();
  });
});

describe('grouping by model', () => {
  it('names the unattributed bucket rather than dropping the row', () => {
    const report = reportOf([record({ model: undefined })]);
    expect(report.byModel.map((row) => row.name)).toEqual(['(unattributed)']);
    expect(report.byModel[0].costUsd).toBeNull();
  });

  it('leaves out a model whose every row was unmeasurable', () => {
    const report = reportOf([
      record(),
      record({ model: 'claude-sonnet-5', status: 429 }),
    ]);
    // A model listed at zero reads as one the proxy cannot help; what happened
    // is that nothing it did was billed.
    expect(report.byModel.map((row) => row.name)).toEqual(['gpt-5.6-sol']);
  });

  it('orders by saving, then by name so two equal rows do not reshuffle', () => {
    const small = {
      measured: true,
      beforeTokens: 300,
      afterTokens: 200,
      method: METHOD,
    } as const;
    const report = reportOf([
      record({ model: 'claude-sonnet-5', tokens: small }),
      record({ model: 'gpt-5.6-sol' }),
    ]);
    expect(report.byModel.map((row) => row.name)).toEqual([
      'gpt-5.6-sol',
      'claude-sonnet-5',
    ]);
  });
});

describe('reading a ledger off disk', () => {
  function ledgerOf(lines: readonly string[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'proxy-savings-'));
    const path = join(dir, 'accounting.jsonl');
    writeFileSync(path, lines.join('\n'), 'utf8');
    return path;
  }

  it('folds the rows it can read', async () => {
    const path = ledgerOf([
      JSON.stringify(record()),
      JSON.stringify(record({ status: 429 })),
    ]);
    const report = await readProxySavings(path, NOW);
    expect(report.totalRecords).toBe(2);
    expect(report.windows[3].tokensSaved).toBe(750);
    expect(report.skippedLines).toBe(0);
  });

  it('counts a torn line instead of failing the whole report', async () => {
    const path = ledgerOf([
      JSON.stringify(record()),
      '{"ts":"2026-10-01T12:00',
      '{"something":"else"}',
      '',
    ]);
    const report = await readProxySavings(path, NOW);
    expect(report.skippedLines).toBe(2);
    // The control: the good row still landed, so the skips above are the two
    // bad lines and not the reader giving up.
    expect(report.totalRecords).toBe(1);
    expect(report.windows[3].tokensSaved).toBe(750);
  });
});

describe('loadProxyInput', () => {
  it('reads the ledger the environment names', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'proxy-input-'));
    const path = join(dir, 'ledger.jsonl');
    writeFileSync(path, `${JSON.stringify(record())}\u000a`, 'utf8');
    const input = await loadProxyInput({
      env: { TOKEN_OPTIMIZER_PROXY_ACCOUNTING: path },
      now: NOW,
    });
    expect(input.kind).toBe(PROXY_INPUT.Read);
    if (input.kind !== PROXY_INPUT.Read) throw new Error('not read');
    expect(input.path).toBe(path);
    expect(input.report.windows[3].tokensSaved).toBe(750);
  });

  it('prefers an explicit path over the environment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'proxy-input-'));
    const given = join(dir, 'given.jsonl');
    writeFileSync(given, `${JSON.stringify(record())}\u000a`, 'utf8');
    const input = await loadProxyInput({
      env: { TOKEN_OPTIMIZER_PROXY_ACCOUNTING: join(dir, 'other.jsonl') },
      now: NOW,
      path: given,
    });
    expect(input.kind).toBe(PROXY_INPUT.Read);
    if (input.kind !== PROXY_INPUT.Read) throw new Error('not read');
    expect(input.path).toBe(given);
  });

  it('says the ledger was never configured, not that it was empty', async () => {
    for (const env of [{}, { TOKEN_OPTIMIZER_PROXY_ACCOUNTING: '   ' }]) {
      const input = await loadProxyInput({ env, now: NOW });
      expect(input.kind).toBe(PROXY_INPUT.NotConfigured);
    }
    // Positive control: a real path on the same call shape is read.
    const dir = mkdtempSync(join(tmpdir(), 'proxy-input-'));
    const path = join(dir, 'ledger.jsonl');
    writeFileSync(path, `${JSON.stringify(record())}\u000a`, 'utf8');
    const read = await loadProxyInput({
      env: { TOKEN_OPTIMIZER_PROXY_ACCOUNTING: path },
      now: NOW,
    });
    expect(read.kind).toBe(PROXY_INPUT.Read);
  });

  it('separates a configured ledger that does not exist from one that fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'proxy-input-'));
    const missing = await loadProxyInput({
      now: NOW,
      path: join(dir, 'never-written.jsonl'),
    });
    expect(missing.kind).toBe(PROXY_INPUT.Missing);
    // A directory is readable as a path and unreadable as a file, which is the
    // cheapest portable way to reach the other failure.
    const broken = await loadProxyInput({ now: NOW, path: dir });
    expect(broken.kind).toBe(PROXY_INPUT.Unreadable);
    if (broken.kind !== PROXY_INPUT.Unreadable) throw new Error('not that');
    expect(broken.reason.length).toBeGreaterThan(0);
  });

  it('never throws, so the MCP half of the report still prints', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'proxy-input-'));
    await expect(
      loadProxyInput({ now: NOW, path: dir })
    ).resolves.toMatchObject({ kind: PROXY_INPUT.Unreadable, path: dir });
    await expect(
      loadProxyInput({ now: NOW, path: join(dir, 'nope.jsonl') })
    ).resolves.toMatchObject({ kind: PROXY_INPUT.Missing });
  });
});

describe('the models the catalog could not price', () => {
  it('names a counted row whose model is not in the catalog', () => {
    const report = reportOf([record(), record({ model: UNPRICED_GEMINI })]);
    expect(report.unpricedModels).toEqual([UNPRICED_GEMINI]);
    // Positive control: the other row priced, so the list is short because the
    // catalog knew one model and not because pricing failed for both.
    const all = report.windows.find((window) => window.since === null);
    expect(all?.pricedRequests).toBe(1);
    expect(all?.countedRequests).toBe(2);
  });

  it('is empty when every counted row priced', () => {
    const report = reportOf([record()]);
    expect(report.unpricedModels).toEqual([]);
    expect(report.windows[0].costUsd).not.toBeNull();
  });

  it('leaves out a model whose rows were never billed', () => {
    // AN UNBILLED ROW HAS NO PRICE TO BE MISSING. It is reported by the gate
    // note as a request the provider never charged for, and naming it here as
    // well would send an operator to the catalog over a row that had no bill.
    const report = reportOf([record({ status: 429, model: UNPRICED_GEMINI })]);
    expect(report.unpricedModels).toEqual([]);
    expect(report.unbilledRecords).toBe(1);
  });
});

describe('the ids these fixtures rely on being absent', () => {
  it('names models the catalog really does not carry', () => {
    // THE GUARD FOR EVERY "UNPRICED" FIXTURE BELOW. These used to be real
    // model ids that the catalog merely had not been widened to cover yet, so
    // when it was widened the fixtures became priced rows and the assertions
    // went on passing while proving nothing. Each id keeps a vendor prefix so
    // the route still resolves and the missing price is the catalog's.
    for (const id of [UNPRICED_OPENAI, UNPRICED_GEMINI]) {
      expect(MODEL_PRICE_CATALOG.some((row) => row.model === id)).toBe(false);
    }
    // The positive control: the id they are contrasted with IS priced.
    expect(
      MODEL_PRICE_CATALOG.some((row) => row.model === 'gpt-5.6-sol')
    ).toBe(true);
  });
});
