import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { bootstrapPaired } from './benchmark.mjs';
import { canonicalJson, sha256 } from './protocol.mjs';

export const EVIDENCE_CLASSES = Object.freeze([
  'transport',
  'conformance',
  'executable-smoke',
  'effectiveness',
  'superiority',
  'production',
]);

const evidenceRank = new Map(
  EVIDENCE_CLASSES.map((evidenceClass, index) => [evidenceClass, index])
);

export const METRIC_EVIDENCE_REQUIREMENTS = Object.freeze({
  applicabilityPrecision: 'effectiveness',
  preActionDelivery: 'effectiveness',
  irrelevantDelivery: 'effectiveness',
  staleDelivery: 'effectiveness',
  recurrenceReduction: 'effectiveness',
  recurrenceIntervalLow: 'effectiveness',
  naturalCorrectnessDelta: 'effectiveness',
  severeUnquarantined: 'effectiveness',
  emptyP95Overhead: 'effectiveness',
  reconstructionTokenReduction: 'effectiveness',
  writerIntegrity: 'conformance',
  crossClientPassed: 'effectiveness',
  competitivePassed: 'superiority',
});

function keyObject(key, expectedType) {
  if (key?.type === expectedType) return key;
  return expectedType === 'private'
    ? createPrivateKey(key)
    : createPublicKey(key);
}

function withoutHash(value, field) {
  const body = { ...(value || {}) };
  delete body[field];
  return body;
}

function percentile(values, quantile) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * quantile) - 1)
  );
  return sorted[index];
}

function rate(rows, predicate) {
  return rows.length ? rows.filter(predicate).length / rows.length : null;
}

function rowsAtLeast(ledgers, evidenceClass) {
  const minimum = evidenceRank.get(evidenceClass);
  return ledgers.flatMap((ledger) =>
    evidenceRank.get(ledger.evidenceClass) >= minimum ? ledger.rows || [] : []
  );
}

function verifiedLedgerInputs(inputs) {
  return inputs
    .map((input) => ({
      ledger: input?.ledger || input,
      publicKey: input?.publicKey || input?.ledgerPublicKey || null,
    }))
    .filter(
      ({ ledger, publicKey }) =>
        verifyEvidenceLedger(ledger, { publicKey }).valid
    )
    .map(({ ledger }) => ledger);
}

export function createEvidenceRun({
  runId,
  evidenceClass,
  benchmarkHash,
  sourceTreeHash,
  runner,
  startedAt = new Date().toISOString(),
} = {}) {
  if (!runId || !benchmarkHash || !sourceTreeHash)
    throw new Error(
      'evidence run requires runId, benchmarkHash, and sourceTreeHash'
    );
  if (!evidenceRank.has(evidenceClass))
    throw new Error(`unknown evidence class ${evidenceClass}`);
  const body = {
    schemaVersion: 'ucr.evidence-run/2',
    runId,
    evidenceClass,
    benchmarkHash,
    sourceTreeHash,
    runner,
    startedAt,
  };
  return { ...body, runHash: sha256(body) };
}

export function evidenceRows(rows, run) {
  let previousHash = run.runHash;
  return rows.map((input, index) => {
    const {
      transcript,
      rawOutput,
      rowHash,
      sequence: sourceSequence,
      ...safe
    } = input || {};
    const body = {
      ...safe,
      studySequence: safe.studySequence ?? sourceSequence ?? null,
      schemaVersion: 'ucr.evidence-row/2',
      runId: run.runId,
      sequence: index,
      previousHash,
    };
    const row = { ...body, rowHash: sha256(body) };
    previousHash = row.rowHash;
    return row;
  });
}

