/**
 * THE INPUT-PARITY PRECONDITION, ON CASES WHOSE ANSWER IS KNOWN IN ADVANCE.
 *
 * Nothing here is captured. Each case states a recorded `input` object and the
 * verdict it must produce, because the interesting cases are the ones a real
 * capture cannot currently produce: every credited winner matches today, so a
 * run over the live record exercises the agreeing branch and nothing else.
 *
 * The four that carry the weight:
 *
 *  - `matching digests are a comparison` -- the case that must not become noisy,
 *    since it is all eighteen of the live rows.
 *  - `different digests are refused` -- the defect, which is a wrapped input
 *    inflating a ratio.
 *  - `a missing field is undecided, never agreement` -- the `if (parity && ...)`
 *    spelling that reads an absent precondition as a satisfied one.
 *  - `a record that contradicts itself is undecided` -- the flag is cross-checked
 *    against the digests it was written beside, so one bug cannot make a row
 *    agree with itself.
 */

import { inputParity } from './input-parity.mjs';

let failures = 0;
const ok = (name, detail = '') => console.log(`ok   ${name}${detail ? ` -- ${detail}` : ''}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`);
};
const check = (cond, name, detail = '') => (cond ? ok(name, detail) : bad(name, detail || 'false'));

const A = '51f5e2ff64f45da6';
const B = '56f08ca9deefa001';

console.log('matching digests are a comparison');
{
  const v = inputParity({ oursDigest: A, theirsDigest: A, same: true });
  check(v.ok === true, 'both columns on the same bytes passes', v.detail);
  check(v.detail.includes(A), 'and the detail names the input, so it can be checked', v.detail);
}

console.log('\ndifferent digests are refused');
{
  const v = inputParity({ oursDigest: A, theirsDigest: B, same: false });
  check(v.ok === false, 'a wrapped input on their side is not a comparison', v.detail);
  check(
    v.detail.includes(A) && v.detail.includes(B),
    'and both digests are named, so the row can be traced to its capture',
    v.detail
  );
  // THE FLAG IS NOT THE AUTHORITY. A record whose `same` was written true while
  // the digests differ must still be refused; otherwise one bug in the recorder
  // lets every row vouch for itself.
  const lying = inputParity({ oursDigest: A, theirsDigest: B, same: true });
  check(
    lying.ok !== true,
    'and a flag that claims agreement cannot override the digests',
    lying.detail
  );
}

console.log('\na missing field is undecided, never agreement');
{
  for (const [label, value] of [
    ['absent', undefined],
    ['null', null],
  ]) {
    const v = inputParity(value);
    check(v.ok === null, `an ${label} parity field is undecided`, v.detail);
    check(v.ok !== true, `and specifically is not a pass when ${label}`, v.detail);
  }
  const half = inputParity({ oursDigest: A, theirsDigest: null, same: true });
  check(half.ok === null, 'one digest missing is undecided too', half.detail);
  const neither = inputParity({});
  check(neither.ok === null, 'and an empty object is undecided', neither.detail);
}

console.log('\na record that contradicts itself is undecided');
{
  const v = inputParity({ oursDigest: A, theirsDigest: A, same: false });
  check(
    v.ok === null,
    'digests that agree under a flag that says they do not',
    v.detail
  );
  check(
    v.detail.includes('contradicts'),
    'and the detail says the record contradicts itself rather than guessing',
    v.detail
  );
  // A record with no flag at all is decided by its digests, because the digests
  // are the measurement and the flag is only a convenience.
  const noFlag = inputParity({ oursDigest: A, theirsDigest: A });
  check(noFlag.ok === true, 'while a record with digests and no flag is decided by them', noFlag.detail);
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
