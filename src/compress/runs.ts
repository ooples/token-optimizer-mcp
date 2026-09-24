/**
 * Fold a long stretch of bytes that is an exact repeat of one already above it.
 *
 * WHY THIS IS NOT `dedup`, `segments` OR `log`. Those three each fold a repeat
 * at a boundary somebody else drew: `dedup` works on whole request blocks,
 * `segments` on headings and blank lines, `log` on lines. A serialised message
 * list holding two copies of the same screenshot has none of those boundaries --
 * it is one line, 780,000 characters wide, and every walker that keys on a line
 * or a block looks straight past 346,732 characters of byte-identical base64.
 * Measured on the browser workload, that hole was the whole gap: the block
 * router removed 5.9% where the request-level arm, which can see the image
 * blocks as structure, removed 49.7% of the same bytes.
 *
 * WHAT IT COSTS THE READER: nothing that needs a round trip. The referent is
 * still in the output, above the marker, and the marker says how much to copy
 * and which run to copy it from. That makes it reconstructible from the output
 * alone -- the same category the rest of this module's back-references sit in --
 * rather than recoverable-with-a-read.
 */

import type { CompressionResult, Elision } from './types.js';

/**
 * The window the index is built on.
 *
 * Any repeat at least this long lands a whole window on some position of both
 * copies, so indexing every position -- not every aligned position -- is what
 * makes the search exact rather than lucky. An aligned index finds a repeat
 * only when the two copies happen to be congruent modulo the window, which for
 * two images at arbitrary offsets in a JSON document is a coin toss.
 */
const GRAIN = 256;

/**
 * The shortest repeat worth a marker.
 *
 * The marker is around 90 characters once the quote that addresses the referent
 * is in it, so anything near that size is noise. This is set far above the
 * break-even point on purpose: this pass exists for the case where a large
 * opaque payload is sent twice, and folding a 200-character coincidence out of
 * prose would cost legibility for a saving nobody would notice.
 */
const MIN_REPEAT = 2_048;

/** The opening quote starts here and doubles until it names one run. */
const QUOTE_START = 24;

/**
 * Mixing constants for the rolling window hash.
 *
 * SIZED FOR DOUBLES, NOT FOR ENTROPY. Every intermediate has to stay under
 * 2^53 or the modulus stops meaning anything: at a base of 16,777,619 the
 * product `hash * BASE` reaches 3.4e16, which rounds, and the rounding made
 * every position collide with every other. The symptom was not a wrong answer
 * -- the byte comparison below catches that -- but a scan that verified 256
 * characters at every one of three quarters of a million positions.
 */
const BASE = 131;
const MOD = 2_147_483_647;

/**
 * A rolling hash of every GRAIN-wide window, one entry per position.
 *
 * `Int32Array` rather than a `Map` of strings: the string form was correct and
 * held a quarter of a megabyte of keys for a payload of three quarters of one,
 * which is a lot of memory to spend on something the verification pass checks
 * anyway. A collision here costs one failed comparison, never a wrong fold.
 */
function windowHashes(text: string): Int32Array {
  const last = text.length - GRAIN;
  const hashes = new Int32Array(Math.max(0, last + 1));
  if (last < 0) return hashes;

  let power = 1;
  for (let i = 1; i < GRAIN; i += 1) power = (power * BASE) % MOD;

  let hash = 0;
  for (let i = 0; i < GRAIN; i += 1)
    hash = (hash * BASE + text.charCodeAt(i)) % MOD;
  hashes[0] = hash;

  for (let i = 1; i <= last; i += 1) {
    hash = (hash - ((text.charCodeAt(i - 1) * power) % MOD) + MOD) % MOD;
    hash = (hash * BASE + text.charCodeAt(i + GRAIN - 1)) % MOD;
    hashes[i] = hash;
  }
  return hashes;
}

/**
 * The shortest opening that leads a reader to the right bytes.
 *
 * ADDRESSED BY CONTENT, NOT BY OFFSET, for the reason `quoteFor` in `dedup.ts`
 * gives: an offset is a number the reader cannot check and the encoder has to
 * keep true through every later rewrite, while a quote is checkable by looking
 * up. The lookup is decided against the text ABOVE the marker, because that is
 * exactly what a decoder holds when it reaches one.
 *
 * NOT UNIQUENESS -- THE RIGHT BYTES. Requiring the opening to occur once and
 * only once above looked stricter and was simply wrong for the case this pass
 * exists to serve: a payload holding the same screenshot three times has an
 * opening that matches all the earlier copies, and every one of them is
 * followed by the identical run. Refusing there gave up 137,000 characters on
 * the browser workload to protect against an ambiguity that does not exist.
 * First-wins is the rule `rehydrateSequence` already resolves a literal by,
 * and what makes it safe here is that the encoder checks the bytes the rule
 * actually lands on -- and then decodes its whole output and compares.
 */
