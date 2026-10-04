/**
 * THE RECOVERY ORACLE, IN A FILE A TEST CAN REACH.
 *
 * This lived inside `head-to-head.mjs`, which means the one function every
 * conservation and retention column depends on could only be exercised by
 * running the whole two-hour sweep. That is not a style complaint. The floor
 * the word oracle uses is about to be chosen per row, and choosing it without
 * the real decoder produces exactly the artefact the comment below warns about:
 * a stand-in that ran `expandLongRepeats` alone read 157 of 200 seven-character
 * units "gone" on code-search, every one of which the engine templates and
 * hands back --
 *
 *   Template: ["  {
    \"id\": \"doc_",0,"\",
    \"score\": ",1,...]
 *
 * `doc_100` is not a substring of that and decodes back exactly. A weaker
 * decoder does not make a stricter gate, it makes a wrong one.
 *
 * The refusal maps are exported rather than hidden because `head-to-head.mjs`
 * prints both of them, and a refusal counted but never shown is the same as not
 * measuring it.
 */

import { rehydrateSequence } from '../../dist/compress/rehydrate.js';
import { expandLongRepeats } from '../../dist/compress/runs.js';
import { describeImage } from '../../dist/compress/images.js';
import { PathAddressedError } from '../../dist/compress/annotate.js';

/**
 * EVERYTHING THE PUBLISHED DECODER CAN PUT BACK, given only the output.
 *
 * This is our side of the operation `resolve-theirs.py` performs on theirs,
 * and it is deliberately the SHIPPED decoder (`src/compress/rehydrate.ts`),
 * not a reimplementation: a bespoke expander written to score our own
 * benchmark would be our guess at our own losslessness, and a flattering guess
 * is indistinguishable from a result.
 *
 * IT HAS TO DESCEND INTO THE JSON. Most payloads here are a serialised
 * conversation, and the compressed tool output sits inside a string value with
 * its newlines escaped -- where the decoder's line-oriented grammars cannot
 * see it. Offered only the whole document, it recovers nothing at all on most
 * of these workloads, which would score them as total loss. So every string
 * leaf is offered to it as well.
 *
 * A refusal is not a failure of the run. An unregistered marker grammar means
 * the decoder declines to vouch for that fragment; the fragment then earns no
 * credit and is named at the end. That direction can only cost us.
 */
