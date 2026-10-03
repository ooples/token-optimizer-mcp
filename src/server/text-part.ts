/**
 * A FILE'S TEXT, SENT AS TEXT RATHER THAN AS AN ESCAPED JSON STRING.
 *
 * Every tool answers with one object, serialised once by the dispatch, so a
 * tool that returns a file returns that file as a JSON string value: each
 * newline costs two characters instead of one, each quote two, each backslash
 * two. Measured through smart_read on three thousand characters of this
 * repository's own source -- under the disclosure threshold, so the reply is
 * exactly what the dispatch built -- the escape of the `content` field alone
 * cost 255, 162 and 243 tokens on replies of 1,089, 965 and 1,021. That is
 * between a sixth and a quarter of the whole reply spent on nothing: the caller
 * learns not one thing from a doubled newline.
 *
 * MCP replies are a LIST of parts, and the text parts are joined. So the escape
 * is avoidable without withholding anything: the envelope goes in one part as
 * JSON, the field's text goes in the next as itself, and the envelope names
 * where it went. `restoreTextPart` below puts it back, and a round-trip test
 * holds the two halves to each other -- that function is the whole claim that
 * the caller's information is unchanged.
 *
 * WHY HERE AND NOT IN THE DISPATCH. Progressive disclosure re-renders a large
 * reply into a preview, and its `parseShape` already routes a long string field
 * through a nested shape pass -- which de-escapes it as a side effect. So a
 * disclosed reply has no escape tax to recover and splitting it first would
 * hand disclosure a body that is no longer JSON. This runs only where
 * disclosure declined, which is every reply too small to be disclosed.
 */

/**
 * The smallest saving worth a second part, in characters.
 *
 * A split costs a reader a part boundary and a key naming the field, so a
 * two-character win is a worse reply, not a cheaper one. Sixty-four is roughly
 * four times what the `_textPart` key itself costs, which means a lift always
 * pays for its own bookkeeping several times over. Nothing measured sets the
 * exact figure; what the figure protects against is a split that buys nothing.
 */
const MIN_SAVING_CHARS = 64;

/**
 * How deep a field may sit and still be lifted.
 *
 * smart_read's content is top-level; smart_pretty's formatted code sits at
 * `data.format.code`. Both are reachable well inside this, and a bound keeps a
 * cyclic or pathological payload from walking forever.
 */
const MAX_DEPTH = 6;

/** The key the envelope carries to say which field moved, and where. */
export const TEXT_PART_KEY = '_textPart';

interface Candidate {
  readonly path: readonly string[];
  readonly value: string;
}

/**
 * The longest string held in an OBJECT PROPERTY anywhere in the payload.
 *
 * Array elements are deliberately not candidates. Removing one shifts every
 * index after it, so the envelope could no longer describe the payload it came
 * from without also describing the hole -- and measured across the fourteen
 * benched tools the longest string in an array is a sentence of advice, twenty
 * tokens, far below the threshold above. The money is in the one big field.
 */
function largestStringField(value: unknown, depth = 0): Candidate | null {
  if (depth > MAX_DEPTH || !value || typeof value !== 'object') return null;
  const found: Candidate[] = [];
  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = largestStringField(entry, depth + 1);
      if (nested) found.push(nested);
    }
  } else {
    for (const [key, entry] of Object.entries(value)) {
      // A key holding a dot could not be told apart from a path through two
      // keys, so a payload using one is left alone rather than described
      // wrongly.
      if (key.includes('.')) continue;
      if (typeof entry === 'string') {
        found.push({ path: [key], value: entry });
        continue;
      }
      const nested = largestStringField(entry, depth + 1);
      if (nested)
        found.push({ path: [key, ...nested.path], value: nested.value });
    }
  }
  let best: Candidate | null = null;
  for (const candidate of found) {
    if (best === null || candidate.value.length > best.value.length) {
      best = candidate;
    }
  }
  return best;
}

/** Everything but the named field, which is removed from a shallow copy. */
function withoutField(
  payload: Record<string, unknown>,
  path: readonly string[]
): Record<string, unknown> {
  const [head, ...rest] = path;
  const copy: Record<string, unknown> = { ...payload };
  if (rest.length === 0) {
    delete copy[head];
    return copy;
  }
  copy[head] = withoutField(payload[head] as Record<string, unknown>, rest);
  return copy;
}

