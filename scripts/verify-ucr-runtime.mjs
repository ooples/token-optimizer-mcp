#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  BOOTSTRAP_COGNITIVE_OPERATIONS,
  CognitionGraph,
  ContextVM,
  CoordinationRuntime,
  CreditLedger,
  FederationPolicy,
  GuardRuntime,
  RetrievalPlanner,
  RolloutController,
  SemanticCompiler,
  UCRAdapter,
  UCR_CLIENT_REGISTRY,
  benchmarkSchedule,
  canonicalJson,
  canonicalReplay,
  certifyAdapter,
  compoundingSchedule,
  competitorManifest,
  createCheckpoint,
  createCurriculum,
  exactEpisodeJoin,
  freezeBenchmark,
  negotiateCapabilities,
  recoveryExercise,
  releaseVerdict,
  restoreCheckpoint,
  semanticQuality,
  sha256,
  signedBundle,
  surfaceOverhead,
  verifyBundle,
  verifyEvidenceLedger,
} from '../ucr/index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_PATH = join(ROOT, 'evals', 'ucr', 'conformance-fixture-v1.json');
const BENCHMARK_PATH = join(ROOT, 'evals', 'ucr', 'benchmark-v1.json');
const COMPETITORS_PATH = join(ROOT, 'evals', 'ucr', 'competitors-v1.json');
const EVIDENCE_PATH = join(
  ROOT,
  'evals',
  'ucr',
  'results',
  'deterministic-verification-v1.json'
);
const EVIDENCE_INDEX_PATH = join(
  ROOT,
  'evals',
  'ucr',
  'results',
  'evidence-index-v2.json'
);
const args = new Set(process.argv.slice(2));

