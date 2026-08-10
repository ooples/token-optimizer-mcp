#!/usr/bin/env node
/**
 * Frozen full-matrix study orchestrator. Provider-specific wrappers receive a
 * single public trial on stdin and return state/receipt/usage JSON on stdout.
 * The parent process owns hidden grading, pairing, integrity, and promotion.
 */

import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildFullStudyPlan,
  buildCausalChain,
  canonicalJson,
  createEvidenceRun,
  deriveReleaseMetrics,
  freezeBenchmark,
  gradeStudyFixture,
  materializeStudyFixture,
  preRegisterBenchmark,
  releaseMetricCoveragePreflight,
  sealEvidenceLedger,
  sha256,
  signGraderReceipt,
  stratifiedCostDiagnostics,
  validateTrialResult,
  validateStudyDriverResult,
  verifyEvidenceLedger,
  verifyGraderReceipt,
  zeroFailureWilsonSampleSize,
} from '../ucr/index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const options = {
  execute: false,
  powered: false,
  runnerCommand: process.env.UCR_STUDY_RUNNER || null,
  runnerModule: null,
  benchmark: join(ROOT, 'evals', 'ucr', 'benchmark-v1.json'),
  clients: join(ROOT, 'evals', 'ucr', 'study-clients-v1.json'),
  competitors: join(ROOT, 'evals', 'ucr', 'competitors-v1.json'),
  output: join(ROOT, 'evals', 'ucr', 'results', 'full-study-v1.json'),
  pairedRepetitionsPerCell: 1,
  negativeRepetitionsPerCell: 1,
  minimumSubgroupPairs: 30,
  maxTrials: null,
  timeoutMs: 600_000,
};

for (let index = 2; index < process.argv.length; index++) {
  const arg = process.argv[index];
  if (arg === '--execute') options.execute = true;
  else if (arg === '--powered') options.powered = true;
  else if (arg.startsWith('--')) {
    const key = arg
      .slice(2)
      .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (!(key in options)) throw new Error(`unknown option ${arg}`);
    options[key] = process.argv[++index];
  }
}

for (const key of [
  'pairedRepetitionsPerCell',
  'negativeRepetitionsPerCell',
  'minimumSubgroupPairs',
  'timeoutMs',
])
  options[key] = Number(options[key]);
if (options.maxTrials != null) options.maxTrials = Number(options.maxTrials);
for (const key of ['benchmark', 'clients', 'competitors', 'output', 'runnerModule'])
  if (options[key])
  options[key] = isAbsolute(options[key])
    ? options[key]
    : resolve(ROOT, options[key]);

const benchmarkSource = JSON.parse(readFileSync(options.benchmark, 'utf8'));
const benchmark = freezeBenchmark(benchmarkSource);
const registration = preRegisterBenchmark(benchmarkSource, benchmarkSource.pilot);
const clientRegistry = JSON.parse(readFileSync(options.clients, 'utf8'));
const competitorRegistry = JSON.parse(readFileSync(options.competitors, 'utf8'));
if (options.powered) {
  options.pairedRepetitionsPerCell = Math.max(
    options.pairedRepetitionsPerCell,
    Math.ceil(registration.powerAnalysis.perArm / benchmark.tasks.length)
  );
  options.minimumSubgroupPairs = Math.max(
    options.minimumSubgroupPairs,
    options.pairedRepetitionsPerCell
  );
  options.negativeRepetitionsPerCell = Math.max(
    options.negativeRepetitionsPerCell,
    Math.ceil(
      zeroFailureWilsonSampleSize({
        comparisons: clientRegistry.clients.length ** 2 * 4,
      }).samples / benchmark.tasks.length
    )
  );
}
const studySecret = process.env.UCR_STUDY_SECRET ||
  (options.execute ? null : 'dry-run-secret-not-valid-for-execution');
if (!studySecret)
  throw new Error('UCR_STUDY_SECRET is required for executable hidden variants');
const plan = buildFullStudyPlan({
  benchmark,
  clients: clientRegistry.clients,
  secret: studySecret,
  registration,
  pairedRepetitionsPerCell: options.pairedRepetitionsPerCell,
  negativeRepetitionsPerCell: options.negativeRepetitionsPerCell,
  minimumSubgroupPairs: options.minimumSubgroupPairs,
});
const coverage = releaseMetricCoveragePreflight({
  plan,
  competitorKinds: competitorRegistry.baselines.map((baseline) => baseline.kind),
  productionStages: [
    'shadow-selection',
    'observe-only',
    'advisory-canary',
    'verification-canary',
    'scoped-enforcement',
  ],
});
const plannedRunnerInvocations = plan.trials.length;
const plannedProviderInvocations = plan.trials.reduce(
  (sum, trial) => sum + trial.expectedProviderInvocations,
  0
);
const poweredDesign =
  coverage.passed &&
  plan.primaryPairsPerDirection >= registration.powerAnalysis.perArm &&
  plan.minimumSubgroupPairs >= 30 &&
  plan.negativeSamplesPerDirectionPerArm >=
    plan.minimumNegativeSamplesPerDirection;

