import { describe, expect, test } from '@jest/globals';
import {
  CognitiveCostLedger,
  compareCognitiveCosts,
  stratifiedCostDiagnostics,
} from '../../ucr/index.mjs';

function complete(runId, consumerTokens) {
  const ledger = new CognitiveCostLedger({ runId });
  ledger.record({
    phase: 'schema',
    inputTokens: 0,
    accountingMethod: 'tools/list:tiktoken',
  });
  ledger.record({
    phase: 'capture',
    outputTokens: 20,
    modelCalls: 0,
    accountingMethod: 'in-turn-delta:tiktoken',
  });
  ledger.record({
    phase: 'retrieval',
    latencyMs: 2,
    toolCalls: 1,
    accountingMethod: 'host-timer',
  });
  ledger.record({
    phase: 'injection',
    inputTokens: 10,
    accountingMethod: 'tiktoken',
    includedInTotal: false,
  });
  ledger.record({
    phase: 'consumer',
    inputTokens: consumerTokens,
    outputTokens: 10,
    latencyMs: 20,
    modelCalls: 1,
    accountingMethod: 'provider-native',
  });
  ledger.record({
    phase: 'validation',
    latencyMs: 1,
    toolCalls: 1,
    accountingMethod: 'host-timer',
  });
  return ledger.report();
}

describe('cognitive phase accounting', () => {
  test('attributes every phase without double-counting injected input', () => {
    const report = complete('runtime', 50);
    expect(report.attributionComplete).toBe(true);
    expect(report.totals).toMatchObject({
      inputTokens: 50,
      outputTokens: 30,
      totalTokens: 80,
      modelCalls: 1,
    });
    expect(report.ledgerHash).toHaveLength(64);
  });

  test('compares only complete ledgers and rejects invalid measurements', () => {
    expect(compareCognitiveCosts(complete('control', 100), complete('runtime', 50)))
      .toMatchObject({ comparable: true, tokenReduction: 0.38461538461538464 });
    const ledger = new CognitiveCostLedger({ runId: 'bad' });
    expect(() =>
      ledger.record({
        phase: 'consumer',
        inputTokens: -1,
        accountingMethod: 'provider-native',
      })
    ).toThrow(/non-negative/);
  });

  test('reports regressions by direction, family, and client', () => {
    const rows = [
      {
        pairId: 'p1',
        arm: 'empty',
        direction: 'codex->claude-code',
        family: 'workflow',
        consumerClient: 'claude-code',
        totalTokens: 100,
        latencyMs: 100,
      },
      {
        pairId: 'p1',
        arm: 'runtime',
        direction: 'codex->claude-code',
        family: 'workflow',
        consumerClient: 'claude-code',
        totalTokens: 110,
        latencyMs: 90,
      },
    ];
    const report = stratifiedCostDiagnostics(rows);
    expect(report.passed).toBe(false);
    expect(report.groups.find((group) => group.dimension === 'direction')).toMatchObject({
      tokenOverhead: 0.1,
      regressions: ['tokens'],
    });
  });
});
