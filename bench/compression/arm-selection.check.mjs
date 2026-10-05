/**
 * ARM SELECTION, ON CASES WHOSE ANSWER IS KNOWN IN ADVANCE.
 *
 * Nothing here is captured. The numbers in the first section are the real ones
 * from grep-output -- their `crusher` arm at 0.4% of input keeping 4 of 1045
 * identifiers, against a `pipeline` arm at 100.0% keeping all of them -- because
 * that row is the one that made the old single-column gate report a speed
 * regression against the time it takes to delete a payload.
 *
 * The cases that carry the weight:
 *
 *  - `a destructive arm is still the best-of-any arm` -- the comparable column
 *    must not replace the hard bar, only stand beside it.
 *  - `an unknown retained count refuses instead of defaulting to zero` -- a zero
 *    default makes every arm comparable, including the one keeping 4 of 1045,
 *    which is the exact bar this instrument exists to stop.
 *  - `retention keeps one column` -- and the reason is asserted, not assumed,
 *    because a silent omission in the scorer cannot be tested.
 *  - `a decided loss outranks an undecided column` -- the three-state ordering.
 *  - `a missing second column is undecided, never agreement`.
 */
import { bestByRatio, bothColumns, columnsFor, selectArms } from './arm-selection.mjs';

let failures = 0;
const ok = (name, detail = '') => console.log(`ok   ${name}${detail ? ` -- ${detail}` : ''}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`);
};
const check = (cond, name, detail = '') => (cond ? ok(name, detail) : bad(name, detail || 'false'));

// grep-output, as captured: 75,399 characters in, 1045 scorable identifiers, and
// we keep 1005 of them.
const GREP = [
  { arm: 'crusher', before: 75399, after: 284, retained: 4 },
  { arm: 'crusher-lossy-ccr', before: 75399, after: 1120, retained: 11 },
  { arm: 'router', before: 75399, after: 32120, retained: 402 },
  { arm: 'pipeline@0.10', before: 75447, after: 75447, retained: 1045 },
  { arm: 'pipeline@2.00', before: 75447, after: 75447, retained: 1045 },
];

console.log('a destructive arm is still the best-of-any arm');
{
  const s = selectArms(GREP, { ourRetained: 1005 });
  check(s.best.arm === 'crusher', 'the ratio winner is unchanged by this instrument', s.detail);
  check(s.best.retained === 4, 'and it carries what it actually kept, so the row can say so', s.detail);
  check(
    s.comparable.arm === 'pipeline@0.10',
    'while the comparable arm is their best that kept at least our 1005',
    s.detail
  );
  check(
    s.comparable.ratio === 1,
    'which on this workload compressed nothing at all',
    String(s.comparable.ratio)
  );
  check(
    s.comparable.ratio >= s.best.ratio,
    'and can never be a looser bar than the best-of-any arm on ratio',
    `${s.comparable.ratio} >= ${s.best.ratio}`
  );
}

console.log('\nan arm that kept less than ours is never comparable');
{
  // The same capture, with the two pipeline arms removed: nothing left retained
  // our 1005, so there is no comparable column -- and that is a null, not the
  // next-best arm.
  const s = selectArms(GREP.slice(0, 3), { ourRetained: 1005 });
  check(s.best.arm === 'crusher', 'the best-of-any column still resolves', s.detail);
  check(s.comparable === null, 'and the comparable column is absent rather than approximated', s.detail);
  check(
    s.detail.includes('no arm of theirs retained our 1005'),
    'with a detail that says so in the units it was decided in',
    s.detail
  );
}

console.log('\nan arm that kept exactly what we kept is the tightest honest bar');
{
  // THE BOUNDARY, PINNED. "Comparable" is `retained >= ours`, and the arm that
  // kept EXACTLY what we kept is the best opponent that exists: it concedes us
  // nothing on retention and gives their compression its strongest showing.
  // Spelling the test `>` instead of `>=` skips it and falls through to a looser
  // arm or to no column at all -- a substitution that reads as a stricter rule
  // while actually discarding the hardest bar. Nothing else in this file fails
  // if that boundary moves, so it is asserted here on its own.
  const EXACT = [
    { arm: 'exact', before: 1000, after: 400, retained: 1005 },
    { arm: 'generous', before: 1000, after: 900, retained: 1045 },
    { arm: 'lossy', before: 1000, after: 10, retained: 4 },
  ];
  const s = selectArms(EXACT, { ourRetained: 1005 });
  check(s.best.arm === 'lossy', 'their best-of-any arm is still the lossy one', s.detail);
  check(
    s.comparable !== null && s.comparable.arm === 'exact',
    'and the arm that tied our retention IS the comparable one',
    s.detail
  );
  // And it wins the comparable slot on ratio even though a looser arm also
  // qualifies, so the boundary case is not being reached by accident.
  check(
    s.comparable !== null && s.comparable.ratio === 0.4,
    'chosen on ratio among the arms that qualified, not merely first in the list',
    s.detail
  );
}

