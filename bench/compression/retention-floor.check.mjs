/**
 * THE RETENTION MUST-WIN, CHECKED ON READINGS WHOSE ANSWER IS KNOWN IN ADVANCE.
 *
 * The criterion decided real verdicts for months with no test of its own, and it
 * was wrong in a way no capture could reveal: the bar was an absolute count of
 * identifiers, the denominator of that count belongs to the instrument, and when
 * the instrument was corrected nine rows reported a regression while holding
 * every unit available to them. Nothing here is captured or timed; each case
 * states the numbers and the answer they must produce.
 *
 * The four that carry the weight:
 *
 *  - `a corrected denominator is not a regression` -- the defect itself.
 *  - `one more unit dropped is a regression, at any denominator` -- the property
 *    that keeps the fix strict rather than merely quiet.
 *  - `a floor with no denominator is refused, not compared` -- undecided is never
 *    a pass, the same third state speed uses.
 *  - `an empty denominator is not a perfect score` -- the "0 for us, 0 for them"
 *    tie this project published once.
 */

import { retentionVerdict, tightenFloor } from './retention-floor.mjs';

let failures = 0;
const ok = (name, detail = '') => console.log(`ok   ${name}${detail ? ` -- ${detail}` : ''}`);
const bad = (name, detail) => {
  failures++;
  console.log(`FAIL ${name} -- ${detail}`);
};
const check = (cond, name, detail = '') => (cond ? ok(name, detail) : bad(name, detail || 'false'));

// --------------------------------------------------- the defect, as a reading
// agent-loop-logs, before and after the scan stopped admitting units that were
// not substrings of their own payload. Both readings hold every unit there was.
console.log('a corrected denominator is not a regression');
{
  const before = retentionVerdict({
    ids: 2042,
    ours: 2042,
    theirs: 2042,
    story: 2043,
    floor: null,
  });
  check(
    before.pass === true,
    'the wider denominator passes, the story bar capped at what the payload holds',
    before.detail
  );
  check(
    before.detail.includes('capped to the 2042'),
    'and the cap is stated, not silent',
    before.detail
  );
  const floor = tightenFloor(undefined, { ids: 2042, lost: before.lost });
  check(
    floor.lost === 0 && floor.ids === 2042,
    'and records the loss it achieved, with the denominator it was taken over',
    JSON.stringify(floor)
  );
  const after = retentionVerdict({
    ids: 2034,
    ours: 2034,
    theirs: 2034,
    story: 2043,
    floor,
  });
  check(
    after.pass === true,
    'the narrower denominator still passes, though 2034 < the old 2042',
    after.detail
  );
  // THE OLD RULE, STATED, so this file records what it was rather than only
  // what replaced it: `ours >= max(story, retainedFloor)` is 2034 >= 2043,
  // which is false, and that false was the nine reported regressions.
  check(2034 < Math.max(2043, 2042), 'and the retained-count rule would have failed it');
}

// ------------------------------------------- and the strictness it must keep
console.log('\none more unit dropped is a regression, at any denominator');
{
  const floor = { lost: 0, ids: 2042 };
  const r = retentionVerdict({ ids: 2034, ours: 2033, theirs: 2034, story: 5, floor });
  check(r.pass === false, 'one unit lost against a recorded zero fails', r.detail);
  check(r.lost === 1, 'and the loss is reported as one', String(r.lost));
  // A LOW STORY BAR MUST NOT LICENSE IT. codebase-exploration's story asks for
  // 5 units; the row has held all 537 for months. Without the ratchet the bar
  // alone would let 532 of them go.
  const slack = retentionVerdict({ ids: 537, ours: 5, theirs: 537, story: 5, floor: { lost: 0, ids: 537 } });
  check(
    slack.pass === false,
    'and the story bar alone cannot license giving up a perfect result',
    slack.detail
  );
  // A denominator that GREW carries units we now drop, and they count.
  const grown = retentionVerdict({ ids: 2100, ours: 2034, theirs: 2100, story: 5, floor });
  check(grown.pass === false, 'a wider denominator we do not keep up with fails', grown.detail);
  // The ratchet only tightens.
  check(
    tightenFloor({ lost: 0, ids: 2042 }, { ids: 2034, lost: 7 }).lost === 0,
    'and a worse run never loosens the floor'
  );
  check(
    tightenFloor({ lost: 7, ids: 2042 }, { ids: 2034, lost: 3 }).lost === 3,
    'while a better one tightens it'
  );
  check(
    tightenFloor({ lost: 7, ids: 2042 }, { ids: null, lost: null }).lost === 7,
    'and a run that could not measure the loss leaves it alone'
  );
}

// --------------------------------------------------------- the third state
console.log('\nundecided is never a pass');
{
  const legacy = retentionVerdict({ ids: 2034, ours: 2034, theirs: 2034, story: 5, floor: 2050 });
  check(
    legacy.pass === null,
    'a floor with no denominator is refused, not compared',
    legacy.detail
  );
  check(
    legacy.detail.includes('re-derive'),
    'and says what to do about it',
    legacy.detail
  );
  const empty = retentionVerdict({ ids: 0, ours: 0, theirs: 0, story: 'ceiling', floor: null });
  check(empty.pass === null, 'an empty denominator is not a perfect score', empty.detail);
  const missing = retentionVerdict({ ids: null, ours: null, theirs: null, story: 5, floor: null });
  check(missing.pass === null, 'and neither is a capture that did not record it', missing.detail);
  const notMustWin = retentionVerdict({ ids: 185, ours: 185, theirs: 185, story: null, floor: null });
  check(
    notMustWin.pass === null && notMustWin.lost === 0,
    'a row that is not a must-win reports no verdict, but still reports its loss',
    notMustWin.detail
  );
  // THE LABEL MUST STAY TRUE. `'ceiling'` names THEIR column; the bar is the
  // full denominator only because their column sits there.
  const fell = retentionVerdict({ ids: 334, ours: 334, theirs: 300, story: 'ceiling', floor: null });
  check(
    fell.pass === null,
    'and a bar named for their ceiling is refused once their column leaves it',
    fell.detail
  );
  const held = retentionVerdict({ ids: 334, ours: 334, theirs: 334, story: 'ceiling', floor: null });
  check(held.pass === true, 'while a column that is still at the ceiling passes', held.detail);
}

console.log(
  failures === 0
    ? '\nall checks passed'
    : `\n${failures} check(s) failed`
);
process.exit(failures === 0 ? 0 : 1);
