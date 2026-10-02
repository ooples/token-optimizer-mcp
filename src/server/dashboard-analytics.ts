import path from 'path';
import os from 'os';
import fs from 'fs';
import { AnalyticsManager } from '../analytics/analytics-manager.js';
import { SqliteAnalyticsStorage } from '../analytics/analytics-storage.js';
import type { AnalyticsEntry } from '../analytics/analytics-types.js';
import type { AnalyticsRollup } from '../analytics/analytics-rollup.js';
import { schemaVersionOf } from '../analytics/analytics-rollup.js';
import {
  SAVINGS_MEASUREMENT_SCHEMA_VERSION,
  classifySavings,
  hasObservedReturnedContext,
  isVerifiedSavingsEntry,
  isVerifiedExpansionDebit,
  reportedSavings,
  verifiedTransportDelta,
  declaredInputDisplacement,
  verifiedInputDisplacement,
  type SavingsClassification,
} from '../analytics/savings-classification.js';
import {
  MODEL_PRICE_CATALOG,
  priceTokenUsage,
} from '../analytics/provider-pricing.js';
import {
  readNativeProviderUsage,
  summarizeProviderUsage,
  type ProviderUsageSummary,
} from '../analytics/native-provider-usage.js';

let dashboardCache: {
  key: string;
  expiresAt: number;
  report: DashboardAnalyticsReport;
} | null = null;

interface EffectivePricing {
  available: boolean;
  effectiveInputUsdPerMillion: number | null;
  source: 'versioned-provider-model-catalog';
  verifiedAt: string;
  explanation: string;
}

export interface DashboardActionAnalytics {
  name: string;
  totalOperations: number;
  totalOriginalTokens: number;
  totalOptimizedTokens: number;
  totalTokensSaved: number;
  grossTokensSaved: number;
  expansionTokensReturned: number;
  unverifiedReportedTokensSaved: number;
  savingsPercentage: number | null;
  contextUsd: number | null;
  savedUsd: number | null;
  firstSeen: string;
  lastSeen: string;
  measuredSavingsOperations: number;
  pricedReturnedContextOperations: number;
  pricedSavingsOperations: number;
  verifiedExpansionOperations: number;
  unmeasuredSavingsOperations: number;
  observedReturnedContextOperations: number;
  unverifiedReportedOperations: number;
}

