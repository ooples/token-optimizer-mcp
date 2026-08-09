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

export function releaseVerdict(metrics) {
  const required = [
    'applicabilityPrecision',
    'preActionDelivery',
    'irrelevantDelivery',
    'staleDelivery',
    'recurrenceReduction',
    'recurrenceIntervalLow',
    'naturalCorrectnessDelta',
    'severeUnquarantined',
    'emptyP95Overhead',
    'reconstructionTokenReduction',
    'writerIntegrity',
    'crossClientPassed',
    'competitivePassed',
  ];
  const absent = missing(metrics, required);
  if (absent.length)
    return {
      status: 'insufficient',
      passed: false,
      missing: absent,
      failed: [],
    };
  const harmful =
    metrics.severeUnquarantined > 0 || metrics.naturalCorrectnessDelta < -0.02;
  const gates = {
    applicabilityPrecision: metrics.applicabilityPrecision >= 0.95,
    preActionDelivery: metrics.preActionDelivery >= 0.95,
    irrelevantDelivery: metrics.irrelevantDelivery < 0.01,
    staleDelivery: metrics.staleDelivery < 0.01,
    recurrenceReduction:
      metrics.recurrenceReduction >= 0.8 && metrics.recurrenceIntervalLow > 0,
    naturalCorrectness: metrics.naturalCorrectnessDelta >= -0.02,
    noSevereHarm: metrics.severeUnquarantined === 0,
    emptyOverhead: metrics.emptyP95Overhead < 0.05,
    reconstruction: metrics.reconstructionTokenReduction >= 0.5,
    writerIntegrity: metrics.writerIntegrity === true,
    crossClient: metrics.crossClientPassed === true,
    competitive: metrics.competitivePassed === true,
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
