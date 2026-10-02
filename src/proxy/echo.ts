/**
 * How much of a reply is text the model was already shown.
 *
 * TIER 3 OF THE OUTPUT LEDGER, AND NOT A SAVING. The other two tiers are
 * differences between two populations: what we emitted against what comparable
 * untreated requests emitted. This one has no counterfactual at all. It is a
 * property of a single response -- the share of its word n-grams that already
 * appear verbatim in the context we sent -- and it answers a question the other
 * two cannot: whether there is output waste here worth attacking in the first
 * place. A high ratio is an opportunity; it is never added to a saving, and the
 * renderer must never let it be read as one.
 *
 * JUDGED AGAINST WHAT WE SENT, NOT AGAINST THE ORIGINAL. The model can only
 * echo what reached it, so the n-grams come from the FORWARDED body. Measuring
 * against the pre-compression conversation would count a passage we had already
 * removed as something the model copied, which is the opposite of true.
 *
 * COUNTS ONLY LEAVE THIS FILE. The scanner holds hashes of the context and a
 * handful of words of carry while a response streams, and emits one number
 * between 0 and 1. No text, no n-gram and no hash is recorded, logged or
 * transmitted, and the scanner is discarded when the response ends.
 *
 * OPT-IN, DEFAULT OFF, because it is the one instrument here that costs real
 * memory while a request is in flight -- a long context is a few hundred
 * thousand hashes -- and an operator who has not asked for an output-waste
 * figure should not pay for one.
 *
 * REFUSES RATHER THAN UNDERSTATES. Every bound in this file (the n-gram cap,
 * the pending-buffer cap) makes the scanner return `null` when it is hit, never
 * a ratio computed from the part it managed to see. An understated waste figure
 * would make a future output optimizer look better than it is, which is exactly
 * the direction a measurement must not be allowed to fail in.
 */

/** The env var that turns the scanner on. Absent or falsey means no scan. */
export const ECHO_ENV = 'TOKEN_OPTIMIZER_OUTPUT_ECHO';

/**
 * Words per n-gram. Eight is long enough that ordinary prose does not match by
 * chance -- a shared four-word phrase is unremarkable English -- and short
 * enough to catch a restated sentence rather than only a copied paragraph.
 */
export const ECHO_WINDOW = 8;

/**
 * The context n-gram cap, past which the scanner refuses.
 *
 * 200,000 distinct hashes is roughly a 200k-word context, well past the largest
 * window any current model offers, and about 1.6 MB of `Set<number>` while one
 * request is in flight.
 */
export const ECHO_MAX_NGRAMS = 200_000;

/**
 * The cap on response bytes held while waiting for a JSON string to close.
 *
 * A complete `"text":"..."` value is consumed the moment its closing quote
 * arrives, so this only ever holds one partial value. A body that pushes past
 * it is malformed or is not the shape we parse, and either way the scan is
 * abandoned rather than finished from a fragment.
 */
export const ECHO_MAX_PENDING = 262_144;

/**
 * The JSON keys whose string values are treated as text.
 *
 * ONE SET FOR BOTH SIDES. `text` covers an Anthropic content block and an SSE
 * `text_delta`; `content` covers an OpenAI message whose content is a bare
 * string; `system` covers a system prompt sent the same way. Using the same
 * extractor on the request and the response is what makes the two sides
 * comparable -- a context scanned by one rule and a reply scanned by another
 * would disagree about what a word is.
 */
const TEXT_KEYS = ['text', 'content', 'system'] as const;

export function echoEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[ECHO_ENV];
  if (typeof raw !== 'string') return false;
  const value = raw.trim().toLowerCase();
  return value !== '' && value !== '0' && value !== 'false' && value !== 'off';
}