export interface DashboardAnalyticsReport {
  schemaVersion: 3;
  available: boolean;
  source: string;
  pricing: EffectivePricing;
  summary: {
    totalOperations: number;
    totalOriginalTokens: number;
    totalOptimizedTokens: number;
    measuredOptimizedTokens: number;
    totalTokensSaved: number;
    grossTokensSaved: number;
    expansionTokensReturned: number;
    unverifiedReportedTokensSaved: number;
    savingsPercentage: number | null;
    contextUsd: number | null;
    savedUsd: number | null;
    firstSeen: string | null;
    lastSeen: string | null;
    measuredSavingsOperations: number;
    pricedReturnedContextOperations: number;
    pricedSavingsOperations: number;
    verifiedExpansionOperations: number;
    unmeasuredSavingsOperations: number;
    actualReturnedContextOperations: number;
    legacyReportedContextOperations: number;
    observedReturnedContextOperations: number;
    unverifiedReportedOperations: number;
    /**
     * Operations that live in folded day totals rather than in rows.
     *
     * DISCLOSED BECAUSE `recent` CANNOT BE FOLDED. Every total above is exact
     * across the fold, so nothing here shrinks when a day ages out -- but the
     * recent list is per-operation by construction and a folded day has no
     * operations left to list. Without this an operator reading an empty tail
     * under a large total would have no way to tell "nothing happened" from
     * "it is a total now".
     */
    foldedOperations: number;
    foldedDays: number;
    /**
     * File reads this store measured the tool as standing in for, in tokens.
     *
     * ITS OWN FIGURE, NEVER FOLDED INTO `totalTokensSaved`. See the note on
     * `Split.inputDisplacementTokens`: these two credits share one `after` and
     * have different `before`s, so adding them would double-count the reply.
     */
    inputDisplacementTokens: number;
    displacementOperations: number;
    /**
     * The same avoidance on weaker evidence: the before was DECLARED by the
     * tool because the recorder could not reach it from the arguments, and
     * only the after was counted here. Published as its own figure so a
     * reader can see how much of a total rests on a tool's own word.
     */
    declaredDisplacementTokens: number;
    declaredOperations: number;
    /**
     * What each measurement contract in this store contributed.
     *
     * THE BREAK IS SHOWN, NOT SUMMED ACROSS. Every figure above spans every
     * contract the store holds, and a reader has no way to tell a total drawn
     * from one definition of a saving from one drawn from two. A day already
     * folded cannot be re-measured under the newer contract -- its rows are
     * gone -- so the honest move is to label which definition produced which
     * part. Version 0 is a day folded before the stamp existed.
     */
    contracts: Array<{
      measurementSchemaVersion: number;
      current: boolean;
      operations: number;
      verifiedSavingsOperations: number;
      totalTokensSaved: number;
      inputDisplacementTokens: number;
      declaredDisplacementTokens: number;
      firstSeen: string | null;
      lastSeen: string | null;
    }>;
  };
  byAction: DashboardActionAnalytics[];
  byClient: Array<{
    name: string;
    attribution: 'recorded' | 'historical-unattributed';
    totalOperations: number;
    observedReturnedContextOperations: number;
    verifiedSavingsOperations: number;
    verifiedExpansionOperations: number;
    unverifiedReportedOperations: number;
    totalOptimizedTokens: number | null;
    totalTokensSaved: number | null;
    unverifiedReportedTokensSaved: number;
    contextUsd: number | null;
    savedUsd: number | null;
    pricedReturnedContextOperations: number;
    pricedSavingsOperations: number;
  }>;
  recent: Array<{
    name: string;
    originalTokens: number;
    optimizedTokens: number;
    tokensSaved: number;
    reportedTokensSaved: number;
    contextUsd: number | null;
    savedUsd: number | null;
    timestamp: string;
    savingsMeasured: boolean;
    classification: SavingsClassification;
    client: string | null;
    model: string | null;
  }>;
  measurement: {
    definition: string;
    tokenCountMethod: string;
    legacyPolicy: string;
    priceBasis: string;
  };
  providerUsage: ProviderUsageSummary;
}

