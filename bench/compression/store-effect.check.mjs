/**
 * THE PAIR MEASUREMENT, ON PAIRS WHOSE ANSWER IS KNOWN IN ADVANCE.
 *
 * The failure mode this file is weighted against is the flattering one: a pair
 * that is not one variable apart, read as though it were, lets the store take the
 * credit or the blame for an engine difference -- and a pair that IS one variable
 * apart, read as a replicate pair, turns a real dependency into "the instrument
 * could not resolve it" and files it under undecided.
 *
 * The cases that carry the weight:
 *
 *  - `a pair one variable apart is measurable` -- without it every clause below
 *    could refuse everything and the file would still pass.
 *  - `the same store state twice measures nothing` -- the pair a rushed re-run
 *    produces, and the one that looks most like a valid measurement.
 *  - `an instrument that differs in more than the store` -- the store would
 *    otherwise be credited with a lost native detector.
 *  - `a disagreement is a dependency, not an average` -- the claim rule itself.
 */

import { notOneVariableApart, pairing, storeEffect, storeStateOf, withoutStoreTerm } from './store-effect.mjs';

let failures = 0;
const check = (cond, what, detail) => {
  if (cond) console.log(`ok   ${what}${detail === undefined ? '' : ` -- ${detail}`}`);
  else {
    failures += 1;
    console.log(`FAIL ${what}${detail === undefined ? '' : ` -- ${detail}`}`);
  }
};

const BASE = 'v1:detect=rust kompress=ready degraded=none witness=yes chunks=6';
const COMMIT = 'c'.repeat(40);
const side = (label, state, over) => ({
  label,
  fingerprint: state === null ? BASE : `${BASE} store=${state}`,
  commit: COMMIT,
  payloadsDigest: 'deadbeefdeadbeef',
  verdicts: {},
  ...over,
});

console.log('reading the store term out of a fingerprint');
{
  check(storeStateOf(`${BASE} store=empty`) === 'empty', 'an empty store');
  check(storeStateOf(`${BASE} store=warm`) === 'warm', 'a warm one');
  check(storeStateOf(BASE) === null, 'a capture that never recorded it');
  check(storeStateOf(undefined) === null, 'no fingerprint at all');
  // THE REST OF THE FINGERPRINT IS WHAT THE PAIR HOLDS FIXED, so stripping has to
  // leave it byte-identical to a capture that carries no store term at all.
  check(withoutStoreTerm(`${BASE} store=warm`) === BASE, 'stripping leaves the rest exactly');
  check(withoutStoreTerm(BASE) === BASE, 'and is a no-op when there is no term');
}

console.log('\nwhat disqualifies a pair from measuring the store');
{
  check(notOneVariableApart(side('A', 'empty'), side('B', 'warm')) === null, 'a pair one variable apart is measurable');
  const same = notOneVariableApart(side('A', 'warm'), side('B', 'warm'));
  check(same !== null, 'the same store state twice measures nothing', same);
  check(String(same).includes('measures nothing about it'), 'and says so in those terms');
  const unstamped = notOneVariableApart(side('A', null), side('B', 'warm'));
  check(unstamped !== null, 'a capture with no store stamp', unstamped);
  check(String(unstamped).startsWith('A '), 'names the side that is missing it');
  // PRESENT AND UNUSABLE IS THE CASE THAT READS AS RECORDED.
  const bad = notOneVariableApart(side('A', 'unrecorded'), side('B', 'warm'));
  check(bad !== null && String(bad).includes('unusable'), 'an unusable stamp is not a state', bad);
  const code = notOneVariableApart(side('A', 'empty'), side('B', 'warm', { commit: 'd'.repeat(40) }));
  check(code !== null && String(code).includes('different code'), 'two commits', code);
  const corpus = notOneVariableApart(side('A', 'empty'), side('B', 'warm', { payloadsDigest: 'f00d' }));
  // AND NEITHER GUARD MAY PASS FOR WANT OF A STAMP. A record with no reproduction
  // block gives both sides null, the two comparisons above are then false, and the
  // pair would read as having been checked for code and corpus when it was not.
  const noCommit = notOneVariableApart(side('A', 'empty', { commit: null }), side('B', 'warm'));
  check(noCommit !== null, 'an unrecorded commit is refused, not treated as a match', noCommit);
  check(String(noCommit).includes('A '), 'and names the side missing it', noCommit);
  const bothNoCommit = notOneVariableApart(
    side('A', 'empty', { commit: null }),
    side('B', 'warm', { commit: null })
  );
  check(bothNoCommit !== null, 'two unrecorded commits are still not equal commits', bothNoCommit);
  const noCorpus = notOneVariableApart(
    side('A', 'empty', { payloadsDigest: null }),
    side('B', 'warm', { payloadsDigest: null })
  );
  check(
    noCorpus !== null && String(noCorpus).includes('which payloads'),
    'and the same for the corpus digest',
    noCorpus
  );
  check(corpus !== null && String(corpus).includes('different payload sets'), 'two corpora', corpus);
  // THE CLAUSE THE STRIPPED COMPARISON EXISTS FOR. A pair captured across a lost
  // native detector differs in the store term AND in a term that moves the same
  // columns, and the store would be credited with all of it.
  const engine = notOneVariableApart(
    side('A', 'empty'),
    { ...side('B', 'warm'), fingerprint: 'v1:detect=python kompress=ready degraded=none witness=yes chunks=6 store=warm' }
  );
  check(engine !== null && String(engine).includes('more than the store'), 'a different detector backend', engine);
  // AND A DIFFERENT CHUNK SPLIT, which is the same trap by the other term.
  const split = notOneVariableApart(
    side('A', 'empty'),
    { ...side('B', 'warm'), fingerprint: `${BASE.replace('chunks=6', 'chunks=3')} store=warm` }
  );
  check(split !== null && String(split).includes('more than the store'), 'a different chunk split', split);
}

