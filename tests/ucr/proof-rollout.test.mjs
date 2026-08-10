import { describe, expect, test } from '@jest/globals';
import {
  CircuitBreaker,
  RolloutController,
  benchmarkSchedule,
  bootstrapPaired,
  cognitionFunnel,
  compoundingMetrics,
  compoundingSchedule,
  contaminationCheck,
  competitorManifest,
  createCurriculum,
  deterministicGrade,
  evidenceLedger,
  freezeBenchmark,
  learningCurve,
  paretoFront,
  recoveryExercise,
  releaseVerdict,
  signGraderReceipt,
  signedEvidenceManifest,
  superiorityClaim,
  validateFairRun,
  validateCompetitiveEvidence,
  verifyGraderReceipt,
  executeReferenceCompetition,
  hiddenTaskVariant,
  faultInjectionStudy,
  preRegisterBenchmark,
  productionReadiness,
  productionTrafficReport,
  pseudonymizeProductionSamples,
  REQUIRED_FAULTS,
  sloReport,
  tieredReleaseVerdict,
} from '../../ucr/index.mjs';

describe('Cognitive Continuity Benchmark', () => {
  const manifest = freezeBenchmark({
    version: '1.0.0',
    tasks: [
      {
        id: 'task-a',
        family: 'mistake-immunity',
        prompt: 'complete task',
        grader: {
          requiredState: { ready: true },
          requiredReceipts: ['verified'],
          forbiddenReceipts: ['deleted-production'],
          mistakeReceipts: ['wrong-command'],
        },
      },
    ],
  });

  test('freezes manifests, counterbalances arms, and grades state instead of prose', () => {
    expect(manifest.manifestHash).toHaveLength(64);
    const schedule = benchmarkSchedule(manifest.tasks, 7);
    expect(new Set(schedule.map((item) => item.arms[0])).size).toBe(7);
    expect(
      deterministicGrade(manifest.tasks[0], {
        state: { ready: true },
        receipts: ['verified'],
        prose: 'I claim success',
      })
    ).toMatchObject({ correct: true, proseUsedAsOracle: false });
    expect(
      deterministicGrade(manifest.tasks[0], {
        state: { ready: true },
        receipts: ['verified', 'deleted-production'],
      })
    ).toMatchObject({ correct: false, severeHarm: true });
  });

  test('publishes redacted ledgers and paired confidence intervals', () => {
    const rows = Array.from({ length: 20 }, (_, index) => [
      { pairId: `p${index}`, arm: 'empty', correct: 0, transcript: 'private' },
      { pairId: `p${index}`, arm: 'runtime', correct: 1, rawOutput: 'private' },
    ]).flat();
    expect(bootstrapPaired(rows, 'correct')).toMatchObject({
      pairs: 20,
      mean: 1,
      low: 1,
      high: 1,
    });
    const ledger = evidenceLedger(rows, manifest);
    expect(ledger.rows[0].transcript).toBeUndefined();
    expect(ledger.ledgerHash).toHaveLength(64);
    expect(
      contaminationCheck(manifest.tasks[0], ['unrelated']).contaminated
    ).toBe(false);
  });

  test('does not let a model self-assert deterministic grader success', () => {
    const receipt = signGraderReceipt(
      {
        graderId: 'hidden-state',
        passed: true,
        artifactHash: 'a'.repeat(64),
      },
      'grader-secret'
    );
    expect(verifyGraderReceipt(receipt, 'grader-secret')).toBe(true);
    expect(
      verifyGraderReceipt(
        { ...receipt, artifactHash: 'b'.repeat(64) },
        'grader-secret'
      )
    ).toBe(false);
    expect(
      verifyGraderReceipt(
        {
          graderId: 'hidden-state',
          passed: true,
          artifactHash: 'a'.repeat(64),
        },
        'grader-secret'
      )
    ).toBe(false);
  });

  test('pre-registers powered hidden variants without exposing answers', () => {
    const hidden = hiddenTaskVariant(
      {
        ...manifest.tasks[0],
        hiddenAnswer: 'private',
        hiddenVariantSpec: { nonceBytes: 16 },
        fixture: 'fixtures/system-project',
      },
      'benchmark-secret',
      { nonce: 'one' }
    );
    expect(hidden.publicTask.hiddenAnswer).toBeUndefined();
    expect(hidden.publicTask.hiddenVariantId).toHaveLength(24);
    const registration = preRegisterBenchmark(
      {
        ...manifest,
        tasks: [
          {
            ...manifest.tasks[0],
            hiddenVariantSpec: { nonceBytes: 16 },
            fixture: 'fixtures/system-project',
          },
        ],
      },
      { baselineRate: 0.6, minimumEffect: 0.1 }
    );
    expect(registration).toMatchObject({
      hiddenGraders: true,
      naturalTaskFixtures: 1,
      powerAnalysis: {
        method: 'normal-approximation-two-sided-two-proportion',
      },
    });
    expect(registration.powerAnalysis.perArm).toBeGreaterThan(100);
  });
});

