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

import {
  countTokens,
  reduction,
  claimFor,
  selfClaimsInPart,
  contentLinesOf,
} from './reduction.mjs';

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
// A chars/4 stand-in would answer 50, 2 and 2 here, so each reading separates
// the counter from the estimate. The figures are Anthropic's `count_tokens`,
// served from the recorded fixture the compression bench uses, which is what
// puts a row measured by this file on the same scale as one measured there --
// it was counted with tiktoken `cl100k_base` until that was fixed, and the two
// encodings split code and punctuation differently, so a ratio between them is
// not preserved. The long run is the reading that moved: 25 under tiktoken, 68
// here, because the model's tokenizer does not merge a repeated character
// nearly as far.
eq(
  'a 200-character run is 68 tokens, not 50',
  countTokens('a'.repeat(200)),
  68
);
eq('JSON punctuation costs more than chars/4', countTokens('{"a":1}'), 5);
eq('one word is one token', countTokens('token'), 1);

// --- the ratio ---------------------------------------------------------------
close('a payload equal to its input saves nothing', reduction(100, 100), 0);
close('a tenth of the input is a 90% saving', reduction(100, 10), 0.9);
close('an empty payload is a 100% saving', reduction(100, 0), 1);

// A LOSS MUST READ AS A LOSS. This is the case the shipped metric cannot
// express, and the one that found smart_complexity costing 24.6% MORE than
// reading the file it summarised. Clamping here would have hidden it.
close(
  'a payload larger than its input is negative',
  reduction(100, 125),
  -0.25
);

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
eq(
  'an integral reading collapses to one figure',
  claimFor([{ reduction: 0.7 }]).text,
  '70%'
);

// THE ONE PLACE THE CEILING MAY NOT ROUND OUTWARD. 100% saved means an empty
// reply, which no tool sends -- a repeat read still costs its envelope. These
// are smart_read's three repeat readings, which bracketed to `98-100%` and put
// a figure no tool can reach into a description.
eq(
  'a ceiling that would read as total saving keeps its tenth',
  claimFor([{ reduction: 0.981 }, { reduction: 0.993 }, { reduction: 0.995 }])
    .text,
  '98-99.5%'
);

// THE CONTROL. Capping below 100 must not make 100 unsayable: a tool that
// really did return nothing has to be able to say so, or the rule above turns
// into a different kind of misreport.
eq(
  'a reading that truly reached total still says so',
  claimFor([{ reduction: 1 }]).text,
  '100%'
);

// UNMEASURED IS NOT ZERO. A tool every fixture refused must yield no claim at
// all; returning "0%" would put a measured-looking figure in a description that
// nothing measured, which is the situation this whole bench exists to end.
eq(
  'rows that all refused yield no claim',
  claimFor([{ reduction: null }]),
  null
);
eq('no rows at all yield no claim', claimFor([]), null);

// A loss must survive into the claim rather than being dropped as an outlier.
const withLoss = claimFor([{ reduction: -0.246 }, { reduction: 0.677 }]);
eq(
  'a losing reading widens the range below zero',
  withLoss.text,
  '-25% to 68%'
);

// --- the self-claim scan ----------------------------------------------------
// The sweep refuses outright when a tool publishes a figure about its own
// saving, so what that scan can and cannot see is worth knowing exactly.
const NL = String.fromCharCode(10);
const claims = (text) => JSON.stringify(selfClaimsInPart(text));

eq(
  'a saving published anywhere in the reply is found',
  claims('{"metadata":{"nested":{"tokensSaved":12}}}'),
  '["tokensSaved"]'
);
eq(
  'a reply with no figure of its own is clean',
  claims('{"metadata":{"truncated":true,"chunkCount":6}}'),
  '[]'
);

// THE CASE A TEXT SCAN CANNOT GET RIGHT, and the reason this walks keys.
// smart_read answers with the fixture's own source, and one of the fixtures is
// token-counter.ts -- so the words appear in content that claims nothing. A
// grep over the payload would have failed every smart_read reading.
eq(
  'the same words inside a string value are content, not a claim',
  claims('{"content":"const tokenCount = counter.count(x).tokensSaved;"}'),
  '[]'
);

// THE SHAPE THAT WAS GOING UNREAD ALTOGETHER. Six of the fourteen answer in a
// human report, and the first version of this scan parsed or gave up -- so it
// read 54 of 90 parts and missed the only two figures anyone had actually caught
// a tool printing: a -92% footer and a flat 85%, both prose, neither a field.
eq(
  'a figure printed in a report footer is found',
  claims('Summary:' + NL + '  Token Savings: 85%' + NL),
  // The label reported is whichever alternative matched -- `savings` here, since
  // the footer separates the two words. What matters is that the line is caught.
  '["savings"]'
);
eq(
  'a report that states no figure is clean',
  claims(
    'Summary:' + NL + '  Files Scanned: 1' + NL + '  Total Findings: 0' + NL
  ),
  '[]'
);

// A LABEL, A COLON AND A NUMBER -- not a word. The words turn up in prose that
// claims nothing, and a gate that fires on them would be unusable.
eq(
  'the word without a figure is not a claim',
  claims('No changes, so nothing was saved by this read.'),
  '[]'
);

// AND THE LINE THAT IS A CLAIM IN SHAPE AND CONTENT IN FACT. smart_pretty
// answers with the formatted source, and bench/tools/fixtures/token-counter.ts
// carries `percentSaved: 100,` at line 313. Subtracting the fixture's own lines
// is what separates the two, so BOTH arms are pinned: content is clean, and the
// same line from somewhere other than the fixture is still caught.
const fixtureLine = 'percentSaved: 100,';
eq(
  "the fixture's own line is content, not a claim",
  JSON.stringify(
    selfClaimsInPart('  ' + fixtureLine, contentLinesOf(fixtureLine))
  ),
  '[]'
);
eq(
  'the same line from outside the fixture is a claim',
  JSON.stringify(
    selfClaimsInPart('  ' + fixtureLine, contentLinesOf('nothing'))
  ),
  '["saved"]'
);

console.log('');
console.log(
  failures === 0
    ? 'all reduction-oracle cases behaved as specified'
    : `${failures} case(s) did not behave as specified`
);
process.exit(failures === 0 ? 0 : 1);
