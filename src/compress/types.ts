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
  /** Language hint for `code`; inferred from `sourcePath` when absent. */
  readonly language?: string;
  /**
   * Where to write content that has no file of its own. Returns the path to
   * quote in `recoverAt`. Absent means the engine must stay lossless or leave
   * the content alone.
   */
  readonly spill?: (content: string, hint: string) => string;
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
}

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
export function spillFor(
  ctx: EngineContext,
  content: string,
  hint: string
): string | null {
  const at = ctx.spill?.(content, hint);
  return at ? at : null;
}

/** Nothing to do: hand the text back untouched. */
export function unchanged(text: string): CompressionResult {
  return { text, elisions: [], lossless: true };
}
