/**
 * DOES THE ENGINE'S TOKEN PROXY RANK PAYLOADS THE WAY THE TOKENISER DOES?
 *
 * `compressRecords` has to choose between two encodings of the same records, and
 * for a while it chose the shorter string. That was wrong in the only unit anyone
 * is billed in: on one transcript the character-shorter encoding saved 109 bytes
 * and cost 72 tokens, because the bytes it gave up were dense JSON at roughly two
 * characters to the token and the bytes it added were English prose at nearly
 * four. The engine now decides with `tokenCost`, a pretoken count using
 * cl100k_base's own splitting rule, because the tokeniser itself is a benchmark
 * dependency and must never become a runtime one.
 *
 * SO THE PROXY IS AN UNVERIFIED MODEL OF SOMETHING WE CAN ACTUALLY MEASURE, and
 * this is where the two are held together. Two properties matter, and neither is
 * a matter of taste:
 *
 *   1. It never over-charges. Every pretoken costs at least one real token, so
 *      the proxy must come in at or below tiktoken on every payload. If it ever
 *      exceeds, it can talk the encoder out of a swap that would have paid.
 *   2. It ranks a prose-for-JSON trade the same way tiktoken does. That is the
 *      only comparison the encoder ever asks it to make, so it is the only one
 *      worth asserting -- agreement on absolute counts would be a stronger claim
 *      than the engine needs and a weaker one than it relies on.
 *
 * WHAT THIS CANNOT REACH, SAID PLAINLY. The defect that prompted the proxy was a
 * marker chosen over the OTHER encoding of the same records, and both candidates
 * exist only inside `compressRecords`. Pricing that pair from out here would mean
 * rebuilding the encoder in a bench script, which is the drift the compressor's
 * own comments refuse. So this file proves the swap beats leaving the records
 * alone; the corpus token total, and the must-win ratchet over it, are what stop
 * a swap that beats nothing but loses to the alternative.
 */
import { get_encoding } from 'tiktoken';
import { fixtures } from './fixtures.mjs';
import { tokenCost } from '../../dist/compress/json-fragments.js';
import { expandJsonRecordsByPosition } from '../../dist/compress/rehydrate.js';
import { compressBlock } from './ours-engine.mjs';

const enc = get_encoding('cl100k_base');
const real = (text) => enc.encode(text).length;

/** Every string leaf a fixture carries, which is what the engine actually sees. */
function leaves(node, out = []) {
  if (typeof node === 'string') {
    if (node.length > 400) out.push(node);
    return out;
  }
  if (node && typeof node === 'object')
    for (const v of Object.values(node)) leaves(v, out);
  return out;
}

const blocks = fixtures().flatMap((f) => leaves(f.request));
if (blocks.length < 10) {
  console.error(
    `pretoken-proxy: only ${blocks.length} blocks -- the corpus did not load`
  );
  process.exit(1);
}

const failures = [];
let worst = Infinity,
  tightest = 0;
for (const text of blocks) {
  const proxy = tokenCost(text),
    truth = real(text);
  if (proxy > truth)
    failures.push(
      `over-charged a ${text.length}-char block: proxy ${proxy} > tiktoken ${truth}`
    );
  const ratio = proxy / truth;
  worst = Math.min(worst, ratio);
  tightest = Math.max(tightest, ratio);
}
console.log(
  `pretoken-proxy: ${blocks.length} blocks, proxy/tiktoken in ` +
    `[${worst.toFixed(3)}, ${tightest.toFixed(3)}]`
);

// EVERY SWAP THE ENGINE ACTUALLY MADE, PRICED BY THE TOKENISER.
//
// This is the property the proxy exists to deliver, and the earlier draft of this
// check did not test it. That draft paired an arbitrary dense payload against an
// arbitrary plain one and asked the two to agree on which was cheaper; they
// disagreed on 142 of 340 pairs, because punctuation density is not the same thing
// as token density and those pairs were not a trade the encoder would ever
// consider. What the encoder does consider is this exact marker against these
// exact records -- and the decoder inverts the marker, so the records it replaced
// can be recovered and priced rather than guessed at.
//
// EACH MARKER TRAVELS WITH THE STAMP OF THE CALL THAT WROTE IT. Every marker the
// encoder emits carries a keyed stamp, and a decoder handed none honours no
// marker at all -- that is what makes a marker-shaped line planted in the
// content inert. So a marker alone is not enough to price: paired with the wrong
// stamp, or with none, the decode is a no-op, the records come back as the marker
// itself, and every swap reads as exactly break-even. That is how this check
// failed silently once the stamps landed.
const markers = [];
for (const text of blocks) {
  const result = compressBlock(text, {});
  for (const m of result.text.matchAll(
    /\[JSON (?:array records|object map) by position;[\s\S]*?\[\/JSON records by position(?: ~[0-9a-z]+)?\]\n/g
  ))
    markers.push({ text: m[0], stamp: result.stamp ?? null });
}
if (!markers.length) {
  console.error(
    'pretoken-proxy: the corpus produced no by-position markers, so nothing here ' +
      'is testing the decision the proxy is made for'
  );
  process.exit(1);
}

let saved = 0;
for (const { text: marker, stamp } of markers) {
  const replaced = expandJsonRecordsByPosition(marker, stamp);
  // A decode that changed nothing is not a reading. It means the stamp did not
  // match, so `before` and `after` are the same string and the comparison below
  // would pass or fail on nothing at all.
  if (replaced === marker) {
    failures.push(
      `a marker did not decode, so there is nothing to price it against ` +
        `(stamp ${stamp === null ? 'absent' : 'present'})`
    );
    continue;
  }
  const before = real(replaced),
    after = real(marker);
  saved += before - after;
  if (after >= before)
    failures.push(
      `a marker cost ${after - before} tokens more than the ${before} it replaced, ` +
        `so the proxy approved a swap the tokeniser rejects`
    );
  // The proxy has to have reached the same verdict, or the engine got this right
  // by luck on this corpus and will get it wrong on the next one.
  if (tokenCost(marker) >= tokenCost(replaced))
    failures.push(
      `the proxy scored a marker it nevertheless emitted as no cheaper`
    );
}
console.log(
  `pretoken-proxy: ${markers.length} by-position swaps, ${saved} real tokens ` +
    `cheaper than the records they replaced`
);

if (failures.length) {
  for (const f of failures.slice(0, 10)) console.error(`pretoken-proxy: ${f}`);
  console.error(`pretoken-proxy: FAILED with ${failures.length} problem(s)`);
  process.exit(1);
}
console.log(
  'pretoken-proxy: OK -- the proxy never over-charges, and every swap it approved ' +
    'is cheaper in real tokens than what it replaced'
);
