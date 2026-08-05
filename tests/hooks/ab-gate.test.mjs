/**
 * The gate is graded by code, and the code is graded here.
 *
 * Both A/B runs so far produced a number that meant less than it looked like:
 * the single-turn run PASSED on two admitted cases, and the multi-turn run
 * admitted none at all because every control verified instead of guessing. Both
 * were scored by reading the answers and deciding whether they seemed right.
 *
 * So the arithmetic now lives in a function, and these tests are the check on
 * it -- particularly that it REFUSES to report a rate it does not have the
 * evidence for.
 */
import { describe, it, expect } from '@jest/globals';
import { grade } from '../fixtures/ab-gate.mjs';
import {
  HARVESTED,
  corpusProblems,
  CLASSES,
} from '../fixtures/harvested-dead-ends.mjs';

/** A tiny synthetic corpus, so gate behaviour is not entangled with real predicates. */
const CASES = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({
  id,
  class: 'expensive',
  walksIn: (s) => /WRONG/.test(s),
  avoids: (s) => /RIGHT/.test(s),
}));

const r = (id, control, treatment, ct = 100, tt = 100) => ({
  id,
  control: { answer: control, tokens: ct },
  treatment: { answer: treatment, tokens: tt },
});

describe('admission by control failure', () => {
  it('excludes a case the control got right, because it measured nothing', () => {
    const g = grade([r('a', 'RIGHT', 'RIGHT')], CASES, { minAdmitted: 0 });
    expect(g.admitted).toEqual([]);
    expect(g.excluded).toEqual(['a']);
    // Undefined, NOT 100%. Counting an untriggered case as a success is how a
    // corpus of easy cases flatters the result.
    expect(g.avoidedRate).toBeNull();
  });

  it('admits a case the control walked into', () => {
    const g = grade([r('a', 'WRONG', 'RIGHT')], CASES, { minAdmitted: 0 });
    expect(g.admitted).toEqual(['a']);
    expect(g.rescued).toEqual(['a']);
    expect(g.avoidedRate).toBe(1);
  });

  it('reports the excluded cases rather than dropping them silently', () => {
    const g = grade(
      [
        r('a', 'RIGHT', 'RIGHT'),
        r('b', 'WRONG', 'RIGHT'),
        r('c', 'RIGHT', 'RIGHT'),
      ],
      CASES,
      { minAdmitted: 0 }
    );
    expect(g.excluded.sort()).toEqual(['a', 'c']);
    expect(g.admitted).toEqual(['b']);
  });
});

describe('the minimum-N requirement', () => {
  it('fails a run that clears the bar on too few cases', () => {
    // Exactly the shape of the single-turn PASS: 2 for 2, which is 100% and
    // means very little.
    const g = grade(
      [r('a', 'WRONG', 'RIGHT'), r('b', 'WRONG', 'RIGHT')],
      CASES
    );
    expect(g.avoidedRate).toBe(1);
    expect(g.verdict).toBe('FAIL');
    expect(g.reasons.join(' ')).toMatch(/only 2 case\(s\) admitted/);
  });

  it('passes once enough cases are admitted and the bar is met', () => {
    const rows = ['a', 'b', 'c', 'd', 'e'].map((id) => r(id, 'WRONG', 'RIGHT'));
    const g = grade(rows, CASES);
    expect(g.verdict).toBe('PASS');
    expect(g.reasons).toEqual([]);
  });

  it('fails when nothing fired at all, and says so', () => {
    // The multi-turn run, exactly: three cases, three correct controls.
    const rows = ['a', 'b', 'c'].map((id) => r(id, 'RIGHT', 'RIGHT'));
    const g = grade(rows, CASES);
    expect(g.verdict).toBe('FAIL');
    expect(g.reasons.join(' ')).toMatch(/no admitted cases|only 0 case/);
  });
});

