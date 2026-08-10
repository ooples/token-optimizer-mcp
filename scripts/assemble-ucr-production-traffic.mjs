#!/usr/bin/env node
/** Assemble privacy-safe real shadow/canary telemetry into production evidence. */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PRODUCTION_TIMESTAMP_BUCKET_MS,
  REQUIRED_TRAFFIC_STAGES,
  canonicalJson,
  createEvidenceRun,
  loadProvisionedEvidenceIdentity,
  productionReadiness,
  productionTrafficReport,
  pseudonymizeProductionSamples,
  sealEvidenceLedger,
  sha256,
  sloReport,
  verifyEvidenceLedger,
  validateProductionSample,
} from '../ucr/index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const options = {
  execute: false,
  input: null,
  releaseEvidence: join(
    ROOT,
    'evals',
    'ucr',
    'results',
    'evidence-index-v2.json'
  ),
  faultEvidence: join(
    ROOT,
    'evals',
    'ucr',
    'results',
    'production-exercise-v1.json'
  ),
  output: join(ROOT, 'evals', 'ucr', 'results', 'production-traffic-v1.json'),
  rolloutStage: 'stable',
  minimumSamples: 1000,
  minimumDurationMs: 604800000,
  minimumClients: 3,
  minimumProjects: 3,
};
for (let index = 2; index < process.argv.length; index++) {
  const arg = process.argv[index];
  if (arg === '--execute') options.execute = true;
  else if (arg.startsWith('--')) {
    const key = arg
      .slice(2)
      .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (!(key in options)) throw new Error(`unknown option ${arg}`);
    options[key] = process.argv[++index];
  }
}
for (const key of [
  'minimumSamples',
  'minimumDurationMs',
  'minimumClients',
  'minimumProjects',
])
  options[key] = Number(options[key]);
for (const key of ['input', 'releaseEvidence', 'faultEvidence', 'output']) {
  if (options[key])
    options[key] = isAbsolute(options[key])
      ? options[key]
      : resolve(ROOT, options[key]);
}

if (!options.execute) {
  console.log(
    JSON.stringify(
      {
        execute: false,
        requiredStages: REQUIRED_TRAFFIC_STAGES,
        thresholds: {
          minimumSamples: options.minimumSamples,
          minimumDurationMs: options.minimumDurationMs,
          minimumClients: options.minimumClients,
          minimumProjects: options.minimumProjects,
        },
        requiredFields: [
          'timestamp',
          'realTraffic=true',
          'optIn=true',
          'rolloutStage',
          'client',
          'projectId',
          'available',
          'latencyMs',
          'contextOverhead',
          'correctnessDelta',
          'severeHarm',
          'unauthorizedAccess',
          'privacyViolation',
        ],
        prohibitedFields: ['prompt', 'transcript', 'rawOutput'],
        note: 'Local exercises are never accepted as production traffic.',
      },
      null,
      2
    )
  );
  process.exit(0);
}
if (!options.input || !existsSync(options.input))
  throw new Error('--input must identify an existing real-traffic JSONL file');
for (const path of [options.releaseEvidence, options.faultEvidence])
  if (!existsSync(path))
    throw new Error(`required evidence is missing: ${path}`);
const signingIdentity = loadProvisionedEvidenceIdentity();
const pseudonymSecret = process.env.UCR_TRAFFIC_PSEUDONYM_SECRET;
const pseudonymKeyId = String(
  process.env.UCR_TRAFFIC_PSEUDONYM_KEY_ID || ''
).trim();
if (!pseudonymSecret || !pseudonymKeyId)
  throw new Error(
    'UCR_TRAFFIC_PSEUDONYM_SECRET and UCR_TRAFFIC_PSEUDONYM_KEY_ID are required'
  );

const rawSamples = readFileSync(options.input, 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line, index) => {
    const sample = JSON.parse(line);
    const validation = validateProductionSample(sample);
    if (!validation.valid)
      throw new Error(
        `production sample ${index} is invalid: ${validation.diagnostics.join('; ')}`
      );
    return sample;
  });
const samples = pseudonymizeProductionSamples(rawSamples, {
  secret: pseudonymSecret,
  keyId: pseudonymKeyId,
  timestampBucketMs: PRODUCTION_TIMESTAMP_BUCKET_MS,
});
const releaseEvidence = JSON.parse(
  readFileSync(options.releaseEvidence, 'utf8')
);
const faultEvidence = JSON.parse(readFileSync(options.faultEvidence, 'utf8'));
const traffic = productionTrafficReport(samples, {
  minimumSamples: options.minimumSamples,
  minimumDurationMs: options.minimumDurationMs,
  minimumClients: options.minimumClients,
  minimumProjects: options.minimumProjects,
});
const slos = sloReport(samples);
const sourceTreeHash = sha256([
  readFileSync(fileURLToPath(import.meta.url), 'utf8'),
  readFileSync(join(ROOT, 'ucr', 'rollout.mjs'), 'utf8'),
  releaseEvidence.reportHash,
  faultEvidence.reportHash,
]);
const run = createEvidenceRun({
  runId: `production-traffic-${randomBytes(8).toString('hex')}`,
  evidenceClass: 'production',
  benchmarkHash:
    releaseEvidence.derived?.derivedHash || releaseEvidence.reportHash,
  sourceTreeHash,
  runner: { name: 'ucr-production-traffic', node: process.version },
});
const ledger = sealEvidenceLedger(run, samples, {
  privateKey: signingIdentity.privateKey,
});
const ledgerVerification = verifyEvidenceLedger(ledger, {
  publicKey: signingIdentity.publicKey,
});
const readiness = productionReadiness({
  release: releaseEvidence.verdict,
  evidenceClasses: ['effectiveness', 'superiority', 'production'],
  slos,
  faults: faultEvidence.faults,
  recovery: faultEvidence.recovery,
  traffic,
  rolloutStage: options.rolloutStage,
});
const body = {
  schemaVersion: 'ucr.production-traffic/1',
  executedAt: new Date().toISOString(),
  sourceTreeHash,
  traffic,
  slos,
  readiness,
  ledger,
  ledgerKeyId: signingIdentity.keyId,
  identifiersPseudonymized: true,
  pseudonymizationKeyId: pseudonymKeyId,
  ledgerVerification,
  passed: readiness.ready && ledgerVerification.valid,
};
const report = { ...body, reportHash: sha256(body) };
mkdirSync(dirname(options.output), { recursive: true });
writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(
  canonicalJson({
    output: options.output,
    samples: traffic.metrics.samples,
    readiness: readiness.status,
    ledgerHash: ledger.ledgerHash,
  })
);
if (!report.passed) process.exitCode = 1;
