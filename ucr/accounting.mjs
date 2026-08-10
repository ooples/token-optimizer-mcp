import { sha256 } from './protocol.mjs';

export const COGNITIVE_COST_PHASES = Object.freeze([
  'schema',
  'capture',
  'retrieval',
  'injection',
  'consumer',
  'validation',
]);

function finite(value, field) {
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`${field} must be a non-negative finite number`);
  return Number(value);
}

export class CognitiveCostLedger {
  constructor({ runId, requiredPhases = COGNITIVE_COST_PHASES } = {}) {
    if (!runId) throw new Error('cognitive cost ledger requires runId');
    this.runId = runId;
    this.requiredPhases = [...requiredPhases];
    this.entries = [];
  }

  record({
    phase,
    inputTokens = 0,
    outputTokens = 0,
    latencyMs = 0,
    toolCalls = 0,
    modelCalls = 0,
    accountingMethod,
    includedInTotal = true,
    detail = null,
  }) {
    if (!COGNITIVE_COST_PHASES.includes(phase))
      throw new Error(`unknown cognitive cost phase ${phase}`);
    if (!accountingMethod)
      throw new Error('cognitive cost entry requires an accounting method');
    const entry = {
      phase,
      inputTokens: finite(inputTokens, 'inputTokens'),
      outputTokens: finite(outputTokens, 'outputTokens'),
      latencyMs: finite(latencyMs, 'latencyMs'),
      toolCalls: finite(toolCalls, 'toolCalls'),
      modelCalls: finite(modelCalls, 'modelCalls'),
      accountingMethod,
      includedInTotal: includedInTotal === true,
      detail,
    };
    this.entries.push(entry);
    return entry;
  }

  report() {
    const included = this.entries.filter((entry) => entry.includedInTotal);
    const phases = new Set(this.entries.map((entry) => entry.phase));
    const missingPhases = this.requiredPhases.filter(
      (phase) => !phases.has(phase)
    );
    const sum = (field) =>
      included.reduce((total, entry) => total + entry[field], 0);
    const body = {
      schemaVersion: 'ucr.cognitive-cost-ledger/1',
      runId: this.runId,
      entries: this.entries,
      totals: {
        inputTokens: sum('inputTokens'),
        outputTokens: sum('outputTokens'),
        totalTokens: sum('inputTokens') + sum('outputTokens'),
        latencyMs: sum('latencyMs'),
        toolCalls: sum('toolCalls'),
        modelCalls: sum('modelCalls'),
      },
      missingPhases,
      attributionComplete: missingPhases.length === 0,
    };
    return { ...body, ledgerHash: sha256(body) };
  }
}

export function compareCognitiveCosts(control, runtime) {
  const ratio = (baseline, treatment) =>
    baseline > 0 ? (baseline - treatment) / baseline : null;
  return {
    tokenReduction: ratio(
      control?.totals?.totalTokens,
      runtime?.totals?.totalTokens
    ),
    latencyReduction: ratio(
      control?.totals?.latencyMs,
      runtime?.totals?.latencyMs
    ),
    modelCallReduction: ratio(
      control?.totals?.modelCalls,
      runtime?.totals?.modelCalls
    ),
    comparable:
      control?.attributionComplete === true &&
      runtime?.attributionComplete === true,
  };
}

function percentile(values, quantile) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)
  ];
}

/** Explain aggregate and directional regressions without allowing cancellation. */
export function stratifiedCostDiagnostics(
  rows,
  { maximumTokenOverhead = 0.05, maximumLatencyOverhead = 0.05 } = {}
) {
  const pairs = new Map();
  for (const row of rows || []) {
    if (!row.pairId || !['empty', 'runtime'].includes(row.arm)) continue;
    if (!pairs.has(row.pairId)) pairs.set(row.pairId, {});
    pairs.get(row.pairId)[row.arm] = row;
  }
  const complete = [...pairs.values()].filter(
    (pair) => pair.empty && pair.runtime
  );
  const keys = new Set(
    complete.flatMap((pair) => [
      `direction:${pair.runtime.direction}`,
      `family:${pair.runtime.family}`,
      `client:${pair.runtime.consumerClient}`,
    ])
  );
  const groups = [...keys].map((key) => {
    const [dimension, value] = key.split(':');
    const selected = complete.filter(
      (pair) => pair.runtime[
        dimension === 'client' ? 'consumerClient' : dimension
      ] === value
    );
    const ratios = (field) =>
      selected
        .map((pair) =>
          pair.empty[field] > 0 && Number.isFinite(pair.runtime[field])
            ? (pair.runtime[field] - pair.empty[field]) / pair.empty[field]
            : null
        )
        .filter(Number.isFinite);
    const tokenRatios = ratios('totalTokens');
    const latencyRatios = ratios('latencyMs');
    const average = (values) =>
      values.length
        ? values.reduce((sum, item) => sum + item, 0) / values.length
        : null;
    const tokenOverhead = average(tokenRatios);
    const latencyOverheadP95 = percentile(latencyRatios, 0.95);
    const regressions = [];
    if (tokenOverhead === null || tokenOverhead > maximumTokenOverhead)
      regressions.push('tokens');
    if (
      latencyOverheadP95 === null ||
      latencyOverheadP95 > maximumLatencyOverhead
    )
      regressions.push('latency');
    return {
      dimension,
      value,
      pairs: selected.length,
      tokenOverhead,
      latencyOverheadP95,
      regressions,
      passed: regressions.length === 0,
    };
  });
  return {
    passed: groups.length > 0 && groups.every((group) => group.passed),
    thresholds: { maximumTokenOverhead, maximumLatencyOverhead },
    groups,
  };
}
