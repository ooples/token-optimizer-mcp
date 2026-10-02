/**
 * The second input to the savings report: the proxy's own ledger.
 *
 * WHY A SECOND INPUT AT ALL. `windows.ts` aggregates the analytics database,
 * which only the MCP tool path writes to. The proxy -- the component that
 * rewrites every request an agent makes and is responsible for the larger part
 * of what this product saves -- wrote a JSONL ledger that no savings surface
 * read, so `token-optimizer-savings` had to print a line disclaiming its own
 * scope and an operator whose savings came mostly from the proxy read the
 * report as the product barely working.
 *
 * NOT MERGED INTO THE ANALYTICS DATABASE. The obvious alternative was to have
 * the proxy write analytics rows directly, and it was rejected twice over. The
 * database is shared with the dashboard and three other readers, so a proxy
 * writing to it on every request introduces lock contention on the agent's
 * critical path; and the two inputs do not prove the same thing -- see
 * `proxy-savings.ts` -- so folding them into one column would hide the fact
 * that one of them carries the provider's own count as a check and the other
 * has no external check at all. Two inputs, reported separately.
 *
 * STREAMED AND FOLDED, NEVER COLLECTED. A ledger accumulates a line per
 * request for as long as it is configured; the inspect reader can keep the last
 * ten records in memory but a report over all time cannot keep all of them.
 * Every figure here is therefore accumulated as the file is read, so the peak
 * cost of the report is one record rather than the ledger.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import {
  classifyProxySavings,
  proxyTransportDelta,
  PROXY_SAVINGS,
} from '../analytics/proxy-savings.js';
import { accountingPath, type AccountingRecord } from '../proxy/accounting.js';
import { looksLikeRecord } from '../inspect/ledger.js';
import {
  addTotals,
  emptyTotals,
  foldRecord,
  looksLikeRollup,
  rollupPath,
  transformQuantile,
  type RollupRow,
  type RollupTotals,
} from './retention.js';
import {
  emptyOutputLedgers,
  mergeOutputLedgers,
  deferralTier,
  outputTiers,
  parseOutputLedgers,
  recordOutputRow,
  type OutputLedgers,
} from './output.js';
import type {
  OutputSavingsEstimate,
  OutputWaste,
} from '../proxy/output-savings.js';
import {
  UNATTRIBUTED,
  byName,
  localDayKey,
  startOfDayKey,
  windowBoundaries,
  type SavingsGroup,
} from './windows.js';

export interface ProxySavingsWindow {
  readonly label: string;
  readonly since: string | null;
  /** Every ledger row in the window, whatever it proves. */
  readonly requests: number;
  /** Rows the provider accepted with a 2xx and therefore charged for. */
  readonly billedRequests: number;
  /** Billed rows that also carry our token count of both bodies. */
  readonly countedRequests: number;
  readonly pricedRequests: number;
  readonly calibratedRequests: number;
  readonly tokensSaved: number;
  readonly tokensBefore: number;
  readonly savingsPercent: number;
  readonly costUsd: number | null;
  /** Our count of the bodies we sent, summed over calibrated rows. */
  readonly oursTokens: number;
  /** The provider's count of those same bodies. */
  readonly billedTokens: number;
  /**
   * Rows that carried a timing block, which every latency figure below is over.
   *
   * THE DENOMINATOR IS PUBLISHED BESIDE THE FIGURES because it is not
   * `requests`: a ledger written by a proxy built before the timings existed
   * carries none, and the figures are then null rather than zero.
   */
  readonly timedRequests: number;
  /** Mean milliseconds spent rewriting a request. Exact across the fold. */
  readonly transformMsMean: number | null;
  /** The median transform, as the bound of the bucket it falls in. */
  readonly transformMsP50: LatencyBound | null;
  /** The slow transform: what a request at the 95th percentile paid. */
  readonly transformMsP95: LatencyBound | null;
  /** The slowest single transform in the window. */
  readonly transformMsMax: number | null;
  /**
   * Mean milliseconds the provider took, which is what our share is read
   * against: 3 ms of transform in front of a 2-second call is a different
   * trade from 3 ms in front of a 30 ms one.
   */
  readonly upstreamMsMean: number | null;
  /**
   * What compression appears to have done to the output side, ESTIMATED.
   *
   * OBSERVATIONAL, AND THE WORD IS PART OF THE FIGURE. The comparison is
   * against rows compression declined to act on, and it declined because they
   * were small or unusual -- so the two groups differ in ways besides the
   * treatment, in an unknown direction, and no interval covers that. The band
   * that travels with it covers sampling noise only.
   *
   * SIGNED. A negative figure says we made the model write more, and that is
   * reported as readily as the other sign.
   */
  readonly outputEstimated: OutputSavingsEstimate;
  /**
   * What the output shaper did to the output side, MEASURED.
   *
   * NULL UNLESS A HOLDOUT ACTUALLY RAN, and the renderer then prints nothing
   * rather than a null result: an operator who never started the experiment
   * must not read "the holdout found no effect".
   */
  readonly outputMeasured: OutputSavingsEstimate | null;
  /**
   * Tier 3: the share of a reply the model had already been shown, averaged
   * over the responses the opt-in scanner read.
   *
   * NULL UNLESS THE SCANNER RAN, AND NEVER A TOKEN COUNT. It is output waste
   * with no counterfactual -- an opportunity, not a saving -- and it is carried
   * in its own units so nothing downstream can add it to one.
   */
  readonly outputWaste: OutputWaste | null;
  /**
   * What tool deferral did to the PROMPT side, MEASURED by the provider.
   *
   * INPUT TOKENS, NOT OUTPUT TOKENS, and the only field here that is. It sits
   * beside the output tiers because it is the same kind of evidence -- a
   * randomized difference read off the provider's own meter -- but its unit is
   * the other side of the bill, so it is never summed with them.
   *
   * IT IS THE CHECK ON A NUMBER WE ALREADY COMPUTE. The deferred schemas are
   * counted exactly, so `tokensSaved` above already carries deferral's effect
   * at prompt level. What no arithmetic of ours can show is that the provider
   * honoured the beta and left those schemas out of the context it charged for.
   * This figure is the gap between the billed prompt tokens of conversations
   * whose tools were deferred and those randomly withheld from the feature.
   *
   * NULL UNLESS A HOLDOUT RAN, which is the default, because a holdout makes
   * its control arm pay full price on purpose.
   */
  readonly deferralMeasured: OutputSavingsEstimate | null;
}