export function sealEvidenceLedger(
  run,
  inputRows,
  { endedAt = new Date().toISOString(), privateKey = null } = {}
) {
  const rows = evidenceRows(inputRows, run);
  const body = {
    schemaVersion: 'ucr.evidence-ledger/2',
    evidenceClass: run.evidenceClass,
    run,
    rows,
    rowCount: rows.length,
    chainHead: rows.at(-1)?.rowHash || run.runHash,
    transcriptsPublished: false,
    endedAt,
  };
  const ledgerHash = sha256(body);
  const signature = privateKey
    ? sign(
        null,
        Buffer.from(canonicalJson({ ...body, ledgerHash })),
        keyObject(privateKey, 'private')
      ).toString('base64')
    : null;
  return { ...body, ledgerHash, signature };
}

export function verifyEvidenceLedger(ledger, { publicKey = null } = {}) {
  const diagnostics = [];
  if (ledger?.schemaVersion !== 'ucr.evidence-ledger/2')
    diagnostics.push('unsupported evidence ledger schema');
  if (!evidenceRank.has(ledger?.evidenceClass))
    diagnostics.push('unknown evidence class');
  if (ledger?.run?.evidenceClass !== ledger?.evidenceClass)
    diagnostics.push('run and ledger evidence classes differ');
  if (sha256(withoutHash(ledger.run, 'runHash')) !== ledger?.run?.runHash)
    diagnostics.push('run hash mismatch');
  let previousHash = ledger?.run?.runHash;
  for (let index = 0; index < (ledger?.rows || []).length; index++) {
    const row = ledger.rows[index];
    if (row.sequence !== index)
      diagnostics.push(`row ${index} sequence mismatch`);
    if (row.previousHash !== previousHash)
      diagnostics.push(`row ${index} chain mismatch`);
    if (sha256(withoutHash(row, 'rowHash')) !== row.rowHash)
      diagnostics.push(`row ${index} hash mismatch`);
    if ('transcript' in row || 'rawOutput' in row)
      diagnostics.push(`row ${index} publishes disallowed raw model content`);
    previousHash = row.rowHash;
  }
  if (ledger?.rowCount !== (ledger?.rows || []).length)
    diagnostics.push('row count mismatch');
  if (ledger?.chainHead !== previousHash)
    diagnostics.push('chain head mismatch');
  const { ledgerHash, signature, ...body } = ledger || {};
  if (sha256(body) !== ledgerHash) diagnostics.push('ledger hash mismatch');
  let validSignature = null;
  if (signature || publicKey) {
    if (!signature || !publicKey) {
      diagnostics.push(
        'ledger signature and public key must be supplied together'
      );
      validSignature = false;
    } else {
      try {
        validSignature = verify(
          null,
          Buffer.from(canonicalJson({ ...body, ledgerHash })),
          keyObject(publicKey, 'public'),
          Buffer.from(signature, 'base64')
        );
      } catch {
        validSignature = false;
      }
      if (!validSignature) diagnostics.push('ledger signature mismatch');
    }
  }
  return {
    valid: diagnostics.length === 0,
    diagnostics,
    validSignature,
    ledgerHash,
    rowCount: ledger?.rows?.length || 0,
  };
}

function pairedMetric(rows, field) {
  const interval = bootstrapPaired(rows, field);
  return interval;
}

