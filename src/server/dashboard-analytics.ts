import path from 'path';
import os from 'os';
import fs from 'fs';
import { AnalyticsManager } from '../analytics/analytics-manager.js';
import { SqliteAnalyticsStorage } from '../analytics/analytics-storage.js';
import type { AnalyticsEntry } from '../analytics/analytics-types.js';
import {
  classifySavings,
  hasObservedReturnedContext,
  isVerifiedSavingsEntry,
  isVerifiedExpansionDebit,
  reportedSavings,
  verifiedTransportDelta,
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

function sumPriced(
  rows: AnalyticsEntry[],
  tokens: (entry: AnalyticsEntry) => number
): { amount: number | null; priced: number } {
  let amount = 0;
  let priced = 0;
  for (const row of rows) {
    const value = inputEquivalent(row, tokens(row));
    if (value === null) continue;
    amount += value;
    priced += 1;
  }
  return { amount: priced ? amount : null, priced };
}

/**
 * Summarize only provenance-qualified savings. Historical tool-reported rows
 * stay visible as an audit population, but never enter the verified headline.
 */
export function summarizeDashboardAnalytics(
  input: AnalyticsEntry[],
  options: { limit?: number; providerUsage?: ProviderUsageSummary } = {}
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

  const groups = new Map<string, AnalyticsEntry[]>();
  for (const entry of entries) {
    const name = entry.toolName.trim();
    const group = groups.get(name) || [];
    group.push(entry);
    groups.set(name, group);
  }

  const byAction = [...groups.entries()]
    .map(([name, rows]): DashboardActionAnalytics => {
      const verifiedRows = rows.filter(isVerifiedSavingsEntry);
      const expansionRows = rows.filter(isVerifiedExpansionDebit);
      const observedRows = rows.filter(hasObservedReturnedContext);
      const unverifiedRows = rows.filter(
        (row) =>
          !isVerifiedSavingsEntry(row) &&
          !isVerifiedExpansionDebit(row) &&
          reportedSavings(row) > 0
      );
      const totalOriginalTokens = verifiedRows.reduce(
        (sum, row) => sum + row.originalTokens,
        0
      );
      const totalOptimizedTokens = observedRows.reduce(
        (sum, row) => sum + row.optimizedTokens,
        0
      );
      const grossTokensSaved = verifiedRows.reduce(
        (sum, row) => sum + reportedSavings(row),
        0
      );
      const expansionTokensReturned = expansionRows.reduce(
        (sum, row) => sum + row.optimizedTokens,
        0
      );
      const totalTokensSaved = grossTokensSaved - expansionTokensReturned;
      const unverifiedReportedTokensSaved = unverifiedRows.reduce(
        (sum, row) => sum + reportedSavings(row),
        0
      );
      const timestamps = rows.map((row) => row.timestamp).sort();
      const returnedCost = sumPriced(
        observedRows,
        (row) => row.optimizedTokens
      );
      const savedCost = sumPriced([...verifiedRows, ...expansionRows], (row) =>
        verifiedTransportDelta(row)
      );
      return {
        name,
        totalOperations: rows.length,
        totalOriginalTokens,
        totalOptimizedTokens,
        totalTokensSaved,
        grossTokensSaved,
        expansionTokensReturned,
        unverifiedReportedTokensSaved,
        savingsPercentage:
          totalOriginalTokens > 0
            ? (totalTokensSaved / totalOriginalTokens) * 100
            : null,
        contextUsd: returnedCost.amount,
        savedUsd: savedCost.amount,
        firstSeen: timestamps[0],
        lastSeen: timestamps.at(-1) || timestamps[0],
        measuredSavingsOperations: verifiedRows.length,
        pricedReturnedContextOperations: returnedCost.priced,
        pricedSavingsOperations: savedCost.priced,
        verifiedExpansionOperations: expansionRows.length,
        unmeasuredSavingsOperations:
          rows.length - verifiedRows.length - expansionRows.length,
        observedReturnedContextOperations: observedRows.length,
        unverifiedReportedOperations: unverifiedRows.length,
      };
    })
    .sort(
      (a, b) =>
        b.totalTokensSaved - a.totalTokensSaved ||
        b.unverifiedReportedTokensSaved - a.unverifiedReportedTokensSaved
    );

  const clientGroups = new Map<string, AnalyticsEntry[]>();
  for (const entry of entries) {
    const metadata = entry.metadata || {};
    const recorded = String(entry.client || metadata.client || '').trim();
    const name =
      recorded && recorded !== 'unattributed'
        ? recorded
        : 'Historical — client not recorded';
    const group = clientGroups.get(name) || [];
    group.push(entry);
    clientGroups.set(name, group);
  }
  const byClient = [...clientGroups.entries()]
    .map(([name, rows]) => {
      const observedRows = rows.filter(hasObservedReturnedContext);
      const verifiedRows = rows.filter(isVerifiedSavingsEntry);
      const expansionRows = rows.filter(isVerifiedExpansionDebit);
      const unverifiedRows = rows.filter(
        (row) =>
          !isVerifiedSavingsEntry(row) &&
          !isVerifiedExpansionDebit(row) &&
          reportedSavings(row) > 0
      );
      const totalOptimizedTokens = observedRows.reduce(
        (sum, row) => sum + row.optimizedTokens,
        0
      );
      const grossTokensSaved = verifiedRows.reduce(
        (sum, row) => sum + reportedSavings(row),
        0
      );
      const expansionTokensReturned = expansionRows.reduce(
        (sum, row) => sum + row.optimizedTokens,
        0
      );
      const totalTokensSaved = grossTokensSaved - expansionTokensReturned;
      const unverifiedReportedTokensSaved = unverifiedRows.reduce(
        (sum, row) => sum + reportedSavings(row),
        0
      );
      const returnedCost = sumPriced(
        observedRows,
        (row) => row.optimizedTokens
      );
      const savedCost = sumPriced([...verifiedRows, ...expansionRows], (row) =>
        verifiedTransportDelta(row)
      );
      return {
        name,
        attribution:
          name === 'Historical — client not recorded'
            ? ('historical-unattributed' as const)
            : ('recorded' as const),
        totalOperations: rows.length,
        observedReturnedContextOperations: observedRows.length,
        verifiedSavingsOperations: verifiedRows.length,
        verifiedExpansionOperations: expansionRows.length,
        unverifiedReportedOperations: unverifiedRows.length,
        totalOptimizedTokens: observedRows.length ? totalOptimizedTokens : null,
        totalTokensSaved:
          verifiedRows.length || expansionRows.length ? totalTokensSaved : null,
        grossTokensSaved,
        expansionTokensReturned,
        unverifiedReportedTokensSaved,
        contextUsd: returnedCost.amount,
        savedUsd: savedCost.amount,
        pricedReturnedContextOperations: returnedCost.priced,
        pricedSavingsOperations: savedCost.priced,
      };
    })
    .sort(
      (a, b) =>
        (b.totalTokensSaved || 0) - (a.totalTokensSaved || 0) ||
        b.totalOperations - a.totalOperations
    );

  const verifiedEntries = entries.filter(isVerifiedSavingsEntry);
  const expansionEntries = entries.filter(isVerifiedExpansionDebit);
  const observedEntries = entries.filter(hasObservedReturnedContext);
  const historicalEntries = entries.filter(
    (entry) => classifySavings(entry) === 'unverified-reported'
  );
  const unverifiedEntries = entries.filter(
    (entry) =>
      !isVerifiedSavingsEntry(entry) &&
      !isVerifiedExpansionDebit(entry) &&
      reportedSavings(entry) > 0
  );
  const totalOriginalTokens = verifiedEntries.reduce(
    (sum, entry) => sum + entry.originalTokens,
    0
  );
  const totalOptimizedTokens = observedEntries.reduce(
    (sum, entry) => sum + entry.optimizedTokens,
    0
  );
  const grossTokensSaved = verifiedEntries.reduce(
    (sum, entry) => sum + reportedSavings(entry),
    0
  );
  const expansionTokensReturned = expansionEntries.reduce(
    (sum, entry) => sum + entry.optimizedTokens,
    0
  );
  const totalTokensSaved = grossTokensSaved - expansionTokensReturned;
  const unverifiedReportedTokensSaved = unverifiedEntries.reduce(
    (sum, entry) => sum + reportedSavings(entry),
    0
  );
  const measuredOptimizedTokens = [
    ...verifiedEntries,
    ...expansionEntries,
  ].reduce((sum, entry) => sum + entry.optimizedTokens, 0);
  const timestamps = entries.map((entry) => entry.timestamp).sort();
  const totalReturnedCost = sumPriced(
    observedEntries,
    (entry) => entry.optimizedTokens
  );
  const totalSavedCost = sumPriced(
    [...verifiedEntries, ...expansionEntries],
    (entry) => verifiedTransportDelta(entry)
  );

  return {
    schemaVersion: 3,
    available: entries.length > 0,
    source:
      'analytics.db: verified materialized MCP before/after payloads; legacy and tool-reported estimates quarantined',
    pricing: price,
    summary: {
      totalOperations: entries.length,
      totalOriginalTokens,
      totalOptimizedTokens,
      measuredOptimizedTokens,
      totalTokensSaved,
      grossTokensSaved,
      expansionTokensReturned,
      unverifiedReportedTokensSaved,
      savingsPercentage:
        totalOriginalTokens > 0
          ? (totalTokensSaved / totalOriginalTokens) * 100
          : null,
      contextUsd: totalReturnedCost.amount,
      savedUsd: totalSavedCost.amount,
      firstSeen: timestamps[0] || null,
      lastSeen: timestamps.at(-1) || null,
      measuredSavingsOperations: verifiedEntries.length,
      pricedReturnedContextOperations: totalReturnedCost.priced,
      pricedSavingsOperations: totalSavedCost.priced,
      verifiedExpansionOperations: expansionEntries.length,
      unmeasuredSavingsOperations:
        entries.length - verifiedEntries.length - expansionEntries.length,
      actualReturnedContextOperations: observedEntries.length,
      legacyReportedContextOperations: historicalEntries.length,
      observedReturnedContextOperations: observedEntries.length,
      unverifiedReportedOperations: unverifiedEntries.length,
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
    const entries = await manager.getEntries();
    const report = summarizeDashboardAnalytics(entries, { limit });
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
