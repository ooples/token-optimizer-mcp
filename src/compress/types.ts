/**
 * Shared contract for the compression engines.
 *
 * WHAT MAKES THIS DIFFERENT FROM THE COMPETITION, in one type.
 *
 * HeadRoom's CCR replaces elided content with an opaque marker --
 * `<<ccr:HASH,KIND,SIZE>>` -- and teaches the model a bespoke
 * `headroom_retrieve` tool to redeem it. That costs a system message and a
 * tool definition on every compressed request, and it degrades badly: on a
 * cache miss the model receives `<<ccr:a1b2c3>> [unresolved: entry not found]`,
 * an unusable token sitting mid-context, and their own module docstring records
 * that markers "leak through as raw text" when no tool-call turn exists to
 * redeem them.
 *
 * An `Elision` carries a `recoverAt` PATH instead. A coding agent already owns
 * a retrieval interface -- `Read` with a line range -- so nothing has to be
 * injected and nothing has to be taught. The failure mode inverts too: when our
 * side of the bookkeeping is gone the model reads the real file and gets the
 * truth, where theirs yields a dead token.
 */

/** One thing removed from a block, and how to get it back. */
export interface Elision {
  /**
   * What was removed, phrased for a reader rather than a parser: "37 duplicate
   * lines", "body, 24 lines". This is the part that makes the compression
   * legible instead of mysterious -- a model that can see what is missing can
   * decide whether it needs it.
   */
  readonly removed: string;

  /**
   * Where to get it: `path/to/file.ts:14-37`, or a spill path for content
   * that never had a file. `null` is only valid on a lossless elision.
   */
  readonly recoverAt: string | null;

  /**
   * Can this removal be undone from the output alone?
   *
   * THE FIELD EXISTS BECAUSE `recoverAt: null` WAS AMBIGUOUS, and the
   * registry boundary found it the day it was written. Null meant both
   * "nothing to recover" -- whitespace, null keys, duplicate lines carrying
   * their own count -- and "gone, with nowhere to look". A rule refusing
   * unrecoverable elisions therefore rejected whole JSON documents whose
   * only null-pathed elisions were the free ones, taking three workloads to
   * 0%.
   *
   * True means the output fully describes what went. False means recovery
   * needs `recoverAt`, and the boundary refuses the elision without one.
   */
  readonly lossless: boolean;
}

/** What an engine hands back. */
export interface CompressionResult {
  /** Exact standalone marker lines inserted by the engine, including duplicates. */
  readonly insertedLines?: readonly string[];
  /** The replacement text. */
  readonly text: string;
  /** Everything removed, in the order it was removed. */
  readonly elisions: readonly Elision[];
  /**
   * True when every byte dropped can be reconstructed from the output alone,
   * with no lookup: JSON whitespace, duplicate log lines carrying their count.
   * False when recovery needs the file or the spill.
   */
  readonly lossless: boolean;
}

/** Content classes the router can distinguish. */
export type ContentKind =
  | 'json'
  | 'code'
  | 'log'
  | 'prose'
  | 'search'
  // Repeated same-shape records that no more specific engine claimed. A shape
  // rather than a kind, which is why it is reported under its own name instead
  // of as 'log': the engine that folds it is the same one, but the content is
  // whatever was left over.
  | 'records'
  // Anything a third party registered. Named so a custom engine appears in
  // a report rather than being invisible.
  | 'custom'
  | 'unknown';

/**
 * Per-call state handed to an engine.
 *
 * PASSED, NEVER STORED ON THE ENGINE. HeadRoom's #3486 is precisely this: one
 * shared `ContentRouter` keeping per-request state on `self`, so concurrent
 * requests cross-contaminate each other's options. Engines here are pure
 * functions of (text, context) and hold no mutable state at all, which makes
 * that class of bug unrepresentable rather than merely avoided.
 */
export interface EngineContext {
  /**
   * The file this content came from, when it came from one. Lets `code`
   * produce `src/x.ts:14-37` rather than a spill path.
   */
  readonly sourcePath?: string;
  /**
   * Compresses content found INSIDE a string value, when the caller has a
   * router to route it with.
   *
   * Supplied rather than imported so an engine never depends on the router
   * that dispatches to it, which would be a cycle. Absent means no descent:
   * every engine stays exactly as it was.
   */
  /** How many strings deep this content already is. Guards re-entry. */
  readonly stringDepth?: number;
  readonly compressNested?: (
    text: string,
    ctx: EngineContext
  ) => CompressionResult;
  /** Language hint for `code`; inferred from `sourcePath` when absent. */
  readonly language?: string;
  /**
   * Where to write content that has no file of its own. Returns the path to
   * quote in `recoverAt`. Absent means the engine must stay lossless or leave
   * the content alone.
   */
  readonly spill?: SpillSink;
  /**
   * What the agent is asking about, so retention can be ranked against it
   * rather than decided from the shape of the content alone.
   *
   * A 900-line log compressed identically whether the question is "why did
   * the deploy fail" or "which worker handled request 4471" keeps the answer
   * by luck. Absent means every engine falls back to its structural rules,
   * which is the behaviour that shipped before this existed.
   */
  readonly query?: string;
  /**
   * The resolved dials for this run.
   *
   * Always fully populated by the time an engine sees it -- `compressBlock`
   * resolves it once so no engine has to carry its own fallback, and a
   * missing dial cannot mean two different things in two engines.
   */
  readonly tuning?: Tuning;
  /**
   * Vectors a request-level pre-pass already computed, keyed by exact text.
   *
   * Present only when a semantic encoder is configured. Its absence is the
   * normal case and means BM25, which is also the fallback for any unit the
   * pre-pass did not happen to see.
   */
  readonly embeddings?: EmbeddingCache;
}

