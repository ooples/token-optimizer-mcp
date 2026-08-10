#!/usr/bin/env node

import { performance } from 'node:perf_hooks';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import {
  appendFileSync,
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
  CircuitBreaker,
  EventStore,
  HybridLogicalClock,
  REQUIRED_FAULTS,
  RolloutController,
  canonicalJson,
  createEvent,
  createEvidenceRun,
  faultInjectionStudy,
  productionReadiness,
  reconcileCoordinationPartitions,
  recoveryExercise,
  releaseVerdict,
  sealEvidenceLedger,
  sha256,
  sloReport,
  verifyEvidenceLedger,
} from '../ucr/index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const outputArg = process.argv.includes('--output')
  ? process.argv[process.argv.indexOf('--output') + 1]
  : join(ROOT, 'evals', 'ucr', 'results', 'production-exercise-v1.json');
const output = isAbsolute(outputArg) ? outputArg : resolve(ROOT, outputArg);
const temporary = mkdtempSync(join(tmpdir(), 'ucr-production-exercise-'));

function fixtureEvent(sequence) {
  return createEvent({
    type: 'task.observed',
    payload: { sequence },
    traceId: 'production-exercise',
    writer: { id: 'exercise-writer', sequence },
    actor: {
      agentId: 'exercise-agent',
      client: 'conformance-harness',
      capabilityTier: 'connected',
    },
    scope: {
      sessionId: 'production-exercise',
      projectId: 'production-exercise',
      workspaceId: 'production-exercise',
    },
    clock: new HybridLogicalClock('exercise-writer'),
    wallMs: 1710000000000 + sequence,
  });
}

function receipt(fault, contained, detail, recoveryTimeMs = 0, dataLoss = 0) {
  return { fault, contained, detail, recoveryTimeMs, dataLoss };
}

try {
  const receipts = [];

  const breaker = new CircuitBreaker({ failures: 3, resetMs: 10 });
  breaker.record(false, 100);
  breaker.record(false, 101);
  breaker.record(false, 102);
  receipts.push(
    receipt(
      'dependency-timeout',
      !breaker.allow(105) && breaker.allow(113),
      'circuit opened after three failures and reset after the bounded interval',
      11
    )
  );

  const eventRoot = join(temporary, 'event-store');
  const store = new EventStore(eventRoot);
  const accepted = [fixtureEvent(0), fixtureEvent(1)];
  for (const event of accepted) store.append(event);
  const digestBeforeRestart = store.digest();
  appendFileSync(store.path, '{malformed-event\n', 'utf8');
  const corruptedRead = store.read();
  receipts.push(
    receipt(
      'malformed-event',
      corruptedRead.events.length === accepted.length &&
        corruptedRead.malformed.length === 1,
      'malformed JSONL was quarantined while accepted canonical events replayed',
      1,
      accepted.length - corruptedRead.events.length
    )
  );

  const controller = new RolloutController({ stage: 'advisory-canary' });
  const safeMode = controller.safeMode({ readOnly: true, disconnected: true });
  receipts.push(
    receipt(
      'storage-unavailable',
      safeMode.readOnly && safeMode.disconnected && !safeMode.guardsEnforced,
      'runtime entered disconnected read-only mode with enforcement disabled',
      1
    )
  );
  const rollback = controller.observe(
    {
      correctnessDelta: -0.1,
      severeHarm: 0,
      p95LatencyMs: 10,
      p95ContextOverhead: 0.01,
      availability: 1,
      unauthorizedAccess: 0,
    },
    { projectId: 'fault-project' }
  );
  receipts.push(
    receipt(
      'canary-regression',
      rollback.rolledBack &&
        !controller.enabled({ projectId: 'fault-project' }),
      'correctness regression rolled the stage back and activated a scoped kill switch',
      1
    )
  );

  const reopened = new EventStore(eventRoot);
  const restored = reopened.read().events;
  const recovery = recoveryExercise({
    acceptedEvents: accepted.map((event) => event.eventId),
    restoredEvents: restored.map((event) => event.eventId),
    startedAt: 0,
    recoveredAt: 2,
  });
  receipts.push(
    receipt(
      'process-restart',
      recovery.passed && reopened.digest() === digestBeforeRestart,
      'fresh store instance reconstructed the accepted canonical event digest',
      recovery.recoveryTimeMs,
      recovery.recoveryPointEvents
    )
  );

  const partitioned = reconcileCoordinationPartitions([
    {
      events: [
        {
          eventId: 'partition-a',
          type: 'coordination.claimed',
          taskId: 'shared-task',
          agentId: 'agent-a',
          at: 1,
        },
      ],
    },
    {
      events: [
        {
          eventId: 'partition-b',
          type: 'coordination.claimed',
          taskId: 'shared-task',
          agentId: 'agent-b',
          at: 2,
        },
      ],
    },
  ]);
  receipts.push(
    receipt(
      'network-partition',
      partitioned.conflicts.length === 1,
      'split ownership reconciled to an explicit conflict instead of silent overwrite',
      1
    )
  );

  const faults = faultInjectionStudy(receipts);
  const latencySamples = Array.from({ length: 1000 }, () => {
    const started = performance.now();
    controller.enabled({ projectId: 'unaffected-project' });
    return {
      available: true,
      latencyMs: performance.now() - started,
      contextOverhead: 0,
      correctnessDelta: 0,
      severeHarm: 0,
      unauthorizedAccess: 0,
    };
  });
  const slos = sloReport(latencySamples);
  const release = releaseVerdict({});
  const readiness = productionReadiness({
    release,
    evidenceClasses: ['executable-smoke'],
    slos,
    faults,
    recovery,
    rolloutStage: controller.stage,
  });

  const sourceTreeHash = sha256([
    readFileSync(join(ROOT, 'ucr', 'rollout.mjs'), 'utf8'),
    readFileSync(fileURLToPath(import.meta.url), 'utf8'),
  ]);
  const run = createEvidenceRun({
    runId: `production-exercise-${randomBytes(8).toString('hex')}`,
    evidenceClass: 'executable-smoke',
    benchmarkHash: sha256(REQUIRED_FAULTS),
    sourceTreeHash,
    runner: { name: 'ucr-production-exercise', node: process.version },
  });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const ledger = sealEvidenceLedger(run, receipts, { privateKey });
  const ledgerPublicKey = publicKey.export({ type: 'spki', format: 'pem' });
  const ledgerVerification = verifyEvidenceLedger(ledger, { publicKey });
  const body = {
    schemaVersion: 'ucr.production-exercise/1',
    evidenceClass:
      'executable-fault-and-slo-mechanism-exercise-not-production-traffic',
    executedAt: new Date().toISOString(),
    sourceTreeHash,
    faults,
    faultReceipts: receipts,
    slos,
    recovery,
    readiness,
    release,
    ledger,
    ledgerPublicKey,
    ledgerVerification,
    passed:
      faults.passed &&
      slos.passed &&
      recovery.passed &&
      ledgerVerification.valid,
    limitations: [
      'local executable fault injection is not production traffic evidence',
      'the SLO window measures gate mechanics and local control-path latency, not provider latency',
      'production readiness intentionally remains insufficient until powered effectiveness and staged production evidence exist',
    ],
  };
  const report = { ...body, reportHash: sha256(body) };
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(
    canonicalJson({
      output,
      passed: report.passed,
      faults: `${faults.exercised}/${faults.required.length}`,
      p95ControlLatencyMs: slos.metrics.p95LatencyMs,
      recoveryPointEvents: recovery.recoveryPointEvents,
      readiness: readiness.status,
      ledgerHash: ledger.ledgerHash,
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
