import { describe, expect, it } from '@jest/globals';
import { AnalyticsManager } from '../../src/analytics/analytics-manager.js';
import type {
  AnalyticsEntry,
  AnalyticsStorage,
} from '../../src/analytics/analytics-types.js';
import { getOptimizationReportTool } from '../../src/tools/analytics/get-optimization-report.js';

/**
 * #498. Two defects that made the report's figures contradict each other:
 *
 * 1. "After optimization" summed every observed reply while "Original" and
 *    "saved" summed only verified reductions, so saved > original - optimized
 *    on a real ledger (4,355,006 against 5,972,827 - 3,335,483).
 * 2. sessionId scoped the summary but not byAction / byHook / byServer, which
 *    showed the all-time ledger under a session summary.
 */

let seq = 0;
function verified(
  sessionId: string,
  hookPhase: string,
  original: number,
  returned: number
): AnalyticsEntry {
  seq += 1;
  const id = `m-${seq}`;
  return {
    hookPhase,
    toolName: 'smart_grep',
    mcpServer: 'token-optimizer',
    originalTokens: original,
    optimizedTokens: returned,
    tokensSaved: original - returned,
    timestamp: '2026-10-13T12:00:00.000Z',
    sessionId,
    savingsMeasured: true,
    measurementId: id,
    metadata: {
      measurementId: id,
      measurementSchemaVersion: 2,
      measurementClass: 'verified-transport-reduction',
      baselineKind: 'materialized-undisclosed-mcp-result',
      disclosureRef: 'a'.repeat(16),
      baselineBytes: original * 4,
      returnedBytes: returned * 4,
      bytesSaved: (original - returned) * 4,
      baselineSha256: 'a'.repeat(64),
      returnedSha256: 'b'.repeat(64),
    },
  } as AnalyticsEntry;
}

/** A reply that was observed but never verified: it has returned tokens and no saving. */
function observedOnly(sessionId: string, returned: number): AnalyticsEntry {
  return {
    hookPhase: 'PostToolUse',
    toolName: 'smart_read',
    mcpServer: 'token-optimizer',
    originalTokens: returned,
    optimizedTokens: returned,
    tokensSaved: 0,
    timestamp: '2026-10-13T12:00:00.000Z',
    sessionId,
    metadata: {
      measurementSchemaVersion: 2,
      measurement: 'actual-return-context-only',
    },
  } as AnalyticsEntry;
}

function storageOf(entries: AnalyticsEntry[]): AnalyticsStorage {
  const match = (filters?: Partial<AnalyticsEntry>) =>
    entries.filter((e) =>
      Object.entries(filters ?? {}).every(
        ([k, v]) => v === undefined || (e as Record<string, unknown>)[k] === v
      )
    );
  return {
    save: async () => {},
    saveBatch: async () => {},
    query: async (filters) => match(filters),
    queryByDateRange: async () => entries,
    clear: async () => {},
    count: async () => entries.length,
    rollups: async () => [],
  } as unknown as AnalyticsStorage;
}

const LEDGER = [
  verified('mine', 'PreToolUse', 1_000, 250),
  verified('mine', 'PostToolUse', 2_000, 500),
  observedOnly('mine', 4_000),
  verified('other', 'Stop', 9_000, 1_000),
  observedOnly('other', 7_000),
];

async function report(args: { sessionId?: string }) {
  const tool = getOptimizationReportTool(
    new AnalyticsManager(storageOf(LEDGER))
  );
  return JSON.parse(await tool(args)) as Record<string, any>;
}

describe('the report is one population (#498)', () => {
  it('saved equals original minus the returned tokens it is printed against', async () => {
    const { summary } = await report({});
    expect(summary.totalTokensSaved).toBe(
      summary.totalOriginalTokens - summary.totalVerifiedReturnedTokens
    );
    // The broad returned-context figure is still reported, and is larger,
    // because it counts the unverified replies too -- which is why it cannot
    // be the "after" of a verified "before".
    expect(summary.totalOptimizedTokens).toBeGreaterThan(
      summary.totalVerifiedReturnedTokens
    );
  });

  it('prints the same-population figure as "After optimization"', async () => {
    const { formatted, summary } = await report({});
    expect(formatted).toMatch(
      new RegExp(
        `After optimization : ${summary.totalVerifiedReturnedTokens.toLocaleString('en-US')}`
      )
    );
  });

  it('scopes every breakdown to the session, not just the summary', async () => {
    const r = await report({ sessionId: 'mine' });
    expect(r.summary.totalOperations).toBe(3);
    const ops = (rows: { totalOperations: number }[]) =>
      rows.reduce((s, row) => s + row.totalOperations, 0);
    expect(ops(r.byHook)).toBe(3);
    expect(ops(r.byAction)).toBe(3);
    expect(ops(r.byServer)).toBe(3);
    expect(r.byHook.map((h: { name: string }) => h.name)).not.toContain('Stop');
  });
});