/** The shape every back-reference marker shares, whichever form it took. */
export const MARKER_SHAPED = /\[\.\.\. [\d,]+ bytes, /;

export const refusals = new Map();
// NOT A DEFECT, AND IT USED TO SHARE A LIST WITH ONE. `rehydrate` rebuilds from
// the output ALONE, so a `[... what went -> path]` marker is something it can
// never expand -- the path is the whole point of it. Six of those sat on a
// queue the comment above calls the work queue, which is how a queue stops
// being read. They are counted, because a column of them growing IS worth
// seeing, but they are not named as gaps.
export const pathRefusals = new Map();
export function recoverable(text, label, keys = []) {
  const parts = [];
  // THE KEYS THE PRODUCER MINTED, AND WITHOUT THEM THIS ORACLE READS NOTHING.
  //
  // Every marker grammar is authenticated: the encoder derives a key per block
  // and writes it into each marker, and the decoder honours only the markers
  // that verify. So a decoder handed no key reads a marker-shaped line as the
  // content it would be if a user had typed it, hands it straight back, and
  // this function returns nothing recovered -- which is a column of losses the
  // product does not have. The oracle holds the keys because the oracle IS the
  // producer, measuring its own output.
  //
  // PICKED OUT OF THE FRAGMENT, NOT ASSUMED BY POSITION. A document arm has one
  // key for the whole text; the body arm has one per block, and that walk is
  // the product's, not this harness's, so indexing them against this walk would
  // be an alignment nobody checked. Instead each fragment names its own key, and
  // it is accepted only if it is one of ours. That cannot resolve a reference
  // under a sibling's key -- a marker ends on the key its own encoder wrote --
  // and it cannot honour a planted line, because the keys are MACs under a
  // secret this process never emits and content cannot guess.
  const ours = new Set(
    (Array.isArray(keys) ? keys : [keys]).filter((k) => typeof k === 'string')
  );
  // NOT ANCHORED ON A CLOSING BRACKET. The search engine's header is not an
  // envelope -- `src/a.ts:11-18 ~h5nq2x` ends at the key with no bracket at
  // all -- so a bracket-anchored scan found no key on the grep fixture and
  // scored its recovery as zero. Loose is safe here because the acceptance
  // test is membership below, not shape: a planted `~abcdef` is in the
  // producer set only if it is a MAC under a secret the process never emits.
  const STAMP_IN_MARKER = /~([0-9a-z]+)/g;
  const keyOf = (fragment) => {
    for (const m of fragment.matchAll(STAMP_IN_MARKER))
      if (ours.has(m[1])) return m[1];
    return null;
  };

  // THE WHOLE DOCUMENT FIRST, BECAUSE THAT IS WHAT WAS FOLDED. Every other
  // pass rewrites the inside of one block, so decoding block by block matches
  // how they were written. `foldLongRepeats` is the exception: it runs over
  // the text `compressBlock` was handed, which for these payloads is the whole
  // serialised request, and its marker names a run that may live in an EARLIER
  // block. Handing the decoder one block at a time therefore asks it to
  // resolve a back-reference against text it was never shown -- which is not a
  // finding about the engine but about the order these two lines were in. The
  // engine restores both folded payloads byte for byte when it is given the
  // same scope it compressed: 735,340 -> 50,602 -> 735,340 on browser-session.
  try {
    // ONCE PER KEY, because a fold carries the key of the block it was written
    // in and `expandLongRepeats` honours exactly one: on the body arm the folds
    // in different blocks verify under different keys, and a single pass would
    // leave every one but the first family folded and count them as lost.
    // Each pass is a no-op for markers keyed to anything else.
    for (const key of ours) {
      const unfolded = expandLongRepeats(text, key);
      if (unfolded !== text) {
        parts.push(unfolded);
        text = unfolded;
      }
    }
  } catch (error) {
    if (!refusals.has(label))
      refusals.set(label, String(error.message).split(/\r?\n/)[0]);
  }

  let handed = 0;
  let step = rehydrateSequence();
  const decode = (fragment) => {
    if (MARKER_SHAPED.test(fragment)) handed += 1;
    try {
      const back = step(fragment, keyOf(fragment));
      if (back !== fragment) parts.push(back);
    } catch (error) {
      if (error instanceof PathAddressedError) {
        pathRefusals.set(label, (pathRefusals.get(label) ?? 0) + 1);
        return;
      }
      const first = String(error.message).split('\n')[0];
      if (!refusals.has(label)) refusals.set(label, first);
    }
  };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }

  // THE IMAGES ARE READ OFF THE OUTPUT, NOT OFF THE INPUT, because the question
  // is what a reader holding only the output can rebuild. `dedupImages` keeps
  // the first copy of every distinct image and numbers the rest against it, so
  // the first copies are still here -- but only the parsed structure says which
  // string leaf is an image, which is why the decoder is handed them rather
  // than left to guess from the bytes.
  const imagesAbove = [];
  const findImages = (node) => {
    if (Array.isArray(node)) {
      node.forEach(findImages);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const image = describeImage(node);
    if (image) {
      if (!imagesAbove.includes(image.data)) imagesAbove.push(image.data);
      return;
    }
    Object.values(node).forEach(findImages);
  };
  if (parsed !== undefined) findImages(parsed);
  step = rehydrateSequence(imagesAbove);

  // A BLOCK, NOT EVERY STRING. `rehydrateSequence` resolves the run form by
  // ORDER -- it names the block after the one the reference above it resolved
  // to -- so it has to be handed the block texts, in reader order, and nothing
  // else. Walking every string leaf interleaves each block's own `"text"` type
  // discriminator between the markers, which breaks the walk the form
  // describes. The quoted forms survived that because they resolve by CONTENT
  // and a stray string never matches a quote; the first order-addressed marker
  // is what made the sloppiness visible. These are the keys `mapBlocks` writes
  // through, so they are the whole set of places a marker can be.
  const TEXT_BEARING = new Set(['messages', 'system', 'content', 'text']);
  const walk = (node) => {
    if (typeof node === 'string') decode(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object')
      for (const [key, value] of Object.entries(node))
        if (TEXT_BEARING.has(key)) walk(value);
  };
  // A SERIALISED MESSAGE LIST IS NOT A BLOCK, and handing one to a line-oriented
  // decoder asks a question with no answer: the document is one line with every
  // newline escaped, so a marker claiming 8 folded rows meets 135 candidates and
  // the decoder correctly refuses. That refusal said nothing about our output --
  // it was the harness mis-addressing the decoder -- and it produced four of the
  // names on the gap list. So when the payload parses, the attempt is made over
  // its BLOCKS -- see the walk above for why the string leaves are not them.
  if (parsed !== undefined) walk(parsed);
  else decode(text);
  // NOT TAKEN ON TRUST. Narrowing the walk could quietly stop handing the
  // decoder a marker, and a marker never handed over is a marker that never
  // refuses -- which turns a gap into a clean row and reads as an improvement.
  // So count the back-references anywhere in the payload and insist the walk
  // above was given every one of them.
  let reachable = 0;
  const countMarkers = (node) => {
    if (typeof node === 'string') {
      if (MARKER_SHAPED.test(node)) reachable += 1;
    } else if (Array.isArray(node)) node.forEach(countMarkers);
    else if (node && typeof node === 'object')
      Object.values(node).forEach(countMarkers);
  };
  if (parsed !== undefined) countMarkers(parsed);
  else if (MARKER_SHAPED.test(text)) reachable += 1;
  if (handed < reachable && !refusals.has(label))
    refusals.set(
      label,
      `harness: ${reachable - handed} of ${reachable} back-references were ` +
        'never handed to the decoder'
    );
  return parts.join('\n');
}