function quoteFor(
  text: string,
  from: number,
  length: number,
  before: number
): string | null {
  const prefix = text.slice(0, before);
  const run = text.substr(from, length);
  for (let size = QUOTE_START; size <= length; size *= 2) {
    const needle = text.substr(from, size);
    // A WIDER WINDOW CANNOT LOSE A CHARACTER THE NARROW ONE HELD, so an
    // opening that cannot be delimited is a refusal now, not after three more
    // doublings that will each carry the same backtick.
    if (needle.includes(FENCE)) return null;
    const at = prefix.indexOf(needle);
    if (at !== -1 && prefix.substr(at, length) === run) return needle;
  }
  return null;
}
/**
 * The character the quote is delimited by.
 *
 * A BACKTICK, NOT A DOUBLE QUOTE, WHICH IS WHAT THE OTHER MARKERS IN THIS
 * MODULE USE. Those all sit inside one block, and the block is escaped by
 * `JSON.stringify` on its way to the wire, so a quote in them costs nothing.
 * This pass is the only one that can also be handed a whole serialised
 * request -- a document whose quoting has ALREADY happened -- and a raw `"`
 * dropped into that ends the string it lands in. Measured: three of the twelve
 * comparator payloads stopped parsing as JSON, and the harness scored the
 * identifiers in them as unrecoverable, which is how a real win reads as a
 * loss. A backtick needs no escape in either context.
 */
const FENCE = '`';

/** What a folded run looks like in the output. */
function markerFor(length: number, quote: string): string {
  return `[... ${length.toLocaleString('en-US')} bytes, an exact repeat of the run opening ${FENCE}${quote}${FENCE} above]`;
}

/**
 * The grammar `rehydrate` inverts.
 *
 * The quote runs to the next backtick and cannot contain one, because
 * `quoteFor` refuses an opening that does -- so the delimiter is exact rather
 * than lazily guessed, and a marker the encoder never wrote cannot be read as
 * one. A newline inside a quote is allowed and simply makes the marker two
 * lines: this pass runs last, and `rehydrate` runs it first, so no
 * line-oriented decoder ever sees the marker whole.
 */
const FOLDED =
  /\[\.\.\. ([\d,]+) bytes, an exact repeat of the run opening `([^`]*)` above\]/;

/** Is there a folded run anywhere in here? */
export function hasFoldedRuns(text: string): boolean {
  return FOLDED.test(text);
}

/**
 * Puts every folded run back, left to right.
 *
 * LEFT TO RIGHT IS LOAD-BEARING. A marker addresses a run in the text above it,
 * and `foldLongRepeats` never points at a region that is itself folded, so by
 * the time a marker is reached everything it can name is already whole.
 *
 * STRICT, like the other decoders here: a quote that names nothing above, or
 * a length that runs off the end of what has been rebuilt, throws rather than
 * resolving to a guess. A decoder that guesses is worse than no decoder,
 * because the guess is silent.
 */
export function expandLongRepeats(text: string): string {
  const pattern = new RegExp(FOLDED.source, 'g');
  let out = '';
  let read = 0;
  for (;;) {
    pattern.lastIndex = read;
    const found = pattern.exec(text);
    if (!found) break;
    out += text.slice(read, found.index);

    const length = Number(found[1].replace(/,/g, ''));
    const quote = found[2];

    // FIRST WINS, the same rule the encoder addressed it by. Several earlier
    // copies of one run share an opening, and they are the same bytes, so
    // which one is read from cannot change the answer.
    const at = out.indexOf(quote);
    if (at === -1)
      throw new Error(
        `expandLongRepeats: quote names no run above: ${found[0]}`
      );
    if (at + length > out.length)
      throw new Error(`expandLongRepeats: run runs past its source: ${found[0]}`);

    out += out.slice(at, at + length);
    read = found.index + found[0].length;
  }
  return out + text.slice(read);
}

/**
 * Is the character at `at` a quote that opens or closes a JSON string?
 *
 * A quote is a boundary unless a backslash escapes it, and a backslash is
 * only an escape when an even number of them precede it -- `\\\\"` ends a
 * string, `\\"` does not.
 */
function atStringEdge(text: string, at: number): boolean {
  if (text.charCodeAt(at) !== QUOTE) return false;
  let back = at - 1;
  while (back >= 0 && text.charCodeAt(back) === BACKSLASH) back -= 1;
  return (at - 1 - back) % 2 === 0;
}