function finite(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function pricing(): EffectivePricing {
  return {
    available: true,
    effectiveInputUsdPerMillion: null,
    source: 'versioned-provider-model-catalog',
    verifiedAt: MODEL_PRICE_CATALOG[0]?.verifiedAt || 'unknown',
    explanation:
      'API/list-price equivalents use the exact captured provider, model, request-time tier, uncached input, cache reads, cache writes, and output. Actual billed cost is shown only when the CLI reports it. Subscription and included-credit usage is never mislabeled as an invoice.',
  };
}

function inputEquivalent(entry: AnalyticsEntry, tokens: number): number | null {
  const direction = tokens < 0 ? -1 : 1;
  const metadata = entry.metadata || {};
  const priced = priceTokenUsage({
    client: entry.client || String(metadata.client || ''),
    provider: String(metadata.provider || ''),
    route: String(metadata.pricingRoute || metadata.route || ''),
    model: entry.model || String(metadata.model || ''),
    timestamp: entry.timestamp,
    usage: { uncachedInputTokens: Math.abs(tokens) },
  });
  return priced.available && priced.currency === 'USD' && priced.amount !== null
    ? priced.amount * direction
    : null;
}

/**
 * Every figure this dashboard shows about one set of operations.
 *
 * ONE ACCUMULATOR FOR BOTH SOURCES, because the store holds two: live rows, and
 * days the retention pass has already folded into per-dimension totals. A reader
 * that added up only the rows would report less than the product earned and
 * would report it with no sign that anything was missing -- the worst shape a
 * wrong number can take. So rows and folded days both reduce into this, and
 * every published figure is read off the sum rather than off either source.
 *
 * THE PER-ROW GATES ARE APPLIED WHERE THE ROW IS, never re-derived from a total:
 * a live row goes through the predicates in `addRow`, and a folded day arrives
 * with those same predicates already applied, row by row, at fold time.
 */
interface Split {
  operations: number;
  verifiedOperations: number;
  expansionOperations: number;
  unverifiedOperations: number;
  observedOperations: number;
  legacyOperations: number;
  verifiedOriginalTokens: number;
  observedOptimizedTokens: number;
  measuredOptimizedTokens: number;
  grossTokensSaved: number;
  expansionTokensReturned: number;
  unverifiedReportedTokensSaved: number;
  /**
   * File reads this tool stood in for, in tokens.
   *
   * SUMMED APART FROM `grossTokensSaved` ON PURPOSE. One reply measured
   * against two different baselines -- the payload the proxy would have
   * carried, and the file the caller would have read -- gives two befores for
   * one after, and those are not additive. A reader who wants one figure adds
   * them deliberately.
   */
  inputDisplacementTokens: number;
  displacementOperations: number;
  declaredDisplacementTokens: number;
  declaredOperations: number;
  contextUsd: number;
  pricedContextOperations: number;
  savedUsd: number;
  pricedSavingsOperations: number;
  firstSeen: string | null;
  lastSeen: string | null;
}

function emptySplit(): Split {
  return {
    operations: 0,
    verifiedOperations: 0,
    expansionOperations: 0,
    unverifiedOperations: 0,
    observedOperations: 0,
    legacyOperations: 0,
    verifiedOriginalTokens: 0,
    observedOptimizedTokens: 0,
    measuredOptimizedTokens: 0,
    grossTokensSaved: 0,
    expansionTokensReturned: 0,
    unverifiedReportedTokensSaved: 0,
    inputDisplacementTokens: 0,
    displacementOperations: 0,
    declaredDisplacementTokens: 0,
    declaredOperations: 0,
    contextUsd: 0,
    pricedContextOperations: 0,
    savedUsd: 0,
    pricedSavingsOperations: 0,
    firstSeen: null,
    lastSeen: null,
  };
}

function earliest(current: string | null, candidate: string): string {
  return current === null || candidate < current ? candidate : current;
}

function latest(current: string | null, candidate: string): string {
  return current === null || candidate > current ? candidate : current;
}

/** Adds one live row, gated by the predicates that classify it. */
function addRow(split: Split, entry: AnalyticsEntry): void {
  const verified = isVerifiedSavingsEntry(entry);
  const expansion = isVerifiedExpansionDebit(entry);
  const observed = hasObservedReturnedContext(entry);
  const reported = reportedSavings(entry);
  const unverified = !verified && !expansion && reported > 0;
  split.operations += 1;
  split.verifiedOperations += verified ? 1 : 0;
  split.expansionOperations += expansion ? 1 : 0;
  split.unverifiedOperations += unverified ? 1 : 0;
  split.observedOperations += observed ? 1 : 0;
  split.legacyOperations +=
    classifySavings(entry) === 'unverified-reported' ? 1 : 0;
  split.verifiedOriginalTokens += verified ? entry.originalTokens : 0;
  split.observedOptimizedTokens += observed ? entry.optimizedTokens : 0;
  split.measuredOptimizedTokens +=
    verified || expansion ? entry.optimizedTokens : 0;
  split.grossTokensSaved += verified ? reported : 0;
  split.expansionTokensReturned += expansion ? entry.optimizedTokens : 0;
  split.unverifiedReportedTokensSaved += unverified ? reported : 0;
  const displacement = verifiedInputDisplacement(entry);
  split.inputDisplacementTokens += displacement;
  split.displacementOperations += displacement === 0 ? 0 : 1;
  const declared = declaredInputDisplacement(entry);
  split.declaredDisplacementTokens += declared;
  split.declaredOperations += declared === 0 ? 0 : 1;
  if (observed) {
    const priced = inputEquivalent(entry, entry.optimizedTokens);
    if (priced !== null) {
      split.contextUsd += priced;
      split.pricedContextOperations += 1;
    }
  }
  if (verified || expansion) {
    const priced = inputEquivalent(entry, verifiedTransportDelta(entry));
    if (priced !== null) {
      split.savedUsd += priced;
      split.pricedSavingsOperations += 1;
    }
  }
  split.firstSeen = earliest(split.firstSeen, entry.timestamp);
  split.lastSeen = latest(split.lastSeen, entry.timestamp);
}

/** Adds one folded day, whose per-row arithmetic already ran at fold time. */
function addFolded(split: Split, rollup: AnalyticsRollup): void {
  split.operations += rollup.operations;
  split.verifiedOperations += rollup.verifiedOperations;
  split.expansionOperations += rollup.expansionOperations;
  split.unverifiedOperations += rollup.unverifiedOperations;
  split.observedOperations += rollup.observedReturns;
  split.legacyOperations +=
    rollup.classification === 'unverified-reported' ? rollup.operations : 0;
  split.verifiedOriginalTokens += rollup.verifiedOriginalTokens;
  split.observedOptimizedTokens += rollup.observedOptimizedTokens;
  split.measuredOptimizedTokens += rollup.measuredOptimizedTokens;
  split.grossTokensSaved += rollup.verifiedReportedSavings;
  split.expansionTokensReturned += rollup.expansionOptimizedTokens;
  split.unverifiedReportedTokensSaved += rollup.unverifiedReportedSavings;
  split.inputDisplacementTokens += rollup.inputDisplacementTokens;
  split.displacementOperations += rollup.displacementOperations;
  split.declaredDisplacementTokens += rollup.declaredDisplacementTokens;
  split.declaredOperations += rollup.declaredOperations;
  split.contextUsd += rollup.contextUsd;
  split.pricedContextOperations += rollup.pricedContextOperations;
  split.savedUsd += rollup.costUsd;
  split.pricedSavingsOperations += rollup.pricedOperations;
  split.firstSeen = earliest(split.firstSeen, rollup.firstTimestamp);
  split.lastSeen = latest(split.lastSeen, rollup.lastTimestamp);
}

/** The figures for one group: its live rows plus its folded days. */
function splitOf(
  rows: readonly AnalyticsEntry[],
  folded: readonly AnalyticsRollup[]
): Split {
  const split = emptySplit();
  for (const row of rows) addRow(split, row);
  for (const rollup of folded) addFolded(split, rollup);
  return split;
}

/** Net verified transport avoided: the credit less the debit beside it. */
function netTokensSaved(split: Split): number {
  return split.grossTokensSaved - split.expansionTokensReturned;
}

function savingsPercentage(split: Split): number | null {
  return split.verifiedOriginalTokens > 0
    ? (netTokensSaved(split) / split.verifiedOriginalTokens) * 100
    : null;
}

/**
 * A dollar figure the dashboard can publish.
 *
 * QUANTIZED FOR THE SAME REASON THE SAVINGS REPORT QUANTIZES ITS OWN. Binary
 * floating-point addition is not associative, so the same priced operations
 * summed in a different order differ in their last digits -- and a folded day is
 * summed at fold time rather than here, which is a different order. Without
 * this, a day ageing out would move a published figure by a part in 10^15 and
 * nothing in the product could explain why.
 *
 * NULL WHEN NOTHING WAS PRICED, so an absent rate reads as unknown rather than
 * as zero dollars.
 */
function money(amount: number, priced: number): number | null {
  return priced > 0 ? Math.round(amount * 1e10) / 1e10 : null;
}

/**
 * The last word in every group ordering, so a tie has one answer.
 *
 * WITHOUT THIS THE ORDER IS WHATEVER ORDER THE DATA ARRIVED IN. Two tools that
 * saved the same amount compared equal, and `sort` then left them in insertion
 * order -- which is newest-row-first for live rows and group-discovery order for
 * folded days. The same history therefore listed its groups differently
 * depending on how much of it had aged out, with every figure identical.
 *
 * CODE-POINT ORDER, NOT `localeCompare`, because the order must not depend on
 * the locale the server happens to be running under.
 */
function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function groupBy<T>(
  items: readonly T[],
  key: (item: T) => string
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const name = key(item);
    const group = groups.get(name);
    if (group) group.push(item);
    else groups.set(name, [item]);
  }
  return groups;
}

