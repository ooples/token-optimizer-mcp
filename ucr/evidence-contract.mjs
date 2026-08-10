import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import {
  BENCHMARK_ARMS,
  BENCHMARK_FAMILIES,
  bootstrapPaired,
} from './benchmark.mjs';
import {
  REQUIRED_COMPETITIVE_BASELINES,
  validateCompetitiveEvidence,
} from './competitors.mjs';
import {
  EFFECTIVENESS_REQUIRED_METRICS,
  SUPERIORITY_REQUIRED_METRICS,
} from './effectiveness.mjs';
import { canonicalJson, sha256 } from './protocol.mjs';
import {
  bonferroniNormalZ,
  validateCausalChain,
} from './study-design.mjs';

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
  applicabilityPrecisionIntervalLow: 'effectiveness',
  preActionDelivery: 'effectiveness',
  preActionDeliveryIntervalLow: 'effectiveness',
  irrelevantDelivery: 'effectiveness',
  irrelevantDeliveryIntervalHigh: 'effectiveness',
  staleDelivery: 'effectiveness',
  staleDeliveryIntervalHigh: 'effectiveness',
  recurrenceReduction: 'effectiveness',
  recurrenceIntervalLow: 'effectiveness',
  naturalCorrectnessDelta: 'effectiveness',
  naturalCorrectnessIntervalLow: 'effectiveness',
  severeUnquarantined: 'effectiveness',
  emptyP95Overhead: 'effectiveness',
  reconstructionTokenReduction: 'effectiveness',
  firstSuccessorTokenReduction: 'effectiveness',
  firstSuccessorTokenIntervalLow: 'effectiveness',
  latencyOverheadP95: 'effectiveness',
  knownMistakeRecurrence: 'effectiveness',
  contradictoryDelivery: 'effectiveness',
  contradictoryDeliveryIntervalHigh: 'effectiveness',
  negativeDeliveryIntervalHigh: 'effectiveness',
  consumerSchemaTokensP95: 'effectiveness',
  captureModelCallsP95: 'effectiveness',
  writerIntegrity: 'conformance',
  crossClientPassed: 'effectiveness',
  benchmarkFamilyCoverage: 'effectiveness',
  benchmarkArmCoverage: 'effectiveness',
  directionalCorrectnessIntervalLow: 'effectiveness',
  familyCorrectnessIntervalLow: 'effectiveness',
  directionalTokenOverheadHigh: 'effectiveness',
  causalChainIntegrity: 'effectiveness',
  trialIntegrity: 'effectiveness',
  independentGrading: 'effectiveness',
  competitivePassed: 'superiority',
  competitiveCoverage: 'superiority',
  competitiveReproducibility: 'superiority',
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

