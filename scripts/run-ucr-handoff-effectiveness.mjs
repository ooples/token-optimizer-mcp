#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import {
  appendFileSync,
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
  canonicalJson,
  createEvidenceRun,
  deriveReleaseMetrics,
  freezeBenchmark,
  preRegisterBenchmark,
  releaseVerdict,
  sealEvidenceLedger,
  sha256,
  verifyEvidenceLedger,
} from '../ucr/index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const options = {
  execute: false,
  pairsPerDirection: 1,
  directions: 'codex->claude-code,claude-code->codex',
  output: join(
    ROOT,
    'evals',
    'ucr',
    'results',
    'handoff-effectiveness-pilot-v1.json'
  ),
};
for (let index = 2; index < process.argv.length; index++) {
  const argument = process.argv[index];
  if (argument === '--execute') options.execute = true;
  else if (argument.startsWith('--')) {
    const key = argument
      .slice(2)
      .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (!(key in options)) throw new Error(`unknown option ${argument}`);
    options[key] = process.argv[++index];
  }
}
options.pairsPerDirection = Number(options.pairsPerDirection);
options.output = isAbsolute(options.output)
  ? options.output
  : resolve(ROOT, options.output);
const directions = String(options.directions)
  .split(',')
  .map((direction) => direction.trim())
  .filter(Boolean);
if (
  !Number.isInteger(options.pairsPerDirection) ||
  options.pairsPerDirection < 1 ||
  directions.some((direction) => direction.split('->').length !== 2)
) {
  throw new Error('invalid pairs-per-direction or direction syntax');
}

const benchmarkSource = JSON.parse(
  readFileSync(join(ROOT, 'evals', 'ucr', 'benchmark-v1.json'), 'utf8')
);
const benchmark = freezeBenchmark(benchmarkSource);
const registration = preRegisterBenchmark(
  benchmarkSource,
  benchmarkSource.pilot
);
const requiredPerArm = registration.powerAnalysis.perArm;
const poweredDesign =
  directions.length >= 2 && options.pairsPerDirection >= requiredPerArm;
const plannedInvocations = directions.length * options.pairsPerDirection * 4;
if (!options.execute) {
  console.log(
    JSON.stringify(
      {
        execute: false,
        directions,
        pairsPerDirection: options.pairsPerDirection,
        requiredPerArm,
        poweredDesign,
        plannedInvocations,
        note: poweredDesign
          ? 'Completion may produce effectiveness-tier cross-client evidence.'
          : 'This is a pilot and remains executable-smoke evidence.',
      },
      null,
      2
    )
  );
  process.exit(0);
}

function totalTokens(usage) {
  if (Number.isFinite(usage?.totalTokens)) return usage.totalTokens;
  const values = [usage?.inputTokens, usage?.outputTokens].filter(
    Number.isFinite
  );
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
}