describe('competitive baselines and compounding', () => {
  test('requires equal budgets and keeps only non-dominated results', () => {
    const reference = {
      model: 'm',
      modelVersion: '1',
      taskId: 't',
      permissionsHash: 'p',
      contextBudget: 100,
      retryBudget: 1,
      toolBudget: 10,
    };
    expect(validateFairRun({ ...reference }, reference)).toMatchObject({
      fair: true,
    });
    expect(
      validateFairRun({ ...reference, contextBudget: 200 }, reference)
    ).toMatchObject({ fair: false, mismatches: ['contextBudget'] });
    expect(
      competitorManifest({
        kind: 'vector-rag',
        name: 'RAG',
        version: '1',
        command: ['run'],
      }).manifestHash
    ).toHaveLength(64);
    const ucr = {
      name: 'UCR',
      correctness: 0.95,
      harm: 0,
      tokens: 50,
      latencyMs: 50,
      fair: true,
      reproduced: true,
    };
    const rag = {
      name: 'RAG',
      correctness: 0.8,
      harm: 0,
      tokens: 80,
      latencyMs: 80,
      fair: true,
      reproduced: true,
    };
    expect(paretoFront([ucr, rag])).toEqual([ucr]);
    expect(
      superiorityClaim(ucr, [rag], { low: 0.05, high: 0.25 }).allowed
    ).toBe(true);
  });

  test('builds a 100-task cross-model/client/machine curriculum and measures learning', () => {
    const curriculum = createCurriculum({ tasks: 100 });
    const schedule = compoundingSchedule(curriculum, {
      models: ['gpt', 'claude', 'gemini'],
      clients: ['codex', 'claude-code', 'gemini'],
      machines: ['a', 'b'],
    });
    expect(curriculum).toHaveLength(100);
    expect(schedule).toHaveLength(700);
    expect(new Set(schedule.map((row) => row.model)).size).toBe(3);
    const rows = Array.from({ length: 100 }, (_, sequence) => [
      {
        arm: 'empty',
        sequence,
        correct: true,
        firstPass: sequence > 95,
        mistakeExecuted: true,
        reconstructionTokens: 100,
      },
      {
        arm: 'runtime',
        sequence,
        correct: true,
        firstPass: sequence / 100,
        mistakeExecuted: sequence % 10 === 0,
        reconstructionTokens: 40,
        quarantinedBeforeNext: true,
      },
    ]).flat();
    expect(learningCurve(rows).slope).toBeGreaterThan(0);
    expect(compoundingMetrics(rows)).toMatchObject({
      recurrenceReduction: 0.9,
      reconstructionTokenReduction: 0.6,
      severeUnquarantined: 0,
    });
  });

  test('executes every frozen reference baseline with explicit non-product labels', () => {
    const rows = executeReferenceCompetition([
      {
        id: 'reference-task',
        targetMemoryId: 'target',
        embedding: [1, 0],
        seedIds: ['target'],
        tags: ['build'],
        at: 100,
        memories: [
          {
            id: 'target',
            type: 'procedure',
            tags: ['build'],
            embedding: [1, 0],
            state: 'active',
            utility: 1,
            learnedAt: 100,
            staticInstruction: true,
          },
          {
            id: 'noise',
            tags: ['other'],
            embedding: [0, 1],
            state: 'active',
            learnedAt: 1,
          },
        ],
        edges: [],
      },
    ]);
    expect(rows).toHaveLength(10);
    expect(rows.every((row) => row.productClaimAllowed === false)).toBe(true);
    expect(rows.find((row) => row.kind === 'oracle-context').correct).toBe(
      true
    );
  });

  test('requires live pinned named products for superiority evidence', () => {
    expect(
      validateCompetitiveEvidence({
        baselineKind: 'vector-rag',
        fair: true,
        reproduced: true,
        liveExecution: true,
        versionPinned: true,
        configurationPublished: true,
        namedProduct: true,
        ucrOnParetoFrontier: true,
        correctnessImprovement: 0.15,
        effectIntervalLow: 0.03,
      })
    ).toMatchObject({ valid: true });
    expect(
      validateCompetitiveEvidence({
        baselineKind: 'vector-rag',
        fair: true,
        reproduced: true,
        liveExecution: false,
      }).valid
    ).toBe(false);
  });
});

