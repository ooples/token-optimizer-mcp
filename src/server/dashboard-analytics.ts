import path from 'path';
import os from 'os';
import fs from 'fs';
import { AnalyticsManager } from '../analytics/analytics-manager.js';
import { SqliteAnalyticsStorage } from '../analytics/analytics-storage.js';
import type { AnalyticsEntry } from '../analytics/analytics-types.js';

export const DASHBOARD_USD_PER_MILLION_TOKENS = 3;

export interface DashboardActionAnalytics {
  name: string;
  totalOperations: number;
  totalOriginalTokens: number;
  totalOptimizedTokens: number;
  totalTokensSaved: number;
  savingsPercentage: number | null;
  contextUsd: number;
  savedUsd: number;
  firstSeen: string;
  lastSeen: string;
  measuredSavingsOperations: number;
  unmeasuredSavingsOperations: number;
}

export interface DashboardAnalyticsReport {
  schemaVersion: 1;
  available: boolean;
  source: string;
  referenceUsdPerMillionTokens: number;
  summary: {
    totalOperations: number;
    totalOriginalTokens: number;
    totalOptimizedTokens: number;
    measuredOptimizedTokens: number;
    totalTokensSaved: number;
    savingsPercentage: number | null;
    contextUsd: number;
    savedUsd: number;
    firstSeen: string | null;
    lastSeen: string | null;
    measuredSavingsOperations: number;
    unmeasuredSavingsOperations: number;
    actualReturnedContextOperations: number;
    legacyReportedContextOperations: number;
  };
  byAction: DashboardActionAnalytics[];
  byClient: Array<{
    name: string;
    attribution: 'recorded' | 'historical-unattributed';
    totalOperations: number;
    totalOptimizedTokens: number;
    totalTokensSaved: number;
    contextUsd: number;
    savedUsd: number;
  }>;
  recent: Array<{
    name: string;
    originalTokens: number;
    optimizedTokens: number;
    tokensSaved: number;
    contextUsd: number;
    savedUsd: number;
    timestamp: string;
    savingsMeasured: boolean;
    client: string | null;
    model: string | null;
  }>;
  measurement: {
    definition: string;
    priceBasis: string;
  };
}

