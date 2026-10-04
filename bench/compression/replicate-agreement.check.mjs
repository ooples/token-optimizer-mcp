/**
 * KNOWN ANSWERS FOR THE TWO-RECORDING RULE.
 *
 * Every case here is a claim about what the rule must do, written so that a
 * weakening of the rule fails a named case rather than quietly passing. The
 * cases that matter most are the ones where the rule must REFUSE: a rule that
 * only ever says yes is indistinguishable from no rule, and the copy case is the
 * one that turns the whole mechanism into a no-op if it is missing.
 */
import { disqualify, agreeAcrossRecordings } from './replicate-agreement.mjs';

const rec = ({ dir = 'hr27', commit = 'abc123', refusal = null, rows = {} }) => ({
  capture: { dir },
  reproduction: { commit, refusal },
  workloads: Object.entries(rows).map(([name, oursMsPasses]) => ({
    name,
    speed: { oursMsPasses },
  })),
});

// The judge under test is deliberately trivial: it reads one number off the
// recording and calls anything under 100 a pass. The rule's job is to combine
// two judgements, not to time anything, so a real estimator here would only
// hide which of the two is being exercised.
const judge = (speed) =>
  speed === undefined || speed === null
    ? { pass: null, detail: 'no readings' }
    : { pass: speed.oursMsPasses[0][0] < 100, detail: `read ${speed.oursMsPasses[0][0]}ms` };

const cases = [];
const K = (what, got, want) => cases.push({ what, got, want });

const A = rec({ rows: { row: [[50]] } });
const B = rec({ rows: { row: [[60]] } });

K('two agreeing recordings decide the verdict',
  agreeAcrossRecordings({ judge, primary: A, replicate: B, name: 'row' }).pass, true);

K('two agreeing recordings can also decide a loss',
  agreeAcrossRecordings({
    judge,
    primary: rec({ rows: { row: [[150]] } }),
    replicate: rec({ rows: { row: [[160]] } }),
    name: 'row',
  }).pass, false);

K('a verdict that flips between recordings is undecided, not a loss',
  agreeAcrossRecordings({
    judge,
    primary: A,
    replicate: rec({ rows: { row: [[150]] } }),
    name: 'row',
  }).pass, null);

K('a verdict that flips the other way is also undecided',
  agreeAcrossRecordings({
    judge,
    primary: rec({ rows: { row: [[150]] } }),
    replicate: A,
    name: 'row',
  }).pass, null);

K('one recording alone cannot enforce a pass',
  agreeAcrossRecordings({ judge, primary: A, replicate: null, name: 'row' }).pass, null);

K('one recording alone cannot enforce a loss either',
  agreeAcrossRecordings({
    judge,
    primary: rec({ rows: { row: [[150]] } }),
    replicate: null,
    name: 'row',
  }).pass, null);

K('a copied record is not a second recording',
  disqualify({ primary: A, replicate: rec({ rows: { row: [[50]] } }), name: 'row' }) === null,
  false);

K('a copied record cannot enforce a pass',
  agreeAcrossRecordings({
    judge,
    primary: A,
    replicate: rec({ rows: { row: [[50]] } }),
    name: 'row',
  }).pass, null);

K('a replicate of another capture is not a second recording of this one',
  disqualify({ primary: A, replicate: rec({ dir: 'hr26', rows: { row: [[60]] } }), name: 'row' }) === null,
  false);

K('a replicate at another commit measured different code',
  disqualify({ primary: A, replicate: rec({ commit: 'def456', rows: { row: [[60]] } }), name: 'row' }) === null,
  false);

K('a replicate that refuses its own provenance cannot corroborate',
  disqualify({
    primary: A,
    replicate: rec({ refusal: 'the working tree was modified', rows: { row: [[60]] } }),
    name: 'row',
  }) === null, false);

K('a replicate that does not cover the row cannot corroborate it',
  disqualify({ primary: A, replicate: rec({ rows: { other: [[60]] } }), name: 'row' }) === null,
  false);

K('a valid replicate is not disqualified',
  disqualify({ primary: A, replicate: B, name: 'row' }), null);

K('an already-refused primary keeps its own reason',
  agreeAcrossRecordings({
    judge,
    primary: rec({ rows: {} }),
    replicate: B,
    name: 'row',
  }).detail, 'no readings');

K('an already-refused primary is not overridden by a missing replicate',
  agreeAcrossRecordings({ judge, primary: rec({ rows: {} }), replicate: null, name: 'row' }).detail,
  'no readings');

let bad = 0;
for (const c of cases) {
  if (c.got !== c.want) {
    console.error(`FAIL  ${c.what}\n      got ${JSON.stringify(c.got)} want ${JSON.stringify(c.want)}`);
    bad += 1;
  }
}
console.log(
  bad === 0
    ? `all ${cases.length} checks pass`
    : `${bad} of ${cases.length} checks FAILED`
);
process.exit(bad === 0 ? 0 : 1);
