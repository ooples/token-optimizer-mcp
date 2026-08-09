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
  profile = 'cognitive',
  advanced = [],
} = {}) {
  const bootstrap = BOOTSTRAP_COGNITIVE_OPERATIONS.map(
    (operation) => operation.name
  );
  if (profile !== 'cognitive') {
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
} = {}) {
  const estimate = (value) => Math.ceil(JSON.stringify(value).length / 4);
  return {
    schemaTokens: estimate(schemas),
    instructionTokens: estimate(instructions),
    hookTokens: estimate(hooks),
    capsuleTokens: estimate(capsules),
    roundTrips: calls.length,
    totalTokens:
      estimate(schemas) +
      estimate(instructions) +
      estimate(hooks) +
      estimate(capsules),
  };
}