console.log('\nan unknown retained count refuses instead of defaulting to zero');
{
  for (const [label, ours] of [
    ['absent', {}],
    ['null', { ourRetained: null }],
    ['not a number', { ourRetained: '1005' }],
    ['negative', { ourRetained: -1 }],
    ['no object', undefined],
  ]) {
    const s = selectArms(GREP, ours);
    check(
      s.best === null && s.comparable === null,
      `${label} refuses both columns`,
      s.detail
    );
  }
  // The defect this guards: a zero default would make `crusher` comparable to
  // itself and the destructive arm would be scored as a like-for-like.
  const zero = selectArms(GREP, { ourRetained: 0 });
  check(
    zero.comparable !== null && zero.comparable.arm === 'crusher',
    'a genuine zero, by contrast, does make every arm comparable',
    zero.detail
  );
}

console.log('\na capture that cannot be ranked is refused, not ranked anyway');
{
  const empty = selectArms([], { ourRetained: 10 });
  check(empty.best === null && empty.comparable === null, 'no arms at all refuses', empty.detail);
  check(
    selectArms(null, { ourRetained: 10 }).best === null,
    'and so does a missing arms list',
    'null'
  );
  const zeroBefore = selectArms(
    [{ arm: 'router', before: 0, after: 0, retained: 5 }],
    { ourRetained: 1 }
  );
  check(
    zeroBefore.best === null,
    'a ratio over a zero denominator refuses rather than reading as 0% or 100%',
    zeroBefore.detail
  );
  const noRetained = selectArms(
    [
      { arm: 'router', before: 100, after: 50, retained: 5 },
      { arm: 'crusher', before: 100, after: 10 },
    ],
    { ourRetained: 1 }
  );
  check(
    noRetained.best === null,
    'an arm with no retained count refuses the whole selection',
    noRetained.detail
  );
  check(
    noRetained.detail.includes('crusher'),
    'and names the arm, because dropping it quietly would substitute a worse bar',
    noRetained.detail
  );
  const unnamed = selectArms([{ before: 100, after: 10, retained: 5 }], { ourRetained: 1 });
  check(unnamed.best === null, 'an arm with no name refuses', unnamed.detail);
}

console.log('\nties break by name, so two runs select the same arm');
{
  const tied = [
    { arm: 'router', before: 100, after: 40, retained: 9 },
    { arm: 'crusher', before: 100, after: 40, retained: 9 },
  ];
  const a = selectArms(tied, { ourRetained: 9 });
  const b = selectArms([...tied].reverse(), { ourRetained: 9 });
  check(a.best.arm === 'crusher', 'the lexicographically first arm wins a tie', a.detail);
  check(a.best.arm === b.best.arm, 'and input order does not change the selection', b.detail);
}

console.log('\nretention keeps one column, and says why');
{
  const r = columnsFor('retention');
  check(r.columns.length === 1 && r.columns[0] === 'best', 'retention is scored against best-of-any only', r.columns.join(','));
  check(
    r.reason.includes('tests nothing'),
    'and the reason is recorded in code, because an omission cannot be tested',
    r.reason
  );
  for (const c of ['cost', 'turns', 'speed']) {
    const got = columnsFor(c);
    check(
      got.columns.length === 2 && got.columns[0] === 'best' && got.columns[1] === 'comparable',
      `${c} is scored against both arms`,
      got.columns.join(',')
    );
  }
  const unknown = columnsFor('chars');
  check(unknown.columns.length === 0, 'an unknown criterion gets no columns rather than a default', unknown.reason);
}

