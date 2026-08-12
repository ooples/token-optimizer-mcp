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

const EFFECTIVE_RATE_ENV = 'TOKEN_OPTIMIZER_EFFECTIVE_INPUT_USD_PER_MILLION';

interface EffectivePricing {
  available: boolean;
  effectiveInputUsdPerMillion: number | null;
  source: 'configured-effective-rate' | 'unavailable';
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
  verifiedExpansionOperations: number;
  unmeasuredSavingsOperations: number;
  observedReturnedContextOperations: number;
  unverifiedReportedOperations: number;
}

export interface DashboardAnalyticsReport {
  schemaVersion: 2;
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
}

function finite(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function pricing(override: unknown): EffectivePricing {
  const candidate =
    override === undefined ? process.env[EFFECTIVE_RATE_ENV] : override;
  const rate = Number(candidate);
  if (candidate !== undefined && Number.isFinite(rate) && rate > 0) {
    return {
      available: true,
      effectiveInputUsdPerMillion: rate,
      source: 'configured-effective-rate',
      explanation: `Configured by ${EFFECTIVE_RATE_ENV}. It must already reflect the user's provider, model, plan, cache mix, processing tier, and included credits.`,
    };
  }
  return {
    available: false,
    effectiveInputUsdPerMillion: null,
    source: 'unavailable',
    explanation: `No cost is claimed because the MCP server cannot observe billing. Set ${EFFECTIVE_RATE_ENV} to an effective blended input-token rate to show a cost equivalent.`,
  };
}

function usd(tokens: number, contract: EffectivePricing): number | null {
  const rate = contract.effectiveInputUsdPerMillion;
  return rate === null ? null : (tokens / 1_000_000) * rate;
}

/**
 * Summarize only provenance-qualified savings. Historical tool-reported rows
 * stay visible as an audit population, but never enter the verified headline.
 */
export function summarizeDashboardAnalytics(
  input: AnalyticsEntry[],
  options: { limit?: number; effectiveInputUsdPerMillion?: number } = {}
): DashboardAnalyticsReport {
  const limit = Math.min(100, Math.max(1, finite(options.limit) || 40));
  const price = pricing(options.effectiveInputUsdPerMillion);
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
        contextUsd: usd(totalOptimizedTokens, price),
        savedUsd: usd(totalTokensSaved, price),
        firstSeen: timestamps[0],
        lastSeen: timestamps.at(-1) || timestamps[0],
        measuredSavingsOperations: verifiedRows.length,
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
        contextUsd: observedRows.length
          ? usd(totalOptimizedTokens, price)
          : null,
        savedUsd:
          verifiedRows.length || expansionRows.length
            ? usd(totalTokensSaved, price)
            : null,
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

  return {
    schemaVersion: 2,
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
      contextUsd: usd(totalOptimizedTokens, price),
      savedUsd: usd(totalTokensSaved, price),
      firstSeen: timestamps[0] || null,
      lastSeen: timestamps.at(-1) || null,
      measuredSavingsOperations: verifiedEntries.length,
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
        contextUsd: observed ? usd(entry.optimizedTokens, price) : null,
        savedUsd:
          verified || expansion
            ? usd(verifiedTransportDelta(entry), price)
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
  };
}

export async function readDashboardAnalytics(
  limit = 40
): Promise<DashboardAnalyticsReport> {
  const dbPath =
    process.env.TOKEN_OPTIMIZER_ANALYTICS_DB ||
    path.join(os.homedir(), '.token-optimizer-mcp', 'analytics.db');
  if (!fs.existsSync(dbPath)) return summarizeDashboardAnalytics([], { limit });

  const storage = new SqliteAnalyticsStorage(dbPath);
  const manager = new AnalyticsManager(storage);
  try {
    return summarizeDashboardAnalytics(await manager.getEntries(), { limit });
  } finally {
    await manager.close();
  }
}