/**
 * A latency figure the histogram can defend.
 *
 * `exceeded` SAYS THE BUCKET WAS OPEN, so the slowest requests read as "over
 * 2000 ms" rather than as a measurement of 2000 ms -- see `transformQuantile`.
 */
export interface LatencyBound {
  readonly ms: number;
  readonly exceeded: boolean;
}

export interface ProxySavingsReport {
  readonly windows: readonly ProxySavingsWindow[];
  readonly byModel: readonly SavingsGroup[];
  readonly totalRecords: number;
  /** Rows that contributed a signed token delta to the figures above. */
  readonly measuredRecords: number;
  /** Rows whose request was never charged for: a non-2xx or a dead socket. */
  readonly unbilledRecords: number;
  /** Billed rows with no token count -- an older proxy, or a named refusal. */
  readonly uncountedRecords: number;
  /** Lines that were not a record. See `inspect/ledger.ts` for why skipped. */
  readonly skippedLines: number;
  /**
   * Model ids a counted row named that no catalog entry prices.
   *
   * THE SAME FACT THE MCP REPORT CARRIES, under the same name, because the two
   * tables now sit one above the other: a note on one and silence on the other
   * reads as "the proxy knows every price", when both halves consult the one
   * catalog and both halves miss the same models.
   */
  readonly unpricedModels: readonly string[];
  /**
   * Rows that reached these figures as a stored day's totals, not as rows.
   *
   * DISCLOSED, NOT HIDDEN. Past the retention window a row is replaced by the
   * day it belonged to (`retention.ts`), which preserves every figure above
   * exactly but not the per-request detail behind them -- so an operator who
   * goes looking for a request in the ledger and finds the day gone has been
   * told why, by a report that says how much of itself came from where.
   */
  readonly rolledUpRecords: number;
  readonly rolledUpDays: number;
  /**
   * Stored days the live rows outranked, which is how a crash mid-prune reads.
   *
   * Not an error: the rollup is written before the ledger is rewritten so that
   * dying between the two costs a duplicate rather than a day. This counts the
   * duplicates that were ignored.
   */
  readonly supersededRollupDays: number;
}

/**
 * One window's running totals. Mutable by design: this is a fold.
 *
 * THE SHAPE AND THE FOLD BOTH COME FROM `retention.ts`, which is also what
 * writes the pre-folded days this reader adds back in. Two copies of this
 * arithmetic would put a step in every figure exactly at the age where the
 * rows stop being rows.
 */
