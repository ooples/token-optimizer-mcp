/**
 * THE WHOLE-PAYLOAD CONSERVATION ORACLE, ON READINGS WHOSE ANSWER IS KNOWN.
 *
 * Every case here states its own numbers, so nothing is captured, nothing is
 * timed, and a failure names a property rather than a workload. The cases that
 * carry the weight are the ones where the oracle must FAIL: a stub that reports
 * "nothing lost" on every input would pass a suite of only-passing cases, and
 * that stub is precisely the instrument defect this file exists to rule out.
 */

import {
  contentWords,
  discriminatingFloor,
  unaccounted,
  FLOORS,
  MIN_WORD_LEN,
} from './conservation.mjs';

let failures = 0;
const ok = (name, detail = '') => console.log(`ok   ${name}${detail ? ` -- ${detail}` : ''}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`FAIL ${name} -- ${detail}`);
};
const check = (cond, name, detail = '') => (cond ? ok(name, detail) : bad(name, detail || 'false'));

console.log('a word shorter than the floor is excluded, not counted as lost');
{
  // `cat` cannot be looked for: it occurs inside `concatenate` in any document.
  const r = unaccounted({ before: 'cat dog pig', output: '' });
  check(r.words === 0, 'no word reaches the floor', `words=${r.words}`);
  check(r.gone === 0, 'nothing is reported lost', `gone=${r.gone}`);
  check(r.goneShare === 0, 'an empty denominator is 0, not NaN', `share=${r.goneShare}`);
}

console.log('a word deleted outright is reported lost');
{
  const before = 'preserved_identifier and deleted_identifier';
  const r = unaccounted({ before, output: 'preserved_identifier and' });
  check(r.words === 2, 'both words counted', `words=${r.words}`);
  check(r.gone === 1, 'exactly one lost', `gone=${r.gone}`);
  check(r.missing[0] === 'deleted_identifier', 'and it is named', r.missing.join(','));
  check(r.goneMass === 'deleted_identifier'.length, 'its bytes are charged', `mass=${r.goneMass}`);
}

console.log('a word only in the expansion is accounted for, not lost');
{
  const r = unaccounted({
    before: 'alpha_identifier beta_identifier',
    output: 'alpha_identifier <<ref>>',
    reconstructed: 'alpha_identifier beta_identifier',
  });
  check(r.gone === 0, 'a back-reference loses nothing', `gone=${r.gone}`);
  check(r.inReconstruction === 1, 'credited to the expansion', `derived=${r.inReconstruction}`);
}

console.log('a repeat removed is not a loss');
{
  const before = Array(50).fill('repeated_identifier').join(' ');
  const r = unaccounted({ before, output: 'repeated_identifier x49' });
  check(r.gone === 0, 'one surviving copy is enough', `gone=${r.gone}`);
  check(
    r.beforeMass === 50 * 'repeated_identifier'.length,
    'but the original bytes are still the denominator',
    `mass=${r.beforeMass}`
  );
}

console.log('a sink that was never asked reports null, not zero');
{
  const r = unaccounted({ before: 'spilled_identifier', output: '', spill: 'spilled_identifier' });
  check(r.inSpill === null, 'no sink means no reading', `inSpill=${r.inSpill}`);
  check(r.gone === 1, 'and the word is lost as far as this arm goes', `gone=${r.gone}`);
  const s = unaccounted({
    before: 'spilled_identifier',
    output: '',
    spill: 'spilled_identifier',
    hasSink: true,
  });
  check(s.inSpill === 1, 'with a sink it is found there', `inSpill=${s.inSpill}`);
  check(s.gone === 0, 'and not charged as lost', `gone=${s.gone}`);
}

console.log('prose between two preserved identifiers is inside the denominator');
{
  // THE DEFECT THIS FILE EXISTS FOR. The identifier oracle would score this
  // arm perfect: both identifiers survive. The sentence between them does not.
  const before = 'path/to/alpha_module.ts the allocator refused a suballocation path/to/beta_module.ts';
  const r = unaccounted({
    before,
    output: 'path/to/alpha_module.ts path/to/beta_module.ts',
  });
  // TWO, not one: `allocator` is nine characters and so is inside the
  // denominator as well. Counted by hand from the sentence above rather than
  // read off a first run, which is how a wrong expectation becomes the spec.
  check(r.gone === 2, 'both prose words are caught', `gone=${r.gone} missing=${r.missing.join(',')}`);
  check(
    r.missing.includes('suballocation') && r.missing.includes('allocator'),
    'and both are named',
    r.missing.join(',')
  );
  check(r.words === 4, 'two identifiers plus two prose words', `words=${r.words}`);
}

console.log('the byte share is a share of the original, not of the output');
{
  const before = `${'keep_this_identifier '.repeat(10)}drop_this_word`;
  const r = unaccounted({ before, output: 'keep_this_identifier' });
  const expected = 'drop_this_word'.length / (10 * 'keep_this_identifier'.length + 'drop_this_word'.length);
  check(
    Math.abs(r.goneShare - expected) < 1e-12,
    'share matches the hand calculation',
    `got=${r.goneShare} want=${expected}`
  );
}

console.log('the floor is the documented one');
check(MIN_WORD_LEN === 8, 'eight characters, as retention.mjs uses', String(MIN_WORD_LEN));
check(contentWords('abcdefgh abcdefg').size === 1, 'eight in, seven out');

console.log('the floor a row is judged at is chosen by the control, not by this file');
{
  // THE SHAPE OF relevance-probe: every long word is one of two repeated
  // template strings, so deleting most of the document leaves both behind and
  // the oracle reads clean at eight characters. The variety is in `evt_0`.
  const rows = [];
  for (let i = 0; i < 400; i += 1) rows.push(`{"identifier": "evt_${i}", "elapsed_ms": ${i}}`);
  const before = rows.join('\n');
  const control = before.slice(0, Math.floor(before.length / 2));

  const atEight = unaccounted({ before, output: control });
  check(
    atEight.gone === 0,
    'at the default floor the control loses nothing -- this is the blind spot',
    `words=${atEight.words} gone=${atEight.gone}`
  );

  const f = discriminatingFloor(before, control);
  check(f.minLen !== null, 'a floor is found', `minLen=${f.minLen}`);
  check(f.minLen < MIN_WORD_LEN, 'and it is lower than the default', `minLen=${f.minLen}`);
  check(
    f.tried.length === FLOORS.length && f.tried[0].minLen === FLOORS[0],
    'every candidate is reported, largest first',
    f.tried.map((t) => t.minLen).join(',')
  );
  // LARGEST, NOT SMALLEST. Every floor below the chosen one also discriminates
  // here, and taking the lowest would admit short words for no extra power.
  const discriminating = f.tried.filter((t) => t.controlGone > 0).map((t) => t.minLen);
  check(
    f.minLen === Math.max(...discriminating),
    'the largest discriminating floor is the one chosen',
    `chosen=${f.minLen} of ${discriminating.join(',')}`
  );

  const atChosen = unaccounted({ before, output: control, minLen: f.minLen });
  check(atChosen.gone > 0, 'AND AT THAT FLOOR THE LOSS IS REPORTED', `gone=${atChosen.gone} of ${atChosen.words}`);
  check(
    atChosen.gone > atChosen.words * 0.2,
    'in proportion to what was removed, not a token amount',
    `gone=${atChosen.gone} of ${atChosen.words}`
  );
  check(atChosen.minLen === f.minLen, 'and the reading carries the floor it was taken at', String(atChosen.minLen));
}

console.log('a payload no floor can read is reported as such rather than given a number');
{
  // One word, repeated. Half of it still contains the word at every floor, so
  // there is no floor at which the control detects a loss -- and the honest
  // answer is null, not 4.
  const before = 'aaaa '.repeat(500);
  const f = discriminatingFloor(before, before.slice(0, 200));
  check(f.minLen === null, 'no floor discriminates', String(f.minLen));
  check(
    f.tried.every((t) => t.controlGone === 0),
    'and every candidate is recorded as having seen nothing',
    f.tried.map((t) => `${t.minLen}:${t.controlGone}`).join(' ')
  );
}

console.log('lowering the floor cannot invent a loss, and a reading carries its floor');
{
  // The direction that matters: a shorter word has more chance of matching
  // somewhere by accident, which makes the oracle LENIENT. So at any floor, a
  // word this output really holds is never charged as lost.
  const before = Array.from({ length: 200 }, (_, i) => `row ${i} value ${i * 7} tag_${i} correlation_${i}`).join('\n');
  for (const minLen of FLOORS) {
    const r = unaccounted({ before, output: before, minLen });
    // OVER A DENOMINATOR WORTH HAVING. `gone === 0` over an empty word set is
    // a vacuous pass, and at floor 8 this fixture had exactly that until the
    // longer token was added.
    check(r.words > 100, `floor ${minLen} has a real denominator`, `words=${r.words}`);
    check(r.gone === 0, `an untouched output loses nothing at floor ${minLen}`, `gone=${r.gone} of ${r.words}`);
    check(r.minLen === minLen, 'and says which floor it used', String(r.minLen));
  }
  const four = unaccounted({ before, output: before, minLen: 4 });
  const eight = unaccounted({ before, output: before, minLen: 8 });
  check(four.words > eight.words, 'a lower floor admits strictly more words', `${four.words} > ${eight.words}`);
}


console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
