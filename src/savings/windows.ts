/**
 * Windowed, priced savings over the analytics ledger.
 *
 * WHY THIS IS NOT THE MCP REPORT. `get_optimization_report` answers "what has
 * token-optimizer saved, broken down by tool, hook and server" over a date
 * range the caller has to supply. The question an operator actually asks is the
 * other one -- "what did it save me today, this week, this month, and what was
 * that worth" -- and nothing in this package answered it. The breakdowns here
 * are by MODEL and by CLIENT for the same reason: those are the two dimensions
 * a bill is denominated in.
 *
 * THE PROVENANCE GATE IS INHERITED, NOT RELAXED. Every number below is built
 * from `verifiedTransportDelta`, which is zero for any row that cannot prove a
 * before-state from two materialized payloads, and from `priceTokenUsage`,
 * which refuses a model it does not have an exact catalog entry for. So a
 * window can legitimately report tokens saved and no dollar figure, and that
 * pair is reported as it is rather than averaged into something presentable.
 *
 * THE WINDOWS NEST; THEY DO NOT PARTITION. Today is inside the last 7 days is
 * inside the last 30. Summing them double-counts, which is exactly the mistake
 * a reader makes with a column of numbers that look like buckets, so the label
 * on each one says "last N days" and `since` is carried alongside.
 */

import {
  priceTokenUsage,
  type PriceCurrency,
} from '../analytics/provider-pricing.js';
import { verifiedTransportDelta } from '../analytics/savings-classification.js';
import type { AnalyticsEntry } from '../analytics/analytics-types.js';

/** The group name used for a row that carries no attribution of its own. */
export const UNATTRIBUTED = '(unattributed)';

/**
 * The dollar value of one row's verified transport delta, or null.
 *
 * ONE IMMEDIATE UNCACHED-INPUT EQUIVALENT, which is the same definition
 * `get_optimization_report` publishes, and this is deliberately the only copy
 * of it: two copies of a pricing rule drift, and the one that drifts is always
 * the one nobody is looking at.
 *
 * NULL IS NOT ZERO. A model with no exact catalog entry has an unknown price,
 * and folding it in at zero would make a report look cheaper the less it knew.
 */
export function priceVerifiedDelta(entry: AnalyticsEntry): number | null {
  const tokens = verifiedTransportDelta(entry);
  if (tokens === 0) return null;
  const metadata = entry.metadata || {};
  const priced = priceTokenUsage({
    client: entry.client || String(metadata.client || ''),
    provider: String(metadata.provider || ''),
    route: String(metadata.pricingRoute || metadata.route || ''),
    model: entry.model || String(metadata.model || ''),
    timestamp: entry.timestamp,
    usage: { uncachedInputTokens: Math.abs(tokens) },
  });
  const usd: PriceCurrency = 'USD';
  if (!priced.available || priced.currency !== usd || priced.amount === null) {
    return null;
  }
  return Math.sign(tokens) * priced.amount;
}

export interface SavingsWindow {
  readonly label: string;
  /** ISO instant the window opens at, or null for all time. */
  readonly since: string | null;
  readonly operations: number;
  readonly tokensSaved: number;
  readonly tokensBefore: number;
  readonly savingsPercent: number;
  readonly costUsd: number | null;
  readonly pricedOperations: number;
  readonly eligibleOperations: number;
}

export interface SavingsGroup {
  readonly name: string;
  readonly operations: number;
  readonly tokensSaved: number;
  readonly costUsd: number | null;
  readonly pricedOperations: number;
  readonly eligibleOperations: number;
}

export interface SavingsReport {
  readonly windows: readonly SavingsWindow[];
  readonly byModel: readonly SavingsGroup[];
  readonly byClient: readonly SavingsGroup[];
  /** Every row in the ledger, including the ones no claim is built on. */
  readonly totalEntries: number;
  /** Rows that cleared the provenance gate in one direction or the other. */
  readonly eligibleEntries: number;
  /** Model ids an eligible row named that the catalog has no price for. */
  readonly unpricedModels: readonly string[];
}

/**
 * Midnight at the start of `now`'s LOCAL day.
 *
 * LOCAL, NOT UTC, and the difference is not cosmetic. Entries are stamped in
 * UTC, so a UTC day boundary would put an operator in UTC-7 into "tomorrow" at
 * 5pm: they would run the command after an afternoon's work and be told they
 * had saved nothing today, while the work sat in a window labelled for a day
 * that had not started where they were. The boundary a person means by "today"
 * is the one on their own clock.
 */
export function startOfLocalDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
}

/**
 * CALENDAR DAYS, NOT ROLLING HOURS. "Last 7 days" opens at the start of the
 * local day six days back, so it covers seven days including today -- which is
 * what the phrase means to a reader and what makes two runs an hour apart
 * report the same window rather than a silently sliding one.
 */
export function windowBoundaries(
  now: Date
): readonly { readonly label: string; readonly since: Date | null }[] {
  const today = startOfLocalDay(now);
  const back = (days: number): Date => {
    const start = new Date(today.getTime());
    start.setDate(start.getDate() - days);
    return start;
  };
  return Object.freeze([
    { label: 'Today', since: today },
    { label: 'Last 7 days', since: back(6) },
    { label: 'Last 30 days', since: back(29) },
    { label: 'All time', since: null },
  ]);
}

/**
 * Accumulates one window or one group from the same rules.
 *
 * `tokensBefore` IS TAKEN FROM THE SAME ROWS AS `tokensSaved`, never from the
 * whole ledger. A percentage whose numerator comes from the verified rows and
 * whose denominator comes from every row would fall as more unverifiable
 * traffic arrived, reading as the compressor getting worse at exactly the
 * moment it was being told less about.
 */