type Totals = RollupTotals;

/**
 * An average, or null when there was nothing to average.
 *
 * NULL RATHER THAN ZERO for the same reason every other figure here does it: a
 * zero in a latency column reads as a transform that cost nothing, which is a
 * false measurement rather than a missing one.
 */
function mean(total: number, count: number): number | null {
  return count > 0 ? total / count : null;
}

function percent(saved: number, before: number): number {
  return before > 0 ? (saved / before) * 100 : 0;
}

function freezeWindow(
  label: string,
  since: Date | null,
  totals: Totals,
  output: OutputLedgers
): ProxySavingsWindow {
  const tiers = outputTiers(output);
  return Object.freeze({
    label,
    since: since === null ? null : since.toISOString(),
    requests: totals.requests,
    billedRequests: totals.billedRequests,
    countedRequests: totals.countedRequests,
    pricedRequests: totals.pricedRequests,
    calibratedRequests: totals.calibratedRequests,
    tokensSaved: totals.tokensSaved,
    tokensBefore: totals.tokensBefore,
    savingsPercent: percent(totals.tokensSaved, totals.tokensBefore),
    costUsd: totals.pricedRequests > 0 ? totals.cost : null,
    oursTokens: totals.oursTokens,
    billedTokens: totals.billedTokens,
    timedRequests: totals.timedRequests,
    transformMsMean: mean(totals.transformMs, totals.timedRequests),
    transformMsP50: transformQuantile(totals.transformBuckets, 0.5),
    transformMsP95: transformQuantile(totals.transformBuckets, 0.95),
    transformMsMax: totals.timedRequests > 0 ? totals.transformMsMax : null,
    upstreamMsMean: mean(totals.upstreamMs, totals.timedRequests),
    outputEstimated: tiers.estimated,
    outputMeasured: tiers.measured,
    outputWaste: tiers.waste,
    deferralMeasured: deferralTier(output),
  });
}

export interface ProxyAggregator {
  add(record: AccountingRecord): void;
  /** One pre-folded day, from the ledger's rollup file. */
  addRollup(row: RollupRow): void;
  /** A line that was not a record at all. Reported, never silently dropped. */
  skip(): void;
  report(): ProxySavingsReport;
}

/**
 * THE WINDOWS NEST; THEY DO NOT PARTITION, exactly as in `windows.ts`, so each
 * record is folded into every window it falls inside rather than into one
 * bucket. Summing a column of them double-counts, which is why each one is
 * labelled "last N days" rather than looking like a bucket.
 */
