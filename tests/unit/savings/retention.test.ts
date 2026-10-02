/**
 * WHAT A PRUNE THAT "WORKS" CAN STILL GET WRONG, and what each test here pins.
 *
 * The file shrinks either way, so the size is not the property. The property is
 * that the report does not change: a prune is only correct if folding a day
 * into its totals and then reading the report produces the same figures the
 * rows produced. Three mistakes satisfy "the file got smaller" and fail that:
 *
 *  1. dropping rows and reporting the remainder, which reads as the product
 *     saving less the longer it runs;
 *  2. folding a day into the wrong windows, which moves a figure an operator
 *     reads as last week's work;
 *  3. counting a day twice -- as rows AND as the totals written beside them --
 *     which a crash between the prune's two writes produces on purpose.
 *
 * So the central test below reads the whole report before and after and demands
 * equality, and each of the others moves one of those failures on its own.
 */

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  longestReportWindowDays,
  looksLikeRollup,
  pruneProxyLedger,
  retentionDays,
  rollupPath,
  RETENTION_MARGIN_DAYS,
} from '../../../src/savings/retention.js';
import {
  createProxyAggregator,
  readProxySavings,
} from '../../../src/savings/proxy.js';
import {
  localDayKey,
  startOfDayKey,
  windowBoundaries,
  startOfLocalDay,
} from '../../../src/savings/windows.js';
import type { AccountingRecord } from '../../../src/proxy/accounting.js';

const METHOD = 'tiktoken-gpt-4-compatible-local-estimate';
const NOW = new Date(2026, 9, 1, 15, 0, 0, 0);

/** A day's worth of midnight, `back` local days before `NOW`. */
function daysBack(back: number): Date {
  const at = startOfLocalDay(NOW);
  at.setDate(at.getDate() - back);
  at.setHours(9, 30, 0, 0);
  return at;
}

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

function ledgerOf(lines: readonly string[]): string {
  const directory = mkdtempSync(join(tmpdir(), 'retention-'));
  const path = join(directory, 'ledger.jsonl');
  writeFileSync(
    path,
    lines.length === 0 ? '' : `${lines.join('\n')}\n`,
    'utf8'
  );
  return path;
}

function ledgerOfRecords(records: readonly AccountingRecord[]): string {
  return ledgerOf(records.map((one) => JSON.stringify(one)));
}

describe('the window the policy keeps', () => {
  it('is read off the report rather than written down beside it', () => {
    // A LITERAL HERE WOULD BE THE BUG. The report's longest window is "last 30
    // days", which opens at the start of the local day 29 days back -- so a
    // policy that kept "30 days" by counting from today would already be a day
    // short, and a fifth window added to the report would make it worse
    // silently. Both halves are asserted: the figure, and that no dated
    // boundary the report actually publishes falls outside it.
    expect(longestReportWindowDays(NOW)).toBe(29);
    const today = startOfLocalDay(NOW).getTime();
    const spans = windowBoundaries(NOW)
      .filter((bound) => bound.since !== null)
      .map((bound) =>
        Math.round((today - (bound.since as Date).getTime()) / 86_400_000)
      );
    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) {
      expect(span).toBeLessThanOrEqual(longestReportWindowDays(NOW));
    }
    expect(retentionDays(NOW)).toBe(29 + RETENTION_MARGIN_DAYS);
  });

  it('refuses a day key that names a day that does not exist', () => {
    // `new Date(2026, 1, 31)` is the 3rd of March, so a range check on the
    // parts is not enough -- a key like this would otherwise be folded into
    // whatever window March falls in, under February's name.
    expect(startOfDayKey('2026-02-31')).toBeNull();
    expect(startOfDayKey('2026-13-01')).toBeNull();
    expect(startOfDayKey('not-a-day')).toBeNull();
    // THE POSITIVE CONTROL: a real day resolves, to local midnight.
    const real = startOfDayKey('2026-02-28');
    expect(real).not.toBeNull();
    expect(real?.getHours()).toBe(0);
    expect(localDayKey(real as Date)).toBe('2026-02-28');
  });
});

/** Everything the report says, minus the fields that describe its own sources. */
function figures(report: Awaited<ReturnType<typeof readProxySavings>>) {
  const { rolledUpRecords, rolledUpDays, supersededRollupDays, ...rest } =
    report;
  void rolledUpRecords;
  void rolledUpDays;
  void supersededRollupDays;
  return rest;
}