console.log('\na disagreement is a dependency, not an average');
{
  check(pairing(true, true) === 'agree-pass', 'passing from either store is a claim');
  check(pairing(false, false) === 'agree-fail', 'failing from either is a loss');
  check(pairing(true, false) === 'needs-empty-store', 'passing only from empty names the state it needs');
  check(pairing(false, true) === 'needs-warm-store', 'and passing only from warm names the other');
  // A REFUSED CRITERION SAYS NOTHING ABOUT THE STORE. Reading null as agreement
  // would count the gate declining to decide as a win under both states.
  check(pairing(null, true) === 'undecided', 'an unresolved criterion on one side');
  check(pairing(true, null) === 'undecided', 'or the other');
  check(pairing(null, null) === 'undecided', 'or both');
}

console.log('\nthe whole pair, over a corpus');
{
  const v = (cost, speed) => ({ issue: 442, cost: { pass: cost, detail: `cost ${cost}` }, speed: { pass: speed, detail: `speed ${speed}` } });
  const empty = side('empty-store', 'empty', {
    verdicts: { alpha: v(true, true), beta: v(true, null), gamma: v(false, false) },
  });
  const warm = side('warm-store', 'warm', {
    verdicts: { alpha: v(true, true), beta: v(false, null), gamma: v(true, false) },
  });
  const r = storeEffect({ empty, warm });
  check(r.refusal === null, 'the pair is measurable');
  check(r.summary.criteria === 6, 'every criterion on both sides is paired', String(r.summary.criteria));
  check(r.summary.agreePass === 2, 'two hold from either store', String(r.summary.agreePass));
  check(r.summary.agreeFail === 1, 'one fails from either', String(r.summary.agreeFail));
  check(r.summary.undecided.length === 1 && r.summary.undecided[0] === 'beta/speed', 'the refused criterion stays undecided', r.summary.undecided.join(','));
  // THE MEASURED QUANTITY. Two criteria turn on the store, and the report names
  // which state each one needs rather than picking the flattering side.
  check(r.summary.storeDependent.length === 2, 'two verdicts turn on the store', String(r.summary.storeDependent.length));
  check(
    r.summary.storeDependent.some((s) => s.startsWith('beta/cost passes only from a empty store')),
    'one needs an empty store',
    r.summary.storeDependent.join(' | ')
  );
  check(
    r.summary.storeDependent.some((s) => s.startsWith('gamma/cost passes only from a warm store')),
    'and one needs a lived-in store'
  );
  // BOTH DETAILS SURVIVE, because the interesting part of a dependency is the two
  // numbers, and a summary that keeps only the verdict cannot be re-read later.
  const beta = r.rows.find((row) => row.name === 'beta' && row.criterion === 'cost');
  check(beta.onEmpty.detail === 'cost true' && beta.onWarm.detail === 'cost false', 'with both sides of the reading');
  check(beta.issue === 442, 'and the issue the row is claimed under');
}

console.log('\na row only one capture covers is reported, not dropped');
{
  const v = (pass) => ({ issue: 1, cost: { pass, detail: 'd' } });
  const r = storeEffect({
    empty: side('empty-store', 'empty', { verdicts: { alpha: v(true), beta: v(true) } }),
    warm: side('warm-store', 'warm', { verdicts: { alpha: v(true) } }),
  });
  check(r.summary.criteria === 1, 'only the shared row is paired', String(r.summary.criteria));
  check(r.summary.missing.length === 1 && r.summary.missing[0].includes('only in empty-store'), 'and the gap is named', r.summary.missing.join(','));
}

console.log('\na refused pair scores nothing at all');
{
  const r = storeEffect({ empty: side('A', 'warm'), warm: side('B', 'warm') });
  check(r.refusal !== null, 'the refusal stands');
  check(r.rows.length === 0 && r.summary === null, 'and no verdict is derived from it');
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