/** FNV-1a over the UTF-16 code units, as an unsigned 32-bit value. */
function hashWord(word: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < word.length; index += 1) {
    hash ^= word.charCodeAt(index) & 0xff;
    hash = Math.imul(hash, 0x01000193);
    hash ^= (word.charCodeAt(index) >>> 8) & 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** FNV-1a again, over the window's word hashes, so order matters. */
function hashWindow(words: readonly number[], start: number, size: number): number {
  let hash = 0x811c9dc5;
  for (let offset = 0; offset < size; offset += 1) {
    let word = words[start + offset] ?? 0;
    for (let byte = 0; byte < 4; byte += 1) {
      hash ^= word & 0xff;
      hash = Math.imul(hash, 0x01000193);
      word >>>= 8;
    }
  }
  return hash >>> 0;
}

/**
 * WHY HASHES AND NOT THE N-GRAMS THEMSELVES. A `Set<string>` of 200,000
 * eight-word phrases is tens of megabytes per in-flight request. A
 * `Set<number>` of 32-bit hashes is about 1.6 MB, at the cost of collisions:
 * at 200,000 entries the chance that a given non-echoed n-gram collides with
 * some context n-gram is about 0.005%, which moves a ratio in the fourth
 * decimal place.
 *
 * AND THE ERROR RUNS THE RIGHT WAY ROUND ONLY HERE. A collision can only
 * OVERSTATE echo, which overstates the waste left to attack -- the direction
 * that makes our own future work look worse, not better. A Bloom filter sized
 * for the same memory would do the same thing with a worse constant; a lossy
 * cache that dropped entries would understate, and must not be used.
 */
export function contextNgrams(
  text: string,
  size: number = ECHO_WINDOW
): Set<number> | null {
  if (size < 1) return null;
  const words = splitWords(text).map(hashWord);
  if (words.length < size) return null;
  const seen = new Set<number>();
  for (let index = 0; index + size <= words.length; index += 1) {
    seen.add(hashWindow(words, index, size));
    if (seen.size > ECHO_MAX_NGRAMS) return null;
  }
  return seen;
}

export function splitWords(text: string): string[] {
  return text.split(/\s+/).filter((word) => word !== '');
}

/** A complete text value pulled out of a buffer, and what is left to re-scan. */
export interface Extraction {
  readonly values: readonly string[];
  readonly rest: string;
}

/** The longest prefix that could still turn into a key match: `"system": "`. */
const MAX_KEY_CARRY = 16;

/**
 * Pulls every COMPLETE text value out of a buffer, leaving the rest for later.
 *
 * INCREMENTAL BECAUSE A STREAM DOES NOT RESPECT TOKENS. An SSE chunk can split
 * `"text":"hello"` anywhere -- inside the key, before the colon, inside the
 * value -- so a scan that discarded what it could not finish would silently
 * drop exactly the long passages a copied paragraph arrives in. Anything not
 * consumed comes back as `rest` and is re-scanned with the next chunk.
 */
export function extractTextValues(buffer: string): Extraction {
  const values: string[] = [];
  let cursor = 0;
  let cut = 0;
  for (;;) {
    const found = nextKey(buffer, cursor);
    if (found === null) {
      // Keep only enough tail to re-form a key split across the boundary.
      const keep = Math.max(cut, buffer.length - MAX_KEY_CARRY);
      return { values, rest: buffer.slice(keep) };
    }
    const open = openQuote(buffer, found.end);
    if (open === null) return { values, rest: buffer.slice(found.start) };
    // NOT A KEY AT ALL, SO SKIP IT RATHER THAN WAIT FOR IT. Every Anthropic
    // content block carries the literal `"type":"text"`, where `"text"` is a
    // VALUE and no colon follows it. Treating that as an unfinished key would
    // park the cursor on it forever: each new chunk would re-scan from the same
    // offset, find the same non-key, and the pending buffer would grow until it
    // hit its cap and the whole scan was refused -- on every single response.
    if (open === SKIP) {
      cursor = found.end;
      cut = Math.max(cut, found.end - MAX_KEY_CARRY);
      continue;
    }
    const close = closeQuote(buffer, open + 1);
    if (close === null) return { values, rest: buffer.slice(found.start) };
    const decoded = decode(buffer.slice(open, close + 1));
    if (decoded !== null) values.push(decoded);
    cursor = close + 1;
    cut = cursor;
  }
}

function nextKey(
  buffer: string,
  from: number
): { readonly start: number; readonly end: number } | null {
  let best: { start: number; end: number } | null = null;
  for (const key of TEXT_KEYS) {
    const needle = `"${key}"`;
    const at = buffer.indexOf(needle, from);
    if (at < 0) continue;
    if (best === null || at < best.start)
      best = { start: at, end: at + needle.length };
  }
  return best;
}

/** Returned when the match was a string value, not a key, and must be passed. */
const SKIP = -1;

/**
 * The index of the value's opening quote, `SKIP` when this was not a key, or
 * null when the buffer has not yet revealed which of the two it is.
 */
function openQuote(buffer: string, from: number): number | null {
  let index = skipSpace(buffer, from);
  if (index === null) return null;
  if (buffer[index] !== ':') return SKIP;
  index = skipSpace(buffer, index + 1);
  if (index === null) return null;
  return buffer[index] === '"' ? index : SKIP;
}

function skipSpace(buffer: string, from: number): number | null {
  let index = from;
  while (index < buffer.length && /\s/.test(buffer[index] ?? '')) index += 1;
  return index < buffer.length ? index : null;
}

/** The index of the value's closing quote, honouring escapes. */
function closeQuote(buffer: string, from: number): number | null {
  for (let index = from; index < buffer.length; index += 1) {
    const char = buffer[index];
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === '"') return index;
  }
  return null;
}

