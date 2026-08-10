#!/usr/bin/env node

import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compoundingMetrics,
  compoundingSchedule,
  createCurriculum,
  createEvidenceRun,
  executeReferenceCompetition,
  freezeBenchmark,
  leaveOneMemoryOut,
  preRegisterBenchmark,
  sealEvidenceLedger,
  sha256,
  verifyEvidenceLedger,
} from '../ucr/index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const write = process.argv.includes('--write');
const source = JSON.parse(
  readFileSync(join(ROOT, 'evals', 'ucr', 'benchmark-v1.json'), 'utf8')
);
const benchmark = freezeBenchmark(source);
const registration = preRegisterBenchmark(source, source.pilot);
const curriculum = createCurriculum({ tasks: 100, seed: source.seed });
const schedule = compoundingSchedule(curriculum, {
  models: ['openai-frontier-fixture', 'anthropic-frontier-fixture', 'google-frontier-fixture'],
  clients: ['codex', 'claude-code', 'gemini'],
  machines: ['machine-a', 'machine-b'],
  arms: source.arms,
});
const taskById = new Map(curriculum.map((task, sequence) => [task.id, { ...task, sequence }]));
const seenByRuntime = new Set();
const rows = schedule.map((scheduled) => {
  const task = taskById.get(scheduled.taskId);
  const learned = seenByRuntime.has(task.gotchaId);
  let correct = true;
  let mistakeExecuted = false;
  let severeHarm = false;
  let reconstructionTokens = 800;
  if (scheduled.arm === 'empty') mistakeExecuted = true;
  else if (scheduled.arm === 'runtime') {
    mistakeExecuted = !learned;
    reconstructionTokens = 280;
    seenByRuntime.add(task.gotchaId);
  } else if (scheduled.arm === 'oracle') reconstructionTokens = 200;
  else if (scheduled.arm === 'stale') {
    mistakeExecuted = task.repositoryVersion > 1;
    correct = !mistakeExecuted;
  } else if (scheduled.arm === 'irrelevant') reconstructionTokens = 900;
  else if (scheduled.arm === 'contradictory') {
    mistakeExecuted = task.sequence % 2 === 0;
    correct = !mistakeExecuted;
  } else if (scheduled.arm === 'harmful') {
    severeHarm = task.sequence % 10 === 0;
    mistakeExecuted = true;
    correct = false;
  }
  return {
    study: 'deterministic-compounding-policy-fixture',
    taskId: task.id,
    pairId: task.id,
    sequence: task.sequence,
    arm: scheduled.arm,
    model: scheduled.model,
    client: scheduled.client,
    machine: scheduled.machine,
    correct,
    firstPass: correct && !mistakeExecuted && !severeHarm,
    mistakeExecuted,
    severeHarm,
    reconstructionTokens,
    quarantinedBeforeNext: scheduled.arm === 'harmful' && severeHarm,
    memoryIds: scheduled.arm === 'runtime' ? [`memory:${task.gotchaId}`] : [],
    deterministicFixture: true,
    liveModelInvocation: false,
  };
});
const metrics = compoundingMetrics(rows);
const ablationRows = Array.from({ length: 12 }, (_, memoryIndex) =>
  Array.from({ length: 6 }, (_, pairIndex) => [
    {
      pairId: `ablation-${memoryIndex}-${pairIndex}`,
      variant: 'included',
      memoryIds: [`memory:gotcha-${memoryIndex}`],
      correct: true,
    },
    {
      pairId: `ablation-${memoryIndex}-${pairIndex}`,
      variant: 'ablated',
      ablatedMemoryId: `memory:gotcha-${memoryIndex}`,
      correct: false,
    },
  ]).flat()
).flat();
const ablations = leaveOneMemoryOut(
  ablationRows,
  Array.from({ length: 12 }, (_, index) => `memory:gotcha-${index}`)
);