/**
 * Every group name either source knows about.
 *
 * A UNION, NOT THE ROWS' KEYS, because a tool whose every row has aged out still
 * has totals, and a tool first seen today has no folded day yet. Iterating one
 * source's keys would drop whichever group the other source holds alone.
 */
function groupNames(
  rows: Map<string, unknown>,
  folded: Map<string, unknown>
): string[] {
  return [...new Set([...rows.keys(), ...folded.keys()])];
}

/**
 * Summarize only provenance-qualified savings. Historical tool-reported rows
 * stay visible as an audit population, but never enter the verified headline.
 */
export function summarizeDashboardAnalytics(
  input: AnalyticsEntry[],
  options: {
    limit?: number;
    providerUsage?: ProviderUsageSummary;
    rollups?: readonly AnalyticsRollup[];
  } = {}
): DashboardAnalyticsReport {
  const limit = Math.min(100, Math.max(1, finite(options.limit) || 40));
  const price = pricing();
  const providerUsage = options.providerUsage || summarizeProviderUsage([]);
  const entries = input
    .filter(
      (entry) =>
        entry &&
        typeof entry.toolName === 'string' &&
        entry.toolName.trim() &&
        typeof entry.timestamp === 'string'
    )
    .map((entry) => ({
      ...entry,
      originalTokens: finite(entry.originalTokens),
      optimizedTokens: finite(entry.optimizedTokens),
      tokensSaved: finite(entry.tokensSaved),
    }))
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));

  /**
   * The days this store has already folded into totals.
   *
   * FILTERED THE SAME WAY THE ROWS ARE, so a group the row path would have
   * discarded cannot reappear through the fold and change a total that the
   * same history, unfolded, would not have had.
   */
  const folded = (options.rollups || []).filter(
    (rollup) =>
      rollup &&
      typeof rollup.toolName === 'string' &&
      rollup.toolName.trim() &&
      typeof rollup.firstTimestamp === 'string' &&
      typeof rollup.lastTimestamp === 'string'
  );
  const foldedOperations = folded.reduce(
    (sum, rollup) => sum + rollup.operations,
    0
  );
  const foldedDays = new Set(folded.map((rollup) => rollup.day)).size;

  const groups = groupBy(entries, (entry) => entry.toolName.trim());
  const foldedGroups = groupBy(folded, (rollup) => rollup.toolName.trim());

  const byAction = groupNames(groups, foldedGroups)
    .map((name): DashboardActionAnalytics => {
      const split = splitOf(
        groups.get(name) || [],
        foldedGroups.get(name) || []
      );
      return {
        name,
        totalOperations: split.operations,
        totalOriginalTokens: split.verifiedOriginalTokens,
        totalOptimizedTokens: split.observedOptimizedTokens,
        totalTokensSaved: netTokensSaved(split),
        grossTokensSaved: split.grossTokensSaved,
        expansionTokensReturned: split.expansionTokensReturned,
        unverifiedReportedTokensSaved: split.unverifiedReportedTokensSaved,
        savingsPercentage: savingsPercentage(split),
        contextUsd: money(split.contextUsd, split.pricedContextOperations),
        savedUsd: money(split.savedUsd, split.pricedSavingsOperations),
        firstSeen: split.firstSeen || '',
        lastSeen: split.lastSeen || split.firstSeen || '',
        measuredSavingsOperations: split.verifiedOperations,
        pricedReturnedContextOperations: split.pricedContextOperations,
        pricedSavingsOperations: split.pricedSavingsOperations,
        verifiedExpansionOperations: split.expansionOperations,
        unmeasuredSavingsOperations:
          split.operations -
          split.verifiedOperations -
          split.expansionOperations,
        observedReturnedContextOperations: split.observedOperations,
        unverifiedReportedOperations: split.unverifiedOperations,
      };
    })
    .sort(
      (a, b) =>
        b.totalTokensSaved - a.totalTokensSaved ||
        b.unverifiedReportedTokensSaved - a.unverifiedReportedTokensSaved ||
        byName(a, b)
    );

  const UNRECORDED_CLIENT = 'Historical — client not recorded';
  const clientName = (recorded: string): string =>
    recorded && recorded !== 'unattributed' ? recorded : UNRECORDED_CLIENT;
  const clientGroups = groupBy(entries, (entry) =>
    clientName(
      String(entry.client || (entry.metadata || {}).client || '').trim()
    )
  );
  const foldedClients = groupBy(folded, (rollup) =>
    clientName(String(rollup.client || '').trim())
  );
  const byClient = groupNames(clientGroups, foldedClients)
    .map((name) => {
      const split = splitOf(
        clientGroups.get(name) || [],
        foldedClients.get(name) || []
      );
      return {
        name,
        attribution:
          name === UNRECORDED_CLIENT
            ? ('historical-unattributed' as const)
            : ('recorded' as const),
        totalOperations: split.operations,
        observedReturnedContextOperations: split.observedOperations,
        verifiedSavingsOperations: split.verifiedOperations,
        verifiedExpansionOperations: split.expansionOperations,
        unverifiedReportedOperations: split.unverifiedOperations,
        totalOptimizedTokens: split.observedOperations
          ? split.observedOptimizedTokens
          : null,
        totalTokensSaved:
          split.verifiedOperations || split.expansionOperations
            ? netTokensSaved(split)
            : null,
        grossTokensSaved: split.grossTokensSaved,
        expansionTokensReturned: split.expansionTokensReturned,
        unverifiedReportedTokensSaved: split.unverifiedReportedTokensSaved,
        contextUsd: money(split.contextUsd, split.pricedContextOperations),
        savedUsd: money(split.savedUsd, split.pricedSavingsOperations),
        pricedReturnedContextOperations: split.pricedContextOperations,
        pricedSavingsOperations: split.pricedSavingsOperations,
      };
    })
    .sort(
      (a, b) =>
        (b.totalTokensSaved || 0) - (a.totalTokensSaved || 0) ||
        b.totalOperations - a.totalOperations ||
        byName(a, b)
    );

  const total = splitOf(entries, folded);

  /*
   * THE SAME UNION-OF-GROUPS SHAPE AS EVERY OTHER BREAKDOWN, keyed on the
   * measurement contract. A live row carries its stamp in metadata; a folded
   * day carries it in the key it was folded under, which is why it had to be
   * in that key -- a day folded without it could never be attributed again.
   */
  const rowContracts = groupBy(entries, (entry) =>
    String(schemaVersionOf(entry.metadata ?? {}))
  );
  const foldedContracts = groupBy(folded, (rollup) =>
    String(rollup.measurementSchemaVersion)
  );
  const contracts = groupNames(rowContracts, foldedContracts)
    .map((version) => {
      const split = splitOf(
        rowContracts.get(version) || [],
        foldedContracts.get(version) || []
      );
      return {
        measurementSchemaVersion: Number(version),
        current: Number(version) === SAVINGS_MEASUREMENT_SCHEMA_VERSION,
        operations: split.operations,
        verifiedSavingsOperations: split.verifiedOperations,
        totalTokensSaved: netTokensSaved(split),
        inputDisplacementTokens: split.inputDisplacementTokens,
        declaredDisplacementTokens: split.declaredDisplacementTokens,
        firstSeen: split.firstSeen,
        lastSeen: split.lastSeen,
      };
    })
    // NEWEST CONTRACT FIRST, so the definition in force now leads the list and
    // the older ones read as history under it.
    .sort((a, b) => b.measurementSchemaVersion - a.measurementSchemaVersion);

  return {
    schemaVersion: 3,
    available: entries.length > 0 || folded.length > 0,
    source:
      'analytics.db: verified materialized MCP before/after payloads; legacy and tool-reported estimates quarantined',
    pricing: price,
    summary: {
      totalOperations: total.operations,
      totalOriginalTokens: total.verifiedOriginalTokens,
      totalOptimizedTokens: total.observedOptimizedTokens,
      measuredOptimizedTokens: total.measuredOptimizedTokens,
      totalTokensSaved: netTokensSaved(total),
      grossTokensSaved: total.grossTokensSaved,
      expansionTokensReturned: total.expansionTokensReturned,
      unverifiedReportedTokensSaved: total.unverifiedReportedTokensSaved,
      savingsPercentage: savingsPercentage(total),
      contextUsd: money(total.contextUsd, total.pricedContextOperations),
      savedUsd: money(total.savedUsd, total.pricedSavingsOperations),
      firstSeen: total.firstSeen,
      lastSeen: total.lastSeen,
      measuredSavingsOperations: total.verifiedOperations,
      pricedReturnedContextOperations: total.pricedContextOperations,
      pricedSavingsOperations: total.pricedSavingsOperations,
      verifiedExpansionOperations: total.expansionOperations,
      unmeasuredSavingsOperations:
        total.operations - total.verifiedOperations - total.expansionOperations,
      actualReturnedContextOperations: total.observedOperations,
      legacyReportedContextOperations: total.legacyOperations,
      observedReturnedContextOperations: total.observedOperations,
      unverifiedReportedOperations: total.unverifiedOperations,
      foldedOperations,
      foldedDays,
      inputDisplacementTokens: total.inputDisplacementTokens,
      displacementOperations: total.displacementOperations,
      declaredDisplacementTokens: total.declaredDisplacementTokens,
      declaredOperations: total.declaredOperations,
      contracts,
    },
    byAction,
    byClient,
    recent: entries.slice(0, limit).map((entry) => {
      const classification = classifySavings(entry);
      const verified = classification === 'verified-transport-reduction';
      const expansion = classification === 'verified-transport-expansion-debit';
      const observed = classification !== 'unverified-reported';
      return {
        name: entry.toolName.trim(),
        originalTokens: verified ? entry.originalTokens : entry.optimizedTokens,
        optimizedTokens: entry.optimizedTokens,
        tokensSaved: verifiedTransportDelta(entry),
        reportedTokensSaved: verified ? 0 : reportedSavings(entry),
        savingsMeasured: verified || expansion,
        classification,
        contextUsd: observed
          ? inputEquivalent(entry, entry.optimizedTokens)
          : null,
        savedUsd:
          verified || expansion
            ? inputEquivalent(entry, verifiedTransportDelta(entry))
            : null,
        timestamp: entry.timestamp,
        client:
          entry.client && entry.client !== 'unattributed' ? entry.client : null,
        model: entry.model || null,
      };
    }),
    measurement: {
      definition:
        'Net verified MCP transport avoided equals materialized payload tokens minus the initial returned payload, less any later expansion payloads.',
      tokenCountMethod:
        'Local GPT-4-compatible tiktoken estimate; exact provider billing tokens are not observable at the MCP boundary.',
      legacyPolicy:
        'Rows without versioned baseline provenance remain visible as unverified reported estimates and are excluded from verified totals.',
      priceBasis: price.explanation,
    },
    providerUsage,
  };
}