function accumulate(entries: readonly AnalyticsEntry[]): {
  operations: number;
  tokensSaved: number;
  tokensBefore: number;
  costUsd: number | null;
  pricedOperations: number;
  eligibleOperations: number;
} {
  let operations = 0;
  let tokensSaved = 0;
  let tokensBefore = 0;
  let cost = 0;
  let pricedOperations = 0;
  let eligibleOperations = 0;
  for (const entry of entries) {
    operations += 1;
    const delta = verifiedTransportDelta(entry);
    if (delta === 0) continue;
    eligibleOperations += 1;
    tokensSaved += delta;
    tokensBefore += Math.max(0, Number(entry.originalTokens) || 0);
    const priced = priceVerifiedDelta(entry);
    if (priced === null) continue;
    cost += priced;
    pricedOperations += 1;
  }
  return {
    operations,
    tokensSaved,
    tokensBefore,
    costUsd: pricedOperations > 0 ? cost : null,
    pricedOperations,
    eligibleOperations,
  };
}

function percent(saved: number, before: number): number {
  return before > 0 ? (saved / before) * 100 : 0;
}

export function summarize(
  entries: readonly AnalyticsEntry[],
  label: string,
  since: Date | null
): SavingsWindow {
  const inWindow =
    since === null
      ? entries
      : entries.filter((entry) => {
          const at = Date.parse(entry.timestamp);
          // AN UNPARSEABLE STAMP IS OUT OF EVERY DATED WINDOW, not silently in
          // all of them: it cannot be placed, and placing it anyway would move
          // a number an operator reads as a day's work.
          return Number.isFinite(at) && at >= since.getTime();
        });
  const totals = accumulate(inWindow);
  return Object.freeze({
    label,
    since: since === null ? null : since.toISOString(),
    operations: totals.operations,
    tokensSaved: totals.tokensSaved,
    tokensBefore: totals.tokensBefore,
    savingsPercent: percent(totals.tokensSaved, totals.tokensBefore),
    costUsd: totals.costUsd,
    pricedOperations: totals.pricedOperations,
    eligibleOperations: totals.eligibleOperations,
  });
}

/**
 * Groups by one attribution, dropping the rows no claim is built on.
 *
 * ROWS WITH NO VERIFIED DELTA ARE LEFT OUT OF THE GROUPS ENTIRELY, which is
 * the opposite of the windows above. A window is a period and has to account
 * for everything that happened in it; a breakdown by model exists to say where
 * a saving came from, and a model whose every row failed the gate contributed
 * none -- listing it at zero would read as a model the compressor cannot help,
 * when what happened is that nothing was measurable.
 */
export function groupBy(
  entries: readonly AnalyticsEntry[],
  key: (entry: AnalyticsEntry) => string
): readonly SavingsGroup[] {
  const buckets = new Map<string, AnalyticsEntry[]>();
  for (const entry of entries) {
    if (verifiedTransportDelta(entry) === 0) continue;
    const name = key(entry).trim() || UNATTRIBUTED;
    const bucket = buckets.get(name);
    if (bucket === undefined) buckets.set(name, [entry]);
    else bucket.push(entry);
  }
  const rows: SavingsGroup[] = [];
  for (const [name, bucket] of buckets) {
    const totals = accumulate(bucket);
    rows.push(
      Object.freeze({
        name,
        operations: totals.operations,
        tokensSaved: totals.tokensSaved,
        costUsd: totals.costUsd,
        pricedOperations: totals.pricedOperations,
        eligibleOperations: totals.eligibleOperations,
      })
    );
  }
  // Largest saving first, then by name so two equal rows keep a stable order
  // across runs -- a report that reshuffles itself is one nobody can diff.
  rows.sort(
    (a, b) => b.tokensSaved - a.tokensSaved || a.name.localeCompare(b.name)
  );
  return Object.freeze(rows);
}

/**
 * The model ids an eligible row named that no catalog entry prices.
 *
 * NAMED, NOT COUNTED. `(8/12 priced)` tells an operator that a third of the
 * dollar figure is missing without telling them what to do about it, and the
 * model id is the one fact that makes it actionable. A per-model breakdown
 * carries the same fact only while the row survives the top-N truncation,
 * which is exactly the case where the unpriced model is the small one.
 *
 * NO FALLBACK RATE, EVER. Pricing an unknown model at some default -- the
 * obvious way to make this note unnecessary -- would hand back a dollar figure
 * nobody was ever charged, indistinguishable in the output from a measured
 * one. An absent number can be chased; a fabricated one cannot be detected.
 */
export function unpricedModels(
  entries: readonly AnalyticsEntry[]
): readonly string[] {
  const names = new Set<string>();
  for (const entry of entries) {
    if (verifiedTransportDelta(entry) === 0) continue;
    if (priceVerifiedDelta(entry) !== null) continue;
    const metadata = entry.metadata || {};
    names.add(
      String(entry.model || metadata.model || '').trim() || UNATTRIBUTED
    );
  }
  return Object.freeze([...names].sort());
}

export function buildReport(
  entries: readonly AnalyticsEntry[],
  now: Date = new Date()
): SavingsReport {
  return Object.freeze({
    windows: Object.freeze(
      windowBoundaries(now).map((bound) =>
        summarize(entries, bound.label, bound.since)
      )
    ),
    byModel: groupBy(entries, (entry) =>
      String(entry.model || (entry.metadata || {}).model || '')
    ),
    byClient: groupBy(entries, (entry) =>
      String(entry.client || (entry.metadata || {}).client || '')
    ),
    totalEntries: entries.length,
    eligibleEntries: entries.filter(
      (entry) => verifiedTransportDelta(entry) !== 0
    ).length,
    unpricedModels: unpricedModels(entries),
  });
}