/** The field put back where it was, on a shallow copy. */
function withField(
  payload: Record<string, unknown>,
  path: readonly string[],
  value: string
): Record<string, unknown> {
  const [head, ...rest] = path;
  const copy: Record<string, unknown> = { ...payload };
  if (rest.length === 0) {
    copy[head] = value;
    return copy;
  }
  const nested = payload[head];
  copy[head] = withField(
    nested && typeof nested === 'object'
      ? (nested as Record<string, unknown>)
      : {},
    rest,
    value
  );
  return copy;
}

/** What the envelope says about the part that follows it. */
export interface TextPartNote {
  /** The field the text belongs to, as a dotted path from the payload's root. */
  readonly path: string;
  /** Which text part of this reply holds it. */
  readonly index: number;
}

/** A reply's text parts, which is all this module reads or writes. */
export interface TextParts {
  readonly content: Array<{ type: string; text: string }>;
}

/**
 * Sends the payload's largest string field as text instead of as a JSON string.
 *
 * Returns the parts unchanged whenever the split would not plainly pay: a reply
 * that is not a single JSON object, a payload already carrying the envelope key,
 * no string field, or a saving under the threshold. BY LENGTH, MEASURED on both
 * renderings rather than estimated from the field -- the envelope keeps its own
 * braces and gains a key, and only the difference between the two complete
 * renderings says whether the caller is better off.
 */
export function liftTextPart(parts: TextParts['content']): {
  content: Array<{ type: string; text: string }>;
  lifted: boolean;
} {
  if (!Array.isArray(parts) || parts.length !== 1) {
    return { content: parts, lifted: false };
  }
  const only = parts[0];
  if (!only || only.type !== 'text' || typeof only.text !== 'string') {
    return { content: parts, lifted: false };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(only.text);
  } catch {
    // Prose, or a preview. Neither has an escape to recover.
    return { content: parts, lifted: false };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { content: parts, lifted: false };
  }
  const record = payload as Record<string, unknown>;
  // The key is the product's own bookkeeping, and a payload that already uses
  // it would have its own value overwritten. Leave it alone.
  if (TEXT_PART_KEY in record) return { content: parts, lifted: false };

  const candidate = largestStringField(record);
  if (!candidate) return { content: parts, lifted: false };

  const note: TextPartNote = {
    path: candidate.path.join('.'),
    index: 1,
  };
  const envelope = {
    ...withoutField(record, candidate.path),
    [TEXT_PART_KEY]: note,
  };
  const envelopeText = JSON.stringify(envelope);
  if (
    only.text.length - (envelopeText.length + candidate.value.length) <
    MIN_SAVING_CHARS
  ) {
    return { content: parts, lifted: false };
  }
  return {
    content: [
      { type: 'text', text: envelopeText },
      { type: 'text', text: candidate.value },
    ],
    lifted: true,
  };
}

/**
 * The payload a caller would have received as one object, rebuilt from the parts.
 *
 * THIS IS THE CLAIM, NOT A CONVENIENCE. Splitting a reply is only honest if the
 * caller can get back exactly what it would have had, so the inverse ships with
 * the transform and a round-trip test holds them to each other. A reply that was
 * never lifted parses straight through, so a caller can route every reply
 * through this and never ask which kind it has.
 *
 * EQUAL AS DATA, NOT BYTE FOR BYTE. Removing a key and putting it back leaves it
 * last rather than where it was, so the rebuilt object deep-equals the original
 * while its serialisation may order two keys differently. Key order carries no
 * information in JSON, and preserving it would mean spending characters in the
 * envelope to record a position -- which is the cost this whole module exists to
 * remove.
 */
export function restoreTextPart(
  parts: TextParts['content'] | undefined
): unknown {
  const texts = (parts || [])
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text);
  if (texts.length === 0) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(texts[0]);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }
  const record = payload as Record<string, unknown>;
  const note = record[TEXT_PART_KEY];
  if (!note || typeof note !== 'object') return payload;
  const { path, index } = note as Partial<TextPartNote>;
  if (typeof path !== 'string' || !path || typeof index !== 'number') {
    return payload;
  }
  const text = texts[index];
  if (typeof text !== 'string') return payload;
  const rest = { ...record };
  delete rest[TEXT_PART_KEY];
  return withField(rest, path.split('.'), text);
}
