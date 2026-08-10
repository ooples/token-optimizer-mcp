#!/usr/bin/env node
/** CI preflight proving that the frozen program can produce every release metric. */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildFullStudyPlan,
  BENCHMARK_ARMS,
  BENCHMARK_FAMILIES,
  canonicalJson,
  freezeBenchmark,
  preRegisterBenchmark,
  releaseMetricCoveragePreflight,
  sha256,
  STUDY_DRIVER_PROTOCOL,
  STUDY_NEGATIVE_ARMS,
  studyDriverRegistry,
  UCR_CLIENT_REGISTRY,
  zeroFailureWilsonSampleSize,
} from '../ucr/index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = join(ROOT, 'evals', 'ucr', 'results', 'study-readiness-v1.json');
const write = process.argv.includes('--write');
const source = JSON.parse(
  readFileSync(join(ROOT, 'evals', 'ucr', 'benchmark-v1.json'), 'utf8')
);
const benchmark = freezeBenchmark(source);
const registration = preRegisterBenchmark(source, source.pilot);
const clients = JSON.parse(
  readFileSync(join(ROOT, 'evals', 'ucr', 'study-clients-v1.json'), 'utf8')
).clients;
const competitorKinds = JSON.parse(
  readFileSync(join(ROOT, 'evals', 'ucr', 'competitors-v1.json'), 'utf8')
).baselines.map((baseline) => baseline.kind);
const pairedRepetitionsPerCell = Math.ceil(
  registration.powerAnalysis.perArm / benchmark.tasks.length
);
const negativeRepetitionsPerCell = Math.ceil(
  zeroFailureWilsonSampleSize({
    comparisons: clients.length ** 2 * STUDY_NEGATIVE_ARMS.length,
  }).samples / benchmark.tasks.length
);
const plan = buildFullStudyPlan({
  benchmark,
  clients,
  secret: 'ci-structure-only-secret',
  registration,
  pairedRepetitionsPerCell,
  negativeRepetitionsPerCell,
  minimumSubgroupPairs: pairedRepetitionsPerCell,
});
const coverage = releaseMetricCoveragePreflight({
  plan,
  competitorKinds,
  productionStages: [
    'shadow-selection',
    'observe-only',
    'advisory-canary',
    'verification-canary',
    'scoped-enforcement',
  ],
});
const driverRegistry = studyDriverRegistry();
const driverContractPassed =
  Object.keys(driverRegistry).length ===
    Object.keys(UCR_CLIENT_REGISTRY).length &&
  Object.values(driverRegistry).every(
    (driver) => driver.protocol === STUDY_DRIVER_PROTOCOL
  );
const powered =
  plan.primaryPairsPerDirection >= registration.powerAnalysis.perArm &&
  plan.negativeSamplesPerDirectionPerArm >=
    plan.minimumNegativeSamplesPerDirection;
const familyCount = new Set(plan.trials.map((trial) => trial.family)).size;
const armCount = new Set(plan.trials.map((trial) => trial.arm)).size;
const readinessChecks = {
  ...coverage.design.checks,
  benchmarkFamilies: familyCount >= BENCHMARK_FAMILIES.length,
  benchmarkArms: armCount >= BENCHMARK_ARMS.length,
};
const designPassed =
  coverage.passed &&
  powered &&
  driverContractPassed &&
  Object.values(readinessChecks).every(Boolean) &&
  coverage.missingMetrics.length === 0;
const body = {
  schemaVersion: 'ucr.study-readiness/1',
  passed: designPassed,
  structuralPlanHash: plan.planHash,
  benchmarkHash: benchmark.manifestHash,
  registrationHash: registration.registrationHash,
  pairedRepetitionsPerCell,
  primaryPairsPerDirection: plan.primaryPairsPerDirection,
  negativeRepetitionsPerCell,
  negativeSamplesPerDirectionPerArm: plan.negativeSamplesPerDirectionPerArm,
  negativeConfidence: plan.negativeConfidence,
  trials: plan.trials.length,
  providerInvocations: plan.trials.reduce((sum, trial) => {
    if (
      !Number.isInteger(trial.expectedProviderInvocations) ||
      trial.expectedProviderInvocations < 2
    )
      throw new Error(
        `trial ${trial.trialId} omits expectedProviderInvocations`
      );
    return sum + trial.expectedProviderInvocations;
  }, 0),
  mappedMetrics: Object.keys(coverage.metricSources).length,
  representativeStudyClients: clients.length,
  universalDriverClients: Object.keys(driverRegistry).length,
  driverContractPassed,
  missingMetrics: coverage.missingMetrics,
  coverage: {
    ...coverage.design.coverage,
    familyCount,
    requiredFamilies: BENCHMARK_FAMILIES.length,
    armCount,
    requiredArms: BENCHMARK_ARMS.length,
  },
  checks: readinessChecks,
};
const report = { ...body, reportHash: sha256(body) };
if (write)
  writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
let artifactValid = false;
if (existsSync(OUTPUT)) {
  try {
    artifactValid =
      canonicalJson(JSON.parse(readFileSync(OUTPUT, 'utf8'))) ===
      canonicalJson(report);
  } catch {
    artifactValid = false;
  }
}
const passed = designPassed && artifactValid;
console.log(
  canonicalJson({
    passed,
    artifactValid,
    output: OUTPUT,
    planHash: plan.planHash,
    pairedRepetitionsPerCell,
    primaryPairsPerDirection: plan.primaryPairsPerDirection,
    negativeRepetitionsPerCell,
    negativeSamplesPerDirectionPerArm: plan.negativeSamplesPerDirectionPerArm,
    trials: plan.trials.length,
    providerInvocations: body.providerInvocations,
    mappedMetrics: Object.keys(coverage.metricSources).length,
    representativeStudyClients: clients.length,
    universalDriverClients: Object.keys(driverRegistry).length,
    missingMetrics: coverage.missingMetrics,
    coverage: body.coverage,
  })
);
if (!passed) process.exitCode = 1;
