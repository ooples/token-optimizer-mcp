#!/usr/bin/env node

import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalJson,
  createEvidenceRun,
  deriveReleaseMetrics,
  evidenceTierReport,
  releaseVerdict,
  sealEvidenceLedger,
  sha256,
  tieredReleaseVerdict,
  verifyEvidenceLedger,
} from '../ucr/index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS = join(ROOT, 'evals', 'ucr', 'results');
const OUTPUT = join(RESULTS, 'evidence-index-v2.json');
const definitions = [
  ['study-readiness', 'study-readiness-v1.json', 'conformance'],
  ['graph-scale', 'graph-scale-v1.json', 'conformance'],
  ['coordination-scale', 'coordination-scale-v1.json', 'conformance'],
  ['consolidation', 'consolidation-study-v1.json', 'conformance'],
  ['adapter-processes', 'adapter-process-certification-v1.json', 'conformance'],
  ['mcp-context', 'mcp-context-audit-v1.json', 'conformance'],
  ['compounding', 'compounding-study-v1.json', 'conformance'],
  ['production-exercise', 'production-exercise-v1.json', 'executable-smoke'],
  [
    'stateful-codex-to-claude',
    'stateful-matched-codex-to-claude-v1.json',
    'executable-smoke',
  ],
  [
    'stateful-claude-to-codex',
    'stateful-matched-claude-to-codex-v1.json',
    'executable-smoke',
  ],
  [
    'transport-negative-claude-plugin',
    'stateful-preflight-codex-to-claude-v3.json',
    'executable-smoke',
    false,
  ],
  [
    'stateful-claude-to-copilot-quota',
    'stateful-preflight-claude-to-copilot-v1.json',
    'executable-smoke',
    false,
  ],
  [
    'effectiveness-pilot-negative',
    'handoff-effectiveness-pilot-v1.json',
    'executable-smoke',
    false,
  ],
];
for (const definition of [
  ['full-effectiveness', 'full-study-v1.json', 'effectiveness', true],
  ['live-competitive', 'competitive-study-v1.json', 'superiority', true],
  ['production-traffic', 'production-traffic-v1.json', 'production', true],
]) {
  if (existsSync(join(RESULTS, definition[1]))) definitions.push(definition);
}

function readReport([name, filename, evidenceClass, requiredPass = true]) {
  const path = join(RESULTS, filename);
  if (!existsSync(path))
    return { name, filename, evidenceClass, present: false, valid: false };
  const report = JSON.parse(readFileSync(path, 'utf8'));
  const { reportHash, ...body } = report;
  const reportHashValid = sha256(body) === reportHash;
  const ledgerVerification = report.ledger
    ? verifyEvidenceLedger(report.ledger, {
        publicKey: report.ledgerPublicKey || null,
      })
    : null;
  return {
    name,
    filename,
    evidenceClass,
    requiredPass,
    present: true,
    valid:
      reportHashValid &&
      (!requiredPass || report.passed === true) &&
      (!ledgerVerification || ledgerVerification.valid),
    reportHashValid,
    reportHash,
    schemaVersion: report.schemaVersion,
    passed: report.passed === true,
    executedAt: report.executedAt || null,
    sourceTreeHash: report.sourceTreeHash || report.sourceHash || null,
    ledgerHash: ledgerVerification?.ledgerHash || null,
    ledgerVerification,
    report,
  };
}

const artifacts = definitions.map(readReport);
const coordination = artifacts.find(
  (artifact) => artifact.name === 'coordination-scale'
);
const conformanceRows = artifacts
  .filter((artifact) => artifact.evidenceClass === 'conformance')
  .map((artifact) => {
    const row = {
      study: artifact.name,
      artifact: artifact.filename,
      artifactHash: artifact.reportHash,
      passed: artifact.valid,
    };
    if (artifact.name !== 'coordination-scale') return row;

    const acceptedWrites = artifact.report?.claimsAccepted;
    const lostAcceptedEvents = artifact.report?.lostAcceptedEvents;
    return {
      ...row,
      study: 'writer-integrity',
      ...(Number.isFinite(acceptedWrites) && Number.isFinite(lostAcceptedEvents)
        ? {
            acceptedWrites,
            restoredWrites: acceptedWrites - lostAcceptedEvents,
          }
        : {}),
    };
  });
