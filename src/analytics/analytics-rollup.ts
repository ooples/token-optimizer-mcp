/**
 * One folded day of analytics rows, and the arithmetic that folds them.
 *
 * WHY A DAY OF ROWS CAN BECOME ONE ROW AT ALL. The savings report classifies
 * every row on its own -- `classifySavings` reads content hashes, byte counts
 * and a schema version off the row's metadata and returns one of four classes
 * -- and then adds up only what the class allows. So a sum of tokens is NOT
 * enough to reproduce the report: two rows with the same tokens and different
 * classes contribute different amounts.
 *
 * The fold key is what makes it exact. A group fixes the day, the dimensions
 * every reader groups by, and the CLASSIFICATION, so within a group every row
 * contributes the same way and the contributions add. What is stored is the
 * result of the row-level arithmetic, not the inputs to it.
 *
 * PRICE IS SUMMED AT FOLD TIME, PER ROW, and that is deliberate on two counts.
 * Pricing is not linear in tokens -- a long-context tier charges a higher rate
 * past a per-request threshold -- so pricing a group's summed tokens once would
 * read as a request nobody made. And a figure already reported should not move
 * when a vendor changes a rate: the fold is where history stops being
 * re-derived and starts being remembered.
 */

import type { AnalyticsEntry } from './analytics-types.js';
import {
  classifySavings,
  hasObservedReturnedContext,
  reportedSavings,
  verifiedTransportDelta,
  type SavingsClassification,
} from './savings-classification.js';
import {
  localDayKey,
  priceVerifiedDelta,
  UNATTRIBUTED,
} from '../savings/windows.js';

/** The dimensions a fold may not mix, because a reader groups by them. */
export interface RollupKey {
  /** Local calendar day, `YYYY-MM-DD`. */
  readonly day: string;
  readonly hookPhase: string;
  readonly toolName: string;
  readonly mcpServer: string;
  readonly client: string;
  readonly clientVersion: string;
  readonly model: string;
  readonly modelVersion: string;
  /** From metadata, and kept because pricing and its disclosure name it. */
  readonly provider: string;
  readonly route: string;
  /** What `classifySavings` returned for every row in this group. */
  readonly classification: SavingsClassification;
}

/** What a folded group contributes to every figure the readers compute. */
export interface RollupSums {
  /** Rows folded. This is the report's operation count. */
  readonly operations: number;
  /** Rows whose verified delta was not zero. */
  readonly eligibleOperations: number;
  /** Signed sum of `verifiedTransportDelta`, which is the report's savings. */
  readonly tokensSaved: number;
  /** `originalTokens` over the eligible rows only, as the report does it. */
  readonly tokensBefore: number;
  /** Over every row, for the surfaces that show gross traffic. */
  readonly originalTokens: number;
  readonly optimizedTokens: number;
  /** Sum of `reportedSavings`, the unverified figure shown beside the real one. */
  readonly reportedSavings: number;
  /** Rows that carried an observed return, whatever their class. */
  readonly observedReturns: number;
  /** USD over the rows that priced, summed one row at a time. */
  readonly costUsd: number;
  readonly pricedOperations: number;
  /** Eligible rows no catalog could price -- what keeps a model disclosed. */
  readonly unpricedOperations: number;
  /** Earliest row in the group, kept so a fold can be audited against rows. */
  readonly firstTimestamp: string;
}

/** A folded day: the dimensions, and what they contributed. */
export interface AnalyticsRollup extends RollupKey, RollupSums {}

/**
 * The local calendar day a timestamp falls in, as `YYYY-MM-DD`.
 *
 * THE SAME KEY THE PROXY HALF USES, from the same function, because the two
 * stores are read side by side: a window that meant one thing for one of them
 * and something else for the other would make the report's own totals
 * disagree across the boundary between them.
 */
export function localDayOf(timestamp: string): string | null {
  const at = new Date(timestamp);
  if (!Number.isFinite(at.getTime())) return null;
  return localDayKey(at);
}

function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim();
}

/**
 * The group one row belongs to.
 *
 * EVERY DIMENSION A READER GROUPS BY IS HERE, and the cost of being wrong is
 * asymmetric: a dimension left out silently merges two groups a report shows
 * apart, while one left in only costs a row.
 */
export function rollupKeyOf(entry: AnalyticsEntry): RollupKey | null {
  const day = localDayOf(entry.timestamp);
  if (day === null) return null;
  const metadata = entry.metadata ?? {};
  return {
    day,
    hookPhase: text(entry.hookPhase),
    toolName: text(entry.toolName),
    mcpServer: text(entry.mcpServer),
    client: text(entry.client || metadata.client),
    clientVersion: text(entry.clientVersion),
    model: text(entry.model || metadata.model),
    modelVersion: text(entry.modelVersion),
    provider: text(metadata.provider),
    route: text(metadata.pricingRoute || metadata.route),
    classification: classifySavings(entry),
  };
}