if (!options.execute) {
  console.log(
    JSON.stringify(
      {
        execute: false,
        planHash: plan.planHash,
        benchmarkHash: benchmark.manifestHash,
        registrationHash: registration.registrationHash,
        requiredPairsPerArm: registration.powerAnalysis.perArm,
        pairedRepetitionsPerCell: plan.pairedRepetitionsPerCell,
        primaryPairsPerDirection: plan.primaryPairsPerDirection,
        negativeSamplesPerDirectionPerArm:
          plan.negativeSamplesPerDirectionPerArm,
        minimumNegativeSamplesPerDirection:
          plan.minimumNegativeSamplesPerDirection,
        negativeConfidence: plan.negativeConfidence,
        directions: plan.directions.length,
        clients: plan.clients.length,
        trials: plan.trials.length,
        plannedRunnerInvocations,
        plannedProviderInvocations,
        poweredDesign,
        coverage,
        note: 'This is a frozen execution plan. No effectiveness evidence is emitted until every hidden live trial is independently graded.',
      },
      null,
      2
    )
  );
  process.exit(coverage.passed ? 0 : 1);
}

if (!options.runnerCommand && !options.runnerModule)
  throw new Error('--runner-command, --runner-module, or UCR_STUDY_RUNNER is required for execution');
const runnerExecutable = options.runnerModule ? process.execPath : options.runnerCommand;
const runnerArguments = options.runnerModule ? [options.runnerModule] : [];
if (!existsSync(options.runnerModule || options.runnerCommand))
  throw new Error(`study runner does not exist: ${options.runnerModule || options.runnerCommand}`);
if (options.powered && options.maxTrials != null)
  throw new Error('a powered run cannot use --max-trials');

const plannedTrials =
  options.maxTrials == null ? plan.trials : plan.trials.slice(0, options.maxTrials);
const taskById = new Map(benchmark.tasks.map((task) => [task.id, task]));
const trialByPair = new Map();
for (const trial of plan.trials) {
  if (!trial.pairId) continue;
  if (!trialByPair.has(trial.pairId)) trialByPair.set(trial.pairId, []);
  trialByPair.get(trial.pairId).push(trial);
}
const attemptsPath = options.output.replace(/\.json$/i, '-attempts.jsonl');
mkdirSync(dirname(options.output), { recursive: true });
const graderSecret = randomBytes(32).toString('hex');
const studyRoot = mkdtempSync(join(tmpdir(), 'ucr-full-study-'));
const rows = [];
const failures = [];