export async function readDashboardAnalytics(
  limit = 40
): Promise<DashboardAnalyticsReport> {
  const dbPath =
    process.env.TOKEN_OPTIMIZER_ANALYTICS_DB ||
    path.join(os.homedir(), '.token-optimizer-mcp', 'analytics.db');
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(dbPath).mtimeMs;
  } catch {
    // An absent ledger is a valid collecting state.
  }
  const cacheKey = `${dbPath}\u0000${mtimeMs}\u0000${limit}`;
  if (dashboardCache?.key === cacheKey && dashboardCache.expiresAt > Date.now())
    return dashboardCache.report;
  if (!fs.existsSync(dbPath)) {
    const report = summarizeDashboardAnalytics([], {
      limit,
    });
    dashboardCache = { key: cacheKey, expiresAt: Date.now() + 30_000, report };
    return report;
  }

  const storage = new SqliteAnalyticsStorage(dbPath);
  const manager = new AnalyticsManager(storage);
  try {
    // ONE READ FOR BOTH HALVES: a prune can land between two reads, and it
    // moves a day out of the rows and into the totals. Rows first then totals
    // would count that day twice; the other order would lose it.
    const entries = await manager.getEntries();
    const rollups = await manager.getRollups();
    const report = summarizeDashboardAnalytics(entries, { limit, rollups });
    dashboardCache = { key: cacheKey, expiresAt: Date.now() + 30_000, report };
    return report;
  } finally {
    await manager.close();
  }
}

export async function readDashboardProviderUsage(
  limit = 40
): Promise<ProviderUsageSummary> {
  return readNativeProviderUsage({
    days: Math.min(
      365,
      Math.max(1, Number(process.env.TOKEN_OPTIMIZER_PROVIDER_USAGE_DAYS) || 7)
    ),
    recentLimit: limit,
  });
}
