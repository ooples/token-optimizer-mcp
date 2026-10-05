/**
 * THE REPRODUCTION GATE, ON RECORDS WHOSE ANSWER IS KNOWN IN ADVANCE.
 *
 * The gate's whole job is to refuse, so every case here is either a record that
 * must be refused for exactly one stated reason, or the one record that must be
 * accepted. Two properties beyond the obvious:
 *
 *  - a field is checked for being USABLE, not merely present. Every value in
 *    the `unusable` table below arrived from a real code path that swallowed a
 *    failure: 'unknown' from a git call in a directory that is not a
 *    repository, '' from a digest over a file that was not read, a truncated
 *    sha from a slice applied twice.
 *  - the refusal reports EVERY problem, because each round trip costs a capture
 *    run. A gate that stopped at the first one would turn one re-run into eight.
 */

import { FIELDS, MIN_PASSES, reproducibilityRefusal } from './reproducibility.mjs';

let failures = 0;
const ok = (name, detail = '') => console.log(`ok  ${name}${detail ? ` -- ${detail}` : ''}`);
const bad = (name, detail) => {
  failures++;
  console.log(`FAIL ${name} -- ${detail}`);
};
const check = (cond, name, detail = '') => (cond ? ok(name, detail) : bad(name, detail || 'false'));

/** A record that carries everything, in the shape head-to-head writes it. */
const GOOD = {
  commit: 'a'.repeat(40),
  node: '22.14.0',
  tiktoken: '1.0.22',
  encoding: 'cl100k_base',
  payloadsDigest: '0123456789abcdef',
  theirsDigest: 'fedcba9876543210',
  headroomVersion: '0.37.0',
  stubArms: null,
  python: '3.13.2',
  instrument: 'v1:detect=rust kompress=ready degraded=none witness=yes chunks=6 store=warm',
  dirty: false,
  speedPasses: { ours: 3, theirs: 3 },
};
const without = (field) => {
  const copy = { ...GOOD };
  delete copy[field];
  return copy;
};

// 0. THE TABLE CANNOT BE ITS OWN WITNESS. Section 3 removes each field in
// FIELDS and requires the refusal to name it, which says nothing whatever about
// a field dropped FROM the table -- the loop would simply stop asking for it,
// and every record would pass while carrying less. A parser tested with a list
// it reads from the thing under test always agrees with itself. So the set is
// written out here, by hand, and the count with it.

const REQUIRED = [
  'commit',
  'node',
  'tiktoken',
  'encoding',
  'payloadsDigest',
  'theirsDigest',
  'python',
  'instrument',
];
check(
  Object.keys(FIELDS).length === REQUIRED.length &&
    REQUIRED.every((f) => Object.hasOwn(FIELDS, f)),
  `the required set is exactly the ${REQUIRED.length} fields a re-run needs`,
  Object.keys(FIELDS).join(', ')
);
// AND THE TWO FIELDS THE TABLE DOES NOT HOLD, named here so dropping their
// handling in the module cannot pass. `headroomVersion` is required or forbidden
// depending on `stubArms`, which a flat table cannot express; a conditional rule
// moved out of the table is exactly the rule that goes unchecked.
check(
  !Object.hasOwn(FIELDS, 'headroomVersion') && !Object.hasOwn(FIELDS, 'stubArms'),
  'headroomVersion and stubArms are judged conditionally, not from the table'
);

// 1. The record that needs nothing said about it.

check(reproducibilityRefusal(GOOD) === null, 'a complete record from a clean tree is accepted', String(reproducibilityRefusal(GOOD)));

// 2. Nothing at all, which is what an older record hands the gate.

for (const [label, value] of [
  ['null', null],
  ['undefined', undefined],
  ['a string', 'v2'],
]) {
  const r = reproducibilityRefusal(value);
  check(
    typeof r === 'string' && /no reproduction block/.test(r),
    `${label} in place of a reproduction block is refused`,
    String(r)
  );
}

