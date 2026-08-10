import { sha256 } from './protocol.mjs';

export const FUNNEL_STAGES = Object.freeze([
  'captured',
  'verified',
  'eligible',
  'retrieved',
  'delivered',
  'used',
  'behaviorChanged',
  'mistakePrevented',
  'taskCorrect',
]);

export function cognitionFunnel(events, filters = {}) {
  const relevant = events.filter((event) =>
    Object.entries(filters).every(([key, value]) => event[key] === value)
  );
  const objectStages = new Map();
  for (const event of relevant) {
    if (!event.objectId || !FUNNEL_STAGES.includes(event.stage)) continue;
    if (!objectStages.has(event.objectId))
      objectStages.set(event.objectId, new Set());
    objectStages.get(event.objectId).add(event.stage);
  }
  const counts = Object.fromEntries(
    FUNNEL_STAGES.map((stage) => [
      stage,
      [...objectStages.values()].filter((stages) => stages.has(stage)).length,
    ])
  );
  return { filters, objects: objectStages.size, counts };
}

function missing(metrics, fields) {
  return fields.filter(
    (field) =>
      field.split('.').reduce((value, key) => value?.[key], metrics) == null
  );
}

export const EFFECTIVENESS_REQUIRED_METRICS = Object.freeze([
  'applicabilityPrecision',
  'applicabilityPrecisionIntervalLow',
  'preActionDelivery',
  'preActionDeliveryIntervalLow',
  'irrelevantDelivery',
  'irrelevantDeliveryIntervalHigh',
  'staleDelivery',
  'staleDeliveryIntervalHigh',
  'recurrenceReduction',
  'recurrenceIntervalLow',
  'naturalCorrectnessDelta',
  'naturalCorrectnessIntervalLow',
  'severeUnquarantined',
  'emptyP95Overhead',
  'reconstructionTokenReduction',
  'firstSuccessorTokenReduction',
  'firstSuccessorTokenIntervalLow',
  'latencyOverheadP95',
  'knownMistakeRecurrence',
  'contradictoryDelivery',
  'contradictoryDeliveryIntervalHigh',
  'negativeDeliveryIntervalHigh',
  'consumerSchemaTokensP95',
  'captureModelCallsP95',
  'writerIntegrity',
  'crossClientPassed',
  'benchmarkFamilyCoverage',
  'benchmarkArmCoverage',
  'directionalCorrectnessIntervalLow',
  'familyCorrectnessIntervalLow',
  'directionalTokenOverheadHigh',
  'causalChainIntegrity',
  'trialIntegrity',
  'independentGrading',
]);

export const SUPERIORITY_REQUIRED_METRICS = Object.freeze([
  'competitivePassed',
  'competitiveCoverage',
  'competitiveReproducibility',
]);

function verdict(metrics, required, gates, { harmful = false } = {}) {
  const absent = missing(metrics, required);
  if (absent.length)
    return {
      status: 'insufficient',
      passed: false,
      missing: absent,
      failed: [],
    };
  const failed = Object.entries(gates)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  return {
    status: harmful ? 'harmful' : failed.length ? 'failed' : 'passed',
    passed: !harmful && failed.length === 0,
    missing: [],
    failed,
    gates,
  };
}