const temporary = mkdtempSync(join(tmpdir(), 'ucr-handoff-effectiveness-'));
const attemptsPath = join(
  dirname(options.output),
  'handoff-effectiveness-attempts.jsonl'
);
const rows = [];
const attempts = [];
mkdirSync(dirname(options.output), { recursive: true });
try {
  for (const direction of directions) {
    for (
      let repetition = 0;
      repetition < options.pairsPerDirection;
      repetition++
    ) {
      const childOutput = join(
        temporary,
        `${direction.replace('->', '-to-')}-${repetition}.json`
      );
      console.log(
        `[${attempts.length + 1}/${directions.length * options.pairsPerDirection}] ${direction}`
      );
      const child = spawnSync(
        process.execPath,
        [
          join(ROOT, 'scripts', 'run-ucr-multimodel-handoff.mjs'),
          '--execute',
          '--direction',
          direction,
          '--output',
          childOutput,
        ],
        {
          cwd: ROOT,
          encoding: 'utf8',
          timeout: 30 * 60 * 1000,
          windowsHide: true,
        }
      );
      const report = existsSync(childOutput)
        ? JSON.parse(readFileSync(childOutput, 'utf8'))
        : null;
      const result = report?.directionResults?.[0] || null;
      const attempt = {
        direction,
        repetition,
        exitCode: child.status,
        reportHash: report?.reportHash || null,
        passed: result?.passed === true,
        taskHash: result?.taskHash || null,
        grades: result
          ? {
              controlExitCode: result.control.exitCode,
              controlAbstained: result.control.abstained,
              producerExitCode: result.producer.exitCode,
              producerRecorded: result.producer.recorded,
              runtimeExitCode: result.runtime.exitCode,
              runtimeDelivered: result.runtime.delivered,
              runtimeCorrect: result.runtime.correct,
              mistakeExecuted: result.runtime.mistakeExecuted,
            }
          : null,
      };
      attempt.attemptHash = sha256(attempt);
      attempts.push(attempt);
      appendFileSync(attemptsPath, `${canonicalJson(attempt)}\n`, 'utf8');
      if (!result) continue;
      const pairId = `${direction}:${repetition}:${result.taskHash}`;
      const baselineTokens = totalTokens(
        result.control.pipelineUsage || result.control.usage
      );
      const runtimeTokens = totalTokens(
        result.runtime.pipelineUsage || result.runtime.usage
      );
      const captureTokens =
        result.runtime.firstSuccessorCost?.captureTokens ?? null;
      const firstSuccessorTokens = runtimeTokens;
      const firstSuccessorLatencyMs =
        result.runtime.costLedger?.totals?.latencyMs ??
        result.runtime.latencyMs + (result.runtime.preflightLatencyMs || 0);
      const common = {
        study: 'cross-client-handoff',
        pairId,
        taskId: result.taskHash,
        producerClient: result.producerClient,
        consumerClient: result.consumerClient,
        producerFamily: result.producerFamily,
        consumerFamily: result.consumerFamily,
        producerModel: result.producerModel,
        consumerModel: result.consumerModel,
        severeHarm: false,
        quarantinedBeforeNext: true,
      };
      rows.push(
        {
          ...common,
          arm: 'empty',
          correct: result.control.correct,
          mistakeExecuted: result.control.mistakeExecuted,
          delivered: false,
          eligible: false,
          selected: false,
          applicable: null,
          inputTokens:
            result.control.pipelineUsage?.inputTokens ??
            result.control.usage.inputTokens,
          outputTokens:
            result.control.pipelineUsage?.outputTokens ??
            result.control.usage.outputTokens,
          totalTokens: baselineTokens,
          latencyMs:
            result.control.costLedger?.totals?.latencyMs ??
            result.control.latencyMs,
        },
        {
          ...common,
          arm: 'runtime',
          correct: result.runtime.correct,
          mistakeExecuted: result.runtime.mistakeExecuted,
          delivered: result.runtime.delivered,
          deliveryPhase: 'pre-action',
          eligible: true,
          selected: result.runtime.delivered,
          applicable: true,
          stale: false,
          contradictory: false,
          contextOverheadRatio:
            baselineTokens && firstSuccessorTokens !== null
              ? (firstSuccessorTokens - baselineTokens) / baselineTokens
              : null,
          inputTokens:
            result.runtime.pipelineUsage?.inputTokens ??
            result.runtime.usage.inputTokens,
          outputTokens:
            result.runtime.pipelineUsage?.outputTokens ??
            result.runtime.usage.outputTokens,
          totalTokens: firstSuccessorTokens,
          latencyMs: firstSuccessorLatencyMs,
          phaseAccounting: {
            captureTokens,
            staticSchemaTokens: result.runtime.usage.staticSchemaTokens,
            capsuleTokens: result.runtime.usage.capsuleTokens,
            instructionTokens: result.runtime.usage.instructionTokens,
            consumerInputTokens: result.runtime.usage.inputTokens,
            consumerOutputTokens: result.runtime.usage.outputTokens,
            captureModelCalls:
              result.runtime.firstSuccessorCost?.additionalModelCalls,
            retrievalLatencyMs: result.runtime.preflightLatencyMs,
            captureHostLatencyMs:
              result.runtime.firstSuccessorCost?.hostCaptureLatencyMs,
            consumerLatencyMs: result.runtime.latencyMs,
            ledgerHash: result.runtime.costLedger?.ledgerHash,
            attributionComplete:
              result.runtime.costLedger?.attributionComplete === true,
          },
        }
      );
    }
  }

  const completedByDirection = Object.fromEntries(
    directions.map((direction) => [
      direction,
      attempts.filter(
        (attempt) => attempt.direction === direction && attempt.passed
      ).length,
    ])
  );
  const poweredCompleted =
    poweredDesign &&
    Object.values(completedByDirection).every(
      (count) => count >= requiredPerArm
    );
  const evidenceClass = poweredCompleted ? 'effectiveness' : 'executable-smoke';
  const sourceTreeHash = sha256([
    readFileSync(
      join(ROOT, 'scripts', 'run-ucr-multimodel-handoff.mjs'),
      'utf8'
    ),
    readFileSync(fileURLToPath(import.meta.url), 'utf8'),
    readFileSync(join(ROOT, 'src', 'server', 'ucr-tools.ts'), 'utf8'),
  ]);
  const run = createEvidenceRun({
    runId: `handoff-effectiveness-${randomBytes(8).toString('hex')}`,
    evidenceClass,
    benchmarkHash: benchmark.manifestHash,
    sourceTreeHash,
    runner: {
      name: 'ucr-handoff-effectiveness',
      registrationHash: registration.registrationHash,
      plannedInvocations,
    },
  });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const ledger = sealEvidenceLedger(run, rows, { privateKey });
  const ledgerPublicKey = publicKey.export({ type: 'spki', format: 'pem' });
  const ledgerVerification = verifyEvidenceLedger(ledger, { publicKey });
  const derived = deriveReleaseMetrics([{ ledger, publicKey }]);
  const verdict = releaseVerdict(derived.metrics);
  const body = {
    schemaVersion: 'ucr.handoff-effectiveness/1',
    evidenceClass,
    executedAt: new Date().toISOString(),
    benchmarkHash: benchmark.manifestHash,
    registration,
    directions,
    pairsPerDirection: options.pairsPerDirection,
    requiredPerArm,
    poweredDesign,
    poweredCompleted,
    plannedInvocations,
    completedByDirection,
    attempts: attempts.length,
    attemptsPassed: attempts.filter((attempt) => attempt.passed).length,
    ledger,
    ledgerPublicKey,
    ledgerVerification,
    derived,
    verdict,
    passed:
      attempts.length === directions.length * options.pairsPerDirection &&
      attempts.every((attempt) => attempt.passed) &&
      ledgerVerification.valid,
    limitations: poweredCompleted
      ? [
          'this estimates cross-client handoff, not every benchmark family',
          'superiority and production require separate evidence tiers',
        ]
      : [
          `pilot is below the preregistered ${requiredPerArm} pairs per arm`,
          'pilot rows remain executable-smoke and cannot supply effectiveness metrics',
          'superiority and production require separate evidence tiers',
        ],
  };
  const report = { ...body, reportHash: sha256(body) };
  writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(
    canonicalJson({
      output: options.output,
      evidenceClass,
      poweredCompleted,
      passed: report.passed,
      completedByDirection,
      ledgerHash: ledger.ledgerHash,
      verdict: verdict.status,
    })
  );
  if (!report.passed) process.exitCode = 1;
} finally {
  rmSync(temporary, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
