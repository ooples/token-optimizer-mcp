import { describe, expect, it } from '@jest/globals';
import type { AnalyticsManager } from '../../src/analytics/analytics-manager.js';
import type {
  AggregatedStats,
  AnalyticsEntry,
} from '../../src/analytics/analytics-types.js';
import { getOptimizationReportTool } from '../../src/tools/analytics/get-optimization-report.js';

const verified: AnalyticsEntry = {
  hookPhase: 'Unknown',
  toolName: 'smart_grep',
  mcpServer: 'token-optimizer',
  originalTokens: 1_000,
  optimizedTokens: 250,
  tokensSaved: 750,
  timestamp: '2026-08-12T12:00:00.000Z',
  client: 'codex',
  model: 'gpt-5.6-sol',
  savingsMeasured: true,
  measurementId: 'measurement-1',
  metadata: {
    measurementId: 'measurement-1',
    measurementSchemaVersion: 2,
    measurementClass: 'verified-transport-reduction',
    baselineKind: 'materialized-undisclosed-mcp-result',
    disclosureRef: 'a'.repeat(16),
    baselineBytes: 4_000,
    returnedBytes: 1_000,
    bytesSaved: 3_000,
    baselineSha256: 'a'.repeat(64),
    returnedSha256: 'b'.repeat(64),
  },
};

function group(name: string): AggregatedStats {
  return {
    name,
    totalOperations: 1,
    totalOriginalTokens: 1_000,
    totalOptimizedTokens: 250,
    totalTokensSaved: 750,
    averageTokensSaved: 750,
    savingsPercentage: 75,
    firstSeen: verified.timestamp,
    lastSeen: verified.timestamp,
  };
}

describe('get_optimization_report provider pricing', () => {
  it('uses the exact per-operation catalog and reports coverage', async () => {
    const summary = {
      totalOperations: 1,
      totalOriginalTokens: 1_000,
      totalOptimizedTokens: 250,
      totalTokensSaved: 750,
    };
    const manager = {
      getHookAnalytics: async () => ({ summary, byHook: [group('Unknown')] }),
      getActionAnalytics: async () => ({
        summary,
        byAction: [group('smart_grep')],
      }),
      getServerAnalytics: async () => ({
        summary,
        byServer: [group('token-optimizer')],
      }),
      getEntries: async () => [verified],
      count: async () => 1,
    } as unknown as AnalyticsManager;

    const report = JSON.parse(
      await getOptimizationReportTool(manager)({})
    ) as Record<string, any>;

    expect(report.costEquivalentUsd).toBeCloseTo(0.00375);
    expect(report.pricing).toMatchObject({
      source: 'versioned-provider-model-catalog',
      pricedOperations: 1,
      eligibleOperations: 1,
    });
    expect(report.formatted).toMatch(/1\/1 savings operations exactly modeled/);
  });
});