function finite(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function usd(tokens: number, rate: number): number {
  return (tokens / 1_000_000) * rate;
}

/**
 * Turns durable before/after optimizer measurements into the dashboard contract.
 *
 * These are direct output-size measurements, not the graph's causal holdout
 * estimate. Keeping the two contracts separate lets the overview report what
 * optimizer tools have already removed while the wiki can continue refusing a
 * graph-effect claim until its treated and control cohorts are large enough.
 */
export function summarizeDashboardAnalytics(
  input: AnalyticsEntry[],
  options: { limit?: number; usdPerMillionTokens?: number } = {}
): DashboardAnalyticsReport {
  const limit = Math.min(100, Math.max(1, finite(options.limit) || 40));
  const rate =
    finite(options.usdPerMillionTokens) || DASHBOARD_USD_PER_MILLION_TOKENS;
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
      const measuredRows = rows.filter((row) => row.savingsMeasured !== false);
      const totalOriginalTokens = measuredRows.reduce(
        (sum, row) => sum + row.originalTokens,
        0
      );
      const totalOptimizedTokens = rows.reduce(
        (sum, row) => sum + row.optimizedTokens,
        0
      );
      const totalTokensSaved = rows.reduce(
        (sum, row) =>
          sum + (row.savingsMeasured === false ? 0 : row.tokensSaved),
        0
      );
      const measuredSavingsOperations = measuredRows.length;
      const timestamps = rows.map((row) => row.timestamp).sort();
      return {
        name,
        totalOperations: rows.length,
        totalOriginalTokens,
        totalOptimizedTokens,
        totalTokensSaved,
        savingsPercentage:
          totalOriginalTokens > 0
            ? (totalTokensSaved / totalOriginalTokens) * 100
            : null,
        contextUsd: usd(totalOptimizedTokens, rate),
        savedUsd: usd(totalTokensSaved, rate),
        firstSeen: timestamps[0],
        lastSeen: timestamps.at(-1) || timestamps[0],
        measuredSavingsOperations,
        unmeasuredSavingsOperations: rows.length - measuredSavingsOperations,
      };
    })
    .sort((a, b) => b.totalTokensSaved - a.totalTokensSaved);

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
      const totalOptimizedTokens = rows.reduce(
        (sum, row) => sum + row.optimizedTokens,
        0
      );
      const totalTokensSaved = rows.reduce(
        (sum, row) =>
          sum + (row.savingsMeasured === false ? 0 : row.tokensSaved),
        0
      );
      return {
        name,
        attribution:
          name === 'Historical — client not recorded'
            ? ('historical-unattributed' as const)
            : ('recorded' as const),
        totalOperations: rows.length,
        totalOptimizedTokens,
        totalTokensSaved,
        contextUsd: usd(totalOptimizedTokens, rate),
        savedUsd: usd(totalTokensSaved, rate),
      };
    })
    .sort((a, b) => b.totalTokensSaved - a.totalTokensSaved);

  const measuredEntries = entries.filter(
    (entry) => entry.savingsMeasured !== false
  );
  const totalOriginalTokens = measuredEntries.reduce(
    (sum, entry) => sum + entry.originalTokens,
    0
  );
  const totalOptimizedTokens = entries.reduce(
    (sum, entry) => sum + entry.optimizedTokens,
    0
  );
  const totalTokensSaved = entries.reduce(
    (sum, entry) =>
      sum + (entry.savingsMeasured === false ? 0 : entry.tokensSaved),
    0
  );
  const measuredOptimizedTokens = measuredEntries.reduce(
    (sum, entry) => sum + entry.optimizedTokens,
    0
  );
  const measuredSavingsOperations = measuredEntries.length;
  const actualReturnedContextOperations = entries.filter((entry) =>
    ['actual-return-context-only', 'optimizer-before-actual-return'].includes(
      String(entry.metadata?.measurement || '')
    )
  ).length;
  const timestamps = entries.map((entry) => entry.timestamp).sort();

  return {
    schemaVersion: 1,
    available: entries.length > 0,
    source:
      'analytics.db: historical optimizer before/after rows plus actual returned context for newly recorded MCP operations',
    referenceUsdPerMillionTokens: rate,
    summary: {
      totalOperations: entries.length,
      totalOriginalTokens,
      totalOptimizedTokens,
      measuredOptimizedTokens,
      totalTokensSaved,
      savingsPercentage:
        totalOriginalTokens > 0
          ? (totalTokensSaved / totalOriginalTokens) * 100
          : null,
      contextUsd: usd(totalOptimizedTokens, rate),
      savedUsd: usd(totalTokensSaved, rate),
      firstSeen: timestamps[0] || null,
      lastSeen: timestamps.at(-1) || null,
      measuredSavingsOperations,
      unmeasuredSavingsOperations: entries.length - measuredSavingsOperations,
      actualReturnedContextOperations,
      legacyReportedContextOperations:
        entries.length - actualReturnedContextOperations,
    },
    byAction,
    byClient,
    recent: entries.slice(0, limit).map((entry) => ({
      name: entry.toolName.trim(),
      originalTokens: entry.originalTokens,
      optimizedTokens: entry.optimizedTokens,
      tokensSaved: entry.tokensSaved,
      savingsMeasured: entry.savingsMeasured !== false,
      contextUsd: usd(entry.optimizedTokens, rate),
      savedUsd: usd(entry.tokensSaved, rate),
      timestamp: entry.timestamp,
      client:
        entry.client && entry.client !== 'unattributed' ? entry.client : null,
      model: entry.model || null,
    })),
    measurement: {
      definition:
        'Original tool-result tokens minus the optimized result tokens actually returned to the client.',
      priceBasis: `$${rate} per million tokens is a reference scale, not a provider invoice.`,
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
