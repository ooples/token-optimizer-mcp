/**
 * Reaching content that arrives as a string INSIDE structured data.
 *
 * THE GAP THIS CLOSES, and it is one gap rather than two. Every workload this
 * package compresses well is won by finding the repeating unit; a JSON array
 * hands that unit over for free. Two of HeadRoom's own fixtures hide it behind a
 * string value instead, and we scored badly on exactly those two:
 *
 *   agentic-conversation   48 messages whose `content` fields hold tool results
 *                          SERIALISED AS JSON TEXT -- thirteen strings of about
 *                          16KB each. Compressing those strings individually
 *                          removes 76.6% of them, which is 64.9% of the whole
 *                          payload; we were achieving 37.8%.
 *   rag-conversation       one 162,250-character document in a single `content`
 *                          field, 1,154 markdown sections of which 1,039 are
 *                          exact duplicates. We removed 0.5%.
 *
 * In both cases the engines already worked. They were simply never reached,
 * because the walker stops at the container.
 *
 * WHAT MAKES THIS SAFE. Re-entry is bounded and every value is size-floored; a value is
 * only replaced when the result is genuinely smaller; and the compressed form
 * goes back as a STRING in the same position, so the document's shape is
 * untouched and a consumer parsing it sees the structure it expects.
 */

import type { CompressionResult, Elision, EngineContext } from './types.js';

/**
 * How many times we may re-enter a string.
 *
 * CONTAINER NESTING IS NOT THE RISK AND MUST NOT BE BUDGETED AS IF IT WERE.
 * `JSON.parse` cannot produce a cycle, so the object tree is finite and walking
 * all of it terminates. Counting object and array levels against a depth budget
 * only starves legitimate documents: the tool results in HeadRoom's
 * agentic-conversation fixture sit at array > object > array > object > string,
 * which is level four, so a budget of three skipped every one of them and the
 * descent measured 0.0% on the payload it was written for.
 *
 * What CAN run away is re-entry -- a string parsed as JSON whose own values are
 * strings holding JSON. That is what this counts. One level of it is real, a
 * tool result carrying a serialised tool result, and two is generous.
 */
export const MAX_STRING_DEPTH = 2;

/**
 * Strings below this are left alone.
 *
 * Every engine has a floor of its own, and calling six claimants on a forty
 * character field is pure overhead on a document with thousands of them.
 */
export const MIN_NESTED_CHARS = 1000;

/** What the caller supplies so this need not import the router and cycle. */
export type Compress = (text: string, ctx: EngineContext) => CompressionResult;

export interface NestedResult {
  readonly value: unknown;
  readonly elisions: readonly Elision[];
  /** Characters removed from nested strings, for the caller's accounting. */
  readonly removed: number;
  /**
   * True only if EVERY nested compression was itself lossless.
   *
   * CARRIED BECAUSE THE CALLER CANNOT INFER IT. `compressJson` copies the
   * rewritten value and the elisions, then decides its own `lossless` from the
   * structural transforms it applied -- so a nested string compressed by a
   * lossy engine was reported inside a document claiming `lossless: true`,
   * whose content could not be reconstructed from the output. One lossy nested
   * value makes the whole document lossy, so this aggregates with AND.
   */
  readonly lossless: boolean;
}

/**
 * Walks a parsed document, compressing large string values in place.
 *
 * Returns the value unchanged when nothing was worth doing, so a caller can
 * cheaply tell whether to re-serialise.
 */
export function compressNestedStrings(
  value: unknown,
  compress: Compress,
  ctx: EngineContext = {},
  depth = 0
): NestedResult {
  const elisions: Elision[] = [];
  let removed = 0;
  let lossless = true;

  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      if (node.length < MIN_NESTED_CHARS) return node;
      let result: CompressionResult;
      try {
        // The counter travels WITH the context, so an engine that recurses
        // back through the router inherits it and cannot reset it.
        result = compress(node, { ...ctx, stringDepth: depth + 1 });
      } catch {
        // An engine that throws on nested content must not take the document
        // with it. Failing open is the rule everywhere in this package.
        return node;
      }
      // NEVER GROW, and compare against the ORIGINAL rather than trusting the
      // engine to have checked: this is the one place a saving on the inside
      // could still cost bytes once re-escaped into the outer document.
      if (result.text.length >= node.length) return node;
      elisions.push(...result.elisions);
      removed += node.length - result.text.length;
      // A result that does not say makes no promise, so it is treated as lossy.
      // Assuming otherwise would let an engine opt into a guarantee by omission.
      if (result.lossless !== true) lossless = false;
      return result.text;
    }

    if (Array.isArray(node)) return node.map(walk);

    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(
        node as Record<string, unknown>
      )) {
        out[key] = walk(item);
      }
      return out;
    }

    return node;
  };

  // Past the re-entry budget nothing is descended into at all.
  if (depth >= MAX_STRING_DEPTH)
    return { value, elisions: [], removed: 0, lossless: true };
  // `walk` fills `removed` and `lossless`, so it must run before they are read.
  const value2 = walk(value);
  return { value: value2, elisions, removed, lossless };
}
