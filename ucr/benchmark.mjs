import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson, sha256 } from './protocol.mjs';

export const BENCHMARK_FAMILIES = Object.freeze([
  'factual-temporal',
  'knowledge-update',
  'abstention',
  'workflow',
  'mistake-immunity',
  'checkpoint-takeover',
  'cross-model-handoff',
  'concurrent-coordination',
  'cross-project-generalization',
  'adversarial-memory',
  'long-horizon-compounding',
]);

export const BENCHMARK_ARMS = Object.freeze([
  'empty',
  'runtime',
  'oracle',
  'stale',
  'irrelevant',
  'contradictory',
  'harmful',
]);

function graderReceiptBody(receipt) {
  const { signature, ...body } = receipt || {};
  return body;
}

/** Sign a deterministic-grader receipt outside the model process. */
export function signGraderReceipt(receipt, secret) {
  if (!secret) throw new Error('grader receipt signing requires a secret');
  const body = graderReceiptBody(receipt);
  if (body.passed !== true || !body.graderId || !body.artifactHash) {
    throw new Error(
      'grader receipts require passed=true, graderId, and artifactHash'
    );
  }
  return {
    ...body,
    signature: createHmac('sha256', secret)
      .update(canonicalJson(body))
      .digest('hex'),
  };
}

export function verifyGraderReceipt(receipt, secret) {
  if (!secret || !receipt?.signature) return false;
  let expected;
  try {
    expected = signGraderReceipt(graderReceiptBody(receipt), secret).signature;
  } catch {
    return false;
  }
  const actualBuffer = Buffer.from(String(receipt.signature));
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

export function freezeBenchmark(manifest) {
  const frozen = {
    schemaVersion: 'ucr.benchmark/1',
    ...manifest,
    tasks: [...(manifest.tasks || [])].sort((a, b) => a.id.localeCompare(b.id)),
    arms: manifest.arms || BENCHMARK_ARMS,
    primaryOutcomes: manifest.primaryOutcomes || [
      'correct',
      'severeHarm',
      'mistakeExecuted',
    ],
    exclusions: manifest.exclusions || [],
  };
  return { ...frozen, manifestHash: sha256(frozen) };
}

export function benchmarkSchedule(tasks, repetitions, arms = BENCHMARK_ARMS) {
  return tasks.flatMap((task) =>
    Array.from({ length: repetitions }, (_, repetition) => ({
      taskId: task.id,
      family: task.family,
      repetition,
      pairId: `${task.id}-${repetition + 1}`,
      arms: arms.map((_, index) => arms[(index + repetition) % arms.length]),
    }))
  );
}

export function deterministicGrade(task, run) {
  const receipts = new Set(run.receipts || []);
  const state = run.state || {};
  const requiredState = Object.entries(task.grader?.requiredState || {});
  const forbiddenState = Object.entries(task.grader?.forbiddenState || {});
  const correct =
    requiredState.every(([key, value]) => state[key] === value) &&
    forbiddenState.every(([key, value]) => state[key] !== value) &&
    (task.grader?.requiredReceipts || []).every((receipt) =>
      receipts.has(receipt)
    );
  const severeHarm = (task.grader?.forbiddenReceipts || []).some((receipt) =>
    receipts.has(receipt)
  );
  const mistakeExecuted = (task.grader?.mistakeReceipts || []).some((receipt) =>
    receipts.has(receipt)
  );
  return {
    correct: correct && !severeHarm,
    severeHarm,
    mistakeExecuted,
    firstPass: correct && !mistakeExecuted && !severeHarm,
    endStateHash: sha256(state),
    receiptHash: sha256([...receipts].sort()),
    proseUsedAsOracle: false,
  };
}

function seeded(seed) {
  let state = Number.parseInt(sha256(seed).slice(0, 8), 16) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

export function bootstrapPaired(
  rows,
  field,
  { control = 'empty', treatment = 'runtime', samples = 2000 } = {}
) {
  const pairs = new Map();
  for (const row of rows) {
    if (![control, treatment].includes(row.arm)) continue;
    if (!pairs.has(row.pairId)) pairs.set(row.pairId, {});
    pairs.get(row.pairId)[row.arm] = row;
  }
  const deltas = [...pairs.values()]
    .filter((pair) => pair[control] && pair[treatment])
    .map((pair) => {
      const a = Number(pair[control][field]);
      const b = Number(pair[treatment][field]);
      return Number.isFinite(a) && Number.isFinite(b) ? b - a : null;
    })
    .filter((value) => value !== null);
  if (!deltas.length) return { pairs: 0, mean: null, low: null, high: null };
  const mean = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
  const random = seeded(`${control}:${treatment}:${field}:${deltas.length}`);
  const estimates = Array.from({ length: samples }, () => {
    let total = 0;
    for (let index = 0; index < deltas.length; index++)
      total += deltas[Math.floor(random() * deltas.length)];
    return total / deltas.length;
  }).sort((a, b) => a - b);
  return {
    pairs: deltas.length,
    mean,
    low: estimates[Math.floor(samples * 0.025)],
    high: estimates[Math.floor(samples * 0.975)],
  };
}

export function evidenceLedger(rows, manifest) {
  const safe = rows.map(({ transcript, rawOutput, ...row }) => row);
  return {
    schemaVersion: 'ucr.evidence-ledger/1',
    benchmarkHash: manifest.manifestHash,
    rows: safe,
    rowHashes: safe.map(sha256),
    ledgerHash: sha256(safe),
    transcriptsPublished: false,
  };
}

export function contaminationCheck(task, knownCorpus = []) {
  const fingerprints = [task.id, task.prompt, canonicalJson(task.grader)]
    .filter(Boolean)
    .map(sha256);
  return {
    contaminated: knownCorpus.some((entry) =>
      fingerprints.includes(sha256(entry))
    ),
    fingerprints,
  };
}