const sourceTreeHash = sha256(
  artifacts.map((artifact) => ({
    filename: artifact.filename,
    reportHash: artifact.reportHash || null,
  }))
);
const run = createEvidenceRun({
  runId: `evidence-index-${randomBytes(8).toString('hex')}`,
  evidenceClass: 'conformance',
  benchmarkHash: sha256(
    readFileSync(join(ROOT, 'evals', 'ucr', 'benchmark-v1.json'), 'utf8')
  ),
  sourceTreeHash,
  runner: { name: 'assemble-ucr-evidence', node: process.version },
});
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const conformanceLedger = sealEvidenceLedger(run, conformanceRows, {
  privateKey,
});
const conformancePublicKey = publicKey.export({ type: 'spki', format: 'pem' });
const ledgerInputs = [
  { ledger: conformanceLedger, publicKey: conformancePublicKey },
  ...artifacts
    .filter((artifact) => artifact.valid && artifact.report?.ledger)
    .map((artifact) => ({
      ledger: artifact.report.ledger,
      publicKey: artifact.report.ledgerPublicKey || null,
    })),
];
const derived = deriveReleaseMetrics(ledgerInputs);
const tiers = evidenceTierReport(ledgerInputs);
const verdict = releaseVerdict(derived.metrics);
const productionTraffic = artifacts.find(
  (artifact) => artifact.name === 'production-traffic'
);
const tieredVerdict = tieredReleaseVerdict(derived.metrics, {
  production: productionTraffic?.report?.readiness || null,
});
const validArtifacts = artifacts.filter((artifact) => artifact.valid);
const liveArtifacts = artifacts.filter(
  (artifact) =>
    artifact.evidenceClass === 'executable-smoke' &&
    artifact.name.startsWith('stateful-')
);
const totalTraffic = (usage) =>
  Number.isFinite(usage?.totalTokens)
    ? usage.totalTokens
    : Number.isFinite(usage?.inputTokens) && Number.isFinite(usage?.outputTokens)
      ? usage.inputTokens + usage.outputTokens
      : null;
const percentDelta = (control, runtime) =>
  Number.isFinite(control) && control > 0 && Number.isFinite(runtime)
    ? (runtime - control) / control
    : null;
