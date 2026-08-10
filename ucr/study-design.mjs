import { BENCHMARK_ARMS, BENCHMARK_FAMILIES, hiddenTaskVariant } from './benchmark.mjs';
import { REQUIRED_COMPETITIVE_BASELINES } from './competitors.mjs';
import {
  EFFECTIVENESS_REQUIRED_METRICS,
  SUPERIORITY_REQUIRED_METRICS,
} from './effectiveness.mjs';
import { canonicalJson, sha256 } from './protocol.mjs';

export const STUDY_MODES = Object.freeze({
  session: Object.freeze(['same-session', 'cross-session']),
  project: Object.freeze(['same-project', 'cross-project']),
  agents: Object.freeze(['single-successor', 'concurrent-successors']),
});

export const REQUIRED_PRODUCTION_STAGES = Object.freeze([
  'shadow-selection',
  'observe-only',
  'advisory-canary',
  'verification-canary',
  'scoped-enforcement',
]);

function normalQuantile(probability) {
  if (!(probability > 0 && probability < 1))
    throw new Error('normal quantile probability must be between zero and one');
  const a = [
    -39.6968302866538, 220.946098424521, -275.928510446969,
    138.357751867269, -30.6647980661472, 2.50662827745924,
  ];
  const b = [
    -54.4760987982241, 161.585836858041, -155.698979859887,
    66.8013118877197, -13.2806815528857,
  ];
  const c = [
    -0.00778489400243029, -0.322396458041136, -2.40075827716184,
    -2.54973253934373, 4.37466414146497, 2.93816398269878,
  ];
  const d = [
    0.00778469570904146, 0.32246712907004, 2.445134137143,
    3.75440866190742,
  ];
  const low = 0.02425;
  if (probability < low) {
    const q = Math.sqrt(-2 * Math.log(probability));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q +
        c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (probability > 1 - low) return -normalQuantile(1 - probability);
  const q = probability - 0.5;
  const r = q * q;
  return (
    (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r +
      a[5]) *
    q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
}

export function bonferroniNormalZ({
  comparisons = 1,
  familyAlpha = 0.05,
  twoSided = true,
} = {}) {
  if (!Number.isInteger(comparisons) || comparisons < 1)
    throw new Error('comparisons must be a positive integer');
  if (!(familyAlpha > 0 && familyAlpha < 1))
    throw new Error('family alpha must be between zero and one');
  const tails = twoSided ? 2 : 1;
  return normalQuantile(1 - familyAlpha / (comparisons * tails));
}

/** Minimum zero-failure opportunities with a family-wise Wilson upper bound. */
export function zeroFailureWilsonSampleSize({
  maximumRate = 0.01,
  comparisons = 36,
  familyAlpha = 0.05,
  z = null,
} = {}) {
  const critical = z ??
    bonferroniNormalZ({ comparisons, familyAlpha, twoSided: true });
  if (!(maximumRate > 0 && maximumRate < 1) || !(critical > 0))
    throw new Error('invalid zero-failure confidence inputs');
  let samples = 1;
  while (critical ** 2 / (samples + critical ** 2) >= maximumRate) samples++;
  return {
    samples,
    maximumRate,
    z: critical,
    comparisons,
    familyAlpha,
    method: 'bonferroni-familywise-wilson-zero-failure-upper-bound',
  };
}

const field = (object, path) =>
  path.split('.').reduce((value, key) => value?.[key], object);

function seeded(seed) {
  let state = Number.parseInt(sha256(seed).slice(0, 8), 16) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

function shuffle(values, seed) {
  const random = seeded(seed);
  const output = [...values];
  for (let index = output.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [output[index], output[swap]] = [output[swap], output[index]];
  }
  return output;
}

function normalizeClients(clients) {
  return (clients || []).map((client) => {
    if (!client?.id || !client?.model || !client?.modelFamily)
      throw new Error('study clients require id, model, and modelFamily');
    return {
      id: client.id,
      model: client.model,
      modelFamily: client.modelFamily,
      version: client.version || 'resolve-at-execution',
      lifecycleFamily: client.lifecycleFamily || null,
    };
  });
}

function allDirections(clients, includeSameClient) {
  return clients.flatMap((producer) =>
    clients
      .filter((consumer) => includeSameClient || producer.id !== consumer.id)
      .map((consumer) => ({
        id: `${producer.id}->${consumer.id}`,
        producer,
        consumer,
      }))
  );
}

function dimensionsFor(task, repetition) {
  return {
    sessionMode: repetition % 2 ? 'same-session' : 'cross-session',
    projectMode:
      task.family === 'cross-project-generalization'
        ? 'cross-project'
        : 'same-project',
    agentMode:
      task.family === 'concurrent-coordination'
        ? 'concurrent-successors'
        : 'single-successor',
  };
}

function executionTopology(trialId, dimensions) {
  const prefix = sha256(`${trialId}:topology`).slice(0, 20);
  const sharedSession = `continuity:${prefix}`;
  const sharedProject = `project:${prefix}`;
  const successorCount =
    dimensions.agentMode === 'concurrent-successors' ? 2 : 1;
  return {
    expectedProviderInvocations: 1 + successorCount,
    producerContinuitySessionId:
      dimensions.sessionMode === 'same-session'
        ? sharedSession
        : `${sharedSession}:producer`,
    consumerContinuitySessionId:
      dimensions.sessionMode === 'same-session'
        ? sharedSession
        : `${sharedSession}:consumer`,
    producerProjectId:
      dimensions.projectMode === 'same-project'
        ? sharedProject
        : `${sharedProject}:source`,
    consumerProjectId:
      dimensions.projectMode === 'same-project'
        ? sharedProject
        : `${sharedProject}:target`,
    successorAgentIds: Array.from(
      { length: successorCount },
      (_, index) => `successor:${prefix}:${index + 1}`
    ),
    concurrentOverlapRequired: successorCount > 1,
  };
}

/**
 * Build the frozen, randomized study matrix before any provider call occurs.
 * Empty/runtime are paired; hard-negative arms are independently randomized.
 */
export function buildFullStudyPlan({
  benchmark,
  clients,
  secret,
  pairedRepetitionsPerCell = 1,
  negativeRepetitionsPerCell = 1,
  includeSameClient = true,
  seed = benchmark?.seed || 'ucr-full-study',
  budgets = {},
  registration = null,
  minimumSubgroupPairs = 30,
} = {}) {
  if (!benchmark?.manifestHash)
    throw new Error('a frozen benchmark with manifestHash is required');
  if (!secret) throw new Error('study planning requires a hidden-variant secret');
  if (
    !Number.isInteger(pairedRepetitionsPerCell) ||
    pairedRepetitionsPerCell < 1 ||
    !Number.isInteger(negativeRepetitionsPerCell) ||
    negativeRepetitionsPerCell < 1
  )
    throw new Error('study repetitions must be positive integers');
  const normalizedClients = normalizeClients(clients);
  const directions = allDirections(normalizedClients, includeSameClient);
  const defaultBudgets = {
    contextTokens: 160,
    retries: 1,
    toolCalls: 40,
    timeoutMs: 600_000,
    ...budgets,
  };
  const trials = [];
  for (const direction of directions) {
    for (const task of benchmark.tasks || []) {
      for (
        let repetition = 0;
        repetition < pairedRepetitionsPerCell;
        repetition++
      ) {
        const pairId = `${direction.id}:${task.id}:${repetition}`;
        const variant = hiddenTaskVariant(task, secret, { nonce: pairId });
        const armOrder = shuffle(['empty', 'runtime'], `${seed}:${pairId}`);
        for (const arm of armOrder) {
          const trialId = `${pairId}:${arm}`;
          const dimensions = dimensionsFor(task, repetition);
          trials.push({
            trialId,
            pairId,
            taskId: task.id,
            family: task.family,
            arm,
            direction: direction.id,
            producerClient: direction.producer.id,
            consumerClient: direction.consumer.id,
            producerFamily: direction.producer.modelFamily,
            consumerFamily: direction.consumer.modelFamily,
            producerModel: direction.producer.model,
            consumerModel: direction.consumer.model,
            hiddenVariantId: variant.publicTask.hiddenVariantId,
            publicVariant: variant.publicTask.publicVariant,
            variantPrompt: variant.publicTask.prompt,
            graderBinding: variant.graderBinding,
            promptHash: sha256(variant.publicTask.prompt),
            permissionsHash: sha256({ tools: 'benchmark-default' }),
            budgets: defaultBudgets,
            ...dimensions,
            ...executionTopology(trialId, dimensions),
            workspaceIsolationId: `workspace:${sha256(trialId).slice(0, 24)}`,
            sessionIsolationId: `session:${sha256(`${trialId}:session`).slice(0, 24)}`,
          });
        }
      }
      for (
        let repetition = 0;
        repetition < negativeRepetitionsPerCell;
        repetition++
      ) {
        for (const arm of BENCHMARK_ARMS.filter(
          (candidate) => !['empty', 'runtime'].includes(candidate)
        )) {
          const nonce = `${direction.id}:${task.id}:${arm}:${repetition}`;
          const variant = hiddenTaskVariant(task, secret, { nonce });
          const trialId = `${nonce}:negative`;
          const dimensions = dimensionsFor(task, repetition);
          trials.push({
            trialId,
            pairId: null,
            taskId: task.id,
            family: task.family,
            arm,
            direction: direction.id,
            producerClient: direction.producer.id,
            consumerClient: direction.consumer.id,
            producerFamily: direction.producer.modelFamily,
            consumerFamily: direction.consumer.modelFamily,
            producerModel: direction.producer.model,
            consumerModel: direction.consumer.model,
            hiddenVariantId: variant.publicTask.hiddenVariantId,
            publicVariant: variant.publicTask.publicVariant,
            variantPrompt: variant.publicTask.prompt,
            graderBinding: variant.graderBinding,
            promptHash: sha256(variant.publicTask.prompt),
            permissionsHash: sha256({ tools: 'benchmark-default' }),
            budgets: defaultBudgets,
            ...dimensions,
            ...executionTopology(trialId, dimensions),
            workspaceIsolationId: `workspace:${sha256(trialId).slice(0, 24)}`,
            sessionIsolationId: `session:${sha256(`${trialId}:session`).slice(0, 24)}`,
          });
        }
      }
    }
  }
  const randomized = shuffle(trials, `${seed}:global`).map(
    (trial, studySequence) => {
      const planned = {
        ...trial,
        poweredStratum:
          !['empty', 'runtime'].includes(trial.arm) ||
          pairedRepetitionsPerCell >= minimumSubgroupPairs,
        studySequence,
      };
      return { ...planned, trialIntegrityHash: sha256(planned) };
    }
  );
  const negativeConfidence = zeroFailureWilsonSampleSize({
    comparisons: directions.length * 4,
  });
  const body = {
    schemaVersion: 'ucr.full-study-plan/1',
    benchmarkHash: benchmark.manifestHash,
    seedHash: sha256(seed),
    clients: normalizedClients,
    directions: directions.map((direction) => direction.id),
    pairedRepetitionsPerCell,
    negativeRepetitionsPerCell,
    includeSameClient,
    budgets: defaultBudgets,
    registrationHash: registration?.registrationHash || null,
    primaryPairsPerDirection:
      pairedRepetitionsPerCell * (benchmark.tasks || []).length,
    preregisteredPairsPerArm: registration?.powerAnalysis?.perArm || null,
    minimumSubgroupPairs,
    minimumNegativeSamplesPerDirection: negativeConfidence.samples,
    negativeConfidence,
    negativeSamplesPerDirectionPerArm:
      negativeRepetitionsPerCell * (benchmark.tasks || []).length,
    trials: randomized,
  };
  return { ...body, planHash: sha256(body) };
}

function setCoverage(actual, expected) {
  const set = new Set(actual);
  return expected.length
    ? expected.filter((value) => set.has(value)).length / expected.length
    : 0;
}

/** Fail before execution when the plan cannot exercise the claimed dimensions. */
export function studyDesignCoverage(plan) {
  const trials = plan?.trials || [];
  const clients = new Set(
    trials.flatMap((trial) => [trial.producerClient, trial.consumerClient])
  );
  const modelFamilies = new Set(
    trials.flatMap((trial) => [trial.producerFamily, trial.consumerFamily])
  );
  const directions = new Set(trials.map((trial) => trial.direction));
  const checks = {
    benchmarkFamilies:
      setCoverage(
        trials.map((trial) => trial.family),
        BENCHMARK_FAMILIES
      ) === 1,
    benchmarkArms:
      setCoverage(
        trials.map((trial) => trial.arm),
        BENCHMARK_ARMS
      ) === 1,
    clients: clients.size >= 3,
    modelFamilies: modelFamilies.size >= 3,
    bidirectional:
      [...directions].some((direction) => {
        const [left, right] = direction.split('->');
        return directions.has(`${right}->${left}`);
      }),
    sameClient: [...directions].some((direction) => {
      const [left, right] = direction.split('->');
      return left === right;
    }),
    crossClient: [...directions].some((direction) => {
      const [left, right] = direction.split('->');
      return left !== right;
    }),
    crossSession: trials.some((trial) => trial.sessionMode === 'cross-session'),
    crossProject: trials.some((trial) => trial.projectMode === 'cross-project'),
    concurrentAgents: trials.some(
      (trial) => trial.agentMode === 'concurrent-successors'
    ),
    pairedControls: trials.every(
      (trial) =>
        !['empty', 'runtime'].includes(trial.arm) ||
        trials.some(
          (candidate) =>
            candidate.pairId === trial.pairId && candidate.arm !== trial.arm
        )
    ),
    isolatedWorkspaces:
      new Set(trials.map((trial) => trial.workspaceIsolationId)).size ===
      trials.length,
    materialVariants: BENCHMARK_FAMILIES.every(
      (family) =>
        new Set(
          trials
            .filter((trial) => trial.family === family)
            .map(
              (trial) =>
                `${trial.publicVariant?.scenarioIndex}:${trial.publicVariant?.layoutIndex}:${trial.publicVariant?.distractorCount}`
            )
        ).size >= 4
    ),
    executionTopology: trials.every((trial) => {
      const sameSession =
        trial.producerContinuitySessionId ===
        trial.consumerContinuitySessionId;
      const sameProject = trial.producerProjectId === trial.consumerProjectId;
      const concurrent = trial.successorAgentIds?.length > 1;
      return (
        sameSession === (trial.sessionMode === 'same-session') &&
        sameProject === (trial.projectMode === 'same-project') &&
        concurrent === (trial.agentMode === 'concurrent-successors') &&
        trial.expectedProviderInvocations ===
          1 + trial.successorAgentIds.length
      );
    }),
  };
  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    coverage: {
      families: setCoverage(
        trials.map((trial) => trial.family),
        BENCHMARK_FAMILIES
      ),
      arms: setCoverage(
        trials.map((trial) => trial.arm),
        BENCHMARK_ARMS
      ),
      clients: clients.size,
      modelFamilies: modelFamilies.size,
      directions: directions.size,
      materialVariants: new Set(
        trials.map(
          (trial) =>
            `${trial.family}:${trial.publicVariant?.scenarioIndex}:${trial.publicVariant?.layoutIndex}:${trial.publicVariant?.distractorCount}`
        )
      ).size,
    },
  };
}

/** Verify matched-arm equality and isolation before accepting a result row. */
export function validateTrialResult(result, trial, pairedTrial = null) {
  const diagnostics = [];
  if (!trial || result?.trialId !== trial.trialId)
    diagnostics.push('result is not bound to its planned trial');
  if (result?.trialIntegrityHash !== trial?.trialIntegrityHash)
    diagnostics.push('trial integrity hash mismatch');
  if (result?.hiddenVariantId !== trial?.hiddenVariantId)
    diagnostics.push('hidden task variant mismatch');
  if (result?.graderBinding !== trial?.graderBinding)
    diagnostics.push('grader binding mismatch');
  if (result?.graderVerified !== true)
    diagnostics.push('independent grader receipt is missing or invalid');
  if (result?.workspaceIsolationId !== trial?.workspaceIsolationId)
    diagnostics.push('workspace isolation mismatch');
  if (result?.sessionIsolationId !== trial?.sessionIsolationId)
    diagnostics.push('session isolation mismatch');
  if (pairedTrial) {
    for (const path of ['promptHash', 'permissionsHash', 'budgets']) {
      if (canonicalJson(field(trial, path)) !== canonicalJson(field(pairedTrial, path)))
        diagnostics.push(`paired ${path} differs`);
    }
    if (trial.workspaceIsolationId === pairedTrial.workspaceIsolationId)
      diagnostics.push('paired arms share a mutable workspace');
  }
  return { valid: diagnostics.length === 0, diagnostics };
}

export function validateCausalChain(chain) {
  const required = [
    'captured',
    'verified',
    'eligible',
    'retrieved',
    'delivered',
    'used',
    'behaviorChanged',
    'mistakePrevented',
    'taskCorrect',
  ];
  const diagnostics = [];
  const stages = chain?.stages || [];
  const events = chain?.events || [];
  const eventById = new Map(events.map((event) => [event.eventId, event]));
  if (stages.length !== required.length)
    diagnostics.push('causal chain does not contain every required stage');
  for (let index = 0; index < required.length; index++) {
    const stage = stages[index];
    if (stage?.stage !== required[index])
      diagnostics.push(`causal stage ${required[index]} is missing or out of order`);
    if (!stage?.eventId || !stage?.artifactHash)
      diagnostics.push(`causal stage ${required[index]} lacks evidence binding`);
    if (index > 0 && stage?.parentEventId !== stages[index - 1]?.eventId)
      diagnostics.push(`causal stage ${required[index]} has the wrong parent`);
    const event = eventById.get(stage?.eventId);
    if (!event || event.stage !== required[index])
      diagnostics.push(`causal stage ${required[index]} is absent from its evidence ledger`);
    else if (sha256(event.artifact ?? event) !== stage.artifactHash)
      diagnostics.push(`causal stage ${required[index]} artifact hash mismatch`);
    if (event?.observer !== 'host')
      diagnostics.push(`causal stage ${required[index]} was not host-observed`);
    if (!Number.isFinite(event?.observedAt))
      diagnostics.push(`causal stage ${required[index]} lacks an observed sequence`);
    if (
      index > 0 &&
      Number.isFinite(event?.observedAt) &&
      Number.isFinite(events[index - 1]?.observedAt) &&
      event.observedAt <= events[index - 1].observedAt
    )
      diagnostics.push(`causal stage ${required[index]} is not ordered after its parent`);
  }
  if (chain?.controlOutcomeHash == null || chain?.treatmentOutcomeHash == null)
    diagnostics.push('causal chain lacks paired outcome bindings');
  if (!events.length || chain?.evidenceLedgerHash !== sha256(events))
    diagnostics.push('causal evidence ledger hash mismatch');
  if (!chain?.pairedPromptHash || !chain?.graderReceiptHash)
    diagnostics.push('causal chain lacks paired prompt or grader binding');
  return { valid: diagnostics.length === 0, diagnostics };
}

/** Build a content-bound causal chain from host-observed, privacy-safe events. */
export function buildCausalChain(
  inputEvents,
  {
    controlOutcomeHash,
    treatmentOutcomeHash,
    pairedPromptHash,
    graderReceiptHash,
  } = {}
) {
  const required = [
    'captured',
    'verified',
    'eligible',
    'retrieved',
    'delivered',
    'used',
    'behaviorChanged',
    'mistakePrevented',
    'taskCorrect',
  ];
  const byStage = new Map((inputEvents || []).map((event) => [event.stage, event]));
  const events = required.map((stage, index) => {
    const source = byStage.get(stage);
    if (!source) throw new Error(`missing causal event ${stage}`);
    const artifact = source.artifact || {};
    const eventId = source.eventId ||
      `causal:${sha256({ stage, artifact, index }).slice(0, 24)}`;
    return {
      eventId,
      stage,
      parentEventId: index ? null : source.parentEventId || null,
      observer: source.observer,
      observedAt: source.observedAt,
      artifact,
    };
  });
  for (let index = 1; index < events.length; index++)
    events[index].parentEventId = events[index - 1].eventId;
  const stages = events.map((event) => ({
    stage: event.stage,
    eventId: event.eventId,
    parentEventId: event.parentEventId,
    artifactHash: sha256(event.artifact),
  }));
  const chain = {
    stages,
    events,
    evidenceLedgerHash: sha256(events),
    controlOutcomeHash,
    treatmentOutcomeHash,
    pairedPromptHash,
    graderReceiptHash,
  };
  const validation = validateCausalChain(chain);
  if (!validation.valid)
    throw new Error(`invalid causal chain: ${validation.diagnostics.join('; ')}`);
  return chain;
}

/** Map every release field to an executable study before costly provider calls. */
export function releaseMetricCoveragePreflight({
  plan,
  competitorKinds = [],
  productionStages = [],
} = {}) {
  const design = studyDesignCoverage(plan);
  const metricSources = Object.fromEntries(
    EFFECTIVENESS_REQUIRED_METRICS.map((metric) => [
      metric,
      metric === 'writerIntegrity' ? 'writer-conformance' : 'full-effectiveness',
    ])
  );
  for (const metric of SUPERIORITY_REQUIRED_METRICS)
    metricSources[metric] = 'live-competitive';
  const competitionCoverage = setCoverage(
    competitorKinds,
    REQUIRED_COMPETITIVE_BASELINES
  );
  const productionCoverage = setCoverage(
    productionStages,
    REQUIRED_PRODUCTION_STAGES
  );
  const checks = {
    effectivenessDesign: design.passed,
    metricMapping:
      Object.keys(metricSources).length ===
      EFFECTIVENESS_REQUIRED_METRICS.length +
        SUPERIORITY_REQUIRED_METRICS.length,
    competitiveBaselines: competitionCoverage === 1,
    productionStages: productionCoverage === 1,
  };
  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    design,
    competitionCoverage,
    productionCoverage,
    metricSources,
    missingMetrics: Object.entries(metricSources)
      .filter(([, source]) => {
        if (source === 'full-effectiveness') return !design.passed;
        if (source === 'live-competitive') return competitionCoverage !== 1;
        return false;
      })
      .map(([metric]) => metric),
  };
}
