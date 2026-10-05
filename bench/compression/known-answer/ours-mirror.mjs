/**
 * PROFILE: MIRROR. Our arms emit exactly the bytes their winning arm emitted.
 *
 * THE NULL-DIFFERENCE TEST, and the one property here that needs no ground
 * truth at all. If both columns describe the same bytes, every paired figure in
 * the table must come out identical -- not close, identical. Any difference is
 * the scorer treating one side differently from the other, which is the defect
 * class this project keeps shipping:
 *
 *   - a denominator taken before an envelope on one side and after it on the
 *     other (the `base = len(text)` escape layer 1 found)
 *   - a token count estimated for one side and tokenised for the other
 *     (their `len(text) // 4` against our cl100k)
 *   - an identifier set scraped from one side's output and the other's payload
 *   - a cost model that charges one arm for a retrieval and the other not
 *
 * None of those needs a fixture that knows anything. They all surface as a
 * residual between two numbers that are required to be equal.
 *
 * WHAT IS NOT ASSERTED EQUAL, and why. Their offload accounting reads markers
 * out of their text; ours counts what our engine handed a spill sink. Given the
 * same marker text the two sides genuinely answer differently -- theirs sees a
 * declared store, ours sees an opaque string it never wrote. That asymmetry is
 * a fact about two different products, not a scoring bug, so scorer.check.mjs
 * asserts the size-, token-, retention- and cost-derived pairs and states that
 * boundary rather than pretending the offload columns mirror too.
 *
 * Driven by BENCH_KA_MIRROR_DIR, the capture directory head-to-head is scoring.
 * Keyed on the payload text rather than the workload name, because the text is
 * all a `compressBlock(text, options)` call carries.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bodyResult } from './ours-arms.mjs';

const dir = process.env.BENCH_KA_MIRROR_DIR;
if (!dir) {
  throw new Error(
    'ours-mirror needs BENCH_KA_MIRROR_DIR: the capture directory whose ' +
      'winning arm our column must reproduce byte for byte.'
  );
}

const payloads = JSON.parse(readFileSync(join(dir, 'payloads.json'), 'utf8'));
const theirs = JSON.parse(readFileSync(join(dir, 'theirs.json'), 'utf8'));

/** payload text -> the bytes their winning arm produced for it. */
const MIRROR = new Map();
for (const [name, text] of Object.entries(payloads)) {
  const best = theirs[name]?.bestText;
  if (typeof best === 'string') MIRROR.set(text, best);
}

function mirrored(text) {
  const best = MIRROR.get(text);
  if (best === undefined) {
    throw new Error(
      'ours-mirror was handed a payload with no counterpart in ' +
        `${dir}/theirs.json (${text.length} chars). The scorer is compressing ` +
        'something the capture never measured, so no mirror exists -- and a ' +
        'silent fallback here would quietly compare our engine against itself.'
    );
  }
  return best;
}

export function compressBlock(text) {
  return { text: mirrored(text) };
}

export function compressBody(buffer) {
  return bodyResult(mirrored(buffer.toString('utf8')));
}