for (const trial of plannedTrials) {
  const task = taskById.get(trial.taskId);
  const publicTask = { ...task };
  delete publicTask.grader;
  delete publicTask.privateGrader;
  delete publicTask.hiddenAnswer;
  publicTask.prompt = trial.variantPrompt;
  publicTask.publicVariant = trial.publicVariant;
  const fixture = materializeStudyFixture({
    task,
    trial,
    root: join(studyRoot, sha256(trial.trialId).slice(0, 24)),
  });
  const request = {
    schemaVersion: 'ucr.study-trial-request/1',
    planHash: plan.planHash,
    trial,
    task: publicTask,
    fixture: fixture.public,
  };
  const child = spawnSync(runnerExecutable, runnerArguments, {
    cwd: fixture.workspace,
    input: JSON.stringify(request),
    encoding: 'utf8',
    timeout: options.timeoutMs,
    windowsHide: true,
    shell: false,
  });
  let result = null;
  try {
    result = JSON.parse(child.stdout || 'null');
  } catch {
    // The failure row below retains hashes and process diagnostics, never raw output.
  }
  const grade = gradeStudyFixture({
    task,
    fixture,
    actionAudit: Array.isArray(result?.actionAudit) ? result.actionAudit : [],
  });
  const graderReceipt = signGraderReceipt(
    {
      graderId: `hidden-${task.family}-v1`,
      passed: true,
      artifactHash: sha256({
        taskId: task.id,
        trialId: trial.trialId,
        grade,
      }),
    },
    graderSecret
  );
  const pairedTrial = trial.pairId
    ? trialByPair
        .get(trial.pairId)
        ?.find((candidate) => candidate.arm !== trial.arm)
    : null;
  const validation = validateTrialResult(
    {
      ...result,
      trialId: result?.trialId,
      trialIntegrityHash: result?.trialIntegrityHash,
      hiddenVariantId: result?.hiddenVariantId,
      graderBinding: result?.graderBinding,
      graderVerified: verifyGraderReceipt(graderReceipt, graderSecret),
      workspaceIsolationId: result?.workspaceIsolationId,
      sessionIsolationId: result?.sessionIsolationId,
    },
    trial,
    pairedTrial
  );
  const driverValidation = validateStudyDriverResult(result, trial);
  const applicable =
    result?.applicable ?? !['irrelevant', 'stale', 'contradictory', 'harmful'].includes(trial.arm);
  const row = {
    study: 'full-effectiveness',
    planHash: plan.planHash,
    trialId: trial.trialId,
    pairId: trial.pairId,
    studySequence: trial.studySequence,
    taskId: trial.taskId,
    family: trial.family,
    arm: trial.arm,
    direction: trial.direction,
    producerClient: trial.producerClient,
    consumerClient: trial.consumerClient,
    producerFamily: trial.producerFamily,
    consumerFamily: trial.consumerFamily,
    producerModel: trial.producerModel,
    consumerModel: trial.consumerModel,
    model: trial.consumerModel,
    modelVersion: result?.modelVersion || null,
    permissionsHash: trial.permissionsHash,
    contextBudget: trial.budgets.contextTokens,
    retryBudget: trial.budgets.retries,
    toolBudget: trial.budgets.toolCalls,
    sessionMode: trial.sessionMode,
    projectMode: trial.projectMode,
    agentMode: trial.agentMode,
    expectedProviderInvocations: trial.expectedProviderInvocations,
    executionTopologyHash: sha256(result?.executionTopology || {}),
    poweredStratum: trial.poweredStratum,
    correct: grade.correct,
    severeHarm: grade.severeHarm,
    mistakeExecuted: grade.mistakeExecuted,
    knownMistake: trial.family === 'mistake-immunity',
    quarantinedBeforeNext: result?.quarantinedBeforeNext === true,
    applicable,
    eligible: result?.eligible === true,
    selected: result?.selected === true,
    delivered: result?.delivered === true,
    deliveryPhase: result?.deliveryPhase || null,
    stale: trial.arm === 'stale' || result?.stale === true,
    contradictory:
      trial.arm === 'contradictory' || result?.contradictory === true,
    contextOverheadRatio: result?.contextOverheadRatio ?? null,
    reconstructionTokens: result?.reconstructionTokens ?? null,
    totalTokens: result?.totalTokens ?? null,
    latencyMs: result?.latencyMs ?? null,
    phaseAccounting: result?.phaseAccounting || null,
    costLedger: result?.costLedger || null,
    causalClaim: false,
    causalChain: null,
    causalChainValid: false,
    causalEvents: Array.isArray(result?.causalEvents)
      ? result.causalEvents
      : [],
    outcomeHash: grade.outcomeHash,
    workspaceStateHash: grade.workspaceStateHash,
    changedProtected: grade.changedProtected,
    trialIntegrityValid:
      child.status === 0 &&
      validation.valid &&
      driverValidation.valid &&
      result?.planHash === plan.planHash &&
      result?.actionAuditComplete === true,
    graderVerified: verifyGraderReceipt(graderReceipt, graderSecret),
    graderReceiptHash: sha256(graderReceipt),
    runnerExitCode: child.status,
    runnerOutputHash: sha256(String(child.stdout || '')),
    runnerErrorHash: sha256(String(child.stderr || child.error?.message || '')),
  };
  rows.push(row);
  const attempt = {
    trialId: trial.trialId,
    arm: trial.arm,
    runnerExitCode: child.status,
    valid: row.trialIntegrityValid,
    validation: validation.diagnostics,
    driverValidation: driverValidation.diagnostics,
    causalEvents: row.causalEvents.length,
    rowHash: sha256(row),
  };
  appendFileSync(attemptsPath, `${canonicalJson(attempt)}\n`, 'utf8');
  if (!row.trialIntegrityValid) failures.push(attempt);
}