function independentPythonReplay(events) {
  const candidates =
    process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
  for (const command of candidates) {
    const commandArgs = command === 'py' ? ['-3'] : [];
    const result = spawnSync(
      command,
      [...commandArgs, join(ROOT, 'scripts', 'verify-ucr-protocol.py')],
      {
        input: JSON.stringify(events),
        encoding: 'utf8',
        windowsHide: true,
      }
    );
    if (result.error?.code === 'ENOENT') continue;
    if (result.status !== 0)
      return {
        available: true,
        passed: false,
        diagnostic: String(result.stderr || result.stdout || '').trim(),
      };
    try {
      return {
        available: true,
        passed: true,
        report: JSON.parse(result.stdout),
      };
    } catch (error) {
      return { available: true, passed: false, diagnostic: error.message };
    }
  }
  return {
    available: false,
    passed: false,
    diagnostic: 'python not installed',
  };
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const checks = [];
const check = (name, passed, detail) => {
  checks.push({ name, passed: Boolean(passed), detail });
  const suffix =
    detail === undefined
      ? ''
      : ` -- ${typeof detail === 'string' ? detail : canonicalJson(detail)}`;
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}${suffix}`);
};

const fixture = readJson(FIXTURE_PATH);
const benchmarkSource = readJson(BENCHMARK_PATH);
const competitorSource = readJson(COMPETITORS_PATH);
const clients = Object.keys(UCR_CLIENT_REGISTRY).sort();
const evidenceIndex = existsSync(EVIDENCE_INDEX_PATH)
  ? readJson(EVIDENCE_INDEX_PATH)
  : null;

console.log('UCR deterministic verification');

// Workstreams 1 and 13: replay one language-neutral fixture through every
// registered client. Identity fields may differ; cognition semantics may not.
const certifications = clients.map((client) =>
  certifyAdapter(client, fixture.inputs)
);
const canonicalSemantics = (certification) =>
  certification.events.map((event) => ({
    type: event.type,
    payloadHash: event.payloadHash,
    causalParents: event.causalParents,
    sensitivity: event.sensitivity,
    scope: event.scope,
  }));
const referenceSemantics = canonicalSemantics(certifications[0]);
const semanticParity = certifications.every(
  (certification) =>
    canonicalJson(canonicalSemantics(certification)) ===
    canonicalJson(referenceSemantics)
);
const sourceEvents = certifications.find(
  (item) => item.client === 'codex'
).events;
check(
  'all registered clients pass schema conformance',
  certifications.every((item) => item.certified),
  `${certifications.filter((item) => item.certified).length}/${clients.length}`
);
check(
  'all clients produce identical cognition semantics',
  semanticParity,
  `${fixture.inputs.length} lifecycle events each`
);
const independentReplay = independentPythonReplay(sourceEvents);
const referenceSemanticDigest = sha256(referenceSemantics);
check(
  'independent Python implementation replays identical cognition semantics',
  independentReplay.passed &&
    independentReplay.report?.semanticDigest === referenceSemanticDigest,
  independentReplay.passed
    ? independentReplay.report
    : independentReplay.diagnostic
);
check(
  'certification is honest about executable smoke coverage',
  certifications.every((item) => item.executableSmoke === 'unexercised'),
  'schema certification is not labelled live proof'
);
const { reportHash: evidenceIndexHash, ...evidenceIndexBody } =
  evidenceIndex || {};
const evidenceIndexValid =
  Boolean(evidenceIndex) &&
  sha256(evidenceIndexBody) === evidenceIndexHash &&
  evidenceIndex?.summary?.artifactsValid ===
    evidenceIndex?.summary?.artifactsTotal &&
  evidenceIndex?.conformanceLedgerVerification?.valid === true &&
  verifyEvidenceLedger(evidenceIndex?.conformanceLedger, {
    publicKey: evidenceIndex?.conformancePublicKey,
  }).valid;
check(
  'unified signed evidence index is integrity-valid',
  evidenceIndexValid,
  evidenceIndex
    ? `${evidenceIndex.summary.artifactsValid}/${evidenceIndex.summary.artifactsTotal} artifacts`
    : 'not assembled'
);
check(
  'live cross-client smoke covers three passing directions without raw transcripts',
  evidenceIndexValid &&
    evidenceIndex.summary.liveDirectionsPassed === 3 &&
    evidenceIndex.summary.liveDirectionsAttempted === 3,
  evidenceIndex?.summary
);
check(
  'scale, coordination, adapter, and fault artifacts meet frozen targets',
  evidenceIndexValid &&
    evidenceIndex.summary.graphEvents === 1_000_000 &&
    evidenceIndex.summary.coordinationWorkers === 100 &&
    evidenceIndex.summary.registeredClientProcesses === clients.length &&
    evidenceIndex.summary.productionFaults === 6 &&
    evidenceIndex.summary.cognitiveSchemaTokens < 1_500 &&
    evidenceIndex.summary.cognitiveReductionVsFull > 0.95,
  evidenceIndex?.summary
);

const reordered = [...sourceEvents]
  .reverse()
  .flatMap((event, index) => (index % 2 ? [event, event] : [event]));
const orderedReplay = canonicalReplay(sourceEvents);
const reorderedReplay = canonicalReplay(reordered);
check(
  'duplicate and out-of-order replay is projection invariant',
  canonicalJson(orderedReplay.events) === canonicalJson(reorderedReplay.events),
  `${reordered.length - reorderedReplay.events.length} duplicates suppressed`
);

// Workstream 2: deterministic graph rebuild from the same immutable event set.
const graphEvents = sourceEvents.map((event, index) =>
  index === 0
    ? {
        ...event,
        type: 'finding.activated',
        payload: {
          object: {
            id: 'failure:generated-source',
            type: 'failure',
            state: 'active',
            confidence: 1,
            trigger: 'editing generated sources',
            correction: 'edit generator then regenerate',
            applicability: ['generated/client.ts is generator-owned'],
            nonApplicability: ['file is hand-authored'],
            provenance: [event.eventId],
          },
        },
        payloadHash: sha256({
          object: {
            id: 'failure:generated-source',
            type: 'failure',
            state: 'active',
            confidence: 1,
            trigger: 'editing generated sources',
            correction: 'edit generator then regenerate',
            applicability: ['generated/client.ts is generator-owned'],
            nonApplicability: ['file is hand-authored'],
            provenance: [event.eventId],
          },
        }),
      }
    : event
);
const graphA = new CognitionGraph().applyAll(graphEvents);
const graphB = new CognitionGraph().applyAll([...graphEvents].reverse());
check(
  'graph rebuild is byte-equivalent after canonical ordering',
  graphA.digest() === graphB.digest(),
  graphA.integrity()
);

// Workstream 3: active-model semantic authorship with evidence-backed activation.
const receipt = {
  eventId: 'receipt:verification',
  type: 'verification.passed',
  payload: { passed: true },
};
const semantic = {
  trigger: 'generated source edit',
  attemptedAction: 'edited generated/client.ts directly',
  observedFailure: 'regeneration overwrote the edit',
  rootCause: 'the file is generator-owned',
  correction: 'edit the generator and regenerate',
  verificationEvidence: ['generator check passed'],
  applicability: ['target is generator-owned'],
  nonApplicability: ['target is hand-authored'],
  invalidators: ['generator ownership changes'],
  scope: { projectId: 'verification-project' },
  confidence: 1,
  confidenceLabel: 'verified',
  expectedOutcome: 'direct generated edits are avoided',
  evidenceReceipts: [receipt.eventId],
};
const compiler = new SemanticCompiler({
  eventFactory: (type, payload) => ({ type, payload }),
});
const proposal = compiler.propose('failure', semantic, {
  producer: 'active-model',
});
const verified = compiler.verify(proposal.proposal.id, [receipt]);
const activated = compiler.activate(proposal.proposal.id);
const quality = semanticQuality([activated.object]);
check(
  'semantic compiler enforces propose, verify, activate',
  proposal.accepted && verified.verified && activated.activated,
  quality
);
check(
  'semantic object has positive and negative applicability',
  quality.positiveApplicabilityRate === 1 &&
    quality.negativeApplicabilityRate === 1,
  quality
);

// Workstream 4: capability-safe executable guard with adversarial negatives.
const guard = {
  id: 'guard:generated-source',
  state: 'active',
  triggers: [{ field: 'path', operator: 'startsWith', value: 'generated/' }],
  intervention: { type: 'require-verification' },
  evidence: [receipt.eventId],
  scope: { projectId: 'verification-project' },
  replacementAction: { path: 'generator/source.ts', then: 'regenerate' },
  rollback: 'disable guard:generated-source',
};
const guards = new GuardRuntime({ mode: 'require-verification' });
const registered = guards.register(guard);
const traces = [
  {
    expected: true,
    action: { path: 'generated/client.ts' },
    context: { projectId: 'verification-project' },
  },
  ...Array.from({ length: 100 }, (_, index) => ({
    expected: false,
    action: { path: `src/hand-authored-${index}.ts` },
    context: { projectId: 'verification-project' },
  })),
];
const guardSimulation = guards.simulate(guard.id, traces);
const intercept = guards.evaluate(
  { path: 'generated/client.ts' },
  {
    projectId: 'verification-project',
    capabilityTier: 'interceptable',
  }
);
check(
  'guard simulation has no false activation or miss',
  registered.registered && guardSimulation.safeToActivate,
  guardSimulation
);
check(
  'known mistake requires verification before action',
  intercept.decision === 'require-verification',
  intercept.decision
);
check(
  'emergency disable always permits recovery',
  guards.evaluate({ path: 'generated/client.ts' }, { emergencyDisable: true })
    .decision === 'allow'
);

// Workstreams 5, 6 and 11: exact credit, conservative selection and bounded paging.
const invalidJoin = exactEpisodeJoin(
  [
    {
      episodeId: 'confounded',
      kind: 'delivery',
      deliveryId: 'd1',
      objectIds: ['memory:bad'],
    },
    {
      episodeId: 'confounded',
      kind: 'delivery',
      deliveryId: 'd2',
      objectIds: ['memory:bad'],
    },
    {
      episodeId: 'confounded',
      kind: 'action',
      actionId: 'a1',
      deliveryId: 'd1',
    },
    {
      episodeId: 'confounded',
      kind: 'outcome',
      outcomeId: 'o1',
      actionId: 'a1',
      graderId: 'g1',
    },
  ],
  'confounded'
);
check(
  'causal credit refuses a confounded join',
  invalidJoin.valid === false,
  invalidJoin.diagnostics
);
const ledger = new CreditLedger();
check(
  'credit policy abstains without minimum causal evidence',
  ledger.selection(['memory:new'], {}).action === 'abstain'
);
const planner = new RetrievalPlanner({ graph: graphA });
const context = new ContextVM({ planner, hardMaximumTokens: 512 });
const page = context.page(
  { text: 'generated source failure' },
  { taskId: 'verification-task', trigger: 'pre-tool' },
  { budget: 128 }
);
check(
  'applicable context capsule is delivered within the decision budget',
  page.action === 'deliver' && page.tokens <= 128,
  { action: page.action, tokens: page.tokens, maximum: 128 }
);

// Workstream 7: stale checkpoints are detected before authorizing an action.
const checkpoint = createCheckpoint(
  {
    goalDag: { nodes: [{ id: 'goal:1' }], edges: [] },
    plan: [{ step: 'regenerate', state: 'pending' }],
    currentHypothesis: 'the generated client is stale',
    decisions: [],
    rejectedAlternatives: [],
    workspace: {
      head: 'old-head',
      dirtyHash: 'clean',
      artifactHashes: { 'generated/client.ts': 'old' },
    },
    attemptedActions: [],
    edits: [],
    knownFailures: ['direct generated edit'],
    validations: [],
    invariants: ['edit generator'],
    permissions: { filesystem: true },
    blockers: [],
    ownership: { agent: 'codex' },
    nextSafeAction: 'inspect generator',
    unresolvedQuestions: [],
    policyHash: 'policy-1',
    dependenciesHash: 'deps-1',
    environmentHash: 'env-1',
    activeBeliefsHash: 'beliefs-1',
  },
  { boundary: 'handoff', producer: 'codex', now: 1710000000000 }
);
const takeover = restoreCheckpoint(
  checkpoint,
  {
    workspace: {
      head: 'new-head',
      dirtyHash: 'clean',
      artifactHashes: { 'generated/client.ts': 'new' },
    },
    policyHash: 'policy-1',
    dependenciesHash: 'deps-1',
    environmentHash: 'env-1',
    activeBeliefsHash: 'beliefs-1',
  },
  { consumer: 'claude-code' }
);
check(
  'cross-model takeover rejects stale workspace state',
  takeover.requiresRefresh &&
    takeover.receipt.rejected.includes('workspace.head'),
  takeover.receipt.rejected
);

// Workstream 8: 100 independently identified writers claim distinct tasks,
// then duplicate intent is rejected without silently overwriting ownership.
const coordination = new CoordinationRuntime();
let claimed = 0;
for (let index = 0; index < 100; index++) {
  const agentId = `agent-${index}`;
  const taskId = `task-${index}`;
  coordination.registerAgent({ id: agentId, capabilities: ['edit'] });
  coordination.defineTask({
    id: taskId,
    goal: `goal-${index}`,
    artifacts: [`file-${index}`],
    plannedActions: [`action-${index}`],
  });
  if (
    coordination.claim(taskId, agentId, {
      expectedVersion: 0,
      now: 1710000000000,
    }).claimed
  )
    claimed++;
}
const duplicate = coordination.defineTask({
  id: 'duplicate-task',
  goal: 'goal-0',
  artifacts: ['file-0'],
  plannedActions: ['action-0'],
});
check(
  '100 simulated concurrent writers retain authoritative ownership',
  claimed === 100 && coordination.leases.size === 100,
  `${claimed}/100`
);
check(
  'coordination rejects duplicate work intent',
  duplicate.defined === false && duplicate.duplicateOf === 'task-0',
  duplicate
);

// Workstream 10: cross-project federation is signed and deny-by-default.
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const policy = new FederationPolicy({
  principal: 'verification',
  tenantId: 'tenant-a',
  grants: [
    {
      id: 'grant-1',
      operation: 'retrieve',
      sourceTenant: 'tenant-a',
      targetTenant: 'tenant-b',
      maximumScope: 'project',
    },
  ],
});
const federatedObject = {
  id: 'claim:federated',
  type: 'claim',
  tenantId: 'tenant-a',
  sensitivity: 'internal',
  scope: { level: 'project', projectId: 'source' },
  compatibility: { language: 'typescript', policyHash: 'policy-1' },
  claim: 'edit the generator',
  applicability: ['generator-owned source'],
};
const target = {
  tenantId: 'tenant-b',
  scope: { level: 'project' },
  compatibility: { language: 'typescript', policyHash: 'policy-1' },
};
const bundle = signedBundle({ objects: [federatedObject] }, privateKey);
const federation = verifyBundle(bundle, publicKey, policy, target);
policy.revoke(federatedObject.id, 'verification exercise');
const revoked = verifyBundle(bundle, publicKey, policy, target);
check(
  'signed compatible federation bundle is authorized',
  federation.valid && federation.validSignature,
  federation.decisions[0]
);
check(
  'revocation prevents subsequent cross-project retrieval',
  revoked.valid === false,
  revoked.decisions[0].denied
);

// Workstream 12: four bootstrap operations, with measured static surface.
const capabilities = negotiateCapabilities({ profile: 'cognitive' });
const surface = surfaceOverhead({ schemas: BOOTSTRAP_COGNITIVE_OPERATIONS });
check(
  'minimal cognitive profile exposes exactly four bootstrap operations',
  capabilities.operations.length === 4,
  capabilities.operations
);

// Workstreams 14-16: freeze the benchmark and create the full 100-task,
// seven-arm schedule. These are protocol/schedule metrics, never live claims.
const benchmark = freezeBenchmark(benchmarkSource);
const schedule = benchmarkSchedule(
  benchmark.tasks,
  benchmarkSource.repetitions,
  benchmark.arms
);
const scheduledArmRuns = schedule.reduce(
  (total, row) => total + row.arms.length,
  0
);
const competitorManifests = competitorSource.baselines.map(competitorManifest);
const curriculum = createCurriculum({ tasks: 100, seed: benchmarkSource.seed });
const longSchedule = compoundingSchedule(curriculum, {
  models: ['openai-frontier', 'anthropic-frontier', 'google-frontier'],
  clients: ['codex', 'claude-code', 'gemini'],
  machines: ['machine-a', 'machine-b'],
  arms: benchmark.arms,
});
check(
  'benchmark covers all eleven cognitive-continuity families',
  new Set(benchmark.tasks.map((task) => task.family)).size === 11 &&
    scheduledArmRuns === 77,
  `${benchmark.tasks.length} tasks / ${scheduledArmRuns} scheduled arm runs`
);
check(
  'competitive registry covers ten frozen baseline kinds',
  competitorManifests.length === 10 &&
    new Set(competitorManifests.map((item) => item.kind)).size === 10,
  `${competitorManifests.length}/10`
);
check(
  'compounding protocol schedules 100 linked tasks across models, clients and machines',
  curriculum.length === 100 && longSchedule.length === 700,
  `${curriculum.length} tasks / ${longSchedule.length} arm runs`
);

// Workstreams 17 and 18: fail-closed release evidence and rollback exercises.
const metrics = {
  applicabilityPrecision: null,
  preActionDelivery: null,
  irrelevantDelivery: guardSimulation.falsePositiveRate,
  staleDelivery: null,
  recurrenceReduction: null,
  recurrenceIntervalLow: null,
  naturalCorrectnessDelta: null,
  severeUnquarantined: null,
  emptyP95Overhead: null,
  reconstructionTokenReduction: null,
  writerIntegrity: claimed === 100,
  crossClientPassed: null,
  competitivePassed: null,
};
const verdict = releaseVerdict(metrics);
check(
  'release gate refuses to infer effectiveness from deterministic conformance',
  verdict.status === 'insufficient' && verdict.missing.length > 0,
  `${verdict.missing.length} live fields missing`
);
const rollout = new RolloutController({ stage: 'advisory-canary' });
const rollback = rollout.observe(
  {
    correctnessDelta: -0.1,
    severeHarm: 0,
    p95LatencyMs: 10,
    p95ContextOverhead: 0.01,
    availability: 1,
    unauthorizedAccess: 0,
  },
  { projectId: 'verification-project' }
);
const recovery = recoveryExercise({
  acceptedEvents: ['a', 'b'],
  restoredEvents: ['b', 'a'],
  startedAt: 100,
  recoveredAt: 130,
});
check(
  'canary regression automatically rolls back and scopes a kill switch',
  rollback.rolledBack &&
    !rollout.enabled({ projectId: 'verification-project' }),
  rollback.stage
);
check(
  'recovery exercise restores every accepted event',
  recovery.passed && recovery.recoveryPointEvents === 0,
  recovery
);

const implementationModules = [
  'protocol',
  'graph',
  'compiler',
  'guards',
  'credit',
  'context-vm',
  'checkpoint',
  'coordination',
  'consolidation',
  'federation',
  'retrieval',
  'capability-surface',
  'adapter-sdk',
  'benchmark',
  'competitors',
  'compounding',
  'effectiveness',
  'rollout',
];
const reportBody = {
  schemaVersion: 'ucr.deterministic-verification/2',
  evidenceClass: 'deterministic-conformance-not-live-effectiveness',
  source: {
    fixtureHash: sha256(fixture),
    benchmarkHash: benchmark.manifestHash,
    competitorRegistryHash: sha256(competitorSource),
  },
  implementation: {
    workstreamsWithRuntimeModules: implementationModules.filter((name) =>
      existsSync(join(ROOT, 'ucr', `${name}.mjs`))
    ).length,
    workstreamsTotal: 18,
    bootstrapOperations: capabilities.operations.length,
    staticSurfaceTokens: surface.totalTokens,
  },
  conformance: {
    registeredClients: clients.length,
    schemaCertifiedClients: certifications.filter((item) => item.certified)
      .length,
    lifecycleFamilies: new Set(certifications.map((item) => item.family)).size,
    executableSmokeClients: evidenceIndexValid ? 3 : 0,
    cognitionSemanticParity: semanticParity,
    fixtureEventsPerClient: fixture.inputs.length,
  },
  deterministicProof: {
    checksPassed: checks.filter((item) => item.passed).length,
    checksTotal: checks.length,
    replayInvariant:
      canonicalJson(orderedReplay.events) ===
      canonicalJson(reorderedReplay.events),
    graphRebuildInvariant: graphA.digest() === graphB.digest(),
    guardFalsePositiveRate: guardSimulation.falsePositiveRate,
    guardFalseNegativeCount: guardSimulation.falseNegative,
    contextCapsuleTokens: page.tokens,
    contextBudgetTokens: 128,
    coordinatedWriters: claimed,
    lostAcceptedEventsInRecovery: recovery.recoveryPointEvents,
  },
  benchmarkProtocol: {
    taskFamilies: new Set(benchmark.tasks.map((task) => task.family)).size,
    frozenTasks: benchmark.tasks.length,
    arms: benchmark.arms.length,
    deterministicArmRuns: scheduledArmRuns,
    compoundingTasks: curriculum.length,
    plannedCompoundingRuns: longSchedule.length,
    competitorBaselines: competitorManifests.length,
  },
  liveEvidence: {
    status: evidenceIndexValid ? 'passed-three-direction-smoke' : 'not-run',
    modelRuns: evidenceIndexValid ? 9 : 0,
    executableClientSmokes: evidenceIndexValid ? 3 : 0,
    competitiveReproductions: 0,
    reportHash: evidenceIndexValid ? evidenceIndexHash : null,
    evidenceTiers: evidenceIndexValid
      ? evidenceIndex.evidenceContract.tiers
      : null,
    reason: evidenceIndexValid
      ? 'three live directions prove executable transfer and control abstention across three CLIs and two model families, not powered effectiveness or superiority'
      : 'CI conformance must not be represented as model-effectiveness evidence',
  },
  release: verdict,
  checks,
};
const report = { ...reportBody, reportHash: sha256(reportBody) };
const serialized = `${JSON.stringify(report, null, 2)}\n`;

if (args.has('--write')) {
  mkdirSync(dirname(EVIDENCE_PATH), { recursive: true });
  writeFileSync(EVIDENCE_PATH, serialized, 'utf8');
  console.log(`\nwrote ${EVIDENCE_PATH}`);
} else if (args.has('--print')) {
  console.log(`\n${serialized}`);
} else {
  if (!existsSync(EVIDENCE_PATH)) {
    console.error(
      `\nmissing deterministic evidence artifact: ${EVIDENCE_PATH}`
    );
    console.error(
      'run npm run evidence:ucr:update after reviewing intentional metric changes'
    );
    process.exitCode = 1;
  } else if (
    readFileSync(EVIDENCE_PATH, 'utf8').replace(/\r\n/g, '\n') !== serialized
  ) {
    console.error('\ndeterministic evidence artifact is stale');
    console.error(
      'run npm run evidence:ucr:update after reviewing intentional metric changes'
    );
    process.exitCode = 1;
  }
}

const failed = checks.filter((item) => !item.passed);
console.log(
  `\n${checks.length - failed.length}/${checks.length} deterministic checks passed`
);
console.log(
  `release verdict: ${verdict.status} (live model evidence remains required)`
);
if (failed.length) process.exitCode = 1;