function disallowedEvidencePath(value, path = '') {
  if (!value || typeof value !== 'object') return null;
  for (const [key, item] of Object.entries(value)) {
    const next = path ? `${path}.${key}` : key;
    if (['transcript', 'rawOutput', 'prompt'].includes(key)) return next;
    const nested = disallowedEvidencePath(item, next);
    if (nested) return nested;
  }
  return null;
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

function rateInterval(rows, predicate, z = 1.96) {
  if (!rows.length) return { count: 0, rate: null, low: null, high: null };
  const successes = rows.filter(predicate).length;
  const n = rows.length;
  const observed = successes / n;
  const denominator = 1 + z ** 2 / n;
  const center = (observed + z ** 2 / (2 * n)) / denominator;
  const margin =
    (z / denominator) *
    Math.sqrt((observed * (1 - observed)) / n + z ** 2 / (4 * n ** 2));
  return {
    count: n,
    successes,
    rate: observed,
    low: Math.max(0, center - margin),
    high: Math.min(1, center + margin),
  };
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
    const disallowed = disallowedEvidencePath(row);
    if (disallowed)
      diagnostics.push(
        `row ${index} publishes disallowed raw model content at ${disallowed}`
      );
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

function pairedRatios(rows, field) {
  const pairs = new Map();
  for (const row of rows) {
    if (!['empty', 'runtime'].includes(row.arm)) continue;
    if (!pairs.has(row.pairId)) pairs.set(row.pairId, {});
    pairs.get(row.pairId)[row.arm] = row;
  }
  return [...pairs.values()]
    .filter(
      (pair) =>
        Number.isFinite(pair.empty?.[field]) &&
        pair.empty[field] > 0 &&
        Number.isFinite(pair.runtime?.[field])
    )
    .map((pair) => (pair.runtime[field] - pair.empty[field]) / pair.empty[field]);
}

function coverage(rows, field, expected) {
  if (!rows.length) return null;
  const actual = new Set(rows.map((row) => row[field]).filter(Boolean));
  return expected.filter((value) => actual.has(value)).length / expected.length;
}

function poweredStrata(rows, field) {
  const groups = new Map();
  for (const row of rows) {
    if (!['empty', 'runtime'].includes(row.arm) || !row[field]) continue;
    if (!groups.has(row[field])) groups.set(row[field], []);
    groups.get(row[field]).push(row);
  }
  if (!groups.size) return null;
  const intervals = [...groups.values()].map((group) => {
    if (!group.every((row) => row.poweredStratum === true)) return null;
    const interval = bootstrapPaired(group, 'correct', {
      alpha: 0.05 / groups.size,
      samples: 10000,
    });
    return interval.pairs > 0 ? interval : null;
  });
  return intervals.every(Boolean) ? intervals : null;
}

function worstCorrectnessLow(rows, field) {
  const intervals = poweredStrata(rows, field);
  return intervals ? Math.min(...intervals.map((interval) => interval.low)) : null;
}

function worstTokenOverheadHigh(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!['empty', 'runtime'].includes(row.arm) || !row.direction) continue;
    if (!groups.has(row.direction)) groups.set(row.direction, []);
    groups.get(row.direction).push(row);
  }
  if (!groups.size) return null;
  const overheads = [];
  for (const group of groups.values()) {
    if (!group.every((row) => row.poweredStratum === true)) return null;
    const interval = bootstrapPaired(group, 'totalTokens', {
      alpha: 0.05 / groups.size,
      samples: 10000,
    });
    const controls = group.filter(
      (row) => row.arm === 'empty' && Number.isFinite(row.totalTokens)
    );
    const meanControl = controls.length
      ? controls.reduce((sum, row) => sum + row.totalTokens, 0) /
        controls.length
      : null;
    if (!interval.pairs || !meanControl) return null;
    overheads.push(interval.high / meanControl);
  }
  return Math.max(...overheads);
}

function worstNegativeDeliveryHigh(rows) {
  const directions = new Set(rows.map((row) => row.direction).filter(Boolean));
  if (!directions.size) return null;
  const arms = ['irrelevant', 'stale', 'contradictory', 'harmful'];
  const z = bonferroniNormalZ({ comparisons: directions.size * arms.length });
  const intervals = [];
  for (const direction of directions) {
    for (const arm of arms) {
      const opportunities = rows.filter(
        (row) => row.direction === direction && row.arm === arm
      );
      const interval = rateInterval(
        opportunities,
        (row) => row.delivered === true,
        z
      );
      if (interval.high === null) return null;
      intervals.push(interval.high);
    }
  }
  return Math.max(...intervals);
}

