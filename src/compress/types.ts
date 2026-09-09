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
   * Where to get it: `path/to/file.ts:14-37`, or a spill path for content that
   * never had a file. `null` means the transform dropped nothing recoverable --
   * whitespace, say -- so there is nothing to point at.
   */
  readonly recoverAt: string | null;
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
export type ContentKind = 'json' | 'code' | 'log' | 'prose' | 'search' | 'unknown';

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
}

/** Every engine has this shape. */
export type Engine = (text: string, ctx: EngineContext) => CompressionResult;

/** Nothing to do: hand the text back untouched. */
export function unchanged(text: string): CompressionResult {
  return { text, elisions: [], lossless: true };
}
