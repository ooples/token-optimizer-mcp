/**
 * THE LOAD WITNESS, ON CASES WHOSE ANSWER IS KNOWN IN ADVANCE.
 *
 * Nothing here times anything. The witness itself is a clock reading and cannot
 * be asserted against a constant; what CAN be asserted is every decision made
 * from it, and those are the decisions that move a published speed row from
 * enforced to unmeasured.
 *
 * The cases that carry the weight:
 *
 *  - `a missing witness on either side is not agreement` -- an unmeasured load is
 *    not a controlled one, and this is the defect that would quietly restore the
 *    cross-session comparison the witness exists to stop.
 *  - `the band is a ratio, not a difference` -- 5ms apart means nothing without
 *    knowing whether the readings were 45ms or 4500ms.
 *  - `the drift is measured against the smaller reading` -- dividing by the larger
 *    understates every drift, so a run just outside the band reads as inside it.
 *  - `the checksum is asserted` -- a loop that was shortened or optimised away
 *    reports a small number and reads as a quiet machine, which is the failure
 *    that makes every contaminated run look clean.
 */

import { WITNESS_BAND, witness, witnessOnce, witnessesAgree } from './load-witness.mjs';

let failures = 0;
const check = (cond, what, detail) => {
  if (cond) console.log(`ok   ${what}${detail === undefined ? '' : ` -- ${detail}`}`);
  else {
    failures += 1;
    console.log(`FAIL ${what}${detail === undefined ? '' : ` -- ${detail}`}`);
  }
};

console.log('the loop provably ran');
{
  const a = witnessOnce();
  const b = witnessOnce();
  check(a.checksum === b.checksum, 'the checksum is deterministic', String(a.checksum));
  check(a.ms > 0 && b.ms > 0, 'and both readings are positive times', `${a.ms} / ${b.ms}`);
  const w = witness(2);
  check(w.samples.length === 2, 'witness(2) takes exactly two readings');
  check(
    w.ms === Math.max(...w.samples) || w.samples.includes(w.ms),
    'and its reported time is one of them',
    `${w.ms} in [${w.samples.join(', ')}]`
  );
  check(w.checksum === a.checksum, 'the pooled reading carries the same checksum');
}

console.log('\na missing witness on either side is not agreement');
{
  // THE DEFECT SPELLING IS `if (theirs && drift <= band)`, which reads an absent
  // witness as a controlled machine and silently restores exactly the
  // uncontrolled cross-session comparison this file exists to refuse.
  check(witnessesAgree(null, { ms: 45 }).ok === false, 'no witness of ours refuses');
  check(witnessesAgree({ ms: 45 }, null).ok === false, 'no witness of theirs refuses');
  check(witnessesAgree(null, null).ok === false, 'and neither side witnessed refuses');
  check(
    witnessesAgree(undefined, { ms: 45 }).detail.includes('no our load witness recorded'),
    'and the refusal names which side was not witnessed',
    witnessesAgree(undefined, { ms: 45 }).detail
  );
  check(witnessesAgree({ ms: 0 }, { ms: 45 }).ok === false, 'a zero reading is not a time');
  check(
    witnessesAgree({ ms: Number.NaN }, { ms: 45 }).ok === false,
    'and neither is a non-finite one'
  );
  check(
    witnessesAgree({ ms: -45 }, { ms: 45 }).ok === false,
    'and neither is a negative one'
  );
}

console.log('\nthe band is a ratio, not a difference');
{
  // 5ms apart is inside any sane band at 4500ms and far outside it at 45ms. A
  // subtraction here would pass the second case, which is the real one: the
  // witness reads about 45ms.
  check(witnessesAgree({ ms: 45 }, { ms: 50 }).ok === false, '45 vs 50 is 11% and refused');
  check(witnessesAgree({ ms: 4500 }, { ms: 4505 }).ok === true, '4500 vs 4505 is 0.1% and fine');
  check(witnessesAgree({ ms: 45 }, { ms: 45 }).ok === true, 'identical readings agree');
  check(
    witnessesAgree({ ms: 45 }, { ms: 49.5 }).ok === true,
    'exactly at the band is inside it, not outside',
    `band ${WITNESS_BAND}`
  );
}

console.log('\nthe drift is measured against the smaller reading');
{
  // DIVIDING BY THE LARGER UNDERSTATES EVERY DRIFT. 100 vs 112 is 12% of 100 and
  // 10.7% of 112: the first is refused, the second passes a 10% band. The smaller
  // reading is the quiet machine, and the question is how much slower the other
  // one was than that.
  const r = witnessesAgree({ ms: 100 }, { ms: 112 });
  check(r.ok === false, '100 vs 112 is a 12% drift and refused', r.detail);
  check(r.detail.includes('12.0%'), 'and the reported drift is the one against 100', r.detail);
  const s = witnessesAgree({ ms: 112 }, { ms: 100 });
  check(s.ok === false, 'and the same pair refuses in the other order too', s.detail);
}

console.log('\nthe contamination that forced this file would be refused');
{
  // THE MEASURED CASE. Two runs of the same recording, minutes apart, moved our
  // own medians by 33% (grep-output) to 122% (agent-loop-logs). A witness band
  // that admitted either of those would admit the runs it exists to catch.
  check(witnessesAgree({ ms: 45 }, { ms: 45 * 1.33 }).ok === false, 'the mildest, 33%, refuses');
  check(witnessesAgree({ ms: 45 }, { ms: 45 * 2.22 }).ok === false, 'the worst, 122%, refuses');
}

console.log('\na number is accepted where an object is');
{
  // run-theirs.py records the witness as an object; a caller holding only the
  // median should not have to wrap it to ask the question.
  check(witnessesAgree(45, 45).ok === true, 'two bare numbers agree');
  check(witnessesAgree(45, 60).ok === false, 'and two that differ do not');
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