/** One string that identifies a group, for grouping in memory. */
export function rollupKeyText(key: RollupKey): string {
  // A TAB CANNOT APPEAR IN ANY OF THESE. Every part is either a local day, an
  // identifier, or a name `text()` has trimmed, so joining on a tab cannot
  // make two different groups collide into one key.
  return [
    key.day,
    key.hookPhase,
    key.toolName,
    key.mcpServer,
    key.client,
    key.clientVersion,
    key.model,
    key.modelVersion,
    key.provider,
    key.route,
    key.classification,
  ].join('\t');
}

/** Zero of the fold. */
export function emptySums(firstTimestamp: string): RollupSums {
  return {
    operations: 0,
    eligibleOperations: 0,
    tokensSaved: 0,
    tokensBefore: 0,
    originalTokens: 0,
    optimizedTokens: 0,
    reportedSavings: 0,
    observedReturns: 0,
    costUsd: 0,
    pricedOperations: 0,
    unpricedOperations: 0,
    firstTimestamp,
  };
}

function nonNegative(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

/**
 * Adds one row to a group's sums.
 *
 * THE ORDER OF THE CHECKS MIRRORS `accumulate` IN THE REPORT, deliberately: a
 * row with a zero delta counts as an operation and contributes nothing else,
 * including no `tokensBefore`. Folding its original tokens in anyway would
 * raise the denominator of every savings percentage for the folded days and
 * show the product getting worse with age.
 */
export function foldEntry(sums: RollupSums, entry: AnalyticsEntry): RollupSums {
  const delta = verifiedTransportDelta(entry);
  const priced = delta === 0 ? null : priceVerifiedDelta(entry);
  const earlier =
    sums.operations === 0 ||
    Date.parse(entry.timestamp) < Date.parse(sums.firstTimestamp);
  return {
    operations: sums.operations + 1,
    eligibleOperations: sums.eligibleOperations + (delta === 0 ? 0 : 1),
    tokensSaved: sums.tokensSaved + delta,
    tokensBefore:
      sums.tokensBefore + (delta === 0 ? 0 : nonNegative(entry.originalTokens)),
    originalTokens: sums.originalTokens + nonNegative(entry.originalTokens),
    optimizedTokens: sums.optimizedTokens + nonNegative(entry.optimizedTokens),
    reportedSavings: sums.reportedSavings + reportedSavings(entry),
    observedReturns:
      sums.observedReturns + (hasObservedReturnedContext(entry) ? 1 : 0),
    costUsd: sums.costUsd + (priced ?? 0),
    pricedOperations: sums.pricedOperations + (priced === null ? 0 : 1),
    unpricedOperations:
      sums.unpricedOperations + (delta !== 0 && priced === null ? 1 : 0),
    firstTimestamp: earlier ? entry.timestamp : sums.firstTimestamp,
  };
}

/** Merges two folds of the same group, which is what a second prune does. */
export function mergeSums(into: RollupSums, from: RollupSums): RollupSums {
  return {
    operations: into.operations + from.operations,
    eligibleOperations: into.eligibleOperations + from.eligibleOperations,
    tokensSaved: into.tokensSaved + from.tokensSaved,
    tokensBefore: into.tokensBefore + from.tokensBefore,
    originalTokens: into.originalTokens + from.originalTokens,
    optimizedTokens: into.optimizedTokens + from.optimizedTokens,
    reportedSavings: into.reportedSavings + from.reportedSavings,
    observedReturns: into.observedReturns + from.observedReturns,
    costUsd: into.costUsd + from.costUsd,
    pricedOperations: into.pricedOperations + from.pricedOperations,
    unpricedOperations: into.unpricedOperations + from.unpricedOperations,
    firstTimestamp:
      Date.parse(into.firstTimestamp) <= Date.parse(from.firstTimestamp)
        ? into.firstTimestamp
        : from.firstTimestamp,
  };
}

/** Folds a batch of rows into one rollup per group. */
export function foldEntries(
  entries: readonly AnalyticsEntry[]
): AnalyticsRollup[] {
  const groups = new Map<string, { key: RollupKey; sums: RollupSums }>();
  for (const entry of entries) {
    const key = rollupKeyOf(entry);
    // A ROW WITH NO READABLE TIMESTAMP HAS NO DAY, so there is no window it
    // could be folded into. It is left where it is rather than guessed at.
    if (key === null) continue;
    const id = rollupKeyText(key);
    const group = groups.get(id) ?? {
      key,
      sums: emptySums(entry.timestamp),
    };
    groups.set(id, { key: group.key, sums: foldEntry(group.sums, entry) });
  }
  return [...groups.values()].map(({ key, sums }) => ({ ...key, ...sums }));
}

/** The model name a folded group discloses when nothing could price it. */
export function rollupModelName(rollup: AnalyticsRollup): string {
  return rollup.model || UNATTRIBUTED;
}