/** A spread of rows whose shapes exercise every branch of the fold. */
function spread(): AccountingRecord[] {
  return [
    record({ ts: daysBack(0).toISOString() }),
    record({ ts: daysBack(3).toISOString(), model: 'claude-sonnet-5' }),
    record({ ts: daysBack(40).toISOString() }),
    record({ ts: daysBack(40).toISOString(), model: 'claude-sonnet-5' }),
    // Never charged for, so it counts as a request and nothing else.
    record({ ts: daysBack(41).toISOString(), status: 503 }),
    // Charged for, with no count of either body.
    record({ ts: daysBack(41).toISOString(), tokens: undefined }),
    // Counted, with a model no catalog prices.
    record({ ts: daysBack(42).toISOString(), model: 'gpt-0-not-a-model' }),
    // Counted, with no model named at all.
    record({ ts: daysBack(42).toISOString(), model: undefined }),
  ];
}

describe('folding a day away and reading the report back', () => {
  it('reports the same figures the rows reported', async () => {
    const ledger = ledgerOfRecords(spread());
    const before = await readProxySavings(ledger, NOW);

    const outcome = pruneProxyLedger(ledger, NOW);

    expect(outcome.changed).toBe(true);
    expect(outcome.reason).toBe('age');
    expect(outcome.linesFolded).toBe(6);
    expect(outcome.linesKept).toBe(2);
    const after = await readProxySavings(ledger, NOW);
    // THE WHOLE REPORT, not a figure from it. Every window, every model
    // breakdown, every counter -- because a prune that moved one row into the
    // wrong window would leave most of them right.
    expect(figures(after)).toEqual(figures(before));
    expect(after.rolledUpRecords).toBe(6);
    expect(after.rolledUpDays).toBe(3);
    expect(after.supersededRollupDays).toBe(0);
  });

  it('leaves a ledger that is entirely inside the window alone', async () => {
    const ledger = ledgerOfRecords([
      record({ ts: daysBack(0).toISOString() }),
      record({ ts: daysBack(5).toISOString() }),
    ]);
    const original = readFileSync(ledger, 'utf8');

    const outcome = pruneProxyLedger(ledger, NOW);

    expect(outcome.changed).toBe(false);
    expect(outcome.reason).toBe('none');
    // BYTE FOR BYTE, because "rewrote it identically" is not the same promise:
    // this runs inside the proxy's own append path and a rewrite there costs
    // the whole file on every request.
    expect(readFileSync(ledger, 'utf8')).toBe(original);
    expect(existsSync(rollupPath(ledger))).toBe(false);
  });
});

describe('a day that is present as rows and as a rollup at once', () => {
  it('reads the rows and discloses that it set the rollup aside', async () => {
    const ledger = ledgerOfRecords(spread());
    const before = await readProxySavings(ledger, NOW);
    const folded = readFileSync(ledger, 'utf8');

    pruneProxyLedger(ledger, NOW);
    // THE CRASH STATE, BUILT ON PURPOSE. Stopping between the rollup write and
    // the ledger rename leaves the old rows in place with their totals already
    // written beside them; this restores exactly that file.
    writeFileSync(ledger, folded, 'utf8');

    const after = await readProxySavings(ledger, NOW);
    expect(figures(after)).toEqual(figures(before));
    // Three stored days were outranked, and none of them was counted twice.
    expect(after.supersededRollupDays).toBe(3);
    expect(after.rolledUpRecords).toBe(0);
    expect(after.rolledUpDays).toBe(0);
  });

  it('does not grow by being printed twice', () => {
    const aggregator = createProxyAggregator(NOW);
    aggregator.addRollup({
      kind: 'proxy-day-rollup',
      version: 1,
      day: localDayKey(daysBack(2)),
      records: {
        total: 4,
        measured: 4,
        unbilled: 0,
        uncounted: 0,
        skippedLines: 0,
      },
      totals: {
        requests: 4,
        billedRequests: 4,
        countedRequests: 4,
        pricedRequests: 4,
        calibratedRequests: 0,
        tokensSaved: 3000,
        tokensBefore: 4000,
        cost: 0.5,
        oursTokens: 1000,
        billedTokens: 4000,
      },
      byModel: {},
    });

    const first = aggregator.report();
    const second = aggregator.report();

    expect(first.totalRecords).toBe(4);
    // A FOLD ACCUMULATES, so a second call is where the double would land.
    expect(figures(second)).toEqual(figures(first));
  });
});