const referenceTasks = curriculum.map((task, sequence) => ({
  id: task.id,
  targetMemoryId: `memory:${task.gotchaId}`,
  embedding: [1, sequence % 3, 0],
  seedIds: [`memory:${task.gotchaId}`],
  tags: [task.gotchaId],
  at: sequence,
  limit: 3,
  memories: [
    {
      id: `memory:${task.gotchaId}`,
      type: 'procedure',
      tags: [task.gotchaId],
      embedding: [1, sequence % 3, 0],
      state: 'active',
      utility: 1,
      learnedAt: sequence,
      staticInstruction: sequence % 4 === 0,
      payload: 'verified target procedure',
    },
    {
      id: `noise:${task.id}`,
      type: 'claim',
      tags: ['unrelated'],
      embedding: [0, 0, 1],
      state: 'active',
      learnedAt: sequence - 1,
      payload: 'irrelevant memory',
    },
  ],
  edges: [],
}));
const referenceRows = executeReferenceCompetition(referenceTasks);
const sourceTreeHash = sha256([
  readFileSync(join(ROOT, 'ucr', 'compounding.mjs'), 'utf8'),
  readFileSync(join(ROOT, 'ucr', 'competitors.mjs'), 'utf8'),
  readFileSync(join(ROOT, 'ucr', 'evidence-contract.mjs'), 'utf8'),
]);
const run = createEvidenceRun({
  runId: 'deterministic-compounding-v1',
  evidenceClass: 'conformance',
  benchmarkHash: benchmark.manifestHash,
  sourceTreeHash,
  runner: {
    name: 'deterministic-policy-fixture',
    version: '1',
    liveModelInvocation: false,
  },
  startedAt: '2026-08-09T00:00:00.000Z',
});
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const ledger = sealEvidenceLedger(run, rows, {
  privateKey,
  endedAt: '2026-08-09T00:10:00.000Z',
});
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
const ledgerVerification = verifyEvidenceLedger(ledger, { publicKey });
const referenceSummary = Object.fromEntries(
  [...new Set(referenceRows.map((row) => row.kind))].map((kind) => {
    const selected = referenceRows.filter((row) => row.kind === kind);
    return [
      kind,
      {
        runs: selected.length,
        correctness:
          selected.filter((row) => row.correct).length / selected.length,
        meanTokens:
          selected.reduce((sum, row) => sum + row.tokens, 0) / selected.length,
        productClaimAllowed: false,
      },
    ];
  })
);
const body = {
  schemaVersion: 'ucr.compounding-study/1',
  evidenceClass: 'deterministic-policy-conformance-not-live-model-effectiveness',
  benchmark: {
    manifestHash: benchmark.manifestHash,
    registration,
    naturalTaskFixtures: registration.naturalTaskFixtures,
  },
  schedule: {
    tasks: curriculum.length,
    armRuns: schedule.length,
    modelLabels: new Set(schedule.map((row) => row.model)).size,
    clients: new Set(schedule.map((row) => row.client)).size,
    machines: new Set(schedule.map((row) => row.machine)).size,
    labelsAreFixturesNotInvocations: true,
  },
  metrics,
  ablations,
  referenceCompetition: {
    runs: referenceRows.length,
    baselines: Object.keys(referenceSummary).length,
    summary: referenceSummary,
    productClaimsAllowed: false,
  },
  ledger,
  ledgerPublicKey: publicKeyPem,
  ledgerVerification,
  sourceTreeHash,
  passed:
    schedule.length === 700 &&
    referenceRows.length === 1000 &&
    metrics.recurrenceReduction >= 0.8 &&
    metrics.reconstructionTokenReduction >= 0.5 &&
    ledgerVerification.valid,
  executedAt: new Date().toISOString(),
};
const report = { ...body, reportHash: sha256(body) };
if (write) {
  const output = join(
    ROOT,
    'evals',
    'ucr',
    'results',
    'compounding-study-v1.json'
  );
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(output);
}
console.log(
  JSON.stringify(
    {
      outputHash: report.reportHash,
      passed: report.passed,
      schedule: report.schedule,
      metrics: report.metrics,
      referenceCompetition: report.referenceCompetition,
      ledger: {
        rows: ledger.rowCount,
        ledgerHash: ledger.ledgerHash,
        valid: ledgerVerification.valid,
      },
    },
    null,
    2
  )
);
if (!report.passed) process.exitCode = 1;
