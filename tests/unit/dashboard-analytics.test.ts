import { describe, expect, it } from '@jest/globals';
import { summarizeDashboardAnalytics } from '../../src/server/dashboard-analytics.js';
import type { AnalyticsEntry } from '../../src/analytics/analytics-types.js';

function row(overrides: Partial<AnalyticsEntry> = {}): AnalyticsEntry {
  return {
    hookPhase: 'Unknown',
    toolName: 'smart_read',
    mcpServer: 'token-optimizer',
    originalTokens: 1_000,
    optimizedTokens: 250,
    tokensSaved: 750,
    timestamp: '2026-08-12T12:00:00.000Z',
    ...overrides,
  };
}

const verified = row({
  savingsMeasured: true,
  measurementId: 'measurement-1',
  client: 'codex',
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
});

describe('dashboard optimizer analytics contract', () => {
  it('reports only versioned materialized payload reductions as verified', () => {
    const report = summarizeDashboardAnalytics(
      [
        verified,
        row({
          toolName: 'smart_grep',
          originalTokens: 47_000_000,
          optimizedTokens: 2_000,
          tokensSaved: 46_998_000,
          timestamp: '2026-08-12T12:01:00.000Z',
        }),
        row({
          toolName: 'wiki_read',
          originalTokens: 100,
          optimizedTokens: 100,
          tokensSaved: 0,
          savingsMeasured: false,
          timestamp: '2026-08-12T12:02:00.000Z',
          metadata: {
            measurementSchemaVersion: 2,
            measurementClass: 'observed-return-only',
            measurement: 'actual-return-context-only',
          },
        }),
      ],
      {}
    );

    expect(report.schemaVersion).toBe(3);
    expect(report.summary).toMatchObject({
      totalOperations: 3,
      totalOriginalTokens: 1_000,
      totalOptimizedTokens: 350,
      totalTokensSaved: 750,
      unverifiedReportedTokensSaved: 46_998_000,
      measuredSavingsOperations: 1,
      observedReturnedContextOperations: 2,
      unverifiedReportedOperations: 1,
      legacyReportedContextOperations: 1,
      contextUsd: null,
      savedUsd: null,
    });
    expect(
      report.byAction.find((item) => item.name === 'smart_grep')
    ).toMatchObject({
      totalOptimizedTokens: 0,
      totalTokensSaved: 0,
      unverifiedReportedTokensSaved: 46_998_000,
      unverifiedReportedOperations: 1,
    });
    expect(report.recent[0]).toMatchObject({
      name: 'wiki_read',
      classification: 'observed-return-only',
      savingsMeasured: false,
    });
  });

  it('leaves cost unavailable until an exact model and route are recorded', () => {
    const report = summarizeDashboardAnalytics([verified]);

    expect(report.pricing).toMatchObject({
      available: true,
      effectiveInputUsdPerMillion: null,
      source: 'versioned-provider-model-catalog',
    });
    expect(report.summary.contextUsd).toBeNull();
    expect(report.summary.savedUsd).toBeNull();
    expect(report.measurement.priceBasis).toMatch(/exact captured provider/i);
  });

  it('prices exact model operations without using one blended rate', () => {
    const report = summarizeDashboardAnalytics([
      { ...verified, model: 'gpt-5.6-sol' },
    ]);

    expect(report.summary).toMatchObject({
      contextUsd: 0.00125,
      savedUsd: 0.00375,
      pricedReturnedContextOperations: 1,
      pricedSavingsOperations: 1,
    });
  });

  it('does not certify a legacy row merely because savingsMeasured is true', () => {
    const report = summarizeDashboardAnalytics([
      row({ savingsMeasured: true }),
    ]);

    expect(report.summary.totalTokensSaved).toBe(0);
    expect(report.summary.measuredSavingsOperations).toBe(0);
    expect(report.summary.unverifiedReportedTokensSaved).toBe(750);
    expect(report.summary.legacyReportedContextOperations).toBe(1);
  });

  it('rejects a versioned row when its materialized delta is inconsistent', () => {
    const report = summarizeDashboardAnalytics([
      row({
        ...verified,
        metadata: { ...verified.metadata, bytesSaved: 2_999 },
      }),
    ]);

    expect(report.summary.totalTokensSaved).toBe(0);
    expect(report.summary.measuredSavingsOperations).toBe(0);
    expect(report.summary.unverifiedReportedTokensSaved).toBe(750);
  });

  it('subtracts a linked expansion from net verified transport avoided', () => {
    const report = summarizeDashboardAnalytics([
      verified,
      row({
        toolName: 'expand',
        originalTokens: 400,
        optimizedTokens: 400,
        tokensSaved: 0,
        savingsMeasured: false,
        measurementId: 'measurement-2',
        timestamp: '2026-08-12T12:03:00.000Z',
        metadata: {
          measurementId: 'measurement-2',
          measurementSchemaVersion: 2,
          measurementClass: 'verified-transport-expansion-debit',
          measurement: 'actual-expansion-transport-debit',
          expansionRef: 'a'.repeat(16),
          creditedMeasurementId: 'measurement-1',
          returnedBytes: 1_600,
          returnedSha256: 'c'.repeat(64),
        },
      }),
    ]);

    expect(report.summary).toMatchObject({
      grossTokensSaved: 750,
      expansionTokensReturned: 400,
      totalTokensSaved: 350,
      verifiedExpansionOperations: 1,
      totalOptimizedTokens: 650,
    });
    expect(report.recent[0]).toMatchObject({
      name: 'expand',
      classification: 'verified-transport-expansion-debit',
      tokensSaved: -400,
      savingsMeasured: true,
    });
  });

  it('keeps new tool-reported estimates outside verified savings', () => {
    const report = summarizeDashboardAnalytics([
      row({
        originalTokens: 250,
        optimizedTokens: 250,
        tokensSaved: 0,
        savingsMeasured: false,
        metadata: {
          measurementSchemaVersion: 2,
          measurementClass: 'observed-return-only',
          measurement: 'actual-return-context-only',
          reportedToolSavings: {
            originalTokens: 10_000,
            optimizedTokens: 250,
            tokensSaved: 9_750,
          },
        },
      }),
    ]);

    expect(report.summary.totalTokensSaved).toBe(0);
    expect(report.summary.totalOptimizedTokens).toBe(250);
    expect(report.summary.unverifiedReportedTokensSaved).toBe(9_750);
    expect(report.summary.unverifiedReportedOperations).toBe(1);
    expect(report.summary.legacyReportedContextOperations).toBe(0);
  });

  it('returns an explicit unavailable state for an empty ledger', () => {
    const report = summarizeDashboardAnalytics([]);

    expect(report.available).toBe(false);
    expect(report.summary.totalOperations).toBe(0);
    expect(report.byAction).toEqual([]);
    expect(report.recent).toEqual([]);
  });
});
