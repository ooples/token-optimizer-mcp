import { describe, expect, it } from '@jest/globals';
import { summarizeDashboardAnalytics } from '../../src/server/dashboard-analytics.js';
import type { AnalyticsEntry } from '../../src/analytics/analytics-types.js';

const rows: AnalyticsEntry[] = [
  {
    hookPhase: 'Unknown',
    toolName: 'smart_read',
    mcpServer: 'token-optimizer',
    originalTokens: 1_000,
    optimizedTokens: 250,
    tokensSaved: 750,
    timestamp: '2026-08-12T12:00:00.000Z',
  },
  {
    hookPhase: 'Unknown',
    toolName: 'smart_read',
    mcpServer: 'token-optimizer',
    originalTokens: 400,
    optimizedTokens: 100,
    tokensSaved: 300,
    timestamp: '2026-08-12T12:01:00.000Z',
  },
  {
    hookPhase: 'Unknown',
    toolName: 'smart_grep',
    mcpServer: 'token-optimizer',
    originalTokens: 300,
    optimizedTokens: 200,
    tokensSaved: 100,
    timestamp: '2026-08-12T12:02:00.000Z',
  },
];

describe('dashboard optimizer analytics contract', () => {
  it('reports direct before/after totals, per-action USD, and recent rows', () => {
    const report = summarizeDashboardAnalytics(rows, {
      limit: 2,
      usdPerMillionTokens: 3,
    });

    expect(report.available).toBe(true);
    expect(report.summary).toMatchObject({
      totalOperations: 3,
      totalOriginalTokens: 1_700,
      totalOptimizedTokens: 550,
      totalTokensSaved: 1_150,
      contextUsd: 0.00165,
      savedUsd: 0.00345,
      actualReturnedContextOperations: 0,
      legacyReportedContextOperations: 3,
    });
    expect(report.byAction[0]).toMatchObject({
      name: 'smart_read',
      totalOperations: 2,
      totalOriginalTokens: 1_400,
      totalOptimizedTokens: 350,
      totalTokensSaved: 1_050,
      contextUsd: 0.00105,
    });
    expect(report.recent.map((row) => row.name)).toEqual([
      'smart_grep',
      'smart_read',
    ]);
    expect(report.byClient).toEqual([
      expect.objectContaining({
        name: 'Historical — client not recorded',
        attribution: 'historical-unattributed',
        totalOperations: 3,
      }),
    ]);
    expect(report.source).toMatch(/actual returned context/i);
  });

  it('attributes new optimizer measurements to the MCP handshake client', () => {
    const report = summarizeDashboardAnalytics([
      {
        ...rows[0],
        client: 'codex',
        clientVersion: '0.147.0',
      },
      rows[1],
    ]);

    expect(report.byClient).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'codex', attribution: 'recorded' }),
        expect.objectContaining({
          name: 'Historical — client not recorded',
          attribution: 'historical-unattributed',
        }),
      ])
    );
  });

  it('returns explicit unavailable state instead of zero-valued claims', () => {
    const report = summarizeDashboardAnalytics([]);

    expect(report.available).toBe(false);
    expect(report.summary.totalOperations).toBe(0);
    expect(report.byAction).toEqual([]);
    expect(report.recent).toEqual([]);
  });

  it('keeps zero-savings operations as measured context', () => {
    const report = summarizeDashboardAnalytics([
      {
        ...rows[0],
        originalTokens: 100,
        optimizedTokens: 100,
        tokensSaved: 0,
      },
    ]);

    expect(report.available).toBe(true);
    expect(report.summary.totalTokensSaved).toBe(0);
    expect(report.summary.totalOptimizedTokens).toBe(100);
    expect(report.summary.savingsPercentage).toBe(0);
  });

  it('counts returned context without inventing or diluting a before-state', () => {
    const report = summarizeDashboardAnalytics([
      rows[0],
      {
        ...rows[1],
        originalTokens: 900,
        optimizedTokens: 900,
        tokensSaved: 0,
        savingsMeasured: false,
        metadata: { measurement: 'actual-return-context-only' },
      },
    ]);

    expect(report.summary).toMatchObject({
      totalOperations: 2,
      totalOriginalTokens: 1_000,
      totalOptimizedTokens: 1_150,
      measuredOptimizedTokens: 250,
      totalTokensSaved: 750,
      savingsPercentage: 75,
      measuredSavingsOperations: 1,
      unmeasuredSavingsOperations: 1,
      actualReturnedContextOperations: 1,
      legacyReportedContextOperations: 1,
    });
    expect(report.recent[0]).toMatchObject({ savingsMeasured: false });
  });
});