describe('effectiveness gates and production rollout', () => {
  const passingMetrics = {
    applicabilityPrecision: 0.97,
    applicabilityPrecisionIntervalLow: 0.96,
    preActionDelivery: 0.96,
    preActionDeliveryIntervalLow: 0.951,
    irrelevantDelivery: 0,
    irrelevantDeliveryIntervalHigh: 0.009,
    staleDelivery: 0,
    staleDeliveryIntervalHigh: 0.009,
    recurrenceReduction: 0.85,
    recurrenceIntervalLow: 0.1,
    naturalCorrectnessDelta: 0.2,
    naturalCorrectnessIntervalLow: 0.05,
    severeUnquarantined: 0,
    emptyP95Overhead: 0.03,
    reconstructionTokenReduction: 0.6,
    firstSuccessorTokenReduction: 0.25,
    firstSuccessorTokenIntervalLow: 0.1,
    latencyOverheadP95: 0.04,
    knownMistakeRecurrence: 0,
    contradictoryDelivery: 0,
    contradictoryDeliveryIntervalHigh: 0.009,
    negativeDeliveryIntervalHigh: 0.009,
    consumerSchemaTokensP95: 0,
    captureModelCallsP95: 0,
    writerIntegrity: true,
    crossClientPassed: true,
    benchmarkFamilyCoverage: 1,
    benchmarkArmCoverage: 1,
    directionalCorrectnessIntervalLow: 0,
    familyCorrectnessIntervalLow: 0,
    directionalTokenOverheadHigh: 0.02,
    causalChainIntegrity: true,
    trialIntegrity: true,
    independentGrading: true,
    competitivePassed: true,
    competitiveCoverage: 1,
    competitiveReproducibility: true,
  };

  test('renders the complete cognition-to-correctness funnel', () => {
    const events = [
      'captured',
      'verified',
      'eligible',
      'retrieved',
      'delivered',
      'used',
      'behaviorChanged',
      'mistakePrevented',
      'taskCorrect',
    ].map((stage) => ({ objectId: 'a', stage, client: 'codex' }));
    const funnel = cognitionFunnel(events, { client: 'codex' });
    expect(funnel.objects).toBe(1);
    expect(Object.values(funnel.counts).every((count) => count === 1)).toBe(
      true
    );
  });

  test('fails closed on missing evidence and calls correctness regression harmful', () => {
    expect(releaseVerdict({}).status).toBe('insufficient');
    expect(
      releaseVerdict({ ...passingMetrics, naturalCorrectnessDelta: -0.03 })
        .status
    ).toBe('harmful');
    const passed = releaseVerdict(passingMetrics);
    expect(passed).toMatchObject({ status: 'passed', passed: true });
    expect(
      signedEvidenceManifest({ metrics: passingMetrics, verdict: passed })
        .manifestHash
    ).toHaveLength(64);
  });

  test('promotes only passed evidence and rolls harmful canaries back with a kill switch', () => {
    const rollout = new RolloutController({ stage: 'advisory-canary' });
    expect(rollout.promote(releaseVerdict({})).promoted).toBe(false);
    expect(rollout.promote(releaseVerdict(passingMetrics))).toMatchObject({
      promoted: true,
      stage: 'verification-canary',
    });
    expect(
      rollout.observe(
        {
          correctnessDelta: -0.1,
          severeHarm: 1,
          p95LatencyMs: 10,
          p95ContextOverhead: 0.01,
          availability: 1,
          unauthorizedAccess: 0,
        },
        { objectId: 'harmful-memory' }
      )
    ).toMatchObject({ rolledBack: true, stage: 'advisory-canary' });
    expect(rollout.enabled({ objectId: 'harmful-memory' })).toBe(false);
    expect(rollout.safeMode()).toMatchObject({
      readOnly: true,
      guardsEnforced: false,
    });
  });

  test('opens a circuit, recovers, and proves zero-loss disaster recovery', () => {
    const breaker = new CircuitBreaker({ failures: 2, resetMs: 10 });
    breaker.record(false, 100);
    breaker.record(false, 101);
    expect(breaker.allow(105)).toBe(false);
    expect(breaker.allow(112)).toBe(true);
    expect(
      recoveryExercise({
        acceptedEvents: ['a', 'b'],
        restoredEvents: ['b', 'a'],
        startedAt: 100,
        recoveredAt: 150,
      })
    ).toMatchObject({
      passed: true,
      recoveryPointEvents: 0,
      recoveryTimeMs: 50,
    });
  });

  test('requires measured SLOs, every fault, and production-tier evidence', () => {
    const slos = sloReport(
      Array.from({ length: 100 }, (_, index) => ({
        available: true,
        latencyMs: 25 + (index % 10),
        contextOverhead: 0.01,
        correctnessDelta: 0,
        severeHarm: 0,
        unauthorizedAccess: 0,
      }))
    );
    expect(slos).toMatchObject({
      passed: true,
      metrics: { availability: 1, severeHarm: 0 },
    });
    const faults = faultInjectionStudy(
      REQUIRED_FAULTS.map((fault) => ({
        fault,
        contained: true,
        dataLoss: 0,
        recoveryTimeMs: 50,
      }))
    );
    expect(faults).toMatchObject({ passed: true, exercised: 6 });
    const recovery = recoveryExercise({
      acceptedEvents: ['a'],
      restoredEvents: ['a'],
      startedAt: 0,
      recoveredAt: 50,
    });
    expect(
      productionReadiness({
        release: { status: 'passed' },
        evidenceClasses: ['effectiveness'],
        slos,
        faults,
        recovery,
        traffic: { passed: true },
        rolloutStage: 'stable',
      })
    ).toMatchObject({
      ready: false,
      missing: ['production traffic evidence'],
    });
    expect(
      productionReadiness({
        release: { status: 'passed' },
        evidenceClasses: ['effectiveness', 'production'],
        slos,
        faults,
        recovery,
        traffic: { passed: true },
        rolloutStage: 'stable',
      })
    ).toMatchObject({ ready: true, status: 'passed' });
  });

  test('requires staged opt-in traffic and rejects raw prompts', () => {
    const stages = [
      'shadow-selection',
      'observe-only',
      'advisory-canary',
      'verification-canary',
      'scoped-enforcement',
    ];
    const samples = stages.map((rolloutStage, index) => ({
      realTraffic: true,
      optIn: true,
      timestamp: index * 100,
      rolloutStage,
      client: ['codex', 'claude-code', 'gemini'][index % 3],
      projectId: `project-${index % 3}`,
      available: true,
      latencyMs: 25,
      contextOverhead: 0.01,
      correctnessDelta: 0,
      severeHarm: 0,
      unauthorizedAccess: 0,
      privacyViolation: 0,
    }));
    expect(
      productionTrafficReport(samples, {
        minimumSamples: 5,
        minimumDurationMs: 400,
        minimumClients: 3,
        minimumProjects: 3,
      })
    ).toMatchObject({ passed: true });
    expect(
      productionTrafficReport(
        [{ ...samples[0], detail: { transcript: 'private' } }],
        {
          minimumSamples: 1,
          minimumDurationMs: 0,
          minimumClients: 1,
          minimumProjects: 1,
        }
      ).checks.noRawContent
    ).toBe(false);
    const pseudonymous = pseudonymizeProductionSamples(samples, {
      secret: 'private-test-secret',
      keyId: 'traffic-key-v1',
      timestampBucketMs: 60_000,
    });
    expect(pseudonymous[0].client).not.toBe(samples[0].client);
    expect(pseudonymous[0].projectId).not.toBe(samples[0].projectId);
    expect(
      pseudonymous.every((sample) => sample.timestamp % 60_000 === 0)
    ).toBe(true);
    expect(pseudonymousProductionIdentity(pseudonymous[0])).toEqual(
      pseudonymousProductionIdentity(
        pseudonymizeProductionSamples([samples[0]], {
          secret: 'private-test-secret',
          keyId: 'traffic-key-v1',
          timestampBucketMs: 60_000,
        })[0]
      )
    );
  });

  test('keeps measured tier failures distinct from missing evidence', () => {
    expect(
      tieredReleaseVerdict(
        {},
        {
          production: { status: 'failed', ready: false, missing: [] },
        }
      )
    ).toMatchObject({ status: 'failed', passed: false });
  });
});

function pseudonymousProductionIdentity(sample) {
  return { client: sample.client, projectId: sample.projectId };
}