// 3. EVERY REQUIRED FIELD, ONE AT A TIME. A gate is only as good as its
// weakest field, and a table of fields invites exactly one kind of bug: a
// field listed in the table that nothing ever reads. Removing each one in turn
// and requiring the refusal to NAME it, and to name nothing else, is what makes
// the table load-bearing rather than documentation.

for (const field of Object.keys(FIELDS)) {
  const r = reproducibilityRefusal(without(field));
  const named = typeof r === 'string' && r.includes(`${field} is missing`);
  const only = typeof r === 'string' && r.startsWith('1 thing(s)');
  check(named && only, `a record with no ${field} is refused, and only for that`, String(r));
}

// 3b. THEIR VERSION, WHOSE RULE DEPENDS ON WHETHER THEIR ENGINE RAN. Both arms
// refuse, and that is the point: this started as a single required field, and a
// known-answer capture -- where their engine is never imported -- was stamping
// the installed package version anyway, which named an engine that produced none
// of the column. Loosening the field to accept that would have accepted a
// fabricated provenance on every real capture too.

{
  // A RECORD FROM BEFORE THE FIELD EXISTED is not thereby unreadable: it names a
  // competitor version, which is the question stubArms exists to answer when the
  // version is absent. Refusing it would have meant re-recording every committed
  // capture to add a field that tells a reader nothing those captures do not
  // already say.
  const older = reproducibilityRefusal(without('stubArms'));
  check(older === null, 'a record with a version but no stubArms is accepted', String(older));
  const neither = reproducibilityRefusal({ ...without('stubArms'), headroomVersion: null });
  check(
    typeof neither === 'string' &&
      /headroomVersion is missing/.test(neither) &&
      /stubArms does not say a stub produced their column/.test(neither) &&
      neither.startsWith('1 thing(s)'),
    'but with neither, the refusal names both ways out',
    String(neither)
  );
  const mine = reproducibilityRefusal(without('headroomVersion'));
  check(
    typeof mine === 'string' &&
      mine.includes('headroomVersion is missing') &&
      mine.startsWith('1 thing(s)'),
    'a real capture with no competitor version is refused, as before',
    String(mine)
  );
  const stub = { ...GOOD, stubArms: 'bench/compression/known-answer/arms.py' };
  const named = reproducibilityRefusal(stub);
  check(
    typeof named === 'string' &&
      /headroomVersion is "0[.]37[.]0" on a capture taken with stub arms/.test(named) &&
      /produced none of this column/.test(named) &&
      named.startsWith('1 thing(s)'),
    'a stubbed capture carrying their version is refused, because no engine of theirs ran',
    String(named)
  );
  const honest = reproducibilityRefusal({ ...stub, headroomVersion: null });
  check(
    honest === null,
    'and the same stubbed capture with no version is accepted',
    String(honest)
  );
  // The empty string is not a stub name, so it cannot be a way to claim the
  // lenient arm while saying nothing.
  const blank = reproducibilityRefusal({ ...GOOD, stubArms: '', headroomVersion: null });
  check(
    typeof blank === 'string' && blank.includes('headroomVersion is missing'),
    'an empty stubArms does not buy the stub rule',
    String(blank)
  );
}

// 4. Present and unusable, which reads as recorded and is not.

const unusable = [
  ['commit', 'unknown'],
  ['commit', 'a'.repeat(39)],
  ['payloadsDigest', ''],
  ['payloadsDigest', '0123456789ABCDEF'],
  ['theirsDigest', '0123456789abcde'],
  ['node', 22],
  ['node', 'v22'],
  ['tiktoken', 'latest'],
  ['encoding', 'cl100k base'],
  ['headroomVersion', '0.37'],
  ['python', null],
  // A STORE STATE THE CAPTURE DID NOT LOOK UP is the case this field exists
  // for, and it is not absence: the string is well formed, the sweep ran, and
  // the one term that separates their two engines says nothing.
  ['instrument', 'v1:detect=rust kompress=ready degraded=none witness=yes store=unrecorded'],
  // A FINGERPRINT FROM BEFORE THE STAMP, which is every capture taken so far.
  ['instrument', 'v1:detect=rust kompress=ready degraded=none witness=yes'],
  ['instrument', 'detect=rust store=warm'],
];
for (const [field, value] of unusable) {
  const r = reproducibilityRefusal({ ...GOOD, [field]: value });
  // 'unknown' is the sentinel a failed git call leaves behind, so the gate
  // reports it as absent rather than malformed. Either branch refuses; the
  // case is here for the value, not for which sentence it earns.
  const absent = value === null || value === '' || value === 'unknown';
  const expected = absent ? 'is missing' : 'is not usable';
  check(
    typeof r === 'string' && r.includes(`${field} ${expected}`) && r.startsWith('1 thing(s)'),
    `${field} as ${JSON.stringify(value)} is refused`,
    String(r)
  );
}

