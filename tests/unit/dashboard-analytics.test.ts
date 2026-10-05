import { describe, expect, it } from '@jest/globals';
import {
  summarizeDashboardAnalytics,
  type DashboardAnalyticsReport,
} from '../../src/server/dashboard-analytics.js';
import { foldEntries } from '../../src/analytics/analytics-rollup.js';
import { SAVINGS_MEASUREMENT_SCHEMA_VERSION } from '../../src/analytics/savings-classification.js';
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
      // 250 returned and 750 saved tokens at GPT-5.6 Sol's $4/M uncached input
      // rate, down from the $5/M the catalog carried before the reduction the
      // model page describes.
      contextUsd: 0.001,
      savedUsd: 0.003,
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

/**
 * What the dashboard must still report once a day has been folded.
 *
 * THE RETENTION PASS RUNS ON ITS OWN, on a write, without being asked -- so the
 * question these tests answer is not "can the dashboard read a rollup" but
 * "does this dashboard shrink as the store ages". Row counts would not catch
 * that: a report built from half the rows is internally consistent and still
 * wrong by exactly the half it lost.
 *
 * EACH TEST COMPARES A WHOLE REPORT AGAINST ITSELF, rows against the same rows
 * folded, rather than asserting figures a future change could simply restate.
 */
/** A row with no contract stamp at all: everything recorded before one existed. */
const legacyRow = row({
  toolName: 'smart_grep',
  originalTokens: 9_000,
  optimizedTokens: 500,
  tokensSaved: 8_500,
  timestamp: '2026-08-12T12:07:00.000Z',
});

describe('dashboard analytics across the retention fold', () => {
  const expansion = row({
    toolName: 'smart_read',
    originalTokens: 400,
    optimizedTokens: 400,
    tokensSaved: 0,
    client: 'codex',
    measurementId: 'measurement-x',
    timestamp: '2026-08-12T12:05:00.000Z',
    metadata: {
      measurementId: 'measurement-x',
      measurementSchemaVersion: 2,
      measurementClass: 'verified-transport-expansion-debit',
      expansionRef: 'c'.repeat(16),
      creditedMeasurementId: 'measurement-1',
      returnedBytes: 1_600,
      returnedSha256: 'd'.repeat(64),
    },
  });
  const observed = row({
    toolName: 'wiki_read',
    originalTokens: 100,
    optimizedTokens: 100,
    tokensSaved: 0,
    savingsMeasured: false,
    client: 'claude-code',
    timestamp: '2026-08-12T12:06:00.000Z',
    metadata: {
      measurementSchemaVersion: 2,
      measurementClass: 'observed-return-only',
      measurement: 'actual-return-context-only',
    },
  });
  const population = [verified, expansion, observed, legacyRow];

  /** The report as the dashboard publishes it, minus what a fold cannot keep. */
  function published(report: DashboardAnalyticsReport) {
    const { foldedOperations, foldedDays, ...summary } = report.summary;
    return {
      available: report.available,
      summary,
      byAction: report.byAction,
      byClient: report.byClient,
    };
  }

  it('reports the same totals, tools and clients once every row is folded', () => {
    const rows = summarizeDashboardAnalytics(population, {});
    const folded = summarizeDashboardAnalytics([], {
      rollups: foldEntries(population),
    });

    // POSITIVE CONTROL: the fixture has figures to lose. Without this the
    // equality below would also hold for a report of nothing at all.
    expect(rows.summary.totalOperations).toBe(4);
    expect(rows.summary.totalTokensSaved).toBe(350);
    expect(rows.byAction).toHaveLength(3);
    expect(rows.byClient).toHaveLength(3);

    expect(published(folded)).toEqual(published(rows));
    expect(folded.summary.foldedOperations).toBe(4);
    expect(folded.summary.foldedDays).toBe(1);
    expect(rows.summary.foldedOperations).toBe(0);
  });

  it('adds a live row to the folded day it belongs beside', () => {
    const whole = summarizeDashboardAnalytics(population, {});
    const split = summarizeDashboardAnalytics([legacyRow], {
      rollups: foldEntries([verified, expansion, observed]),
    });

    expect(published(split)).toEqual(published(whole));
    // AND THE DISCLOSURE SPLITS WITH IT: the one live row is listable, the
    // three folded ones are not.
    expect(split.summary.foldedOperations).toBe(3);
    expect(split.recent).toHaveLength(1);
    expect(whole.recent).toHaveLength(4);
  });

  it('stays available when every row has aged into totals', () => {
    const empty = summarizeDashboardAnalytics([], {});
    expect(empty.available).toBe(false);

    const folded = summarizeDashboardAnalytics([], {
      rollups: foldEntries(population),
    });
    expect(folded.available).toBe(true);
    expect(folded.recent).toHaveLength(0);
    expect(folded.summary.foldedDays).toBe(1);
  });
});

