#!/usr/bin/env node
/** Fair live-product comparison using a completed effectiveness trial set. */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PRODUCT_BASELINE_KINDS,
  REQUIRED_COMPETITIVE_BASELINES,
  bootstrapPaired,
  buildFullStudyPlan,
  canonicalJson,
  createEvidenceRun,
  freezeBenchmark,
  gradeStudyFixture,
  loadProvisionedEvidenceIdentity,
  materializeStudyFixture,
  paretoFront,
  preRegisterBenchmark,
  sealEvidenceLedger,
  sha256,
  validateCompetitiveEvidence,
  validateFairRun,
  verifyEvidenceLedger,
} from '../ucr/index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const options = {
  execute: false,
  effectivenessReport: join(
    ROOT,
    'evals',
    'ucr',
    'results',
    'full-study-v1.json'
  ),
  products: join(ROOT, 'evals', 'ucr', 'competitors-v1.json'),
  benchmark: join(ROOT, 'evals', 'ucr', 'benchmark-v1.json'),
  runnerCommand: process.env.UCR_COMPETITOR_RUNNER || null,
  repetitions: 2,
  timeoutMs: 600_000,
  output: join(ROOT, 'evals', 'ucr', 'results', 'competitive-study-v1.json'),
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
options.repetitions = Number(options.repetitions);
options.timeoutMs = Number(options.timeoutMs);
if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0)
  throw new Error('--timeout-ms must be a positive integer');
for (const key of ['effectivenessReport', 'products', 'benchmark', 'output'])
  options[key] = isAbsolute(options[key])
    ? options[key]
    : resolve(ROOT, options[key]);

const registry = JSON.parse(readFileSync(options.products, 'utf8'));
const baselines = registry.baselines || [];
const kinds = new Set(baselines.map((baseline) => baseline.kind));
const missingKinds = REQUIRED_COMPETITIVE_BASELINES.filter(
  (kind) => !kinds.has(kind)
);
const productReady = baselines
  .filter((baseline) => REQUIRED_COMPETITIVE_BASELINES.includes(baseline.kind))
  .every(
    (baseline) =>
      baseline.liveExecution === true &&
      baseline.version &&
      baseline.configuration &&
      (!PRODUCT_BASELINE_KINDS.includes(baseline.kind) ||
        baseline.namedProduct === true)
  );

if (!options.execute) {
  console.log(
    JSON.stringify(
      {
        execute: false,
        requiredBaselines: REQUIRED_COMPETITIVE_BASELINES,
        registeredBaselines: [...kinds],
        missingKinds,
        productReady,
        repetitions: options.repetitions,
        fairnessFields: [
          'model',
          'modelVersion',
          'taskId',
          'permissionsHash',
          'contextBudget',
          'retryBudget',
          'toolBudget',
        ],
        note: productReady
          ? 'Registry can execute a superiority study.'
          : 'Reference algorithms remain useful controls but cannot support a product-superiority claim.',
      },
      null,
      2
    )
  );
  process.exit(missingKinds.length ? 1 : 0);
}

if (!existsSync(options.effectivenessReport))
  throw new Error('a completed effectiveness report is required');
if (!options.runnerCommand || !existsSync(options.runnerCommand))
  throw new Error('UCR_COMPETITOR_RUNNER must identify an executable wrapper');
if (missingKinds.length)
  throw new Error(
    `competitive registry is missing: ${missingKinds.join(', ')}`
  );
if (!productReady)
  throw new Error('reference-only baselines cannot be promoted to superiority');
if (!Number.isInteger(options.repetitions) || options.repetitions < 2)
  throw new Error('competitive reproduction requires at least two repetitions');
if (!process.env.UCR_STUDY_SECRET)
  throw new Error(
    'UCR_STUDY_SECRET is required to reproduce the frozen hidden variants'
  );
const signingIdentity = loadProvisionedEvidenceIdentity();

const effectiveness = JSON.parse(
  readFileSync(options.effectivenessReport, 'utf8')
);
if (
  effectiveness.evidenceClass !== 'effectiveness' ||
  effectiveness.complete !== true ||
  effectiveness.ledgerKeyId !== signingIdentity.keyId ||
  !effectiveness.ledger?.run ||
  !verifyEvidenceLedger(effectiveness.ledger, {
    publicKey: signingIdentity.publicKey,
  }).valid
)
  throw new Error(
    'competitive execution requires complete signed effectiveness evidence'
  );
const benchmarkSource = JSON.parse(readFileSync(options.benchmark, 'utf8'));
const benchmark = freezeBenchmark(benchmarkSource);
if (benchmark.manifestHash !== effectiveness.ledger.run.benchmarkHash)
  throw new Error('effectiveness and competitive benchmark hashes differ');