describe('the byte ceiling behind the window', () => {
  it('folds inside the window when the file is too big, newest day last', async () => {
    const recent = [0, 1, 2, 3].flatMap((back) => [
      record({ ts: daysBack(back).toISOString() }),
      record({ ts: daysBack(back).toISOString(), model: 'claude-sonnet-5' }),
    ]);
    const ledger = ledgerOfRecords(recent);
    const before = await readProxySavings(ledger, NOW);
    const size = readFileSync(ledger, 'utf8').length;

    // THE CONTROL ARM. Every one of these rows is inside the window, so age
    // alone must leave the file untouched -- which is what makes the run below
    // attributable to the ceiling rather than to the window.
    expect(pruneProxyLedger(ledger, NOW, { maxBytes: size * 2 })).toMatchObject(
      {
        changed: false,
        reason: 'none',
      }
    );

    const outcome = pruneProxyLedger(ledger, NOW, {
      maxBytes: Math.floor(size / 2),
    });

    expect(outcome.reason).toBe('bytes');
    expect(outcome.bytesAfter).toBeLessThan(outcome.bytesBefore);
    // THE NEWEST DAY SURVIVES AS ROWS. It is the day still being appended to,
    // and folding it would replace rows a reader can see with a total the next
    // append makes partial.
    const keptDays = readFileSync(ledger, 'utf8')
      .trimEnd()
      .split(String.fromCharCode(10))
      .map((line) => localDayKey(new Date(String(JSON.parse(line).ts))));
    expect(keptDays).toContain(localDayKey(daysBack(0)));
    // AND IT FOLDS FROM THE OLD END. The ceiling folds only as many days as it
    // takes, so which days are left is not fixed -- but every day it folded has
    // to be older than every day it kept, or "oldest first" is not what ran.
    const foldedDays = readFileSync(rollupPath(ledger), 'utf8')
      .trimEnd()
      .split(String.fromCharCode(10))
      .map((line) => String(JSON.parse(line).day));
    expect(foldedDays.length).toBeGreaterThan(0);
    for (const folded of foldedDays) {
      for (const kept of keptDays) expect(folded < kept).toBe(true);
    }
    expect(figures(await readProxySavings(ledger, NOW))).toEqual(
      figures(before)
    );
  });

  it('leaves no temporary file behind', () => {
    const ledger = ledgerOfRecords(spread());

    pruneProxyLedger(ledger, NOW);

    // A HALF-WRITTEN NAME LEFT IN PLACE is how the next prune reads a stale
    // rollup, so the renames have to have landed.
    const left = readdirSync(dirname(ledger)).sort();
    expect(left).toEqual(['ledger.jsonl', 'ledger.jsonl.rollup.jsonl']);
    expect(
      looksLikeRollup(
        JSON.parse(readFileSync(rollupPath(ledger), 'utf8').split('\n')[0])
      )
    ).toBe(true);
  });
});

describe('lines the policy cannot read', () => {
  it('carries a line it could not parse into the count, not out of it', async () => {
    const ledger = ledgerOf([
      JSON.stringify(record({ ts: daysBack(40).toISOString() })),
      'this line is not json',
      JSON.stringify(record({ ts: daysBack(0).toISOString() })),
    ]);
    const before = await readProxySavings(ledger, NOW);
    expect(before.skippedLines).toBe(1);

    const outcome = pruneProxyLedger(ledger, NOW);

    // IT IS DROPPED, because there is no day to file it under and keeping it
    // forever is the growth this policy exists to stop. What survives is the
    // fact that it existed, folded into the oldest day's count.
    expect(outcome.linesSkipped).toBe(1);
    expect(figures(await readProxySavings(ledger, NOW))).toEqual(
      figures(before)
    );
  });

  it('keeps a rollup line it cannot read instead of rewriting it away', () => {
    const ledger = ledgerOfRecords(spread());
    const foreign =
      '{"kind":"proxy-day-rollup","version":99,"day":"2020-01-01"}';
    writeFileSync(rollupPath(ledger), `${foreign}\n`, 'utf8');

    pruneProxyLedger(ledger, NOW);

    // A LINE FROM A LATER VERSION IS NOT GARBAGE, it is savings this build does
    // not know how to add up -- so a downgrade must not be what deletes it.
    const written = readFileSync(rollupPath(ledger), 'utf8')
      .trimEnd()
      .split(String.fromCharCode(10));
    expect(written).toContain(foreign);
    expect(looksLikeRollup(JSON.parse(foreign))).toBe(false);
    // THE POSITIVE CONTROL: this build's own rows still landed beside it.
    expect(
      written.filter((line) => looksLikeRollup(JSON.parse(line)))
    ).toHaveLength(3);
  });
});
