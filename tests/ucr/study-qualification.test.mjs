import { describe, expect, test } from '@jest/globals';
import { studyQualificationVerdict } from '../../ucr/index.mjs';

const trial = (arm) => ({ arm, pairId: 'pair-1' });
const row = (arm, totalTokens) => ({
  arm,
  pairId: 'pair-1',
  totalTokens,
  trialIntegrityValid: true,
  graderVerified: true,
  correct: true,
  severeHarm: false,
  delivered: arm === 'runtime',
  deliveryPhase: arm === 'runtime' ? 'pre-action' : null,
});

describe('bounded study qualification verdict', () => {
  test('passes an intact non-inferior paired selection', () => {
    const verdict = studyQualificationVerdict({
      rows: [row('empty', 100), row('runtime', 104)],
      plannedTrials: [trial('empty'), trial('runtime')],
      failures: [],
    });
    expect(verdict).toMatchObject({ passed: true, status: 'passed' });
    expect(verdict.maximumObservedTokenOverhead).toBeCloseTo(0.04);
  });

  test('allows a blinded control failure when runtime prevents it', () => {
    const empty = {
      ...row('empty', 120),
      correct: false,
      mistakeExecuted: true,
    };
    expect(
      studyQualificationVerdict({
        rows: [empty, row('runtime', 90)],
        plannedTrials: [trial('empty'), trial('runtime')],
        failures: [],
      })
    ).toMatchObject({ passed: true, status: 'passed' });
  });

  test('fails correctness, token, integrity, and incomplete selection losses', () => {
    const runtime = {
      ...row('runtime', 106),
      correct: false,
      trialIntegrityValid: false,
    };
    const verdict = studyQualificationVerdict({
      rows: [runtime],
      plannedTrials: [trial('empty'), trial('runtime')],
      failures: [{ trialId: 'runtime' }],
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.failed).toEqual(
      expect.arrayContaining([
        'selectionComplete',
        'trialIntegrity',
        'taskCorrect',
        'pairedCoverage',
        'tokenNonInferiority',
      ])
    );
  });

  test('requires hard-negative context to remain withheld', () => {
    const negative = {
      ...row('stale', 50),
      delivered: true,
    };
    expect(
      studyQualificationVerdict({
        rows: [negative],
        plannedTrials: [trial('stale')],
        failures: [],
      }).failed
    ).toContain('hardNegativesWithheld');
  });

  test('fails when a signed selection is missing an expected row', () => {
    expect(
      studyQualificationVerdict({
        rows: [row('empty', 100)],
        selectedTrialCount: 2,
        plannedArms: ['empty', 'runtime'],
        failures: [],
      }).failed
    ).toEqual(expect.arrayContaining(['selectionComplete', 'pairedCoverage']));
  });
});