export function createProxyAggregator(now: Date = new Date()): ProxyAggregator {
  const bounds = windowBoundaries(now);
  const windows = bounds.map((bound) => ({
    label: bound.label,
    since: bound.since,
    totals: emptyTotals(),
    // PER WINDOW, NOT ONE SHARED LEDGER. An output tier is a difference of
    // means with an interval over the rows in its window, and a seven-day
    // figure computed from every row ever recorded is not a seven-day figure.
    output: emptyOutputLedgers(),
  }));
  const models = new Map<string, Totals>();
  let totalRecords = 0;
  let measuredRecords = 0;
  let unbilledRecords = 0;
  let uncountedRecords = 0;
  let skippedLines = 0;
  let rolledUpRecords = 0;
  const rolledUpDays = new Set<string>();
  const supersededDays = new Set<string>();
  /** Days the live rows cover, so a rollup for one can be recognised as stale. */
  const liveDays = new Set<string>();
  /** Rollups held until `report`, because the rows that outrank them may follow. */
  const pending: RollupRow[] = [];
  let settled = false;

  const bucketFor = (name: string): Totals => {
    let bucket = models.get(name);
    if (bucket === undefined) {
      bucket = emptyTotals();
      models.set(name, bucket);
    }
    return bucket;
  };

  /**
   * Folds one day's stored totals in, as though its rows were still here.
   *
   * EVERY WINDOW THE DAY OPENS INSIDE, which is exact rather than generous: a
   * window opens at the start of a local day and a rollup covers a whole local
   * day, so the day is either entirely within a window or entirely outside it.
   * There is no day here to split between two windows.
   */
  const foldRollup = (row: RollupRow): void => {
    const start = startOfDayKey(row.day);
    if (start === null) {
      skippedLines += 1;
      return;
    }
    rolledUpRecords += row.records.total;
    rolledUpDays.add(row.day);
    totalRecords += row.records.total;
    measuredRecords += row.records.measured;
    unbilledRecords += row.records.unbilled;
    uncountedRecords += row.records.uncounted;
    skippedLines += row.records.skippedLines;
    // PARSED ONCE, OUTSIDE THE WINDOW LOOP. `looksLikeRollup` has already
    // refused any row this build cannot read, so a non-null result is the
    // normal case; the guard stays because the two functions can drift and a
    // throw here would abort a report mid-way.
    const output = parseOutputLedgers(row.output);
    for (const window of windows) {
      if (window.since === null || start.getTime() >= window.since.getTime()) {
        addTotals(window.totals, row.totals);
        if (output !== null) mergeOutputLedgers(window.output, output);
      }
    }
    for (const [name, totals] of Object.entries(row.byModel)) {
      addTotals(bucketFor(name), totals);
    }
  };

  return {
    add(record: AccountingRecord): void {
      totalRecords += 1;
      const classification = classifyProxySavings(record);
      if (classification === PROXY_SAVINGS.Unbilled) unbilledRecords += 1;
      else if (classification === PROXY_SAVINGS.Uncounted)
        uncountedRecords += 1;
      const delta = proxyTransportDelta(record);
      if (delta !== 0) measuredRecords += 1;
      // AN UNPARSEABLE STAMP IS OUT OF EVERY DATED WINDOW, not silently in all
      // of them: it cannot be placed, and placing it anyway would move a number
      // an operator reads as a day's work.
      const at = Date.parse(record.ts);
      for (const window of windows) {
        if (window.since === null) {
          foldRecord(window.totals, record);
          recordOutputRow(window.output, record);
        } else if (Number.isFinite(at) && at >= window.since.getTime()) {
          foldRecord(window.totals, record);
          recordOutputRow(window.output, record);
        }
      }
      if (Number.isFinite(at)) liveDays.add(localDayKey(new Date(at)));
      if (delta === 0) return;
      const name = (record.model ?? '').trim() || UNATTRIBUTED;
      foldRecord(bucketFor(name), record);
    },
    skip(): void {
      skippedLines += 1;
    },
    /**
     * Takes one stored day, to be folded in when the report is asked for.
     *
     * HELD RATHER THAN FOLDED NOW, because the live rows decide. A prune that
     * died between writing the rollup and rewriting the ledger leaves a day
     * present in both, and the rows are the half that is certainly complete --
     * so a rollup is only used for a day no row was seen for, and the ledger
     * may be read after this file is.
     */
    addRollup(row: RollupRow): void {
      pending.push(row);
    },
    report(): ProxySavingsReport {
      // ONCE, EVEN IF ASKED TWICE. Folding is accumulation into the same
      // totals, so a second call would double every stored day while leaving
      // the live rows alone -- a report that grows by being printed.
      if (!settled) {
        settled = true;
        for (const row of pending) {
          if (liveDays.has(row.day)) supersededDays.add(row.day);
          else foldRollup(row);
        }
      }
      const byModel: SavingsGroup[] = [];
      for (const [name, totals] of models) {
        byModel.push(
          Object.freeze({
            name,
            operations: totals.countedRequests,
            tokensSaved: totals.tokensSaved,
            costUsd: totals.pricedRequests > 0 ? totals.cost : null,
            pricedOperations: totals.pricedRequests,
            eligibleOperations: totals.countedRequests,
          })
        );
      }
      byModel.sort((a, b) => b.tokensSaved - a.tokensSaved || byName(a, b));
      // DERIVED FROM THE BUCKETS, not a fourth counter: a model whose counted
      // rows outnumber its priced ones had at least one row the catalog could
      // not price. A bucket with no counted rows at all is an unbilled model,
      // which is a different fact and is reported as one.
      const unpriced: string[] = [];
      for (const [name, totals] of models) {
        if (totals.pricedRequests < totals.countedRequests) unpriced.push(name);
      }
      unpriced.sort();
      return Object.freeze({
        windows: Object.freeze(
          windows.map((window) =>
            freezeWindow(
              window.label,
              window.since,
              window.totals,
              window.output
            )
          )
        ),
        byModel: Object.freeze(byModel),
        totalRecords,
        measuredRecords,
        unbilledRecords,
        uncountedRecords,
        skippedLines,
        unpricedModels: Object.freeze(unpriced),
        rolledUpRecords,
        rolledUpDays: rolledUpDays.size,
        supersededRollupDays: supersededDays.size,
      });
    },
  };
}