export function effectivenessVerdict(metrics) {
  const harmful =
    metrics.severeUnquarantined > 0 || metrics.naturalCorrectnessDelta < 0;
  return verdict(
    metrics,
    EFFECTIVENESS_REQUIRED_METRICS,
    {
      applicabilityPrecision: metrics.applicabilityPrecision >= 0.95,
      applicabilityPrecisionInterval:
        metrics.applicabilityPrecisionIntervalLow >= 0.95,
      preActionDelivery:
        metrics.preActionDelivery >= 0.95 &&
        metrics.preActionDeliveryIntervalLow >= 0.95,
      irrelevantDelivery:
        metrics.irrelevantDelivery < 0.01 &&
        metrics.irrelevantDeliveryIntervalHigh < 0.01,
      staleDelivery:
        metrics.staleDelivery < 0.01 &&
        metrics.staleDeliveryIntervalHigh < 0.01,
      recurrenceReduction:
        metrics.recurrenceReduction >= 0.8 &&
        metrics.recurrenceIntervalLow > 0,
      naturalCorrectness:
        metrics.naturalCorrectnessDelta >= 0.1 &&
        metrics.naturalCorrectnessIntervalLow > 0,
      noSevereHarm: metrics.severeUnquarantined === 0,
      emptyOverhead: metrics.emptyP95Overhead < 0.05,
      reconstruction: metrics.reconstructionTokenReduction >= 0.5,
      firstSuccessorTokens:
        metrics.firstSuccessorTokenReduction >= 0.2 &&
        metrics.firstSuccessorTokenIntervalLow > 0,
      latency: metrics.latencyOverheadP95 <= 0.05,
      knownMistakeImmunity: metrics.knownMistakeRecurrence === 0,
      noContradiction:
        metrics.contradictoryDelivery === 0 &&
        metrics.contradictoryDeliveryIntervalHigh < 0.01,
      directionNegativeDelivery:
        metrics.negativeDeliveryIntervalHigh < 0.01,
      zeroConsumerSchema: metrics.consumerSchemaTokensP95 === 0,
      zeroCaptureInference: metrics.captureModelCallsP95 === 0,
      writerIntegrity: metrics.writerIntegrity === true,
      crossClient: metrics.crossClientPassed === true,
      allBenchmarkFamilies: metrics.benchmarkFamilyCoverage === 1,
      allBenchmarkArms: metrics.benchmarkArmCoverage === 1,
      directionNonInferiority:
        metrics.directionalCorrectnessIntervalLow >= -0.02,
      familyNonInferiority: metrics.familyCorrectnessIntervalLow >= -0.02,
      directionTokenNonInferiority:
        metrics.directionalTokenOverheadHigh <= 0.05,
      causalChain: metrics.causalChainIntegrity === true,
      trialIntegrity: metrics.trialIntegrity === true,
      independentGrading: metrics.independentGrading === true,
    },
    { harmful }
  );
}

export function superiorityVerdict(metrics) {
  return verdict(metrics, SUPERIORITY_REQUIRED_METRICS, {
    competitive: metrics.competitivePassed === true,
    competitiveCoverage: metrics.competitiveCoverage === 1,
    competitiveReproducibility:
      metrics.competitiveReproducibility === true,
  });
}

/** Keep effectiveness, competitive superiority, and production readiness distinct. */
export function tieredReleaseVerdict(metrics, { production = null } = {}) {
  const effectiveness = effectivenessVerdict(metrics);
  const superiority = superiorityVerdict(metrics);
  const productionVerdict = production || {
    status: 'insufficient',
    ready: false,
    missing: ['signed staged production traffic evidence'],
  };
  const productionPassed =
    productionVerdict.status === 'passed' && productionVerdict.ready !== false;
  const passed = effectiveness.passed && superiority.passed && productionPassed;
  const harmful =
    effectiveness.status === 'harmful' || productionVerdict.status === 'harmful';
  return {
    status: harmful ? 'harmful' : passed ? 'passed' : 'insufficient',
    passed: !harmful && passed,
    effectiveness,
    superiority,
    production: productionVerdict,
  };
}

export function releaseVerdict(metrics) {
  const required = [
    ...EFFECTIVENESS_REQUIRED_METRICS,
    ...SUPERIORITY_REQUIRED_METRICS,
  ];
  const absent = missing(metrics, required);
  if (absent.length)
    return {
      status: 'insufficient',
      passed: false,
      missing: absent,
      failed: [],
    };
  const effectiveness = effectivenessVerdict(metrics);
  const superiority = superiorityVerdict(metrics);
  const harmful = effectiveness.status === 'harmful';
  const failed = [
    ...effectiveness.failed,
    ...superiority.failed,
  ];
  return {
    status: harmful ? 'harmful' : failed.length ? 'failed' : 'passed',
    passed: !harmful && failed.length === 0,
    missing: [],
    failed,
    gates: {
      ...effectiveness.gates,
      ...superiority.gates,
    },
    tiers: { effectiveness, superiority },
  };
}

export function signedEvidenceManifest({
  benchmark,
  ledger,
  metrics,
  verdict,
  signature = null,
} = {}) {
  const body = {
    schemaVersion: 'ucr.release-evidence/1',
    benchmarkHash: benchmark?.manifestHash,
    ledgerHash: ledger?.ledgerHash,
    metrics,
    verdict,
    createdAt: Date.now(),
  };
  return {
    ...body,
    manifestHash: sha256(body),
    signature,
    downloadableLedger: true,
  };
}