describe('dashboard analytics across a measurement contract change', () => {
  /** A row proved under the contract that added input displacement. */
  const displaced = row({
    toolName: 'smart_dependencies',
    originalTokens: 4_937,
    optimizedTokens: 300,
    tokensSaved: 4_637,
    savingsMeasured: true,
    client: 'claude-code',
    measurementId: 'measurement-d',
    timestamp: '2026-08-12T12:08:00.000Z',
    metadata: {
      measurementId: 'measurement-d',
      measurementSchemaVersion: 3,
      measurement: 'measured-input-displacement',
      measurementClass: 'verified-input-displacement',
      baselineKind: 'measured-displaced-input',
      baselineBytes: 19_748,
      returnedBytes: 1_200,
      bytesSaved: 18_548,
      displacedInputTokens: 4_937,
      displacedInputBytes: 19_748,
      displacedInputSha256: 'e'.repeat(64),
      displacedInputFiles: 1,
      returnedSha256: 'f'.repeat(64),
    },
  });

  /**
   * A row credited on the tool's own word for its before, under the contract
   * that first admitted one.
   */
  const declared = row({
    toolName: 'smart_package_json',
    originalTokens: 8_100,
    optimizedTokens: 420,
    tokensSaved: 7_680,
    savingsMeasured: true,
    client: 'claude-code',
    measurementId: 'measurement-e',
    timestamp: '2026-08-12T12:09:00.000Z',
    metadata: {
      measurementId: 'measurement-e',
      measurementSchemaVersion: SAVINGS_MEASUREMENT_SCHEMA_VERSION,
      measurement: 'declared-input-displacement',
      measurementClass: 'declared-input-displacement',
      baselineKind: 'declared-displaced-input',
      declaredBaselineTokens: 8_100,
      declaredBaselineSource: 'resolved-project-file',
      baselineBytes: null,
      returnedBytes: 1_680,
      bytesSaved: 0,
      returnedSha256: 'c'.repeat(64),
    },
  });

  it('labels each contract instead of only publishing their sum', () => {
    /*
     * A DAY ALREADY FOLDED CANNOT BE RE-MEASURED under a newer contract: its
     * rows were pruned. So the honest disclosure is which definition of a
     * saving produced which part of the headline, not a single number that
     * could have come from either.
     */
    const report = summarizeDashboardAnalytics(
      [verified, legacyRow, displaced, declared],
      {}
    );
    const contracts = report.summary.contracts;

    // NEWEST FIRST, so the definition in force now leads. Version 3 is the
    // interesting one: it is no longer current, and its input-displacement
    // credit survives anyway, because the transport and displacement contracts
    // did not change when version 4 admitted a declared baseline.
    expect(contracts.map((c) => c.measurementSchemaVersion)).toEqual([
      SAVINGS_MEASUREMENT_SCHEMA_VERSION,
      3,
      2,
      0,
    ]);
    expect(contracts.map((c) => c.current)).toEqual([
      true,
      false,
      false,
      false,
    ]);

    const byVersion = new Map(
      contracts.map((c) => [c.measurementSchemaVersion, c])
    );
    // The transport credit belongs to the contract that proved it ...
    expect(byVersion.get(2)?.totalTokensSaved).toBe(750);
    // ... the unversioned row earned none, and says so under its own label ...
    expect(byVersion.get(0)?.operations).toBe(1);
    expect(byVersion.get(0)?.totalTokensSaved).toBe(0);
    // ... and the displacement credit is not a transport credit.
    expect(byVersion.get(3)?.totalTokensSaved).toBe(0);
    expect(byVersion.get(3)?.inputDisplacementTokens).toBe(4_637);
    // ... and a declared baseline is neither of the two, under any contract.
    const now = byVersion.get(SAVINGS_MEASUREMENT_SCHEMA_VERSION);
    expect(now?.totalTokensSaved).toBe(0);
    expect(now?.inputDisplacementTokens).toBe(0);
    expect(now?.declaredDisplacementTokens).toBe(7_680);

    // POSITIVE CONTROL: the shares account for every operation the headline
    // counted, so a label cannot be dropped without this failing.
    expect(contracts.reduce((sum, c) => sum + c.operations, 0)).toBe(
      report.summary.totalOperations
    );
    expect(contracts.reduce((sum, c) => sum + c.totalTokensSaved, 0)).toBe(
      report.summary.totalTokensSaved
    );
  });

  it('attributes the same shares after the day has been folded', () => {
    /*
     * THE WHOLE REASON THE STAMP IS IN THE ROLLUP KEY. A folded day keeps no
     * rows, so a dimension missing from that key can never be recovered -- the
     * attribution would silently collapse into one unlabelled total.
     */
    const population = [verified, legacyRow, displaced, declared];
    const rows = summarizeDashboardAnalytics(population, {});
    const folded = summarizeDashboardAnalytics([], {
      rollups: foldEntries(population),
    });

    expect(rows.summary.contracts).toHaveLength(4);
    expect(folded.summary.contracts).toEqual(rows.summary.contracts);
  });

  it('keeps a displaced file read out of the transport total', () => {
    const transportOnly = summarizeDashboardAnalytics([verified], {});
    const both = summarizeDashboardAnalytics([verified, displaced], {});

    // The displacement row adds an operation and its own figure ...
    expect(both.summary.displacementOperations).toBe(1);
    expect(both.summary.inputDisplacementTokens).toBe(4_637);
    // ... and moves the transport headline by nothing at all, because one
    // reply measured against two befores is not two savings.
    expect(both.summary.totalTokensSaved).toBe(
      transportOnly.summary.totalTokensSaved
    );
    expect(transportOnly.summary.inputDisplacementTokens).toBe(0);
    expect(transportOnly.summary.displacementOperations).toBe(0);
  });
});