/**
 * Reads a proxy ledger and returns its report.
 *
 * A TORN OR FOREIGN LINE IS SKIPPED AND COUNTED, never fatal -- the same trade
 * `inspect/ledger.ts` makes, and for the same reason: refusing to report a
 * week of requests because a disk filled mid-line would be the wrong answer.
 * The shape check is imported from there rather than copied, so a record field
 * added in one place cannot start being rejected in the other.
 */
export async function readProxySavings(
  path: string,
  now: Date = new Date()
): Promise<ProxySavingsReport> {
  const aggregator = createProxyAggregator(now);
  await readRollups(rollupPath(path), aggregator);
  const lines = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    const text = line.trim();
    if (text === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      aggregator.skip();
      continue;
    }
    if (!looksLikeRecord(parsed)) {
      aggregator.skip();
      continue;
    }
    aggregator.add(parsed);
  }
  return aggregator.report();
}

/**
 * Reads the stored days beside a ledger, if there are any.
 *
 * AN ABSENT ROLLUP FILE IS THE NORMAL CASE and not a failure: nothing writes
 * one until a ledger is old enough or large enough to be pruned, so the
 * overwhelming majority of installs never have one. Every other read failure
 * propagates, because a rollup file that exists and cannot be read is missing
 * savings an operator already earned, and reporting silence for it would be the
 * one case where this file's figures are quietly short.
 */
async function readRollups(
  path: string,
  aggregator: ProxyAggregator
): Promise<void> {
  let lines;
  try {
    lines = createInterface({
      input: createReadStream(path, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    // The stream opens lazily, so the ENOENT arrives on the first read rather
    // than here; `for await` is inside the same try for that reason.
    for await (const line of lines) {
      const text = line.trim();
      if (text === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        aggregator.skip();
        continue;
      }
      if (!looksLikeRollup(parsed)) {
        aggregator.skip();
        continue;
      }
      aggregator.addRollup(parsed);
    }
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

/**
 * Which of the two inputs the report actually had.
 *
 * FOUR STATES, NOT A NULLABLE REPORT. "No proxy figures" has four different
 * causes and three of them are actionable by the operator: the ledger was never
 * configured (set the variable), it is configured but empty (the proxy has not
 * run yet), or it exists and could not be read (a permission or a disk). Only
 * the fourth is a measurement. Collapsing them into an absent report would
 * print the same silence for all four, which is the exact defect the scope note
 * existed to work around.
 */
export const PROXY_INPUT = Object.freeze({
  NotConfigured: 'not-configured',
  Missing: 'missing',
  Unreadable: 'unreadable',
  Read: 'read',
} as const);

export type ProxyInput =
  | { readonly kind: typeof PROXY_INPUT.NotConfigured }
  | { readonly kind: typeof PROXY_INPUT.Missing; readonly path: string }
  | {
      readonly kind: typeof PROXY_INPUT.Unreadable;
      readonly path: string;
      readonly reason: string;
    }
  | {
      readonly kind: typeof PROXY_INPUT.Read;
      readonly path: string;
      readonly report: ProxySavingsReport;
    };

/** True for the one failure that means "configured, but nothing written yet". */
function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'ENOENT'
  );
}

/**
 * Resolves the proxy input, reading the ledger when there is one.
 *
 * NEVER THROWS. A savings report whose first input read fine must still print;
 * the proxy half degrades to a named state instead of taking the command's
 * exit code with it. The reason text is the error's own message, which is a
 * local path at worst -- the same class of detail `token-optimizer-inspect`
 * already prints -- and it goes to the caller's terminal only.
 */
export async function loadProxyInput(
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly now?: Date;
    readonly path?: string | null;
  } = {}
): Promise<ProxyInput> {
  const path =
    options.path === undefined
      ? accountingPath(options.env ?? process.env)
      : options.path;
  if (path === null || path === '') return { kind: PROXY_INPUT.NotConfigured };
  try {
    const report = await readProxySavings(path, options.now ?? new Date());
    return { kind: PROXY_INPUT.Read, path, report };
  } catch (error) {
    if (isMissingFile(error)) return { kind: PROXY_INPUT.Missing, path };
    return {
      kind: PROXY_INPUT.Unreadable,
      path,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
