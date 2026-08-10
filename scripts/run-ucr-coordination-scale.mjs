#!/usr/bin/env node

import { Worker } from 'node:worker_threads';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteCoordinationStore, sha256 } from '../ucr/index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const workerPath = join(ROOT, 'scripts', 'ucr-coordination-worker.mjs');
const options = { writers: 100, workers: 100, write: false };
for (let index = 2; index < process.argv.length; index++) {
  const arg = process.argv[index];
  if (arg === '--write') options.write = true;
  else if (arg === '--writers') options.writers = Number(process.argv[++index]);
  else if (arg === '--workers') options.workers = Number(process.argv[++index]);
  else throw new Error(`unknown option ${arg}`);
}
if (options.workers < 1 || options.writers < 1 || options.workers > options.writers)
  throw new Error('workers and writers must be positive, with workers <= writers');

const temporary = mkdtempSync(join(tmpdir(), 'ucr-coordination-scale-'));
const databasePath = join(temporary, 'coordination.sqlite');
const setup = new SqliteCoordinationStore(databasePath, { leaseMs: 30_000 });
for (let index = 0; index < options.writers; index++) {
  setup.defineTask({
    id: `task-${index}`,
    goal: `goal-${index}`,
    artifacts: [`artifact-${index}`],
    plannedActions: ['execute'],
  });
}
let duplicateSuppressed = 0;
for (let index = 0; index < options.writers; index++) {
  const result = setup.defineTask({
    id: `duplicate-${index}`,
    goal: `goal-${index}`,
    artifacts: [`artifact-${index}`],
    plannedActions: ['execute'],
  });
  if (!result.defined) duplicateSuppressed += 1;
}
setup.close();

const claims = Array.from({ length: options.writers }, (_, index) => ({
  taskId: `task-${index}`,
  agentId: `agent-${index}`,
  now: 1_710_000_000_000 + index,
}));
const buckets = Array.from({ length: options.workers }, () => []);
claims.forEach((claim, index) => buckets[index % buckets.length].push(claim));
const started = performance.now();
try {
  const messages = await Promise.all(
    buckets.map(
      (bucket) =>
        new Promise((resolvePromise, reject) => {
          let message = null;
          const worker = new Worker(workerPath, {
            workerData: {
              databasePath,
              leaseMs: 30_000,
              claims: bucket,
            },
          });
          worker.once('message', (value) => {
            message = value;
          });
          worker.once('error', reject);
          worker.once('exit', (code) => {
            if (code !== 0) reject(new Error(`coordination worker exited ${code}`));
            else if (!message) reject(new Error('coordination worker returned no result'));
            else resolvePromise(message);
          });
        })
    )
  );
  const elapsedMs = performance.now() - started;
  const results = messages.flatMap((message) => message.results);
  const store = new SqliteCoordinationStore(databasePath);
  const snapshot = store.snapshot();
  store.close();
  const reopened = new SqliteCoordinationStore(databasePath);
  const replayDigest = reopened.snapshot().digest;
  reopened.close();
  const body = {
    schemaVersion: 'ucr.coordination-scale/1',
    evidenceClass: 'conformance-concurrent-not-model-effectiveness',
    writers: options.writers,
    physicalWorkers: options.workers,
    claimsAccepted: results.filter((result) => result.claimed).length,
    claimsRejected: results.filter((result) => !result.claimed).length,
    leases: snapshot.leases.length,
    acceptedEvents: snapshot.events.length,
    lostAcceptedEvents: snapshot.digest === replayDigest ? 0 : snapshot.events.length,
    duplicateIntents: options.writers,
    duplicateSuppressed,
    duplicateSuppressionRate: duplicateSuppressed / options.writers,
    deterministicReopen: snapshot.digest === replayDigest,
    elapsedMs,
    sourceHash: sha256([
      readFileSync(join(ROOT, 'ucr', 'coordination-sqlite.mjs'), 'utf8'),
      readFileSync(workerPath, 'utf8'),
    ]),
  };
  const report = {
    ...body,
    passed:
      body.claimsAccepted === options.writers &&
      body.claimsRejected === 0 &&
      body.leases === options.writers &&
      body.acceptedEvents === options.writers &&
      body.lostAcceptedEvents === 0 &&
      body.duplicateSuppressionRate >= 0.8,
    executedAt: new Date().toISOString(),
  };
  report.reportHash = sha256(report);
  if (options.write) {
    const output = join(
      ROOT,
      'evals',
      'ucr',
      'results',
      'coordination-scale-v1.json'
    );
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(output);
  }
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
} finally {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  try {
    rmSync(temporary, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
  } catch (error) {
    console.warn(`temporary coordination database cleanup deferred: ${error.message}`);
  }
}