console.log('\nwin both or it is not a win');
{
  const P = { pass: true, detail: 'ok' };
  const F = { pass: false, detail: 'NO' };
  const U = { pass: null, detail: 'undecided' };
  check(bothColumns(P, P).pass === true, 'a pass on both columns is a pass');
  check(bothColumns(P, F).pass === false, 'a loss on the comparable column is a loss');
  check(bothColumns(F, P).pass === false, 'a loss on the best-of-any column is a loss');
  // THE ORDERING. A decided loss outranks an undecided column, because a
  // measurement that refutes the claim refutes it whether or not the other
  // column could be read.
  check(bothColumns(F, U).pass === false, 'a decided loss outranks an undecided column');
  check(bothColumns(U, F).pass === false, 'in either position');
  check(bothColumns(P, U).pass === null, 'an undecided column is never a pass');
  check(bothColumns(U, P).pass === null, 'in either position');
  check(bothColumns(U, U).pass === null, 'two undecided columns stay undecided');
  // A MISSING SECOND COLUMN IS UNDECIDED, NEVER AGREEMENT.
  check(bothColumns(P).pass === null, 'a missing second column is undecided, not a pass on it');
  check(bothColumns(P, null).pass === null, 'and so is an explicit null column');
  check(bothColumns(P, {}).pass === null, 'and so is a column object with no verdict in it');
  check(
    bothColumns(P, { pass: 'yes', detail: 'x' }).pass === null,
    'a verdict that is not a boolean reads as undecided, never as true'
  );
  const d = bothColumns(P, F).detail;
  check(
    d.includes('vs best:') && d.includes('vs comparable:'),
    'and the detail names both columns, so a red row says which arm beat us',
    d
  );
}

console.log('\na ratio tie is broken on measured time, not on the name');
{
  // THE REAL browser-session SHAPE. Three of their arms emit byte-identical
  // output there -- 611859 from 782294, so all three sit at exactly 0.7821 and
  // the ratio cannot separate them -- while their measured times are 284.4ms,
  // 16.7ms and 15.8ms. Broken by name this picks `crusher`; broken the way the
  // capture enumerated it, `router`, which is 18x slower for THE SAME BYTES. A
  // speed claim scored against that arm is inflated by their arm selection
  // rather than by our code, so the fastest of the tied arms is the opponent.
  const TIED = [
    { arm: 'router', before: 782294, after: 611859, retained: 334, ms: 284.448 },
    { arm: 'crusher', before: 782294, after: 611859, retained: 334, ms: 16.683 },
    { arm: 'crusher-lossy-ccr', before: 782294, after: 611859, retained: 334, ms: 15.769 },
    { arm: 'pipeline@0.10', before: 782294, after: 782294, retained: 334, ms: 58.497 },
  ];
  const s = selectArms(TIED, { ourRetained: 334 });
  check(
    s.best.arm === 'crusher-lossy-ccr',
    'the fastest of the tied arms is their best-of-any arm',
    s.detail
  );
  check(
    s.comparable !== null && s.comparable.arm === 'crusher-lossy-ccr',
    'and the comparable column lands on it too, since it kept what we kept',
    s.detail
  );
  const b = bestByRatio(TIED);
  check(
    b !== null && b.arm === s.best.arm,
    'bestByRatio names the SAME arm selectArms calls best, so the capture and the ' +
      'scorer cannot each pick their own',
    String(b === null ? 'refused' : b.arm) + ' vs ' + s.best.arm
  );
}

console.log('\nan arm the capture never timed cannot win a tie on speed');
{
  // NOT REFUSED -- a tie in ratio with one missing time is still decidable on the
  // arms that do have one. But an unmeasured time must not be treated as fast:
  // `null` sorts after any number, or the tie-break would prefer exactly the arm
  // nobody measured.
  const UNTIMED = [
    { arm: 'aaa-untimed', before: 1000, after: 400, retained: 50 },
    { arm: 'zzz-timed', before: 1000, after: 400, retained: 50, ms: 99.0 },
  ];
  const s = selectArms(UNTIMED, { ourRetained: 50 });
  check(
    s.best.arm === 'zzz-timed',
    'the timed arm wins the tie even though the untimed one sorts first by name',
    s.detail
  );
}

console.log('\nbestByRatio refuses rather than guessing');
{
  check(bestByRatio([]) === null, 'an empty arm list has no best arm');
  check(bestByRatio(null) === null, 'and neither does a missing one');
  check(
    bestByRatio([{ arm: '', before: 10, after: 1 }]) === null,
    'an unnamed arm refuses the whole ranking'
  );
  check(
    bestByRatio([{ arm: 'a', before: 0, after: 1 }]) === null,
    'so does a zero denominator, which is not a ratio'
  );
  check(
    bestByRatio([{ arm: 'a', before: 10, after: Number.NaN }]) === null,
    'and so does an arm whose output length was never recorded'
  );
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
