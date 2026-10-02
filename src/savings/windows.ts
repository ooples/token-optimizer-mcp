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
// TYPE ONLY, AND IT HAS TO STAY THAT WAY: the fold imports this module for its
// pricing, so a value import here would close a cycle between the two.
import type { AnalyticsRollup } from '../analytics/analytics-rollup.js';

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
  return priceEntryTokens(entry, tokens);
}

/**
 * What a token count on one row costs as uncached input, at that row's rate.
 *
 * ONE FUNCTION FOR EVERY SURFACE THAT PRICES A ROW. The savings report prices
 * the verified delta; the dashboard also prices the context a row returned. If
 * each kept its own copy of this, a correction to the request shape -- which
 * provider, which route, which request-time tier -- would land on one surface
 * and not the other, and the two would quietly stop agreeing about the same
 * row.
 *
 * THE SIGN TRAVELS SEPARATELY FROM THE RATE, because a tier is chosen by the
 * size of a request and a negative count is not a smaller request. The
 * magnitude is priced and the direction is reapplied afterwards.
 */
export function priceEntryTokens(
  entry: AnalyticsEntry,
  tokens: number
): number | null {
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
  return (tokens < 0 ? -1 : 1) * priced.amount;
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
  /**
   * The before-state of the SAME rows `tokensSaved` came from.
   *
   * A GROUP CAN BE HELD TO A PERCENTAGE ONLY IF IT CARRIES ITS OWN
   * DENOMINATOR. Without this field the only honest question to ask of a
   * client is "did it save anything at all", and a gate built on that would
   * pass a client whose traffic we barely touched.
   */
  readonly tokensBefore: number;
  /** `tokensSaved` over `tokensBefore`, by the same rule the windows use. */
  readonly savingsPercent: number;
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
  /**
   * How much of the report above came from days that are no longer rows.
   *
   * DISCLOSED, BECAUSE IT CHANGES WHAT ELSE CAN BE ASKED. The figures are the
   * same either way -- that is the point of folding rather than deleting --
   * but a folded day can no longer be filtered by session or exported row by
   * row, and an operator who cannot see that a day was folded would read an
   * empty session query as an empty day.
   */
  readonly foldedOperations: number;
  /** Local days the figures above drew from totals rather than rows. */
  readonly foldedDays: number;
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
 * The local calendar day a stamp falls in, as `YYYY-MM-DD`.
 *
 * LOCAL, NOT UTC, because the report's windows are local days. A UTC key would
 * put the evening's requests in tomorrow for anyone east of Greenwich, and a
 * folded day would then straddle a boundary that the raw rows did not.
 */
export function localDayKey(at: Date): string {
  const year = at.getFullYear();
  const month = `${at.getMonth() + 1}`.padStart(2, '0');
  const day = `${at.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Midnight that opens a `YYYY-MM-DD` key, in local time, or null if unparseable. */
export function startOfDayKey(key: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const at = new Date(year, month - 1, day, 0, 0, 0, 0);
  // A ROUND TRIP, NOT A RANGE CHECK: `new Date(2026, 1, 31)` is March 3rd, and
  // only comparing the parts back catches a key that named a day that is not
  // one. The report would otherwise fold a day into a window it never fell in.
  if (
    at.getFullYear() !== year ||
    at.getMonth() !== month - 1 ||
    at.getDate() !== day
  ) {
    return null;
  }
  return at;
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
function accumulate(
  entries: readonly AnalyticsEntry[],
  rollups: readonly AnalyticsRollup[] = []
): {
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
  for (const folded of rollups) {
    // A FOLDED GROUP IS ALREADY CLASSIFIED AND ALREADY PRICED, so there is
    // nothing per-row left to decide here: the arithmetic above ran once, at
    // fold time, on the rows this group replaced. Re-deciding anything would
    // mean deciding it from a sum, which is the mistake the fold key exists to
    // make impossible.
    operations += folded.operations;
    eligibleOperations += folded.eligibleOperations;
    tokensSaved += folded.tokensSaved;
    tokensBefore += folded.tokensBefore;
    cost += folded.costUsd;
    pricedOperations += folded.pricedOperations;
  }
  return {
    operations,
    tokensSaved,
    tokensBefore,
    costUsd: pricedOperations > 0 ? usd(cost) : null,
    pricedOperations,
    eligibleOperations,
  };
}

/**
 * A dollar figure the report can publish.
 *
 * QUANTIZED BECAUSE ADDITION IN BINARY FLOATING POINT IS NOT ASSOCIATIVE. The
 * same set of priced rows summed in a different order lands a few parts in
 * 10^15 apart, so without this the report's own total depends on the order the
 * rows came back in -- and once a day is folded, the fold sums that day first
 * and the window adds one term where it used to add hundreds. Two readings of
 * the same history would then disagree in the last digits, which is exactly
 * the kind of disagreement nobody can explain and everybody distrusts.
 *
 * TEN DECIMALS, which is a ten-billionth of a dollar: far below the smallest
 * real price in the catalog and far above the noise being removed.
 */
/**
 * The last word in a group ordering, so a tie has one answer everywhere.
 *
 * CODE POINTS, NOT `localeCompare`. Two models that saved the same number of
 * tokens compared equal, and the order then came from whatever collation the
 * host's locale supplies -- so the same ledger printed its table in a different
 * order on a different machine, with every figure identical. A published table
 * whose row order moves for no visible reason is read as the figures having
 * moved.
 */
export function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export function usd(amount: number): number {
  return Math.round(amount * 1e10) / 1e10;
}

function percent(saved: number, before: number): number {
  return before > 0 ? (saved / before) * 100 : 0;
}

/**
 * The rows a dated window covers.
 *
 * AN UNPARSEABLE STAMP IS OUT OF EVERY DATED WINDOW, not silently in all of
 * them: it cannot be placed, and placing it anyway would move a number an
 * operator reads as a day's work.
 *
 * ONE DEFINITION, because both the windows and the savings gate ask this same
 * question. A gate that filtered rows its own way would eventually hold a
 * client to a period the report never showed.
 */
export function withinWindow(
  entries: readonly AnalyticsEntry[],
  since: Date | null
): readonly AnalyticsEntry[] {
  if (since === null) return entries;
  return entries.filter((entry) => {
    const at = Date.parse(entry.timestamp);
    return Number.isFinite(at) && at >= since.getTime();
  });
}

/**
 * The folded days a dated window covers.
 *
 * A FOLDED DAY IS IN OR OUT WHOLE. Every dated window opens at a local
 * midnight and a fold never spans two local days, so the day it names is
 * either entirely inside this window or entirely outside it -- which is what
 * makes a day the exact grain rather than an approximate one.
 */
export function foldedWithin(
  rollups: readonly AnalyticsRollup[],
  since: Date | null
): readonly AnalyticsRollup[] {
  if (since === null) return rollups;
  return rollups.filter((folded) => {
    const start = startOfDayKey(folded.day);
    return start !== null && start.getTime() >= since.getTime();
  });
}

export function summarize(
  entries: readonly AnalyticsEntry[],
  label: string,
  since: Date | null,
  rollups: readonly AnalyticsRollup[] = []
): SavingsWindow {
  const totals = accumulate(
    withinWindow(entries, since),
    foldedWithin(rollups, since)
  );
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
  key: (entry: AnalyticsEntry) => string,
  folded: {
    readonly rollups: readonly AnalyticsRollup[];
    readonly key: (rollup: AnalyticsRollup) => string;
  } = { rollups: [], key: () => '' }
): readonly SavingsGroup[] {
  const buckets = new Map<string, AnalyticsEntry[]>();
  for (const entry of entries) {
    if (verifiedTransportDelta(entry) === 0) continue;
    const name = key(entry).trim() || UNATTRIBUTED;
    const bucket = buckets.get(name);
    if (bucket === undefined) buckets.set(name, [entry]);
    else bucket.push(entry);
  }
  // THE SAME GATE, ON THE FOLDED SIDE. A group whose every row failed the
  // provenance gate contributed no eligible operations, so it is left out here
  // exactly as its rows would have been -- otherwise a breakdown would start
  // listing models at zero the moment their rows aged out.
  const foldedBuckets = new Map<string, AnalyticsRollup[]>();
  for (const rollup of folded.rollups) {
    if (rollup.eligibleOperations === 0) continue;
    const name = folded.key(rollup).trim() || UNATTRIBUTED;
    const bucket = foldedBuckets.get(name);
    if (bucket === undefined) foldedBuckets.set(name, [rollup]);
    else bucket.push(rollup);
  }
  const rows: SavingsGroup[] = [];
  for (const name of new Set([...buckets.keys(), ...foldedBuckets.keys()])) {
    const bucket = buckets.get(name) ?? [];
    const totals = accumulate(bucket, foldedBuckets.get(name) ?? []);
    rows.push(
      Object.freeze({
        name,
        operations: totals.operations,
        tokensSaved: totals.tokensSaved,
        tokensBefore: totals.tokensBefore,
        savingsPercent: percent(totals.tokensSaved, totals.tokensBefore),
        costUsd: totals.costUsd,
        pricedOperations: totals.pricedOperations,
        eligibleOperations: totals.eligibleOperations,
      })
    );
  }
  // Largest saving first, then by name so two equal rows keep a stable order
  // across runs -- a report that reshuffles itself is one nobody can diff.
  rows.sort((a, b) => b.tokensSaved - a.tokensSaved || byName(a, b));
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
  entries: readonly AnalyticsEntry[],
  rollups: readonly AnalyticsRollup[] = []
): readonly string[] {
  const names = new Set<string>();
  for (const folded of rollups) {
    // THE COUNT IS WHAT SURVIVES THE FOLD, not the per-row verdict: a group
    // whose eligible rows all failed to price is exactly a model this note has
    // to keep naming, and the fold stored how many did.
    if (folded.unpricedOperations === 0) continue;
    names.add(folded.model.trim() || UNATTRIBUTED);
  }
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

/**
 * The whole report, from live rows and from whatever has been folded away.
 *
 * THE FOLDED DAYS ARE PART OF EVERY FIGURE, not a footnote beside them. The
 * alternative -- rows for the recent window and a note saying older work
 * existed -- is the failure this policy was written to avoid: a product that
 * reports less the longer it runs, because the evidence of its own work was
 * deleted to save a disk.
 */
export function buildReport(
  entries: readonly AnalyticsEntry[],
  now: Date = new Date(),
  rollups: readonly AnalyticsRollup[] = []
): SavingsReport {
  let foldedOperations = 0;
  let foldedEligible = 0;
  const foldedDays = new Set<string>();
  for (const folded of rollups) {
    foldedOperations += folded.operations;
    foldedEligible += folded.eligibleOperations;
    foldedDays.add(folded.day);
  }
  return Object.freeze({
    windows: Object.freeze(
      windowBoundaries(now).map((bound) =>
        summarize(entries, bound.label, bound.since, rollups)
      )
    ),
    byModel: groupBy(
      entries,
      (entry) => String(entry.model || (entry.metadata || {}).model || ''),
      { rollups, key: (folded) => folded.model }
    ),
    byClient: groupBy(
      entries,
      (entry) => String(entry.client || (entry.metadata || {}).client || ''),
      { rollups, key: (folded) => folded.client }
    ),
    totalEntries: entries.length + foldedOperations,
    eligibleEntries:
      entries.filter((entry) => verifiedTransportDelta(entry) !== 0).length +
      foldedEligible,
    unpricedModels: unpricedModels(entries, rollups),
    foldedOperations,
    foldedDays: foldedDays.size,
  });
}
