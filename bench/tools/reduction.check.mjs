/**
 * THE PER-TOOL REDUCTION ORACLE, ON READINGS WHOSE ANSWER IS KNOWN.
 *
 * Every case states its own numbers, so nothing is spawned, nothing is read off
 * disk and a failure names a property rather than a tool. The cases that carry
 * the weight are the ones where the oracle must REFUSE or must report a LOSS: a
 * stub that returned a flattering percentage for every input would pass a suite
 * of only-winning cases, and that stub is exactly the instrument defect this
 * file rules out. It is also the defect the tools already shipped -- their own
 * originalTokens compares their pretty output against their compact output, so
 * it can only ever be positive, whatever the tool costs its caller.
 */

import { countTokens, reduction, claimFor } from './reduction.mjs';

let failures = 0;
const ok = (name, detail = '') =>
  console.log(`ok   ${name}${detail ? ` -- ${detail}` : ''}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`FAIL ${name} -- ${detail}`);
};
const eq = (name, got, want) =>
  got === want ? ok(name, `${got}`) : bad(name, `got ${got}, want ${want}`);
const close = (name, got, want) =>
  Math.abs(got - want) < 1e-9
    ? ok(name, `${got}`)
    : bad(name, `got ${got}, want ${want}`);

// --- the counter is a tokenizer, not a character heuristic -------------------
// A chars/4 stand-in would answer 50 and 2 here. Both readings separate it from
// the encoding the compression bench uses, so a row measured by this file is on
// the same scale as one measured there.
eq('a 200-character run is 25 tokens, not 50', countTokens('a'.repeat(200)), 25);
eq('JSON punctuation costs more than chars/4', countTokens('{"a":1}'), 5);
eq('one word is one token', countTokens('token'), 1);

// --- the ratio ---------------------------------------------------------------
close('a payload equal to its input saves nothing', reduction(100, 100), 0);
close('a tenth of the input is a 90% saving', reduction(100, 10), 0.9);
close('an empty payload is a 100% saving', reduction(100, 0), 1);

// A LOSS MUST READ AS A LOSS. This is the case the shipped metric cannot
// express, and the one that found smart_complexity costing 24.6% MORE than
// reading the file it summarised. Clamping here would have hidden it.
close('a payload larger than its input is negative', reduction(100, 125), -0.25);

// No baseline is not a zero baseline: dividing by it would report Infinity as a
// spectacular saving.
eq('an empty baseline yields no reading', reduction(0, 10), null);
eq('a negative baseline yields no reading', reduction(-1, 10), null);

// --- the words a description may use ----------------------------------------
const spread = claimFor([{ reduction: 0.429 }, { reduction: 0.946 }]);
eq('a spread is stated as a range', spread.text, '42-95%');
eq('the range names how many readings back it', spread.n, 2);

// The floor rounds down and the ceiling rounds up, so the stated range is never
// narrower than what was measured. That holds for a single reading too: 67.7%
// brackets to 67-68%, and collapsing it to a bare "67%" would state a number
// below what was measured. The range only becomes one figure when the reading
// lands on an integer, which is the case below.
const single = claimFor([{ reduction: 0.677 }]);
eq('one fractional reading still brackets', single.text, '67-68%');
eq('an integral reading collapses to one figure', claimFor([{ reduction: 0.7 }]).text, '70%');

// UNMEASURED IS NOT ZERO. A tool every fixture refused must yield no claim at
// all; returning "0%" would put a measured-looking figure in a description that
// nothing measured, which is the situation this whole bench exists to end.
eq('rows that all refused yield no claim', claimFor([{ reduction: null }]), null);
eq('no rows at all yield no claim', claimFor([]), null);

// A loss must survive into the claim rather than being dropped as an outlier.
const withLoss = claimFor([{ reduction: -0.246 }, { reduction: 0.677 }]);
eq('a losing reading widens the range below zero', withLoss.text, '-25-68%');

console.log('');
console.log(
  failures === 0
    ? 'all reduction-oracle cases behaved as specified'
    : `${failures} case(s) did not behave as specified`
);
process.exit(failures === 0 ? 0 : 1);