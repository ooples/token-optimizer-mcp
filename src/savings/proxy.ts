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
  priceProxyDelta,
  proxyCalibration,
  proxyTokensBefore,
  proxyTransportDelta,
  PROXY_SAVINGS,
} from '../analytics/proxy-savings.js';
import { accountingPath, type AccountingRecord } from '../proxy/accounting.js';
import { looksLikeRecord } from '../inspect/ledger.js';
import {
  UNATTRIBUTED,
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
}

/** One window's running totals. Mutable by design: this is a fold. */
interface Totals {
  requests: number;
  billedRequests: number;
  countedRequests: number;
  pricedRequests: number;
  calibratedRequests: number;
  tokensSaved: number;
  tokensBefore: number;
  cost: number;
  oursTokens: number;
  billedTokens: number;
}

function emptyTotals(): Totals {
  return {
    requests: 0,
    billedRequests: 0,
    countedRequests: 0,
    pricedRequests: 0,
    calibratedRequests: 0,
    tokensSaved: 0,
    tokensBefore: 0,
    cost: 0,
    oursTokens: 0,
    billedTokens: 0,
  };
}

/**
 * Folds one record into one set of totals.
 *
 * `tokensBefore` COMES FROM THE SAME ROWS AS `tokensSaved`, which is the rule
 * `windows.ts` already follows: a percentage whose numerator is the measured
 * rows and whose denominator is every row would fall as more unmeasurable
 * traffic arrived, reading as the proxy getting worse at the moment it was
 * being told less.
 */
function fold(totals: Totals, record: AccountingRecord): void {
  totals.requests += 1;
  const classification = classifyProxySavings(record);
  if (classification === PROXY_SAVINGS.Unbilled) return;
  totals.billedRequests += 1;
  if (classification === PROXY_SAVINGS.Uncounted) return;
  totals.countedRequests += 1;
  const calibration = proxyCalibration(record);
  if (calibration !== null) {
    totals.calibratedRequests += 1;
    totals.oursTokens += calibration.ours;
    totals.billedTokens += calibration.billed;
  }
  const delta = proxyTransportDelta(record);
  if (delta === 0) return;
  totals.tokensSaved += delta;
  totals.tokensBefore += proxyTokensBefore(record);
  const priced = priceProxyDelta(record);
  if (priced === null) return;
  totals.cost += priced;
  totals.pricedRequests += 1;
}

function percent(saved: number, before: number): number {
  return before > 0 ? (saved / before) * 100 : 0;
}

function freezeWindow(
  label: string,
  since: Date | null,
  totals: Totals
): ProxySavingsWindow {
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
  });
}

export interface ProxyAggregator {
  add(record: AccountingRecord): void;
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
  }));
  const models = new Map<string, Totals>();
  let totalRecords = 0;
  let measuredRecords = 0;
  let unbilledRecords = 0;
  let uncountedRecords = 0;
  let skippedLines = 0;

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
        if (window.since === null) fold(window.totals, record);
        else if (Number.isFinite(at) && at >= window.since.getTime())
          fold(window.totals, record);
      }
      if (delta === 0) return;
      const name = (record.model ?? '').trim() || UNATTRIBUTED;
      let bucket = models.get(name);
      if (bucket === undefined) {
        bucket = emptyTotals();
        models.set(name, bucket);
      }
      fold(bucket, record);
    },
    skip(): void {
      skippedLines += 1;
    },
    report(): ProxySavingsReport {
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
      byModel.sort(
        (a, b) => b.tokensSaved - a.tokensSaved || a.name.localeCompare(b.name)
      );
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
            freezeWindow(window.label, window.since, window.totals)
          )
        ),
        byModel: Object.freeze(byModel),
        totalRecords,
        measuredRecords,
        unbilledRecords,
        uncountedRecords,
        skippedLines,
        unpricedModels: Object.freeze(unpriced),
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
