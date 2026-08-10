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

export const REQUIRED_COMPETITIVE_BASELINES = Object.freeze([
  'no-memory',
  'full-history',
  'static-instructions',
  'vector-rag',
  'graph-rag',
  'memory-os',
  'vendor-memory',
]);

export const PRODUCT_BASELINE_KINDS = Object.freeze([
  'vector-rag',
  'graph-rag',
  'memory-os',
  'vendor-memory',
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

/** Validate that a comparison is reproducible and represents a live product run. */
export function validateCompetitiveEvidence(row) {
  const diagnostics = [];
  if (!REQUIRED_COMPETITIVE_BASELINES.includes(row?.baselineKind))
    diagnostics.push('baseline kind is outside the preregistered comparison set');
  if (row?.fair !== true) diagnostics.push('budgets or task conditions differ');
  if (row?.reproduced !== true) diagnostics.push('run was not reproduced');
  if (row?.liveExecution !== true)
    diagnostics.push('reference-only execution cannot support superiority');
  if (row?.versionPinned !== true)
    diagnostics.push('baseline version or image digest is not pinned');
  if (row?.configurationPublished !== true)
    diagnostics.push('baseline configuration is not published');
  if (
    PRODUCT_BASELINE_KINDS.includes(row?.baselineKind) &&
    row?.namedProduct !== true
  )
    diagnostics.push('product baseline is not a named reproduced product');
  if (row?.ucrOnParetoFrontier !== true)
    diagnostics.push('UCR is not on the Pareto frontier');
  if (!(row?.effectIntervalLow > 0))
    diagnostics.push('correctness effect interval includes zero');
  if (!(row?.correctnessImprovement > 0.1))
    diagnostics.push('correctness improvement is not greater than ten points');
  return {
    valid: diagnostics.length === 0,
    diagnostics,
  };
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

function tokenCount(items) {
  return Math.ceil(JSON.stringify(items).length / 4);
}

function vectorScore(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length)
    return 0;
  const dot = left.reduce((sum, value, index) => sum + value * right[index], 0);
  const a = Math.sqrt(left.reduce((sum, value) => sum + value ** 2, 0));
  const b = Math.sqrt(right.reduce((sum, value) => sum + value ** 2, 0));
  return a && b ? dot / (a * b) : 0;
}

export function executeReferenceBaseline(kind, task) {
  if (!BASELINE_KINDS.includes(kind)) throw new Error(`unknown baseline ${kind}`);
  const started = performance.now();
  const memories = task.memories || [];
  let selected = [];
  if (kind === 'full-history') selected = [...memories];
  else if (kind === 'static-instructions')
    selected = memories.filter((memory) => memory.staticInstruction);
  else if (kind === 'vector-rag')
    selected = memories
      .map((memory) => ({ memory, score: vectorScore(task.embedding, memory.embedding) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, task.limit || 3)
      .map((item) => item.memory);
  else if (kind === 'graph-rag') {
    const frontier = new Set(task.seedIds || []);
    const selectedIds = new Set(frontier);
    for (let depth = 0; depth < (task.depth || 2); depth++) {
      for (const edge of task.edges || []) {
        if (frontier.has(edge.from) || frontier.has(edge.to)) {
          selectedIds.add(edge.from);
          selectedIds.add(edge.to);
        }
      }
      for (const id of selectedIds) frontier.add(id);
    }
    selected = memories.filter((memory) => selectedIds.has(memory.id));
  } else if (kind === 'temporal-graph')
    selected = [...memories]
      .filter((memory) => memory.validTo == null || memory.validTo > task.at)
      .sort((a, b) => (b.learnedAt || 0) - (a.learnedAt || 0))
      .slice(0, task.limit || 3);
  else if (kind === 'memory-os')
    selected = [...memories]
      .filter((memory) => memory.state === 'active')
      .sort(
        (a, b) =>
          (b.utility || 0) - (a.utility || 0) ||
          (b.learnedAt || 0) - (a.learnedAt || 0)
      )
      .slice(0, task.limit || 3);
  else if (kind === 'workflow-library')
    selected = memories.filter(
      (memory) =>
        memory.type === 'procedure' &&
        (memory.tags || []).some((tag) => (task.tags || []).includes(tag))
    );
  else if (kind === 'vendor-memory')
    selected = memories
      .filter((memory) =>
        (memory.tags || []).some((tag) => (task.tags || []).includes(tag))
      )
      .slice(0, task.limit || 3);
  else if (kind === 'oracle-context')
    selected = memories.filter((memory) => memory.id === task.targetMemoryId);
  const selectedIds = selected.map((memory) => memory.id);
  return {
    kind,
    selectedIds,
    correct: selectedIds.includes(task.targetMemoryId),
    irrelevant: selectedIds.filter((id) => id !== task.targetMemoryId).length,
    tokens: tokenCount(selected),
    latencyMs: performance.now() - started,
    referenceImplementation: true,
    productClaimAllowed: false,
  };
}

export function executeReferenceCompetition(tasks, kinds = BASELINE_KINDS) {
  return tasks.flatMap((task) =>
    kinds.map((kind) => ({ taskId: task.id, ...executeReferenceBaseline(kind, task) }))
  );
}