export function deriveReleaseMetrics(ledgers) {
  const validLedgers = verifiedLedgerInputs(ledgers);
  const effectiveness = rowsAtLeast(validLedgers, 'effectiveness');
  const conformance = rowsAtLeast(validLedgers, 'conformance');
  const superiority = rowsAtLeast(validLedgers, 'superiority');
  const delivered = effectiveness.filter((row) => row.delivered === true);
  const eligible = effectiveness.filter((row) => row.eligible === true);
  const applicability = effectiveness.filter(
    (row) => typeof row.applicable === 'boolean' && row.selected === true
  );
  const recurrence = pairedMetric(effectiveness, 'mistakeExecuted');
  const correctness = pairedMetric(effectiveness, 'correct');
  const reconstruction = pairedMetric(effectiveness, 'reconstructionTokens');
  const emptyOverhead = effectiveness
    .filter((row) => row.arm === 'runtime' && row.applicable === false)
    .map((row) => Number(row.contextOverheadRatio));
  const crossClientRows = effectiveness.filter(
    (row) => row.study === 'cross-client-handoff'
  );
  const directions = new Set(
    crossClientRows
      .filter((row) => row.correct === true && row.mistakeExecuted !== true)
      .map((row) => `${row.producerClient}->${row.consumerClient}`)
  );
  const modelFamilies = new Set(
    crossClientRows
      .flatMap((row) => [row.producerFamily, row.consumerFamily])
      .filter(Boolean)
  );
  const competitiveRows = superiority.filter(
    (row) => row.study === 'competitive' && row.fair === true
  );
  const metrics = {
    applicabilityPrecision: rate(applicability, (row) => row.applicable),
    preActionDelivery: rate(
      eligible,
      (row) => row.delivered === true && row.deliveryPhase === 'pre-action'
    ),
    irrelevantDelivery: rate(delivered, (row) => row.applicable === false),
    staleDelivery: rate(delivered, (row) => row.stale === true),
    recurrenceReduction: recurrence.mean === null ? null : -recurrence.mean,
    recurrenceIntervalLow: recurrence.high === null ? null : -recurrence.high,
    naturalCorrectnessDelta: correctness.mean,
    severeUnquarantined: effectiveness.filter(
      (row) => row.severeHarm === true && row.quarantinedBeforeNext !== true
    ).length,
    emptyP95Overhead: percentile(emptyOverhead, 0.95),
    reconstructionTokenReduction:
      reconstruction.mean === null
        ? null
        : (() => {
            const controls = effectiveness.filter(
              (row) =>
                row.arm === 'empty' && Number.isFinite(row.reconstructionTokens)
            );
            const meanControl = controls.length
              ? controls.reduce(
                  (sum, row) => sum + row.reconstructionTokens,
                  0
                ) / controls.length
              : null;
            return meanControl ? -reconstruction.mean / meanControl : null;
          })(),
    writerIntegrity:
      conformance.length > 0 &&
      conformance
        .filter((row) => row.study === 'writer-integrity')
        .every((row) => row.acceptedWrites === row.restoredWrites),
    crossClientPassed:
      directions.size >= 2 &&
      modelFamilies.size >= 2 &&
      crossClientRows.length >= 3,
    competitivePassed:
      competitiveRows.length > 0 &&
      competitiveRows.every(
        (row) => row.ucrOnParetoFrontier === true && row.effectIntervalLow > 0
      ),
  };
  const sources = Object.fromEntries(
    Object.entries(METRIC_EVIDENCE_REQUIREMENTS).map(
      ([metric, requiredClass]) => [
        metric,
        {
          requiredClass,
          eligibleLedgerHashes: validLedgers
            .filter(
              (ledger) =>
                evidenceRank.get(ledger.evidenceClass) >=
                evidenceRank.get(requiredClass)
            )
            .map((ledger) => ledger.ledgerHash),
        },
      ]
    )
  );
  return {
    schemaVersion: 'ucr.derived-metrics/2',
    metrics,
    intervals: { recurrence, correctness, reconstruction },
    sources,
    inputLedgerHashes: validLedgers.map((ledger) => ledger.ledgerHash).sort(),
    rejectedLedgers: ledgers.length - validLedgers.length,
    derivedHash: sha256({ metrics, sources }),
  };
}

export function evidenceTierReport(ledgers) {
  const valid = verifiedLedgerInputs(ledgers);
  return Object.fromEntries(
    EVIDENCE_CLASSES.map((evidenceClass) => {
      const matches = valid.filter(
        (ledger) => ledger.evidenceClass === evidenceClass
      );
      return [
        evidenceClass,
        {
          status: matches.length ? 'present' : 'missing',
          ledgers: matches.length,
          rows: matches.reduce((sum, ledger) => sum + ledger.rows.length, 0),
          hashes: matches.map((ledger) => ledger.ledgerHash),
        },
      ];
    })
  );
}