/**
 * Every position in `text` holding a quote that opens or closes a JSON string,
 * in order.
 *
 * One pass, because the alternative is counting quotes from the start of the
 * document once per candidate repeat.
 */
function stringEdges(text: string): number[] {
  const at: number[] = [];
  for (let i = 0; i < text.length; i += 1) if (atStringEdge(text, i)) at.push(i);
  return at;
}

/**
 * Does `[lo, hi)` sit inside a single JSON string?
 *
 * True when no string edge falls in the region -- so it cannot span two
 * strings -- AND an odd number of edges precede it, which is what being inside
 * one means. The second half is the part worth stating: a region with no
 * quotes in it may just as well be sitting in the structure BETWEEN two
 * strings, and a marker dropped there is not a string at all.
 */
function insideOneString(edges: number[], lo: number, hi: number): boolean {
  let low = 0;
  let high = edges.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (edges[mid] < lo) low = mid + 1;
    else high = mid;
  }
  if (low % 2 === 0) return false;
  return low === edges.length || edges[low] >= hi;
}

/** Would a cut at `at` land between a backslash and what it escapes? */
function splitsEscape(text: string, at: number): boolean {
  let back = at - 1;
  while (back >= 0 && text.charCodeAt(back) === BACKSLASH) back -= 1;
  return (at - 1 - back) % 2 === 1;
}

/** One repeat the scan decided to fold. */
interface Repeat {
  /** Where the copy being removed starts. */
  at: number;
  /** How long the copy is. */
  length: number;
  /** The quote that addresses the run it copies. */
  quote: string;
}

/**
 * How far apart the positions the scan actually probes are.
 *
 * WHY NOT EVERY POSITION. It used to probe every one, and on a payload built
 * out of a repeating pattern nearly every position found an earlier window
 * that matched and then walked thousands of characters before failing the
 * length test -- quadratic, and measured at 146 seconds on a 780 KB request.
 * A repeat of at least MIN_REPEAT characters covers an interval of at least
 * `MIN_REPEAT - GRAIN` in which a whole window still fits, so probing at that
 * stride cannot miss one. What it can do is meet a repeat part way through,
 * which is why the match below grows in both directions from where it landed
 * rather than only forwards.
 */
const STRIDE = MIN_REPEAT - GRAIN;
const QUOTE = 34;
const BACKSLASH = 92;

/** One repeat the scan decided to fold. */
interface Repeat {
  /** Where the copy being removed starts. */
  at: number;
  /** How long the copy is. */
  length: number;
  /** The quote that addresses the run it copies. */
  quote: string;
}

/** Do two windows agree, without building two strings to ask? */
function windowsAgree(text: string, a: number, b: number): boolean {
  for (let k = 0; k < GRAIN; k += 1)
    if (text.charCodeAt(a + k) !== text.charCodeAt(b + k)) return false;
  return true;
}

/**
 * Finds every long exact repeat, in the order a reader meets the copies.
 *
 * A match is grown at a fixed distance `d` from its source: the copy and the
 * original stay exactly that far apart, so growing the pair is one comparison
 * per character in each direction. The length is capped at `d` so a run never
 * reaches back into itself -- the overlapping form LZ77 allows is legal, but
 * it would make the decoder copy from bytes it is still writing, and the
 * strictness the rest of this module keeps is worth more than the last few
 * hundred characters of a fold.
 */
