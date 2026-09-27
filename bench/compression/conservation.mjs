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
export function contentWords(text, minLen = MIN_WORD_LEN) {
  const counts = new Map();
  if (typeof text !== 'string' || text.length === 0) return counts;
  for (const m of text.matchAll(WORD)) {
    const w = m[0];
    if (w.length < minLen) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return counts;
}

/**
 * THE FLOORS TRIED, LARGEST FIRST. Eight is where every other row already
 * resolves; four is as low as the survey went, and below it a run matches
 * somewhere in a 700KB document often enough that a coincidence would be counted
 * as survival.
 */
export const FLOORS = [8, 7, 6, 5, 4];

/**
 * THE FLOOR A ROW CAN ACTUALLY BE JUDGED AT, chosen by the control rather than
 * fixed by this file.
 *
 * At eight characters the control -- half the output, no expansion, no spill --
 * loses nothing on code-search, issue-triage and relevance-probe. Their variety
 * lives in short tokens (`evt_0`, `tenant 3`) while their long words are a
 * handful of repeated template strings, so half such a document still contains
 * every one of them. `gone: 0` there is a blind spot wearing the shape of
 * evidence.
 *
 * A 48-byte segment was tried as a second unit and measured on all eighteen rows
 * before being gated on any. It failed, and the measurement is why: on the
 * fifteen rows where the word oracle resolves the two units disagreed on
 * thirteen -- api-responses read 1332 of 1332 segments gone where no word was --
 * and on the three blind rows it tracked its own control to within 1 to 20%.
 * The cause is not subtle: the engine templates values,
 *
 *   Template: ["  {
    \"id\": \"doc_",0,"\",
    \"score\": ",1,...]
 *
 * so `doc_100` is not a literal substring of an output that decodes back
 * exactly, and a 48-byte window breaks on every reformat. Reformatting is the
 * one thing this engine always does, so the unit measured framing, not content.
 *
 * A WORD SURVIVES A REFORMAT, which is why the fix is the floor and not the
 * unit. Lowering it costs power, not soundness: a shorter word has more chance
 * of matching somewhere by accident, and an accidental match makes the oracle
 * LENIENT -- it credits us with content we dropped. It cannot invent a loss.
 * Excluding short words from the denominator entirely, which is what a fixed
 * floor of 8 does on these three rows, credits us too, and does it without
 * measuring anything.
 *
 * So the floor is the LARGEST one at which the control still detects a loss.
 * Largest, because that is the least coincidence risk that still leaves the
 * oracle any power; and chosen by the control, because the control is the
 * known-answer arm -- content really was removed from it. A row where no floor
 * discriminates is reported as blind rather than given a number.
 *
 * @param {string} before the original payload
 * @param {string} control the deliberately mutilated output
 * @param {number[]} floors candidates, largest first
 * @returns {{minLen: number|null, tried: Array<{minLen: number, words: number,
 *   controlGone: number}>}} `minLen` is null when the control detects nothing at
 *   any floor, which is the only honest reading of such a row.
 */
export function discriminatingFloor(before, control, floors = FLOORS) {
  const tried = [];
  let chosen = null;
  for (const minLen of floors) {
    const words = contentWords(before, minLen);
    let controlGone = 0;
    for (const w of words.keys()) if (!control.includes(w)) controlGone++;
    tried.push({ minLen, words: words.size, controlGone });
    if (chosen === null && controlGone > 0) chosen = minLen;
  }
  return { minLen: chosen, tried };
}

/**
 * What an arm dropped and could not give back.
 *
 * `minLen` is the word floor, and it is not always 8: `discriminatingFloor`
 * below picks it per payload, because on three fixtures the 8-character floor
 * admits so few words that no reading over them means anything.
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
  minLen = MIN_WORD_LEN,
}) {
  const words = contentWords(before, minLen);
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
    minLen,
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
