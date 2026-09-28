/**
 * KEEPING THE PREFIX THE PROVIDER ALREADY HOLDS, BYTE FOR BYTE.
 *
 * A request that goes out re-serialised is a cache MISS even when every field
 * in it is unchanged. The provider matches its cache on bytes, not on meaning,
 * and `JSON.stringify` does not reproduce the bytes it was given: the captures
 * here are indented, `stringify` emits compact, and the two agree for exactly
 * the 57 characters of `{"model":"...","messages":` before the first newline
 * of the original. So an arm could decline to touch a single message behind
 * the client's `cache_control` marker -- which is what the strategies do -- and
 * still destroy the hit on the way out, paying a 1.25x cache WRITE for a prefix
 * it had every right to send back at the 1.0x read rate.
 *
 * The fix is not to serialise that part at all. Whatever leading run of
 * messages came back unchanged is copied out of the ORIGINAL buffer at its
 * original offsets, and only the tail is stringified.
 *
 * WHY THIS IS A SCANNER AND NOT A PARSER. We need byte offsets, and
 * `JSON.parse` discards them. The scanner below walks the top-level object
 * once, recording where each element of `messages` ends, and understands just
 * enough JSON to do that: strings with escapes, and bracket depth. It never
 * interprets a value.
 *
 * EVERY REFUSAL HERE RETURNS null AND THE CALLER RE-SERIALISES. A wrong splice
 * would emit malformed JSON to the provider, so anything unexpected -- a key
 * order we did not predict, a value the strategy edited ahead of `messages`, a
 * text that does not scan -- falls back to the behaviour that was always there.
 */

/** Index just past the JSON string starting at `i` (which must be a quote). */
function skipString(text: string, i: number): number {
  i += 1;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === 92) {
      i += 2;
      continue;
    }
    if (c === 34) return i + 1;
    i += 1;
  }
  return -1;
}

/** Index just past the complete JSON value starting at or after `i`. */
function skipValue(text: string, i: number): number {
  while (i < text.length && /\s/.test(text[i])) i += 1;
  if (i >= text.length) return -1;
  const c = text[i];
  if (c === '"') return skipString(text, i);
  if (c === '{' || c === '[') {
    let depth = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '"') {
        const end = skipString(text, i);
        if (end < 0) return -1;
        i = end;
        continue;
      }
      if (ch === '{' || ch === '[') depth += 1;
      else if (ch === '}' || ch === ']') {
        depth -= 1;
        if (depth === 0) return i + 1;
      }
      i += 1;
    }
    return -1;
  }
  while (i < text.length && !/[,\]}\s]/.test(text[i])) i += 1;
  return i;
}

export interface PrefixSpan {
  key: string;
  /** Offsets bounding the key's value as the original spelled it. */
  start: number;
  end: number;
}

export interface PrefixScan {
  /** Top-level keys in the order the original spelled them, before `messages`. */
  keysBefore: PrefixSpan[];
  /** Offsets bounding each element of `messages`, as the original spelled it. */
  messages: Array<{ start: number; end: number }>;
  /** Offset of the `]` that closes `messages`. */
  arrayEnd: number;
}

/**
 * Walks the top-level object of an Anthropic-shaped request and records where
 * each message ends. Returns null if the text is not a single object with a
 * `messages` array, or does not scan cleanly.
 */