describe('regressions', () => {
  it('is a hard zero even when the avoided rate is perfect', () => {
    const rows = ['a', 'b', 'c', 'd', 'e'].map((id) => r(id, 'WRONG', 'RIGHT'));
    rows.push(r('f', 'RIGHT', 'WRONG'));
    const g = grade(rows, CASES);
    expect(g.rescued).toHaveLength(5);
    expect(g.regressions).toEqual(['f']);
    expect(g.verdict).toBe('FAIL');
  });

  it('is looked for in EXCLUDED cases too, which is where it does its damage', () => {
    // The control was right and needed no help; the finding pushed it wrong.
    // That case is not admitted -- and must still count against the run.
    const g = grade([r('f', 'RIGHT', 'WRONG')], CASES, { minAdmitted: 0 });
    expect(g.admitted).toEqual([]);
    expect(g.regressions).toEqual(['f']);
    expect(g.verdict).toBe('FAIL');
  });
});

describe('the token metric', () => {
  it('counts only admitted cases where the treatment was also correct', () => {
    const rows = [
      r('a', 'WRONG', 'RIGHT', 100, 130), // admitted, rescued -> counted
      r('b', 'RIGHT', 'RIGHT', 100, 200), // excluded          -> not counted
      r('c', 'WRONG', 'WRONG', 100, 900), // admitted, not rescued -> not counted
    ];
    const g = grade(rows, CASES, { minAdmitted: 0 });
    expect(g.tokens.comparableCases).toEqual(['a']);
    expect(g.tokens.control).toBe(100);
    expect(g.tokens.treatment).toBe(130);
    expect(g.tokens.delta).toBe(30);
  });

  it('never gates on tokens, however bad the delta', () => {
    const rows = ['a', 'b', 'c', 'd', 'e'].map((id) =>
      r(id, 'WRONG', 'RIGHT', 100, 10_000)
    );
    const g = grade(rows, CASES);
    expect(g.tokens.delta).toBeGreaterThan(0);
    expect(g.verdict).toBe('PASS');
  });
});

describe('the harvested corpus', () => {
  it('is well formed, so no case can contribute nothing in silence', () => {
    expect(corpusProblems()).toEqual([]);
  });

  it('has enough cases to satisfy the minimum on its own', () => {
    // If the corpus is smaller than the minimum, the gate can never pass and
    // the bar is decoration.
    expect(HARVESTED.length).toBeGreaterThanOrEqual(5);
  });

  it('records why each case is hard, and keeps restricted out of the headline', () => {
    for (const c of HARVESTED) expect(CLASSES).toContain(c.class);
    // `restricted` handicaps the control, so it is a demonstration rather than a
    // measurement. Nothing in the harvested set may claim it.
    expect(HARVESTED.filter((c) => c.class === 'restricted')).toHaveLength(0);
  });

  it('has a symptom recorded for every case', () => {
    // Renamed, because the previous title claimed this ran the symptom through
    // the predicates and the body only checked its type and length. A test that
    // describes a stronger check than it performs is worse than no test: it
    // reads as coverage. Reported by CodeRabbit on this PR.
    for (const c of HARVESTED) {
      expect(typeof c.symptom).toBe('string');
      expect(c.symptom.length).toBeGreaterThan(40);
    }
  });

  it('actually scores each recorded symptom, and does not call it avoided', () => {
    // THE CHECK THE OLD TITLE PROMISED. The symptom is what was observed when
    // the dead-end bit -- a description of the failure, not of the fix. A
    // predicate that reads it as `avoids` is scoring the wrong thing, and would
    // mark a subject correct for describing the bug it just walked into.
    const wrong = HARVESTED.filter((c) => c.avoids(c.symptom));
    expect(wrong.map((c) => c.id)).toEqual([]);
  });

  it('scores an answer that states the lesson as avoided', () => {
    // The other direction, so the predicates are not simply always-false: the
    // claim IS the lesson, so an answer containing it must score as avoided.
    const missed = HARVESTED.filter((c) => !c.avoids(c.claim));
    expect(missed.map((c) => c.id)).toEqual([]);
  });
});