const taskById = new Map(benchmark.tasks.map((task) => [task.id, task]));
const registration = preRegisterBenchmark(
  benchmarkSource,
  benchmarkSource.pilot
);
const reproducedPlan = buildFullStudyPlan({
  benchmark,
  clients: effectiveness.plan.clients,
  secret: process.env.UCR_STUDY_SECRET,
  registration,
  pairedRepetitionsPerCell: effectiveness.plan.pairedRepetitionsPerCell,
  negativeRepetitionsPerCell: effectiveness.plan.negativeRepetitionsPerCell,
  includeSameClient: effectiveness.plan.includeSameClient,
  budgets: effectiveness.plan.budgets,
  minimumSubgroupPairs: effectiveness.plan.minimumSubgroupPairs,
});
if (reproducedPlan.planHash !== effectiveness.plan.planHash)
  throw new Error(
    'hidden study plan cannot be reproduced from the frozen secret'
  );
const trialById = new Map(
  reproducedPlan.trials.map((trial) => [trial.trialId, trial])
);
const ucrRows = effectiveness.ledger.rows.filter(
  (row) => row.arm === 'runtime'
);
const raw = [];
const studyRoot = mkdtempSync(join(tmpdir(), 'ucr-competitive-study-'));

try {
  for (const baseline of baselines.filter((candidate) =>
    REQUIRED_COMPETITIVE_BASELINES.includes(candidate.kind)
  )) {
    for (const ucrRow of ucrRows) {
      const task = taskById.get(ucrRow.taskId);
      const plannedTrial = trialById.get(ucrRow.trialId);
      if (!task || !plannedTrial)
        throw new Error(`missing frozen task binding for ${ucrRow.trialId}`);
      const reference = {
        model: ucrRow.model,
        modelVersion: ucrRow.modelVersion,
        taskId: ucrRow.taskId,
        permissionsHash: ucrRow.permissionsHash,
        contextBudget: ucrRow.contextBudget,
        retryBudget: ucrRow.retryBudget,
        toolBudget: ucrRow.toolBudget,
      };
      for (let repetition = 0; repetition < options.repetitions; repetition++) {
        const fixture = materializeStudyFixture({
          task,
          trial: plannedTrial,
          root: join(
            studyRoot,
            sha256(`${baseline.kind}:${ucrRow.trialId}:${repetition}`).slice(
              0,
              24
            )
          ),
        });
        const publicTask = { ...task };
        delete publicTask.grader;
        delete publicTask.privateGrader;
        delete publicTask.hiddenAnswer;
        publicTask.prompt = plannedTrial.variantPrompt;
        publicTask.publicVariant = plannedTrial.publicVariant;
        const request = {
          schemaVersion: 'ucr.competitive-trial-request/1',
          baseline,
          reference,
          trial: {
            pairId: ucrRow.pairId,
            taskId: ucrRow.taskId,
            family: ucrRow.family,
            direction: ucrRow.direction,
            repetition,
          },
          task: publicTask,
          fixture: fixture.public,
        };
        const child = spawnSync(options.runnerCommand, [], {
          cwd: fixture.workspace,
          input: JSON.stringify(request),
          encoding: 'utf8',
          timeout: options.timeoutMs,
          maxBuffer: 64 * 1024 * 1024,
          windowsHide: true,
          shell: false,
        });
        let result = null;
        try {
          result = JSON.parse(child.stdout || 'null');
        } catch {
          // Invalid output is preserved as a hashed failed result below.
        }
        const grade = gradeStudyFixture({
          task,
          fixture,
          actionAudit: Array.isArray(result?.actionAudit)
            ? result.actionAudit
            : [],
        });
        const fairness = validateFairRun(result || {}, reference);
        raw.push({
          baselineKind: baseline.kind,
          baselineName: baseline.name,
          namedProduct: baseline.namedProduct === true,
          pairId: ucrRow.pairId,
          taskId: ucrRow.taskId,
          family: ucrRow.family,
          direction: ucrRow.direction,
          repetition,
          fair: fairness.fair,
          fairnessMismatches: fairness.mismatches,
          correct: grade.correct,
          severeHarm: grade.severeHarm,
          totalTokens: result?.totalTokens ?? null,
          latencyMs: result?.latencyMs ?? null,
          exitCode: child.status,
          liveExecution: result?.liveExecution === true,
          versionPinned: result?.version === baseline.version,
          configurationPublished:
            result?.configurationHash === sha256(baseline.configuration),
          independentGrade: grade.proseUsedAsOracle === false,
          changedProtected: grade.changedProtected,
          outputHash: sha256(String(child.stdout || '')),
          errorHash: sha256(String(child.stderr || child.error?.message || '')),
        });
        rmSync(fixture.workspace, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        });
      }
    }
  }
} finally {
  rmSync(studyRoot, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}

const summaryRows = [];
for (const baseline of baselines.filter((candidate) =>
  REQUIRED_COMPETITIVE_BASELINES.includes(candidate.kind)
)) {
  const runs = raw.filter((row) => row.baselineKind === baseline.kind);
  const primary = runs.filter((row) => row.repetition === 0);
  const repeated = new Map();
  for (const row of runs) {
    if (!repeated.has(row.pairId)) repeated.set(row.pairId, []);
    repeated.get(row.pairId).push(row);
  }
  const reproduced =
    repeated.size === ucrRows.length &&
    [...repeated.values()].every(
      (items) =>
        items.length === options.repetitions &&
        items.every(
          (item) =>
            item.exitCode === 0 &&
            item.correct === items[0].correct &&
            item.liveExecution &&
            item.independentGrade
        )
    );
  const paired = ucrRows.flatMap((ucrRow) => {
    const baselineRow = primary.find((row) => row.pairId === ucrRow.pairId);
    return baselineRow
      ? [
          {
            pairId: ucrRow.pairId,
            arm: baseline.kind,
            correct: baselineRow.correct,
          },
          { pairId: ucrRow.pairId, arm: 'runtime', correct: ucrRow.correct },
        ]
      : [];
  });
  const effect = bootstrapPaired(paired, 'correct', {
    control: baseline.kind,
    treatment: 'runtime',
    alpha: 0.05 / REQUIRED_COMPETITIVE_BASELINES.length,
    samples: 10000,
  });
  const average = (rows, path) => {
    const values = rows
      .map((row) =>
        typeof row[path] === 'boolean' ? Number(row[path]) : row[path]
      )
      .filter(Number.isFinite);
    return values.length
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : null;
  };
  const ucr = {
    name: 'UCR',
    correctness: average(ucrRows, 'correct'),
    harm: average(ucrRows, 'severeHarm'),
    tokens: average(ucrRows, 'totalTokens'),
    latencyMs: average(ucrRows, 'latencyMs'),
  };
  const comparison = {
    name: baseline.name,
    correctness: average(primary, 'correct'),
    harm: average(primary, 'severeHarm'),
    tokens: average(primary, 'totalTokens'),
    latencyMs: average(primary, 'latencyMs'),
  };
  const measurable = [ucr, comparison].every((entry) =>
    ['correctness', 'harm', 'tokens', 'latencyMs'].every((key) =>
      Number.isFinite(entry[key])
    )
  );
  const onFrontier = measurable && paretoFront([ucr, comparison]).includes(ucr);
  const row = {
    study: 'competitive',
    baselineKind: baseline.kind,
    baselineName: baseline.name,
    namedProduct: baseline.namedProduct === true,
    fair: runs.length > 0 && runs.every((run) => run.fair),
    reproduced,
    liveExecution: runs.length > 0 && runs.every((run) => run.liveExecution),
    versionPinned: runs.length > 0 && runs.every((run) => run.versionPinned),
    configurationPublished:
      runs.length > 0 && runs.every((run) => run.configurationPublished),
    ucrOnParetoFrontier: onFrontier,
    correctnessImprovement: measurable
      ? ucr.correctness - comparison.correctness
      : null,
    effectIntervalLow: effect.low,
    effectIntervalHigh: effect.high,
    pairs: effect.pairs,
    ucr,
    comparison,
  };
  row.validation = validateCompetitiveEvidence(row);
  summaryRows.push(row);
}

const sourceTreeHash = sha256([
  readFileSync(fileURLToPath(import.meta.url), 'utf8'),
  readFileSync(join(ROOT, 'ucr', 'study-fixtures.mjs'), 'utf8'),
  readFileSync(options.products, 'utf8'),
  effectiveness.reportHash,
]);
const run = createEvidenceRun({
  runId: `competitive-${randomBytes(8).toString('hex')}`,
  evidenceClass: 'superiority',
  benchmarkHash: benchmark.manifestHash,
  sourceTreeHash,
  runner: { name: 'ucr-live-competitive', node: process.version },
});
const ledger = sealEvidenceLedger(run, summaryRows, {
  privateKey: signingIdentity.privateKey,
});
const ledgerVerification = verifyEvidenceLedger(ledger, {
  publicKey: signingIdentity.publicKey,
});
const passed =
  summaryRows.length === REQUIRED_COMPETITIVE_BASELINES.length &&
  summaryRows.every((row) => row.validation.valid) &&
  ledgerVerification.valid;
const body = {
  schemaVersion: 'ucr.competitive-study/1',
  executedAt: new Date().toISOString(),
  sourceTreeHash,
  effectivenessLedgerHash: effectiveness.ledger.ledgerHash,
  rawRunHash: sha256(raw),
  summaries: summaryRows,
  ledger,
  ledgerKeyId: signingIdentity.keyId,
  ledgerVerification,
  passed,
};
const report = { ...body, reportHash: sha256(body) };
mkdirSync(dirname(options.output), { recursive: true });
writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(
  canonicalJson({
    output: options.output,
    baselines: summaryRows.length,
    passed,
    ledgerHash: ledger.ledgerHash,
  })
);
if (!passed) process.exitCode = 1;
