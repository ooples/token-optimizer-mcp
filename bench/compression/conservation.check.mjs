/**
 * THE WHOLE-PAYLOAD CONSERVATION ORACLE, ON READINGS WHOSE ANSWER IS KNOWN.
 *
 * Every case here states its own numbers, so nothing is captured, nothing is
 * timed, and a failure names a property rather than a workload. The cases that
 * carry the weight are the ones where the oracle must FAIL: a stub that reports
 * "nothing lost" on every input would pass a suite of only-passing cases, and
 * that stub is precisely the instrument defect this file exists to rule out.
 */

import { CHUNK_LEN, contentChunks, contentWords, unaccounted, MIN_WORD_LEN } from './conservation.mjs';

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

console.log('the segment unit is non-overlapping and drops the short tail');
{
  // 100 bytes at 48 gives two whole segments and a 4-byte tail that is dropped:
  // a padded tail is not a substring of the original and could never be found.
  const t = 'x'.repeat(48) + 'y'.repeat(48) + 'zzzz';
  const c = contentChunks(t);
  check(c.size === 2, 'two distinct segments, tail dropped', `size=${c.size}`);
  check(CHUNK_LEN === 48, 'the documented length', String(CHUNK_LEN));
  check(contentChunks('short').size === 0, 'a document shorter than one segment yields none');
}

console.log('a repeated segment is one unit with a count, so mass is not multiplied');
{
  const t = 'q'.repeat(48).repeat(3);
  const c = contentChunks(t);
  check(c.size === 1, 'one distinct segment', `size=${c.size}`);
  check(c.get('q'.repeat(48)) === 3, 'occurring three times', String(c.get('q'.repeat(48))));
  const r = unaccounted({ before: t, output: t, units: c });
  check(r.beforeMass === 144, 'mass is the original bytes, not 48 times the count', String(r.beforeMass));
}

console.log('THE CASE THAT MATTERS: the segment unit resolves a payload the word oracle cannot');
{
  // A payload whose variety is in SHORT tokens -- the shape of relevance-probe.
  // Every long word is one of two repeated template strings, so deleting most of
  // the document leaves both of them behind and the word oracle reads clean.
  const lines = [];
  for (let i = 0; i < 400; i += 1) lines.push(`{"identifier": "evt_${i}", "elapsed_ms": ${i}}`);
  const before = lines.join('\n');
  const half = before.slice(0, Math.floor(before.length / 2));

  const byWord = unaccounted({ before, output: half });
  check(byWord.gone === 0, 'the word oracle loses nothing -- it is blind here', `words=${byWord.words} gone=${byWord.gone}`);

  const bySeg = unaccounted({ before, output: half, units: contentChunks(before) });
  check(bySeg.words > 100, 'the segment unit has a real denominator', `units=${bySeg.words}`);
  check(bySeg.gone > 0, 'AND IT REPORTS THE LOSS', `gone=${bySeg.gone}`);
  // Half the document removed should cost close to half the segments; a unit that
  // reported one or two would be technically non-blind and practically useless.
  check(
    bySeg.gone > bySeg.words * 0.4,
    'in proportion to what was removed, not a token amount',
    `gone=${bySeg.gone} of ${bySeg.words}`
  );
}

console.log('a segment unit still cannot be fooled by an output that dropped nothing');
{
  const before = Array.from({ length: 200 }, (_, i) => `row ${i} value ${i * 7}`).join('\n');
  const r = unaccounted({ before, output: before, units: contentChunks(before) });
  check(r.gone === 0, 'an untouched output loses nothing', `gone=${r.gone} of ${r.words}`);
  check(r.words > 50, 'over a denominator worth having', `units=${r.words}`);
}

console.log('the spill is searched in the segment unit too, and only when there is a sink');
{
  const before = 'a'.repeat(48) + 'b'.repeat(48);
  const units = contentChunks(before);
  const held = unaccounted({ before, output: 'a'.repeat(48), spill: 'b'.repeat(48), hasSink: true, units });
  check(held.gone === 0 && held.inSpill === 1, 'found in the spill', `gone=${held.gone} inSpill=${held.inSpill}`);
  const sinkless = unaccounted({ before, output: 'a'.repeat(48), spill: 'b'.repeat(48), hasSink: false, units });
  check(sinkless.gone === 1, 'a sinkless arm may not claim it', `gone=${sinkless.gone}`);
  check(sinkless.inSpill === null, 'and reports null rather than 0', String(sinkless.inSpill));
}

console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