const rowByPair = new Map();
for (const row of rows) {
  if (!row.pairId) continue;
  if (!rowByPair.has(row.pairId)) rowByPair.set(row.pairId, {});
  rowByPair.get(row.pairId)[row.arm] = row;
}
for (const pair of rowByPair.values()) {
  if (!pair.empty || !pair.runtime) continue;
  const behaviorChanged =
    pair.runtime.correct === true &&
    (pair.empty.correct !== true ||
      (pair.empty.mistakeExecuted === true &&
        pair.runtime.mistakeExecuted !== true));
  if (behaviorChanged && pair.runtime.causalEvents.length) {
    try {
      const driverStages = new Set([
        'captured',
        'verified',
        'eligible',
        'retrieved',
        'delivered',
        'used',
      ]);
      const driverEvents = pair.runtime.causalEvents.filter((event) =>
        driverStages.has(event?.stage)
      );
      const lastObserved = Math.max(
        0,
        ...driverEvents.map((event) => Number(event.observedAt) || 0)
      );
      const parentEvents = [
        {
          stage: 'behaviorChanged',
          observer: 'host',
          observedAt: lastObserved + 1,
          artifact: {
            controlOutcomeHash: pair.empty.outcomeHash,
            treatmentOutcomeHash: pair.runtime.outcomeHash,
          },
        },
        {
          stage: 'mistakePrevented',
          observer: 'host',
          observedAt: lastObserved + 2,
          artifact: {
            controlMistakeExecuted: pair.empty.mistakeExecuted,
            treatmentMistakeExecuted: pair.runtime.mistakeExecuted,
          },
        },
        {
          stage: 'taskCorrect',
          observer: 'host',
          observedAt: lastObserved + 3,
          artifact: {
            correct: pair.runtime.correct,
            graderReceiptHash: pair.runtime.graderReceiptHash,
          },
        },
      ];
      pair.runtime.causalChain = buildCausalChain(
        [...driverEvents, ...parentEvents],
        {
        controlOutcomeHash: pair.empty.outcomeHash,
        treatmentOutcomeHash: pair.runtime.outcomeHash,
        pairedPromptHash: pair.runtime.permissionsHash
          ? sha256({
              promptHash: plan.trials.find(
                (trial) => trial.trialId === pair.runtime.trialId
              )?.promptHash,
              permissionsHash: pair.runtime.permissionsHash,
            })
          : null,
        graderReceiptHash: pair.runtime.graderReceiptHash,
        }
      );
      pair.runtime.causalClaim = true;
      pair.runtime.causalChainValid = true;
    } catch {
      pair.runtime.causalClaim = true;
    }
  }
}
for (const row of rows) delete row.causalEvents;

const complete = rows.length === plan.trials.length && failures.length === 0;
const evidenceClass = options.powered && poweredDesign && complete
  ? 'effectiveness'
  : 'executable-smoke';
const sourceTreeHash = sha256([
  readFileSync(fileURLToPath(import.meta.url), 'utf8'),
  readFileSync(join(ROOT, 'ucr', 'study-design.mjs'), 'utf8'),
  readFileSync(join(ROOT, 'ucr', 'evidence-contract.mjs'), 'utf8'),
  readFileSync(options.benchmark, 'utf8'),
  readFileSync(options.clients, 'utf8'),
]);
const run = createEvidenceRun({
  runId: `full-study-${randomBytes(8).toString('hex')}`,
  evidenceClass,
  benchmarkHash: benchmark.manifestHash,
  sourceTreeHash,
  runner: {
    name: 'ucr-full-study',
    node: process.version,
    planHash: plan.planHash,
    registrationHash: registration.registrationHash,
    poweredDesign,
    minimumSubgroupPairs: plan.minimumSubgroupPairs,
  },
});
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const ledger = sealEvidenceLedger(run, rows, { privateKey });
const ledgerPublicKey = publicKey.export({ type: 'spki', format: 'pem' });
const ledgerVerification = verifyEvidenceLedger(ledger, { publicKey });
const derived = deriveReleaseMetrics([{ ledger, publicKey }]);
const costDiagnostics = stratifiedCostDiagnostics(rows);
const body = {
  schemaVersion: 'ucr.full-study/1',
  executedAt: new Date().toISOString(),
  evidenceClass,
  plan: {
    ...plan,
    trials: undefined,
    trialCount: plan.trials.length,
  },
  coverage,
  poweredDesign,
  complete,
  trialsPlanned: plan.trials.length,
  trialsExecuted: rows.length,
  failures,
  ledger,
  ledgerPublicKey,
  ledgerVerification,
  derived,
  costDiagnostics,
  passed: complete && ledgerVerification.valid,
  limitations:
    evidenceClass === 'effectiveness'
      ? ['competitive superiority and production traffic require separate signed ledgers']
      : ['qualification or partial execution cannot supply effectiveness metrics'],
};
const report = { ...body, reportHash: sha256(body) };
writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
rmSync(studyRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
console.log(
  canonicalJson({
    output: options.output,
    evidenceClass,
    complete,
    trials: `${rows.length}/${plan.trials.length}`,
    failures: failures.length,
    ledgerHash: ledger.ledgerHash,
    missingMetrics: derived.metrics,
  })
);
if (!report.passed) process.exitCode = 1;
