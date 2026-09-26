/**
 * KNOWN ANSWERS FOR THE RETENTION DENOMINATOR.
 *
 * `identifiers.mjs` decides what a retention unit IS, which makes it the
 * denominator of every retention figure this project publishes -- and until this
 * file it was the one instrument in that chain with no check of its own and no
 * mutants, so its rules were whatever the regexes happened to do.
 *
 * Two of them happened to do the wrong thing, and both were found by reading a
 * loss column rather than by any test here:
 *
 *   - a length bound inside the quoted-run pattern broke the parity of the scan,
 *     so on JSON carried inside a string it captured the SEPARATORS between keys
 *     (`: 2345, `) instead of the keys
 *   - units were admitted that are not literal substrings of their own payload,
 *     which no arm can ever be credited with keeping, because the only test for
 *     retention is `includes`
 *
 * Every case below has an answer that can be written down by reading the
 * fixture. Nothing here measures a compressor.
 */

import { identifiers, scanIdentifiers, MIN_SYMBOL, MAX_UNIT } from './identifiers.mjs';

let failures = 0;
function check(ok, what, detail) {
  if (ok) {
    console.log(`ok   ${what}`);
  } else {
    failures += 1;
    console.log(`FAIL ${what}${detail === undefined ? '' : ` -- ${detail}`}`);
  }
}

/** A payload in the shape the harness scores: a message list, JSON, one string. */
const payload = (blocks) => JSON.stringify([{ role: 'user', content: blocks }]);
const toolResult = (content) => ({ type: 'tool_result', tool_use_id: 'toolu_ka01', content });

// 1. THE PARITY OF THE QUOTED-RUN SCAN.
//
// The content here is JSON carried as a string, which is what every tool result
// in the captured workloads looks like. Its keys are `id` (too short to admit),
// `user_id` and `amount`. A scan that skips the short run pairs the closing quote
// of `id` with the opening quote of `user_id` and captures the separator between
// them; a scan that starts every match at an opening quote captures the keys.
{
  const rows = '[{"id": 3, "user_id": 2345, "amount": -272.44, "currency": "USD"}]';
  const text = payload([toolResult(rows)]);
  const units = identifiers(text);

  check(units.has('user_id'), 'a key in JSON-inside-a-string is a unit', [...units].join('|'));
  check(units.has('amount'), 'and so is the key after it');
  check(!units.has(': 2345, '), 'and the separator between two keys is not', JSON.stringify([...units]));
  const edged = [...units].filter((u) => /^\s|\s$/.test(u));
  check(edged.length === 0, 'no unit begins or ends in whitespace', JSON.stringify(edged));
  // AND THE FIXTURE MUST REALLY CONTAIN THE TRAP, or the three assertions above
  // are about a string that could not have produced a separator in the first
  // place. `id` is the short run whose skipping flipped the parity.
  check(rows.includes('"id": 3, "'), 'the fixture really does carry the short run that flipped the parity');
}

// 2. THE LENGTH BOUNDS, AT BOTH EDGES, APPLIED TO WHAT WAS CAPTURED.
//
// MIN_SYMBOL is the floor because a four-character unit is found by `includes`
// anywhere; MAX_UNIT is the ceiling because a whole paragraph is not an
// identifier. Both edges are asserted, so neither bound can be widened without
// this file going red.
{
  const short = 'a'.repeat(MIN_SYMBOL - 1);
  const atFloor = 'b'.repeat(MIN_SYMBOL);
  const atCeiling = 'c'.repeat(MAX_UNIT);
  const overCeiling = 'd'.repeat(MAX_UNIT + 1);
  const text = payload([
    toolResult(`{"x": "${short}", "y": "${atFloor}", "z": "${atCeiling}", "w": "${overCeiling}"}`),
  ]);
  const units = identifiers(text);
  check(!units.has(short), `${MIN_SYMBOL - 1} characters is below the floor and excluded`);
  check(units.has(atFloor), `${MIN_SYMBOL} characters is at the floor and admitted`);
  check(units.has(atCeiling), `${MAX_UNIT} characters is at the ceiling and admitted`);
  check(!units.has(overCeiling), `${MAX_UNIT + 1} characters is over the ceiling and excluded`);
}

// 3. THE INVARIANT THAT MAKES `includes` SCORING MEAN ANYTHING.
//
// A unit that is not a literal substring of its own payload cannot be found in
// any output by any arm, so it is not a unit. The fixture nests one level deeper
// than the harness searches: a traceback with escaped newlines, inside JSON,
// inside a string, inside the payload. At that depth the extracted text holds a
// two-character escape where the payload holds a four-character one.
{
  const NL = String.fromCharCode(10);
  const trace = 'Traceback (most recent call last):' + NL + '  File "service_handler.py", line 41';
  const rows = JSON.stringify([{ detail: trace, request_id: 'req-4d8f21ac90' }]);
  const text = payload([toolResult(rows)]);
  const { units, phantoms } = scanIdentifiers(text);

  check(phantoms.length > 0, 'the fixture really does produce a phantom', JSON.stringify(phantoms));
  const kept = [...units].filter((u) => !text.includes(u));
  check(kept.length === 0, 'every admitted unit is a literal substring of the payload', JSON.stringify(kept));
  const wrongly = phantoms.filter((u) => text.includes(u));
  check(wrongly.length === 0, 'and every dropped one really was not', JSON.stringify(wrongly));
  check(units.has('req-4d8f21ac90'), 'a real value at the same depth is still admitted');
  check(
    identifiers(text).size === units.size,
    'the wrapper returns the filtered set, not the raw scrape',
    `${identifiers(text).size} vs ${units.size}`
  );
}

// 4. THE POSITIVE CONTROL: THE SCAN READS CONTENT, NOT SHAPE.
//
// Every assertion above is about what the extractor refuses. This one is the
// other direction, and without it the whole file would still pass against a
// scan that returned a fixed set: delete one value from the payload and the
// denominator must lose exactly that unit and nothing else.
{
  const withIt = payload([toolResult('{"reference": "TXN-F3287E51", "region": "us-west-2"}')]);
  const without = payload([toolResult('{"reference": "", "region": "us-west-2"}')]);
  const a = identifiers(withIt);
  const b = identifiers(without);
  check(a.has('TXN-F3287E51'), 'the value is in the denominator while it is in the payload');
  check(!b.has('TXN-F3287E51'), 'and out of it once the payload no longer carries it');
  const lost = [...a].filter((u) => !b.has(u));
  check(
    JSON.stringify(lost) === JSON.stringify(['TXN-F3287E51']),
    'and nothing else moved with it',
    JSON.stringify(lost)
  );
}

console.log(failures === 0 ? 'all checks passed' : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