const liveDirectionMetrics = liveArtifacts.map((artifact) => {
  const row = artifact.report?.directionResults?.[0];
  const controlTraffic = totalTraffic(
    row?.control?.pipelineUsage || row?.control?.usage
  );
  const runtimeTraffic = totalTraffic(
    row?.runtime?.pipelineUsage || row?.runtime?.usage
  );
  return {
    direction: row?.direction || artifact.name,
    integrityValid: artifact.valid,
    passed: artifact.passed === true,
    controlCorrect: row?.control?.correct ?? null,
    runtimeCorrect: row?.runtime?.correct ?? null,
    predecessorMistakeObserved:
      row?.producer?.predecessorMistakeObserved ?? null,
    predecessorCorrectionVerified:
      row?.producer?.predecessorCorrectionVerified ?? null,
    repeatedFailure: row?.runtime?.mistakeExecuted ?? null,
    controlMistake: row?.control?.mistakeExecuted ?? null,
    delivered: row?.runtime?.delivered ?? null,
    nativeGuardWired: row?.runtime?.nativeGuardWired ?? null,
    nativeGuardEnforced: row?.runtime?.nativeGuardEnforced ?? null,
    captureModelCalls:
      row?.runtime?.firstSuccessorCost?.additionalModelCalls ?? null,
    consumerStaticSchemaTokens:
      row?.runtime?.usage?.staticSchemaTokens ?? null,
    capsuleTokens: row?.runtime?.usage?.capsuleTokens ?? null,
    controlTokenTraffic: controlTraffic,
    runtimeTokenTraffic: runtimeTraffic,
    tokenTrafficDelta: percentDelta(controlTraffic, runtimeTraffic),
    controlLatencyMs:
      row?.control?.costLedger?.totals?.latencyMs ??
      row?.control?.latencyMs ??
      null,
    runtimeLatencyMs:
      row?.runtime?.costLedger?.totals?.latencyMs ??
      row?.runtime?.latencyMs ??
      null,
    latencyDelta: percentDelta(
      row?.control?.costLedger?.totals?.latencyMs ?? row?.control?.latencyMs,
      row?.runtime?.costLedger?.totals?.latencyMs ?? row?.runtime?.latencyMs
    ),
  };
});
const passedLiveDirections = liveDirectionMetrics.filter(
  (direction) => direction.integrityValid && direction.passed
);
const combinedControlTraffic = passedLiveDirections.reduce(
  (sum, direction) => sum + (direction.controlTokenTraffic || 0),
  0
);
const combinedRuntimeTraffic = passedLiveDirections.reduce(
  (sum, direction) => sum + (direction.runtimeTokenTraffic || 0),
  0
);
const combinedControlLatency = passedLiveDirections.reduce(
  (sum, direction) => sum + (direction.controlLatencyMs || 0),
  0
);
const combinedRuntimeLatency = passedLiveDirections.reduce(
  (sum, direction) => sum + (direction.runtimeLatencyMs || 0),
  0
);
const body = {
  schemaVersion: 'ucr.evidence-index/2',
  generatedAt: new Date().toISOString(),
  evidenceContract: {
    claimPolicy:
      'metrics are derived only from ledgers at or above each metric evidence requirement',
    tiers,
  },
  artifacts: artifacts.map(({ report: _report, ...artifact }) => artifact),
  summary: {
    artifactsValid: validArtifacts.length,
    artifactsTotal: artifacts.length,
    liveDirectionsPassed: passedLiveDirections.length,
    liveDirectionsAttempted: liveArtifacts.length,
    liveDirectionMetrics,
    liveDirectionsWithLowerTokenTraffic: passedLiveDirections.filter(
      (direction) => direction.tokenTrafficDelta < 0
    ).length,
    liveDirectionsWithLowerLatency: passedLiveDirections.filter(
      (direction) => direction.latencyDelta < 0
    ).length,
    combinedLiveTokenReduction:
      combinedControlTraffic > 0
        ? (combinedControlTraffic - combinedRuntimeTraffic) /
          combinedControlTraffic
        : null,
    combinedLiveLatencyReduction:
      combinedControlLatency > 0
        ? (combinedControlLatency - combinedRuntimeLatency) /
          combinedControlLatency
        : null,
    blindedControlMistakes: passedLiveDirections.filter(
      (direction) => direction.controlMistake === true
    ).length,
    runtimeKnownMistakeRecurrences: passedLiveDirections.filter(
      (direction) => direction.repeatedFailure === true
    ).length,
    nativeGuardEnforcements: passedLiveDirections.filter(
      (direction) => direction.nativeGuardEnforced === true
    ).length,
    maximumCaptureModelCalls: Math.max(
      0,
      ...passedLiveDirections
        .map((direction) => direction.captureModelCalls)
        .filter(Number.isFinite)
    ),
    maximumConsumerStaticSchemaTokens: Math.max(
      0,
      ...passedLiveDirections
        .map((direction) => direction.consumerStaticSchemaTokens)
        .filter(Number.isFinite)
    ),
    registeredClientProcesses: artifacts.find(
      (artifact) => artifact.name === 'adapter-processes'
    )?.report?.registeredClients,
    graphEvents: artifacts.find((artifact) => artifact.name === 'graph-scale')
      ?.report?.eventCount,
    coordinationWorkers: coordination?.report?.physicalWorkers,
    compoundingTasks: artifacts.find(
      (artifact) => artifact.name === 'compounding'
    )?.report?.benchmark?.tasks,
    productionFaults: artifacts.find(
      (artifact) => artifact.name === 'production-exercise'
    )?.report?.faults?.exercised,
    cognitiveSchemaTokens: artifacts.find(
      (artifact) => artifact.name === 'mcp-context'
    )?.report?.findings?.graphCaptureSchemaTokens,
    cognitiveReductionVsFull: artifacts.find(
      (artifact) => artifact.name === 'mcp-context'
    )?.report?.findings?.graphCaptureReductionVsFull,
    studyDesign: artifacts.find(
      (artifact) => artifact.name === 'study-readiness'
    )?.report
      ? {
          passed: artifacts.find(
            (artifact) => artifact.name === 'study-readiness'
          ).report.passed,
          trials: artifacts.find(
            (artifact) => artifact.name === 'study-readiness'
          ).report.trials,
          providerInvocations: artifacts.find(
            (artifact) => artifact.name === 'study-readiness'
          ).report.providerInvocations,
          mappedMetrics: artifacts.find(
            (artifact) => artifact.name === 'study-readiness'
          ).report.mappedMetrics,
          representativeStudyClients: artifacts.find(
            (artifact) => artifact.name === 'study-readiness'
          ).report.representativeStudyClients,
          universalDriverClients: artifacts.find(
            (artifact) => artifact.name === 'study-readiness'
          ).report.universalDriverClients,
          coverage: artifacts.find(
            (artifact) => artifact.name === 'study-readiness'
          ).report.coverage,
        }
      : null,
  },
  conformanceLedger,
  conformancePublicKey,
  conformanceLedgerVerification: verifyEvidenceLedger(conformanceLedger, {
    publicKey,
  }),
  derived,
  verdict,
  tieredVerdict,
  claims: {
    conformance: validArtifacts.length === artifacts.length,
    executableCrossClient:
      passedLiveDirections.length >= 2,
    effectiveness: tiers.effectiveness.status === 'present',
    superiority: tiers.superiority.status === 'present',
    production: tiers.production.status === 'present',
    replacement:
      tieredVerdict.effectiveness.passed &&
      tieredVerdict.superiority.passed &&
      tieredVerdict.production.ready === true,
  },
};
const report = { ...body, reportHash: sha256(body) };
mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(
  canonicalJson({
    output: OUTPUT,
    validArtifacts: `${validArtifacts.length}/${artifacts.length}`,
    liveDirectionsPassed: report.summary.liveDirectionsPassed,
    tiers,
    verdict: verdict.status,
    reportHash: report.reportHash,
  })
);
if (!report.conformanceLedgerVerification.valid) process.exitCode = 1;