export function deriveReleaseMetrics(ledgers) {
  const validLedgers = verifiedLedgerInputs(ledgers);
  const effectiveness = validLedgers.flatMap((ledger) => {
    if (evidenceRank.get(ledger.evidenceClass) < evidenceRank.get('effectiveness'))
      return [];
    const rows = ledger.rows || [];
    if (
      ledger.evidenceClass === 'effectiveness' &&
      rows.length > 0 &&
      rows.every((row) => !row.study)
    )
      return rows;
    return rows.filter((row) =>
      ['full-effectiveness', 'cross-client-handoff'].includes(row.study)
    );
  });
  const conformance = rowsAtLeast(validLedgers, 'conformance');
  const superiority = rowsAtLeast(validLedgers, 'superiority');
  const eligible = effectiveness.filter(
    (row) => row.eligible === true && row.applicable === true
  );
  const applicability = effectiveness.filter(
    (row) => typeof row.applicable === 'boolean' && row.selected === true
  );
  const recurrence = pairedMetric(effectiveness, 'mistakeExecuted');
  const correctness = pairedMetric(effectiveness, 'correct');
  const reconstruction = pairedMetric(effectiveness, 'reconstructionTokens');
  const firstSuccessorTokens = pairedMetric(effectiveness, 'totalTokens');
  const latencyRatios = pairedRatios(effectiveness, 'latencyMs');
  const emptyOverhead = effectiveness
    .filter((row) => row.arm === 'runtime' && row.applicable === false)
    .map((row) => Number(row.contextOverheadRatio));
  const crossClientRows = effectiveness.filter(
    (row) =>
      ['cross-client-handoff', 'full-effectiveness'].includes(row.study) &&
      row.producerClient &&
      row.consumerClient &&
      row.producerClient !== row.consumerClient
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
  const clients = new Set(
    crossClientRows
      .flatMap((row) => [row.producerClient, row.consumerClient])
      .filter(Boolean)
  );
  const competitiveRows = superiority.filter(
    (row) => row.study === 'competitive' && row.fair === true
  );
  const writerRows = conformance.filter(
    (row) => row.study === 'writer-integrity'
  );
  const negativeApplicability = effectiveness.filter(
    (row) => row.applicable === false
  );
  const staleOpportunities = effectiveness.filter((row) => row.stale === true);
  const contradictoryOpportunities = effectiveness.filter(
    (row) => row.contradictory === true
  );
  const causalRows = effectiveness.filter(
    (row) => row.arm === 'runtime' && row.causalClaim === true
  );
  const causalFamilies = new Set(causalRows.map((row) => row.family));
  const competitiveValidation = competitiveRows.map(validateCompetitiveEvidence);
  const competitiveKinds = new Set(
    competitiveRows.map((row) => row.baselineKind).filter(Boolean)
  );
  const metrics = {
    applicabilityPrecision: rate(applicability, (row) => row.applicable),
    applicabilityPrecisionIntervalLow: rateInterval(
      applicability,
      (row) => row.applicable
    ).low,
    preActionDelivery: rate(
      eligible,
      (row) => row.delivered === true && row.deliveryPhase === 'pre-action'
    ),
    preActionDeliveryIntervalLow: rateInterval(
      eligible,
      (row) => row.delivered === true && row.deliveryPhase === 'pre-action'
    ).low,
    irrelevantDelivery: rate(
      negativeApplicability,
      (row) => row.delivered === true
    ),
    irrelevantDeliveryIntervalHigh: rateInterval(
      negativeApplicability,
      (row) => row.delivered === true
    ).high,
    staleDelivery: rate(
      staleOpportunities,
      (row) => row.delivered === true
    ),
    staleDeliveryIntervalHigh: rateInterval(
      staleOpportunities,
      (row) => row.delivered === true
    ).high,
    recurrenceReduction: recurrence.mean === null ? null : -recurrence.mean,
    recurrenceIntervalLow: recurrence.high === null ? null : -recurrence.high,
    naturalCorrectnessDelta: correctness.mean,
    naturalCorrectnessIntervalLow: correctness.low,
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
    firstSuccessorTokenReduction:
      firstSuccessorTokens.mean === null
        ? null
        : (() => {
            const controls = effectiveness.filter(
              (row) => row.arm === 'empty' && Number.isFinite(row.totalTokens)
            );
            const meanControl = controls.length
              ? controls.reduce((sum, row) => sum + row.totalTokens, 0) /
                controls.length
              : null;
            return meanControl ? -firstSuccessorTokens.mean / meanControl : null;
          })(),
    firstSuccessorTokenIntervalLow:
      firstSuccessorTokens.high === null
        ? null
        : (() => {
            const controls = effectiveness.filter(
              (row) => row.arm === 'empty' && Number.isFinite(row.totalTokens)
            );
            const meanControl = controls.length
              ? controls.reduce((sum, row) => sum + row.totalTokens, 0) /
                controls.length
              : null;
            return meanControl ? -firstSuccessorTokens.high / meanControl : null;
          })(),
    latencyOverheadP95: percentile(latencyRatios, 0.95),
    knownMistakeRecurrence: rate(
      effectiveness.filter(
        (row) =>
          row.arm === 'runtime' &&
          row.applicable === true &&
          row.knownMistake === true
      ),
      (row) => row.mistakeExecuted === true
    ),
    contradictoryDelivery: rate(
      contradictoryOpportunities,
      (row) => row.delivered === true
    ),
    contradictoryDeliveryIntervalHigh: rateInterval(
      contradictoryOpportunities,
      (row) => row.delivered === true
    ).high,
    negativeDeliveryIntervalHigh: worstNegativeDeliveryHigh(effectiveness),
    consumerSchemaTokensP95: percentile(
      effectiveness
        .filter((row) => row.arm === 'runtime')
        .map((row) => Number(row.phaseAccounting?.staticSchemaTokens)),
      0.95
    ),
    captureModelCallsP95: percentile(
      effectiveness
        .filter((row) => row.arm === 'runtime')
        .map((row) => Number(row.phaseAccounting?.captureModelCalls)),
      0.95
    ),
    writerIntegrity:
      writerRows.length > 0 &&
      writerRows.every(
        (row) =>
          Number.isFinite(row.acceptedWrites) &&
          Number.isFinite(row.restoredWrites) &&
          row.acceptedWrites === row.restoredWrites
      ),
    crossClientPassed:
      clients.size >= 3 &&
      modelFamilies.size >= 3 &&
      [...clients].every((producer) =>
        [...clients].every(
          (consumer) =>
            producer === consumer || directions.has(`${producer}->${consumer}`)
        )
      ),
    benchmarkFamilyCoverage: coverage(
      effectiveness,
      'family',
      BENCHMARK_FAMILIES
    ),
    benchmarkArmCoverage: coverage(effectiveness, 'arm', BENCHMARK_ARMS),
    directionalCorrectnessIntervalLow: worstCorrectnessLow(
      effectiveness,
      'direction'
    ),
    familyCorrectnessIntervalLow: worstCorrectnessLow(
      effectiveness,
      'family'
    ),
    directionalTokenOverheadHigh: worstTokenOverheadHigh(effectiveness),
    causalChainIntegrity:
      causalRows.length > 0 &&
      BENCHMARK_FAMILIES.every((family) => causalFamilies.has(family)) &&
      causalRows.every((row) => validateCausalChain(row.causalChain).valid),
    trialIntegrity:
      effectiveness.length > 0 &&
      effectiveness.every((row) => row.trialIntegrityValid === true),
    independentGrading:
      effectiveness.length > 0 &&
      effectiveness.every((row) => row.graderVerified === true),
    competitivePassed:
      competitiveRows.length > 0 &&
      competitiveValidation.every((validation) => validation.valid),
    competitiveCoverage:
      competitiveRows.length > 0
        ? REQUIRED_COMPETITIVE_BASELINES.filter((kind) =>
            competitiveKinds.has(kind)
          ).length / REQUIRED_COMPETITIVE_BASELINES.length
        : null,
    competitiveReproducibility:
      competitiveRows.length > 0 &&
      competitiveValidation.every((validation) => validation.valid),
  };
  const ledgerSupportsMetric = (ledger, metric, requiredClass) => {
    if (evidenceRank.get(ledger.evidenceClass) < evidenceRank.get(requiredClass))
      return false;
    const rows = ledger.rows || [];
    if (EFFECTIVENESS_REQUIRED_METRICS.includes(metric)) {
      if (metric === 'writerIntegrity')
        return rows.some((row) => row.study === 'writer-integrity');
      return (
        (ledger.evidenceClass === 'effectiveness' &&
          rows.length > 0 &&
          rows.every((row) => !row.study)) ||
        rows.some((row) =>
          ['full-effectiveness', 'cross-client-handoff'].includes(row.study)
        )
      );
    }
    if (SUPERIORITY_REQUIRED_METRICS.includes(metric))
      return rows.some((row) => row.study === 'competitive' && row.fair === true);
    return true;
  };
  const sources = Object.fromEntries(
    Object.entries(METRIC_EVIDENCE_REQUIREMENTS).map(
      ([metric, requiredClass]) => [
        metric,
        {
          requiredClass,
          eligibleLedgerHashes: validLedgers
            .filter((ledger) =>
              ledgerSupportsMetric(ledger, metric, requiredClass)
            )
            .map((ledger) => ledger.ledgerHash),
        },
      ]
    )
  );
  return {
    schemaVersion: 'ucr.derived-metrics/2',
    metrics,
    intervals: {
      recurrence,
      correctness,
      reconstruction,
      firstSuccessorTokens,
    },
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
