import { sha256 } from './protocol.mjs';

export const BASELINE_KINDS = Object.freeze([
  'no-memory',
  'full-history',
  'static-instructions',
  'vector-rag',
  'graph-rag',
  'temporal-graph',
  'memory-os',
  'workflow-library',
  'vendor-memory',
  'oracle-context',
]);

export function validateFairRun(run, reference) {
  const fields = [
    'model',
    'modelVersion',
    'taskId',
    'permissionsHash',
    'contextBudget',
    'retryBudget',
    'toolBudget',
  ];
  const mismatches = fields.filter((field) => run[field] !== reference[field]);
  return { fair: mismatches.length === 0, mismatches };
}

export function competitorManifest(input) {
  if (!BASELINE_KINDS.includes(input.kind))
    throw new Error(`unknown baseline ${input.kind}`);
  const manifest = {
    schemaVersion: 'ucr.competitor/1',
    kind: input.kind,
    name: input.name,
    version: input.version,
    command: input.command,
    image: input.image || null,
    configuration: input.configuration || {},
    license: input.license || null,
    automation: input.automation || 'scripted',
    limitations: input.limitations || [],
  };
  return { ...manifest, manifestHash: sha256(manifest) };
}

function dominates(left, right) {
  const noWorse =
    left.correctness >= right.correctness &&
    left.harm <= right.harm &&
    left.tokens <= right.tokens &&
    left.latencyMs <= right.latencyMs;
  const better =
    left.correctness > right.correctness ||
    left.harm < right.harm ||
    left.tokens < right.tokens ||
    left.latencyMs < right.latencyMs;
  return noWorse && better;
}

export function paretoFront(rows) {
  return rows.filter(
    (candidate) =>
      !rows.some((other) => other !== candidate && dominates(other, candidate))
  );
}

export function strongestComparable(rows) {
  const comparable = rows.filter(
    (row) => row.fair === true && row.reproduced === true
  );
  return (
    comparable.sort(
      (a, b) =>
        b.correctness - a.correctness ||
        a.harm - b.harm ||
        a.tokens - b.tokens ||
        a.latencyMs - b.latencyMs
    )[0] || null
  );
}

export function superiorityClaim(ucr, baselines, effect) {
  const strongest = strongestComparable(baselines);
  if (!strongest)
    return { allowed: false, reason: 'no reproduced fair comparable baseline' };
  const improvement = ucr.correctness - strongest.correctness;
  const onFrontier = paretoFront([
    ucr,
    ...baselines.filter((row) => row.fair),
  ]).includes(ucr);
  return {
    allowed: improvement > 0.1 && effect?.low > 0 && onFrontier,
    strongest: strongest.name,
    improvement,
    interval: effect,
    onFrontier,
    reason:
      improvement <= 0.1
        ? 'correctness improvement is not greater than ten points'
        : effect?.low <= 0
          ? 'confidence interval includes zero'
          : !onFrontier
            ? 'UCR is not on the Pareto frontier'
            : null,
  };
}
