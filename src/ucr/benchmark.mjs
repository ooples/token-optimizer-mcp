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
  {
    control = 'empty',
    treatment = 'runtime',
    samples = 2000,
    alpha = 0.05,
  } = {}
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
    low: estimates[Math.floor(samples * (alpha / 2))],
    high:
      estimates[
        Math.min(samples - 1, Math.floor(samples * (1 - alpha / 2)))
      ],
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

export function hiddenTaskVariant(task, secret, { nonce = '' } = {}) {
  if (!secret) throw new Error('hidden task variants require a secret');
  const hiddenVariantId = createHmac('sha256', secret)
    .update(`${task.id}:${nonce}:${canonicalJson(task.hiddenVariantSpec || {})}`)
    .digest('hex');
  const publicTask = { ...task };
  delete publicTask.hiddenAnswer;
  delete publicTask.privateGrader;
  const digestBytes = Buffer.from(hiddenVariantId, 'hex');
  const specification = task.hiddenVariantSpec || {};
  const scenarioCount = Math.max(
    2,
    Number(
      specification.templates ||
        specification.variants ||
        specification.versions ||
        8
    )
  );
  const publicVariant = {
    kind: specification.kind || 'nonce-bound',
    challengeId: hiddenVariantId.slice(0, 24),
    entitySuffix: hiddenVariantId.slice(24, 32),
    variantIndex: digestBytes.readUInt32BE(0),
    fixtureSeed: hiddenVariantId.slice(32, 48),
    scenarioIndex: digestBytes.readUInt32BE(4) % scenarioCount,
    scenarioCount,
    layoutIndex: digestBytes.readUInt16BE(8) % 4,
    distractorCount: 2 + (digestBytes[10] % 5),
    chronologyIndex: digestBytes.readUInt16BE(11) % 17,
  };
  return {
    publicTask: {
      ...publicTask,
      hiddenVariantId: hiddenVariantId.slice(0, 24),
      publicVariant,
      prompt: `${publicTask.prompt}\nChallenge instance ${publicVariant.challengeId}; repository layout ${publicVariant.layoutIndex}; scenario ${publicVariant.scenarioIndex}.`,
    },
    graderBinding: createHmac('sha256', secret)
      .update(
        `${hiddenVariantId}:${canonicalJson(task.grader || {})}:${canonicalJson(publicVariant)}`
      )
      .digest('hex'),
  };
}

export function twoProportionSampleSize({
  baselineRate,
  minimumEffect,
  alpha = 0.05,
  power = 0.8,
} = {}) {
  if (
    ![baselineRate, minimumEffect, alpha, power].every(Number.isFinite) ||
    baselineRate <= 0 ||
    baselineRate >= 1 ||
    minimumEffect <= 0 ||
    baselineRate + minimumEffect >= 1
  )
    throw new Error('invalid two-proportion power-analysis inputs');
  // Pre-registered common design points. The approximation remains explicit
  // instead of pretending a tiny pilot has exact inferential power.
  const zAlpha = alpha <= 0.01 ? 2.576 : alpha <= 0.05 ? 1.96 : 1.645;
  const zPower = power >= 0.9 ? 1.282 : power >= 0.8 ? 0.842 : 0.674;
  const treatmentRate = baselineRate + minimumEffect;
  const pooled = (baselineRate + treatmentRate) / 2;
  const numerator =
    zAlpha * Math.sqrt(2 * pooled * (1 - pooled)) +
    zPower *
      Math.sqrt(
        baselineRate * (1 - baselineRate) +
          treatmentRate * (1 - treatmentRate)
      );
  return {
    baselineRate,
    treatmentRate,
    minimumEffect,
    alpha,
    power,
    perArm: Math.ceil((numerator / minimumEffect) ** 2),
    method: 'normal-approximation-two-sided-two-proportion',
  };
}

export function preRegisterBenchmark(manifest, pilot) {
  const frozen = freezeBenchmark(manifest);
  const powerAnalysis = twoProportionSampleSize(pilot);
  const registration = {
    schemaVersion: 'ucr.benchmark-registration/1',
    benchmarkHash: frozen.manifestHash,
    primaryOutcomes: frozen.primaryOutcomes,
    exclusions: frozen.exclusions,
    arms: frozen.arms,
    powerAnalysis,
    hiddenGraders: frozen.tasks.every(
      (task) => task.hiddenVariantSpec && task.grader
    ),
    naturalTaskFixtures: frozen.tasks.filter((task) => task.fixture).length,
  };
  return { ...registration, registrationHash: sha256(registration) };
}
