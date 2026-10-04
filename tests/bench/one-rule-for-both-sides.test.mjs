import { judgeRows, corpusFaults, classifyArms } from '../../bench/compression/offload.mjs';

// One rule for both sides, or the harness is measuring its own handicap.
//
// The harness used to fail the run on `oursTokens <= theirsTokens`, where
// `theirs` is their best arm of ANY kind. Several of their arms reach their
// ratio by writing the payload to a local store -- the exact thing this module
// exists to say is not reduction, and the exact thing our own `sub` arm is
// refused credit for. So the gate held us to a rule it did not hold them to,
// and failed a real, winning run on a figure the harness itself prints as
// "not apples to apples".
//
// These tests pin the rule from both ends: the row lists and the corpus
// verdict. Each block carries a control that breaks the input on purpose, so a
// green run here is a reading and not a blind spot.

const row = (name, ours, theirs, compRatio) => ({ name, ours, theirs, compRatio });

describe('judgeRows scores a row against the arm that still holds the content', () => {
  // Real shapes from the warm capture: their winner deleted the payload, their
  // comparable arm reduced nothing at all.
  const offloadRow = row('codebase-exploration', 0.164, 0.997, 0.0);
  const honestRow = row('issue-triage', 0.628, 0.531, 0.531);

  it('does not call a row lost because their OFFLOADING arm beat us', () => {
    expect(judgeRows([offloadRow]).lost).toEqual([]);
  });

  it('still says out loud that their best-of-any arm is ahead there', () => {
    expect(judgeRows([offloadRow]).behindOffload).toEqual(['codebase-exploration']);
  });

  it('calls a row lost when their COMPARABLE arm beat us', () => {
    const beaten = row('grep-output', 0.3, 0.996, 0.42);
    expect(judgeRows([beaten]).lost).toEqual(['grep-output']);
  });

  it('counts a tie against us, not for us', () => {
    expect(judgeRows([row('tied', 0.5, 0.9, 0.5)]).lost).toEqual(['tied']);
  });

  it('will not pass a row it cannot judge -- it names it instead', () => {
    const noCleanArm = row('all-offloaded', 0.2, 0.99, null);
    const v = judgeRows([noCleanArm]);
    expect(v.lost).toEqual([]);
    expect(v.unjudgeable).toEqual(['all-offloaded']);
  });

  it('keeps the three lists independent', () => {
    const v = judgeRows([offloadRow, honestRow, row('x', 0.2, 0.99, null)]);
    expect(v).toEqual({
      lost: [],
      unjudgeable: ['x'],
      // 'x' trails their best-of-any arm too -- it is unjudgeable AND behind,
      // and the lists are meant to overlap where that is the truth.
      behindOffload: ['codebase-exploration', 'x'],
    });
  });

  // CONTROL: the old rule, run on the same rows, to prove the fixture really
  // does separate the two readings. If this ever comes back empty the rows
  // above have stopped exercising the defect and the tests above prove nothing.
  it('control: the old best-of-any rule fails rows the new rule passes', () => {
    const rows = [offloadRow, honestRow];
    const oldRule = rows.filter((r) => r.ours <= r.theirs).map((r) => r.name);
    expect(oldRule).toEqual(['codebase-exploration']);
    expect(judgeRows(rows).lost).toEqual([]);
  });
});

describe('corpusFaults judges reduction and store as two columns', () => {
  // The measured warm capture, to one decimal: we lead like-for-like and on the
  // store column, and trail only on the mixed comparison.
  const measured = {
    subGone: 0,
    oursChars: 0.726,
    theirsChars: 0.516,
    like4likeOurs: 0.559,
    like4likeTheirs: 0.318,
    subTokens: 1.0,
    theirsTokens: 0.596,
  };

  it('passes the real measurement', () => {
    expect(corpusFaults(measured)).toEqual([]);
  });

  it('does not fault us for trailing their offloading arm on tokens', () => {
    expect(measured.like4likeOurs).toBeLessThan(measured.theirsTokens);
    expect(corpusFaults(measured)).not.toContain('reduction-like-for-like');
  });

  it('faults a genuine like-for-like loss', () => {
    const lost = { ...measured, like4likeOurs: 0.2 };
    expect(corpusFaults(lost)).toEqual(['reduction-like-for-like']);
  });

  it('faults a missing like-for-like number instead of passing it', () => {
    expect(corpusFaults({ ...measured, like4likeOurs: null })).toContain('no-like-for-like');
    expect(corpusFaults({ ...measured, like4likeTheirs: null })).toContain('no-like-for-like');
  });

  it('faults a substitution arm that cannot give its content back', () => {
    expect(corpusFaults({ ...measured, subGone: 1 })).toEqual(['sub-arm-lost-content']);
  });

  it('faults losing the store column', () => {
    expect(corpusFaults({ ...measured, subTokens: 0.4 })).toEqual(['store-column']);
  });

  it('faults losing chars', () => {
    expect(corpusFaults({ ...measured, oursChars: 0.4 })).toEqual(['chars']);
  });

  it('names every fault at once rather than stopping at the first', () => {
    expect(corpusFaults({ subGone: 3, oursChars: 0.1, theirsChars: 0.9, like4likeOurs: null, like4likeTheirs: null, subTokens: 0.1, theirsTokens: 0.9 })).toEqual([
      'sub-arm-lost-content',
      'chars',
      'no-like-for-like',
      'store-column',
    ]);
  });

  // CONTROL: the gate this replaced, on the same measurement. It fails. That is
  // the whole point, and if it ever stops failing this fixture has gone stale.
  it('control: the old single gate fails the run the new one passes', () => {
    const oldGate = 0.559 <= measured.theirsTokens;
    expect(oldGate).toBe(true);
    expect(corpusFaults(measured)).toEqual([]);
  });
});

describe('the reduction/offload split the verdict rests on', () => {
  const arms = {
    // The marker is 27 characters, so the before-text has to be big enough for
    // parking to actually beat encoding -- otherwise the fixture ranks the
    // encoded arm first and tests nothing about offload at all.
    encoded: { text: 'a'.repeat(400), beforeText: 'a'.repeat(1000) },
    parked: { text: '<<ccr:deadbeef,text,9.0KB>>', beforeText: 'a'.repeat(1000) },
  };

  it('picks the parked arm as best-of-any and the encoded arm as comparable', () => {
    const split = classifyArms(arms, { size: (s) => s.length });
    expect(split.any.label).toBe('parked');
    expect(split.clean.label).toBe('encoded');
    expect(split.comparable).toBe(true);
  });

  // CONTROL: with nothing but offloading arms there is no comparable reading,
  // which is the case `judgeRows` refuses to score and `corpusFaults` refuses
  // to pass.
  it('control: reports no comparable arm when every arm parked its bytes', () => {
    const split = classifyArms({ parked: arms.parked }, { size: (s) => s.length });
    expect(split.clean).toBeNull();
    expect(split.comparable).toBe(false);
  });
});
