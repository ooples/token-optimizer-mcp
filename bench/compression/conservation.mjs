/**
 * WHAT THE IDENTIFIER ORACLE CANNOT SEE.
 *
 * `retention.mjs` asks, of a list of identifiers picked out of the payload,
 * which ones survive. It is a sample, and it is a sample of one kind of thing:
 * paths, hashes, error codes, ids. Everything between those identifiers -- the
 * prose of a log line, a stack frame's function names, the words of a comment --
 * is outside its denominator, so an arm could delete a paragraph of English
 * between two preserved paths and every retention column would still read
 * perfect. The gate in `head-to-head.mjs` called `conserved` does not close that
 * hole either: it checks only that the output did not grow and that the store
 * did not exceed twice the input, which is a size sanity check wearing the name
 * of a content one.
 *
 * SO THIS ASKS THE SAME QUESTION OVER THE WHOLE PAYLOAD. Every word in the
 * original long enough to locate without coincidence must be findable afterwards
 * -- in the output, in what the output expands to, or in the spill the output
 * points at. A word in none of those three is content the arm removed and cannot
 * give back, and it is reported in two units: how many distinct words, and how
 * many bytes of the original those words stood for.
 *
 * EIGHT CHARACTERS, the same floor `retention.mjs` uses, and for the same
 * reason: a shorter run matches somewhere in a 700KB document by accident, and a
 * coincidence counted as survival is a credit we award ourselves. Shorter words
 * are excluded from the denominator and counted where a reader can see the
 * exclusion, never silently dropped.
 *
 * WHY PRESENCE AND NOT COUNT. Removing a repeat is the entire point of a
 * back-reference, so an arm that leaves one copy of a word where the original
 * had fifty has lost nothing a reader cannot recover. Presence is therefore the
 * test. The BYTE figure is still taken from the original's occurrences, because
 * the question a byte answers is "how much of the document did those words
 * account for", not "how much was removed".
 */

export const MIN_WORD_LEN = 8;

// A word is a maximal run of the characters that make up identifiers, names and
// ordinary English alike. Splitting on anything narrower (say, whitespace) would
// hand back `foo(bar,` as one unit, and a unit that exists in no other document
// can never be found in the output.
const WORD = /[A-Za-z0-9_]+/g;

/**
 * The words of a document, with how many times each occurs.
 */
export function contentWords(text) {
  const counts = new Map();
  if (typeof text !== 'string' || text.length === 0) return counts;
  for (const m of text.matchAll(WORD)) {
    const w = m[0];
    if (w.length < MIN_WORD_LEN) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return counts;
}

/**
 * What an arm dropped and could not give back.
 *
 * `hasSink` separates "nothing was in the spill" from "this arm has no spill to
 * look in", the same third state `retention.mjs` reports as null, so a zero here
 * can never mean the question went unasked.
 */
export function unaccounted({
  before,
  output = '',
  reconstructed = '',
  spill = '',
  hasSink = false,
  sampleMissing = 5,
}) {
  const words = contentWords(before);
  let inOutput = 0;
  let inReconstruction = 0;
  let inSpill = 0;
  let gone = 0;
  let goneMass = 0;
  let beforeMass = 0;
  const missing = [];

  for (const [w, n] of words) {
    beforeMass += n * w.length;
    if (output.includes(w)) inOutput++;
    else if (reconstructed.includes(w)) inReconstruction++;
    else if (hasSink && spill.includes(w)) inSpill++;
    else {
      gone++;
      goneMass += n * w.length;
      if (missing.length < sampleMissing) missing.push(w);
    }
  }

  return {
    words: words.size,
    inOutput,
    inReconstruction,
    // NOT ZERO when there is no sink. See the header.
    inSpill: hasSink ? inSpill : null,
    gone,
    goneMass,
    beforeMass,
    // The share of the original's bytes that the dropped words accounted for.
    // Zero words gives zero, and an empty document gives zero rather than NaN,
    // because an empty payload is not a perfect score -- it is no reading, and
    // the caller decides what to do with a `words` of 0.
    goneShare: beforeMass > 0 ? goneMass / beforeMass : 0,
    missing,
  };
}
