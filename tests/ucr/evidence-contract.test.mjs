import { describe, expect, test } from '@jest/globals';
import { generateKeyPairSync } from 'node:crypto';
import {
  createEvidenceRun,
  deriveReleaseMetrics,
  evidenceTierReport,
  sealEvidenceLedger,
  verifyEvidenceLedger,
} from '../../ucr/index.mjs';

function run(evidenceClass, id = evidenceClass) {
  return createEvidenceRun({
    runId: id,
    evidenceClass,
    benchmarkHash: 'b'.repeat(64),
    sourceTreeHash: 's'.repeat(64),
    runner: { name: 'test', version: '1' },
    startedAt: '2026-08-09T00:00:00.000Z',
  });
}

describe('evidence contract v2', () => {
  test('chains, redacts, signs, and independently verifies immutable rows', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const ledger = sealEvidenceLedger(
      run('effectiveness'),
      [
        {
          pairId: 'p1',
          arm: 'empty',
          correct: false,
          transcript: 'never publish this',
        },
        {
          pairId: 'p1',
          arm: 'runtime',
          correct: true,
          rawOutput: 'or this',
        },
      ],
      { privateKey, endedAt: '2026-08-09T00:01:00.000Z' }
    );
    expect(ledger.rows[0].transcript).toBeUndefined();
    expect(ledger.rows[1].rawOutput).toBeUndefined();
    expect(verifyEvidenceLedger(ledger, { publicKey })).toMatchObject({
      valid: true,
      validSignature: true,
      rowCount: 2,
    });
    expect(
      verifyEvidenceLedger(
        {
          ...ledger,
          rows: [ledger.rows[0], { ...ledger.rows[1], correct: false }],
        },
        { publicKey }
      ).valid
    ).toBe(false);
    expect(
      evidenceTierReport([{ ledger, publicKey }]).effectiveness
    ).toMatchObject({ status: 'present', ledgers: 1, rows: 2 });
  });

  test('does not derive effectiveness from transport or conformance evidence', () => {
    const ledger = sealEvidenceLedger(run('conformance'), [
      {
        study: 'writer-integrity',
        acceptedWrites: 100,
        restoredWrites: 100,
      },
      {
        selected: true,
        applicable: true,
        delivered: true,
        deliveryPhase: 'pre-action',
      },
    ]);
    const derived = deriveReleaseMetrics([ledger]);
    expect(derived.metrics.writerIntegrity).toBe(true);
    expect(derived.metrics.applicabilityPrecision).toBeNull();
    expect(derived.metrics.preActionDelivery).toBeNull();
    expect(evidenceTierReport([ledger]).conformance.status).toBe('present');
    expect(evidenceTierReport([ledger]).effectiveness.status).toBe('missing');
  });

  test('fails writer integrity closed when coordination counts are absent or nonnumeric', () => {
    const missingStudy = sealEvidenceLedger(run('conformance', 'missing'), [
      { study: 'adapter-conformance', passed: true },
    ]);
    const missingCounts = sealEvidenceLedger(run('conformance', 'no-counts'), [
      { study: 'writer-integrity', passed: false },
    ]);
    const invalidCounts = sealEvidenceLedger(
      run('conformance', 'invalid-counts'),
      [
        {
          study: 'writer-integrity',
          acceptedWrites: 100,
          restoredWrites: null,
        },
      ]
    );

    expect(deriveReleaseMetrics([missingStudy]).metrics.writerIntegrity).toBe(
      false
    );
    expect(deriveReleaseMetrics([missingCounts]).metrics.writerIntegrity).toBe(
      false
    );
    expect(deriveReleaseMetrics([invalidCounts]).metrics.writerIntegrity).toBe(
      false
    );
  });

  test('derives paired correctness and recurrence only from eligible ledgers', () => {
    const ledger = sealEvidenceLedger(run('effectiveness'), [
      {
        pairId: 'p1',
        arm: 'empty',
        correct: 0,
        mistakeExecuted: 1,
        reconstructionTokens: 100,
      },
      {
        pairId: 'p1',
        arm: 'runtime',
        correct: 1,
        mistakeExecuted: 0,
        reconstructionTokens: 40,
        selected: true,
        applicable: true,
        eligible: true,
        delivered: true,
        deliveryPhase: 'pre-action',
        contextOverheadRatio: 0.01,
      },
    ]);
    expect(deriveReleaseMetrics([ledger]).metrics).toMatchObject({
      applicabilityPrecision: 1,
      preActionDelivery: 1,
      recurrenceReduction: 1,
      naturalCorrectnessDelta: 1,
      reconstructionTokenReduction: 0.6,
    });
  });
});