/**
 * Somewhere to put content an engine wants to elide -- or `undefined`, which
 * is a decision and not an omission.
 *
 * `undefined` MEANS THE CONTENT STAYS IN THE REQUEST. An engine with no sink
 * compresses losslessly or leaves the block alone; it never removes bytes it
 * cannot describe. That is the zero-round-trip arm, and it is what a caller
 * gets unless it asks for the other one, because a recovery path is a turn the
 * agent has to spend and a turn is the one cost no compression ratio pays back.
 *
 * Supplying a sink is the opposite trade: a smaller request now against a
 * `Read` later. Measured over the twelve head-to-head workloads it is the
 * right trade on the log-and-table shapes, where eliding removes 90%+ of the
 * block, and the wrong one wherever the content repeats inside the request --
 * there the lossless fold already collapses the copies, so the sink buys a few
 * thousand tokens and costs a round trip. `spillWholeBlockBelow` in
 * `options.ts` is the dial for the first case; this type is how a caller says
 * no to both.
 */
export type SpillSink = ((content: string, hint: string) => string) | undefined;

import type { Tuning } from './options.js';
import type { EmbeddingCache } from './embedding.js';

/** Every engine has this shape. */
export type Engine = (text: string, ctx: EngineContext) => CompressionResult;

/**
 * Asks the context for somewhere to put content an engine wants to elide.
 *
 * A sink reports failure by returning an empty string -- the proxy's does
 * exactly that when the write fails -- and an empty string is not a path.
 * Normalising it here means one answer to "is there anywhere to recover
 * from?" instead of each engine inventing its own, which is how `json` and
 * `prose` came to elide against a sink that had already failed. The registry
 * boundary caught it, but only by discarding the lossless work alongside the
 * lossy elision; declining up front keeps the minification.
 *
 * Null means the engine must stay lossless or leave the content alone.
 */
const SPILLED = new WeakMap<
  object,
  Map<string, Map<number, Map<string, string>>>
>();

/**
 * One path per distinct content, for the life of one sink.
 *
 * THE SAME BYTES UNDER TWO NAMES IS NOT TWO RECOVERIES, IT IS TWO ROUND TRIPS.
 * A request that reads one file three times -- the shape the `repeated-reads`
 * fixture is built from -- handed the identical 32,369 characters to the sink
 * three times and got three different paths back. That cost three fetches where
 * one would do, and it cost far more than that indirectly: the three elided
 * skeletons were byte-identical except for the path in their markers, so the
 * lossless repeat fold that would have collapsed them could no longer see them
 * as repeats. Measured on that fixture, addressing the spill by content takes
 * the hand-off from 14,202 tokens to 8,772 and the round trips from three to
 * one, and neither number came from compressing anything harder.
 *
 * Keyed on the sink itself, so the memo lives exactly as long as the closure
 * the caller handed us -- one request for the proxy, one workload for the
 * bench -- and a caller that builds a fresh sink per request shares nothing
 * across requests. Content is keyed by its own bytes: a hash would be shorter
 * to hold but would introduce a collision this has no way to detect, and the
 * strings are already resident.
 */
export function spillFor(
  ctx: EngineContext,
  content: string,
  hint: string
): string | null {
  const sink = ctx.spill;
  if (!sink) return null;
  let byHint = SPILLED.get(sink);
  if (!byHint) {
    byHint = new Map<string, Map<number, Map<string, string>>>();
    SPILLED.set(sink, byHint);
  }
  // LENGTH FIRST, CONTENT ONLY IF A LENGTH MATCHES.
  //
  // The obvious memo -- one map from content to path -- made every workload
  // 25-35% slower, including the ones that never spill anything: reaching a
  // `Map` keyed by a 150,000-character string means hashing that string, and
  // these blocks are fresh substrings on every pass, so the hash is paid every
  // time and cached never. Bucketing by length costs an integer lookup, and a
  // block whose length nothing else shares -- which is the ordinary case --
  // never reaches a string comparison at all. Duplicates share a length by
  // definition, so nothing that this is for is missed.
  let byLength = byHint.get(hint);
  if (!byLength) {
    byLength = new Map<number, Map<string, string>>();
    byHint.set(hint, byLength);
  }
  const sameLength = byLength.get(content.length);
  const known = sameLength?.get(content);
  if (known !== undefined) return known;
  const at = sink(content, hint);
  // A SINK THAT FAILED IS NOT REMEMBERED. `''` is how the proxy reports a
  // failed write, and caching that would turn one bad write into a permanent
  // refusal to spill anything with those bytes in it.
  if (!at) return null;
  if (sameLength) sameLength.set(content, at);
  else byLength.set(content.length, new Map([[content, at]]));
  return at;
}

/** Nothing to do: hand the text back untouched. */
export function unchanged(text: string): CompressionResult {
  return { text, elisions: [], lossless: true };
}