function findRepeats(text: string, document: boolean): Repeat[] {
  const hashes = windowHashes(text);
  if (hashes.length === 0) return [];
  const edges = document ? stringEdges(text) : [];

  const firstAt = new Map<number, number>();
  for (let i = 0; i < hashes.length; i += 1)
    if (!firstAt.has(hashes[i])) firstAt.set(hashes[i], i);

  const found: Repeat[] = [];
  let probe = 0;
  let taken = 0;
  while (probe < hashes.length) {
    const source = firstAt.get(hashes[probe]);
    // A HASH AGREEING IS NOT THE BYTES AGREEING. Verified before anything is
    // measured off it, so a collision costs one comparison and never a fold.
    if (
      source === undefined ||
      source >= probe ||
      !windowsAgree(text, source, probe)
    ) {
      probe += STRIDE;
      continue;
    }

    const d = probe - source;
    let lo = probe;
    let hi = probe + GRAIN;
    // `taken` keeps the copy clear of the one before it; `d` keeps it clear
    // of its own source.
    while (
      lo > taken &&
      lo - d > 0 &&
      hi - lo < d &&
      text.charCodeAt(lo - 1) === text.charCodeAt(lo - d - 1) &&
      // THE SAME BOUNDARY, READ BACKWARDS. The glue in front of two copies is
      // identical too -- `{"text":"` sits in front of both -- so backward
      // growth walks out through the string's OPENING quote and the removed
      // region swallows the structure between the copies.
      !(document && atStringEdge(text, lo - 1))
    )
      lo -= 1;
    while (
      hi < text.length &&
      hi - lo < d &&
      text.charCodeAt(hi) === text.charCodeAt(hi - d) &&
      // ONE STRING, NOT ONE DOCUMENT. Growth is greedy, and what follows two
      // copies of a run is usually the same punctuation, so a run of
      // `"AAAA"},{"AAAA"}` grows through the closing quote and takes it with
      // the copy it removes -- leaving the string it lived in unterminated.
      // The bytes still read back identically, which is why the round-trip
      // check below cannot see it. Stopping at the terminator can.
      !(document && atStringEdge(text, hi))
    )
      hi += 1;

    if (document) {
      // AND NOT THROUGH AN ESCAPE AT EITHER END: a run ending on a lone
      // backslash would escape the `[` the marker opens with, and one starting
      // on an escaped character would leave its backslash behind.
      while (hi > lo && splitsEscape(text, hi)) hi -= 1;
      while (lo < hi && splitsEscape(text, lo)) lo += 1;
    }

    // AND WHOLLY INSIDE ONE STRING. Growth stops at a string edge, but the
    // SEED does not have to start inside a string at all: it is a 256-byte
    // window that matched another 256-byte window, and in a serialised request
    // the glue between two blocks -- `"},{"type":"text","text":"` -- repeats
    // just as faithfully as the content around it. A region that opens in one
    // string and closes in the next is replaced by a marker that merges them
    // and drops the structure in between, and the bytes still read back
    // identically. Measured on the browser-session payload: eleven repeats,
    // a 735,340-character block down to 49,508, every byte restored -- and a
    // document that no longer parsed, so the whole fold was thrown away and
    // the block went out untouched.
    if (document && !insideOneString(edges, lo, hi)) {
      probe += STRIDE;
      continue;
    }

    const length = hi - lo;
    const quote =
      length >= MIN_REPEAT ? quoteFor(text, lo - d, length, lo) : null;
    if (quote === null) {
      probe += STRIDE;
      continue;
    }
    found.push({ at: lo, length, quote });
    taken = hi;
    probe = Math.ceil(hi / STRIDE) * STRIDE;
  }
  return found;
}
/** Does this text read as JSON? */
function parses(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Replaces every long exact repeat with a marker naming the run it copies.
 *
 * Returns `null` when there was nothing to fold, when folding would not pay,
 * or when the result does not read back byte for byte. That last check is the
 * point rather than a belt-and-braces afterthought: this pass rewrites the
 * inside of a line, where no other pass in this module operates, so the cheap
 * way to be sure a quote still addresses what the encoder meant is to decode
 * the output and compare it with the input. It runs on a handful of very large
 * regions, so the comparison costs a scan and buys the whole guarantee.
 */
export function foldLongRepeats(text: string): CompressionResult | null {
  if (text.length < MIN_REPEAT * 2) return null;
  // WAS IT A DOCUMENT BEFORE? Asked before anything is cut, because the answer
  // is only interesting if it was yes: a cut that lands between a backslash
  // and the character it escapes leaves the escape dangling, and nothing in
  // the byte-for-byte check below would notice -- that check reads the text
  // back, and the text is identical either way. Cheap, and only on input that
  // opens like a document.
  const wasDocument = /^\s*[[{]/.test(text.slice(0, 64)) && parses(text);
  const repeats = findRepeats(text, wasDocument);
  if (repeats.length === 0) return null;

  let out = '';
  let read = 0;
  let removed = 0;
  for (const repeat of repeats) {
    out += text.slice(read, repeat.at);
    out += markerFor(repeat.length, repeat.quote);
    read = repeat.at + repeat.length;
    removed += repeat.length;
  }
  out += text.slice(read);

  // NEVER GROW, the same rule every engine here answers to.
  if (out.length >= text.length) return null;

  let readBack: string;
  try {
    readBack = expandLongRepeats(out);
  } catch {
    return null;
  }
  if (readBack !== text) return null;
  // A DOCUMENT THAT PARSED HAS TO STILL PARSE. See `wasDocument` above.
  if (wasDocument && !parses(out)) return null;

  const elision: Elision = {
    removed: `${repeats.length} repeated run${repeats.length === 1 ? '' : 's'}, ${removed.toLocaleString('en-US')} bytes`,
    // Each one is still above, and the marker names which run and how much.
    recoverAt: null,
    lossless: true,
  };
  return { text: out, elisions: [elision], lossless: true };
}
