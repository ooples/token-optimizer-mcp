export const BOOTSTRAP_COGNITIVE_OPERATIONS = Object.freeze([
  {
    name: 'context_page',
    description:
      'Obtain a bounded, decision-specific cognition capsule or an explicit empty result.',
    input: ['query', 'task', 'budget'],
  },
  {
    name: 'cognition_record',
    description:
      'Propose and verify durable cognition authored by the active model.',
    input: ['kind', 'semanticObject', 'evidenceReceipts'],
  },
]);

export const ADVANCED_COGNITIVE_OPERATIONS = Object.freeze([
  {
    name: 'checkpoint_handoff',
    description: 'Create, restore, or acknowledge a resumable task checkpoint.',
    input: ['operation', 'checkpoint', 'currentState'],
  },
  {
    name: 'outcome_report',
    description:
      'Report correctness, harm, recurrence, work, latency, and token outcomes.',
    input: ['episodeId', 'outcome', 'graderReceipt'],
  },
]);

export const COMPATIBILITY_ALIASES = Object.freeze({
  wiki_read: 'context_page',
  wiki_write: 'cognition_record',
  get_optimization_report: 'outcome_report',
});

export function negotiateCapabilities({
  dynamicExposure = false,
  requested = [],
  profile = 'continuity',
  advanced = [],
} = {}) {
  const bootstrap = BOOTSTRAP_COGNITIVE_OPERATIONS.map(
    (operation) => operation.name
  );
  if (!['continuity', 'cognitive'].includes(profile)) {
    return { profile, operations: requested, dynamic: false, migration: [] };
  }
  const operations = dynamicExposure
    ? [
        ...new Set([
          ...bootstrap,
          ...requested.filter((name) => advanced.includes(name)),
        ]),
      ]
    : bootstrap;
  return {
    profile,
    operations,
    dynamic: dynamicExposure,
    migration: Object.entries(COMPATIBILITY_ALIASES).map(
      ([legacy, replacement]) => ({
        legacy,
        replacement,
        state: 'deprecated-compatible',
      })
    ),
  };
}

export function surfaceOverhead({
  schemas = [],
  instructions = '',
  hooks = [],
  capsules = [],
  calls = [],
  tokenCounter = null,
} = {}) {
  const estimate = (value) =>
    tokenCounter
      ? tokenCounter.count(value)
      : Math.ceil(JSON.stringify(value).length / 4);
  return {
    schemaTokens: estimate(schemas),
    instructionTokens: estimate(instructions),
    hookTokens: estimate(hooks),
    capsuleTokens: estimate(capsules),
    roundTrips: calls.length,
    tokenAccounting:
      tokenCounter?.method || 'heuristic:utf8-length-div-4',
    totalTokens:
      estimate(schemas) +
      estimate(instructions) +
      estimate(hooks) +
      estimate(capsules),
  };
}

function percentile(values, quantile) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[
    Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))
  ];
}

export function capabilityOverheadStudy(rows) {
  const ratios = rows
    .filter(
      (row) =>
        row.applicable === false &&
        Number.isFinite(row.baselineTokens) &&
        Number.isFinite(row.runtimeTokens) &&
        row.baselineTokens > 0
    )
    .map((row) => (row.runtimeTokens - row.baselineTokens) / row.baselineTokens);
  const roundTrips = rows
    .filter((row) => row.applicable === false)
    .map((row) => row.additionalRoundTrips)
    .filter(Number.isFinite);
  const p50 = percentile(ratios, 0.5);
  const p95 = percentile(ratios, 0.95);
  return {
    schemaVersion: 'ucr.capability-overhead/1',
    samples: ratios.length,
    p50ContextOverhead: p50,
    p95ContextOverhead: p95,
    p95AdditionalRoundTrips: percentile(roundTrips, 0.95),
    nativeTokenAccounting: rows.every((row) =>
      String(row.tokenAccounting || '').startsWith('tiktoken:')
    ),
    attributionComplete: rows.every(
      (row) =>
        row.attribution &&
        [
          'staticSchemaTokens',
          'instructionTokens',
          'capsuleTokens',
          'expansionTokens',
          'outputTokens',
        ].every((field) => Number.isFinite(row.attribution[field]))
    ),
    passed:
      ratios.length > 0 &&
      p50 < 0.02 &&
      p95 < 0.05 &&
      percentile(roundTrips, 0.95) <= 1,
  };
}

export function capabilitySurfaceAudit(operations) {
  const names = operations.map((operation) => operation.name);
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  const descriptions = new Map();
  const semanticallyRedundant = [];
  for (const operation of operations) {
    const fingerprint = JSON.stringify({
      description: String(operation.description || '').toLowerCase(),
      input: [...(operation.input || [])].sort(),
    });
    const prior = descriptions.get(fingerprint);
    if (prior) semanticallyRedundant.push([prior, operation.name]);
    else descriptions.set(fingerprint, operation.name);
  }
  return {
    operations: operations.length,
    duplicates: [...new Set(duplicates)],
    semanticallyRedundant,
    bootstrapMinimal:
      operations.length === BOOTSTRAP_COGNITIVE_OPERATIONS.length &&
      BOOTSTRAP_COGNITIVE_OPERATIONS.every((operation) =>
        names.includes(operation.name)
      ),
  };
}