function decode(quoted: string): string | null {
  try {
    const value: unknown = JSON.parse(quoted);
    return typeof value === 'string' ? value : null;
  } catch {
    // A slice that will not parse as a JSON string is not one. The response is
    // unaffected either way -- this runs beside a stream that has already been
    // delivered.
    return null;
  }
}

/** Watches a response stream and reports how much of it was already in view. */
export interface EchoScanner {
  /** Feeds one decoded response chunk. Never throws. */
  push(chunk: string): void;
  /** The echo ratio in [0, 1], or null when the scan cannot stand behind one. */
  ratio(): number | null;
}

/**
 * A scanner over one response, or null when no ratio is possible for it.
 *
 * NULL IS A FIRST-CLASS ANSWER HERE. A context shorter than one window, or one
 * so large its n-grams pass the cap, gives a ratio that would be a different
 * statistic from the one this reports. The caller records nothing in that case,
 * and the ledger's absent field says "not scanned" rather than "no echo found".
 */
export function createEchoScanner(
  contextText: string,
  size: number = ECHO_WINDOW
): EchoScanner | null {
  const seen = contextNgrams(contextText, size);
  if (seen === null) return null;
  let pending = '';
  let refused = false;
  let hits = 0;
  let total = 0;
  // THE CARRY, WHICH IS WHY A STREAMED REPLY MEASURES THE SAME AS A WHOLE ONE.
  // `carry` holds the last size-1 word hashes so a window spanning two deltas
  // is still counted, and `partial` holds a final word that may be continued by
  // the next delta -- `hel` + `lo` must become one word, not two.
  let carry: number[] = [];
  let partial = '';
  const feed = (value: string): void => {
    const joined = partial + value;
    const words = splitWords(joined);
    // A value not ending in whitespace may have its last word continued.
    if (words.length > 0 && !/\s$/.test(joined)) {
      partial = words[words.length - 1] ?? '';
      words.pop();
    } else {
      partial = '';
    }
    if (words.length === 0) return;
    const hashes = carry.concat(words.map(hashWord));
    for (let index = 0; index + size <= hashes.length; index += 1) {
      total += 1;
      if (seen.has(hashWindow(hashes, index, size))) hits += 1;
    }
    carry = hashes.slice(Math.max(0, hashes.length - (size - 1)));
  };
  return {
    push(chunk: string): void {
      if (refused) return;
      try {
        pending += chunk;
        const { values, rest } = extractTextValues(pending);
        for (const value of values) feed(value);
        pending = rest;
        // A SINGLE VALUE THAT NEVER CLOSES, so the scan is abandoned rather
        // than completed from the fragment it did see. See the file header on
        // why an understated ratio is the one failure mode to refuse.
        if (pending.length > ECHO_MAX_PENDING) refused = true;
      } catch {
        // Instrumentation beside a response that has already been delivered.
        refused = true;
      }
    },
    /**
     * THE LAST WORD HAS TO BE FLUSHED, OR EVERY REPLY LOSES ITS FINAL WINDOW.
     * `feed` holds back a trailing word because a chunk boundary can split one,
     * and nothing in the stream ever says "that was the end". Asking for the
     * ratio does: by then the response has settled, so the held word is a whole
     * word and the window ending on it is a real window. Dropping it understated
     * every ratio by one window, which on a short reply is the difference between
     * a figure and a wrong figure -- and understating output waste is the one
     * direction this file exists to refuse.
     *
     * COMPUTED WITHOUT MUTATING, so a ratio read mid-stream neither corrupts the
     * final one nor double-counts the window it provisionally scored.
     */
    ratio(): number | null {
      if (refused) return null;
      let tailHits = 0;
      let tailTotal = 0;
      if (partial !== '') {
        const hashes = carry.concat([hashWord(partial)]);
        for (let index = 0; index + size <= hashes.length; index += 1) {
          tailTotal += 1;
          if (seen.has(hashWindow(hashes, index, size))) tailHits += 1;
        }
      }
      const counted = total + tailTotal;
      if (counted === 0) return null;
      return (hits + tailHits) / counted;
    },
  };
}
