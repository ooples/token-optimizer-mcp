/**
 * THE WHOLE-PAYLOAD CONSERVATION ORACLE, ON READINGS WHOSE ANSWER IS KNOWN.
 *
 * Every case here states its own numbers, so nothing is captured, nothing is
 * timed, and a failure names a property rather than a workload. The cases that
 * carry the weight are the ones where the oracle must FAIL: a stub that reports
 * "nothing lost" on every input would pass a suite of only-passing cases, and
 * that stub is precisely the instrument defect this file exists to rule out.
 */

import { contentWords, unaccounted, MIN_WORD_LEN } from './conservation.mjs';

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

console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