// 4b. AND THE TWO INSTRUMENT STRINGS THAT MUST BE ACCEPTED. An empty store is a
// state, not a gap -- it is one of the two experiments the store pair exists to
// run -- and the chunk term is absent on a capture swept in one pass, so a gate
// that required it would refuse every unchunked record.

for (const instrument of [
  'v1:detect=rust kompress=ready degraded=none witness=yes store=empty',
  'v1:detect=python kompress=notready degraded=2 witness=no store=warm',
]) {
  const r = reproducibilityRefusal({ ...GOOD, instrument });
  check(r === null, `${instrument} is accepted`, String(r));
}

// 5. The dirty tree. Its honest value is a refusal, and its absence is another
// one -- a record that does not say whether the tree was clean has not made
// the claim the sha implies.

{
  const r = reproducibilityRefusal({ ...GOOD, dirty: true });
  check(
    typeof r === 'string' && /commit names code that did not run/.test(r),
    'a record from a modified tree is refused, and the reason says why the sha is not enough',
    String(r)
  );
  const absent = reproducibilityRefusal(without('dirty'));
  check(
    typeof absent === 'string' && /dirty is missing/.test(absent),
    'a record that never says whether the tree was clean is refused too',
    String(absent)
  );
}

// 6. The speed passes, per side. The single-pass capture that shipped was on
// THEIR side, so a gate that checked ours only would have passed it.

{
  const r = reproducibilityRefusal({ ...GOOD, speedPasses: { ours: 3, theirs: 1 } });
  check(
    typeof r === 'string' &&
      r.includes('speedPasses.theirs is 1') &&
      !r.includes('speedPasses.ours') &&
      r.startsWith('1 thing(s)'),
    'one pass on their side is refused, and the refusal names their side',
    String(r)
  );
  const mine = reproducibilityRefusal({ ...GOOD, speedPasses: { ours: 1, theirs: 3 } });
  check(
    typeof mine === 'string' && mine.includes('speedPasses.ours is 1') && !mine.includes('speedPasses.theirs'),
    'and one pass on ours is refused the same way',
    String(mine)
  );
  const fractional = reproducibilityRefusal({ ...GOOD, speedPasses: { ours: 2.5, theirs: 3 } });
  check(
    typeof fractional === 'string' && fractional.includes('speedPasses.ours is 2.5'),
    'a fractional pass count is refused, because passes are counted things',
    String(fractional)
  );
  const exact = reproducibilityRefusal({ ...GOOD, speedPasses: { ours: MIN_PASSES, theirs: MIN_PASSES } });
  check(exact === null, `${MIN_PASSES} passes on both sides is enough`, String(exact));
}

// 7. EVERY PROBLEM AT ONCE. The count in the refusal is the part a reader acts
// on: it tells them how many re-runs they are about to save.

{
  const broken = { ...without('node'), commit: 'unknown', dirty: true, speedPasses: { ours: 1, theirs: 1 } };
  const r = reproducibilityRefusal(broken);
  const names = ['node is missing', 'commit is missing', 'did not run', 'speedPasses.ours', 'speedPasses.theirs'];
  check(
    typeof r === 'string' && names.every((n) => r.includes(n)) && r.startsWith('5 thing(s)'),
    'five problems are reported as five, not as the first one',
    String(r)
  );
}

console.log(failures === 0 ? '\nall checks pass' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