export function scanRequest(text: string): PrefixScan | null {
  let i = 0;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  if (text[i] !== '{') return null;
  i += 1;
  const keysBefore: PrefixSpan[] = [];
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (text[i] === '}') return null; // no `messages` key at all
    if (text[i] !== '"') return null;
    const keyEnd = skipString(text, i);
    if (keyEnd < 0) return null;
    let key: string;
    try {
      key = JSON.parse(text.slice(i, keyEnd)) as string;
    } catch {
      return null;
    }
    i = keyEnd;
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (text[i] !== ':') return null;
    i += 1;
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (key !== 'messages') {
      const end = skipValue(text, i);
      if (end < 0) return null;
      keysBefore.push({ key, start: i, end });
      i = end;
      while (i < text.length && /\s/.test(text[i])) i += 1;
      if (text[i] === ',') {
        i += 1;
        continue;
      }
      if (text[i] === '}') return null; // ran out before `messages`
      return null;
    }
    if (text[i] !== '[') return null;
    i += 1;
    const messages: Array<{ start: number; end: number }> = [];
    while (i < text.length) {
      while (i < text.length && /\s/.test(text[i])) i += 1;
      if (text[i] === ']') return { keysBefore, messages, arrayEnd: i };
      const start = i;
      const end = skipValue(text, i);
      if (end < 0) return null;
      messages.push({ start, end });
      i = end;
      while (i < text.length && /\s/.test(text[i])) i += 1;
      if (text[i] === ',') {
        i += 1;
        continue;
      }
      if (text[i] === ']') return { keysBefore, messages, arrayEnd: i };
      return null;
    }
    return null;
  }
  return null;
}

/** Structural deep equality, order-sensitive for arrays and keys alike. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => same(v, b[i]));
  }
  if (typeof a !== 'object') return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every(
    (k) =>
      Object.prototype.hasOwnProperty.call(b, k) &&
      same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
  );
}

/** Parses a slice of the original, or a sentinel that is equal to nothing. */
const NOTHING = Symbol('unparseable');
function valueAt(text: string, start: number, end: number): unknown {
  try {
    return JSON.parse(text.slice(start, end)) as unknown;
  } catch {
    return NOTHING;
  }
}

/**
 * Re-emits `next` while keeping the longest leading run of messages that came
 * back unchanged EXACTLY as `original` spelled them.
 *
 * BOTH SIDES OF EVERY COMPARISON COME FROM THE ORIGINAL BYTES. The parsed
 * request the strategies receive is edited in place, so it is not a record of
 * what arrived; comparing against it would let an edited message match itself
 * and be re-emitted from the original text, quietly reverting the edit. Reading
 * the old side back out of `original` makes that impossible: whatever gets
 * copied is, by construction, what the provider already holds.
 *
 * Returns null when nothing can be preserved or when preserving would risk a
 * malformed body -- the caller then serialises as it always did.
 */
export function serialiseKeepingPrefix(
  original: string,
  next: { messages?: unknown[] } & Record<string, unknown>
): string | null {
  const newMsgs = next.messages;
  if (!Array.isArray(newMsgs)) return null;
  const scan = scanRequest(original);
  if (!scan) return null;

  // EVERY KEY THE ORIGINAL PUT AHEAD OF `messages` IS COMING ALONG VERBATIM,
  // so any edit to one of them has to abort the splice rather than be silently
  // dropped -- and a key the strategy ADDED before `messages` would be emitted
  // twice, once stale and once fresh.
  for (const span of scan.keysBefore) {
    if (!Object.prototype.hasOwnProperty.call(next, span.key)) return null;
    if (!same(valueAt(original, span.start, span.end), next[span.key]))
      return null;
  }

  let keep = 0;
  const limit = Math.min(scan.messages.length, newMsgs.length);
  while (keep < limit) {
    const span = scan.messages[keep];
    if (!same(valueAt(original, span.start, span.end), newMsgs[keep])) break;
    keep += 1;
  }
  if (keep === 0) return null;

  const head = original.slice(0, scan.messages[keep - 1].end);
  const tail = newMsgs.slice(keep);
  const seen = new Set(scan.keysBefore.map((k) => k.key));
  const rest = Object.keys(next)
    .filter((k) => k !== 'messages' && !seen.has(k))
    .map((k) => `,${JSON.stringify(k)}:${JSON.stringify(next[k])}`)
    .join('');
  const tailText = tail.map((m) => JSON.stringify(m)).join(',');
  return `${head}${tail.length ? `,${tailText}` : ''}]${rest}}`;
}
