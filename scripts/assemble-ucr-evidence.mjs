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
  verifyEvidenceLedger,
} from '../ucr/index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS = join(ROOT, 'evals', 'ucr', 'results');
const OUTPUT = join(RESULTS, 'evidence-index-v2.json');
const definitions = [
  ['graph-scale', 'graph-scale-v1.json', 'conformance'],
  ['coordination-scale', 'coordination-scale-v1.json', 'conformance'],
  ['consolidation', 'consolidation-study-v1.json', 'conformance'],
  ['adapter-processes', 'adapter-process-certification-v1.json', 'conformance'],
  ['mcp-context', 'mcp-context-audit-v1.json', 'conformance'],
  ['compounding', 'compounding-study-v1.json', 'conformance'],
  ['production-exercise', 'production-exercise-v1.json', 'executable-smoke'],
  [
    'codex-to-claude',
    'live-multimodel-handoff-edge-v1.json',
    'executable-smoke',
  ],
  [
    'claude-to-codex',
    'live-multimodel-handoff-edge-claude-producer-v1.json',
    'executable-smoke',
  ],
  [
    'codex-to-copilot',
    'live-multimodel-handoff-edge-copilot-v1.json',
    'executable-smoke',
  ],
  [
    'effectiveness-pilot-negative',
    'handoff-effectiveness-pilot-v1.json',
    'executable-smoke',
    false,
  ],
];

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
  .map((artifact) => ({
    study: artifact.name,
    artifact: artifact.filename,
    artifactHash: artifact.reportHash,
    passed: artifact.valid,
    ...(artifact.name === 'coordination-scale'
      ? {
          study: 'writer-integrity',
          acceptedWrites: artifact.report.claimsAccepted,
          restoredWrites:
            artifact.report.claimsAccepted - artifact.report.lostAcceptedEvents,
        }
      : {}),
  }));
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
const validArtifacts = artifacts.filter((artifact) => artifact.valid);
const liveArtifacts = artifacts.filter(
  (artifact) =>
    artifact.evidenceClass === 'executable-smoke' &&
    artifact.name.includes('-to-')
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
    liveDirectionsPassed: liveArtifacts.filter((artifact) => artifact.valid)
      .length,
    liveDirectionsAttempted: liveArtifacts.length,
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
  },
  conformanceLedger,
  conformancePublicKey,
  conformanceLedgerVerification: verifyEvidenceLedger(conformanceLedger, {
    publicKey,
  }),
  derived,
  verdict,
  claims: {
    conformance: validArtifacts.length === artifacts.length,
    executableCrossClient:
      liveArtifacts.filter((artifact) => artifact.valid).length >= 2,
    effectiveness: tiers.effectiveness.status === 'present',
    superiority: tiers.superiority.status === 'present',
    production: tiers.production.status === 'present',
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
