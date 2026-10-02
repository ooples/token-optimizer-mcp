/**
 * How a tool is allowed to say what it saved.
 *
 * Across this codebase, savings were being derived by multiplying the RESULT by
 * a constant -- 100x, 50x, 25x, 20x, 18x, 17x, 16x, 15x, 12x, 11x, 10x, 9x,
 * 8.5x, 8x, 7x, 6.5x, 5x, 3x, 2.5x -- and reporting the difference as tokens
 * saved. smart_user alone used eight different multipliers, which is the
 * clearest possible evidence that none of them were measured. Those numbers
 * flowed into the metrics collector and the optimization report, so the
 * headline figure a user was shown was partly invented.
 *
 * An overstated saving is the one number this project must never produce. So
 * there is exactly one way to report one, and it takes two MEASURED
 * quantities: what the alternative would have cost, and what was actually
 * returned.
 *
 * When a tool genuinely has no measured baseline -- a cache hit that never
 * recorded what the original computation cost -- the honest answer is
 * `unmeasured()`, which claims nothing. Understating is the safe direction to
 * be wrong in; overstating is the one that makes the product a lie.
 *
 * A LOSS IS A MEASUREMENT TOO. This helper used to raise `originalTokenCount`
 * to the size of the response whenever the response came out larger, so that
 * `tokensSaved` could never go negative. That bought a non-negative saving by
 * printing a baseline nobody had measured -- the same invention this module
 * exists to prevent, and it hid the outcome that matters most: a tool whose
 * report costs more than the thing it replaced. The core primitive it sits on,
 * TokenCounter.calculateSavings, has always reported that case as a negative,
 * and so does this one now.
 */

/**
 * Places a reported ratio is rounded to.
 *
 * The division ran to full double precision and was serialised in full:
 * 0.7630331753554502, which cost 12 tokens in a 75-token metadata block --
 * more than any other field, to state a ratio between two integers to 16
 * digits. Nothing downstream reads past the fourth.
 */
const RATIO_DECIMALS = 4;

function ratio(tokenCount: number, originalTokenCount: number): number {
  if (originalTokenCount <= 0) {
    return 1;
  }
  return Number((tokenCount / originalTokenCount).toFixed(RATIO_DECIMALS));
}

export interface Savings {
  /** Tokens the alternative would have cost. Measured, never assumed. */
  originalTokenCount: number;
  /** Tokens actually returned to the caller. */
  tokenCount: number;
  /**
   * originalTokenCount - tokenCount. NEGATIVE when the response cost more than
   * the alternative it replaced, which is reported rather than clamped.
   */
  tokensSaved: number;
  /**
   * tokenCount / originalTokenCount, guarded against a zero baseline and
   * rounded to {@link RATIO_DECIMALS} places.
   */
  compressionRatio: number;
}

/**
 * A saving computed from two real measurements.
 *
 * @param baselineTokens what the caller would have paid without this tool,
 *   measured from something that actually exists: the file that would have been
 *   read, the raw output that was received, the rows that were filtered out.
 * @param returnedTokens what the response actually costs.
 */
export function measured(
  baselineTokens: number,
  returnedTokens: number
): Savings {
  const tokenCount = Math.max(0, Math.round(returnedTokens) || 0);
  // Reported as measured. A baseline below what was returned means the tool
  // cost the caller more than doing without it, and the difference is that
  // loss -- summing it downstream gives a true net, where clamping each term
  // at zero gave a total that could only ever look like a win.
  const originalTokenCount = Math.max(0, Math.round(baselineTokens) || 0);

  return {
    originalTokenCount,
    tokenCount,
    tokensSaved: originalTokenCount - tokenCount,
    compressionRatio: ratio(tokenCount, originalTokenCount),
  };
}

/**
 * No baseline was measured, so nothing is claimed.
 *
 * Used where a tool returns a cached value without knowing what producing it
 * originally cost. The response still reports its own size honestly.
 */
export function unmeasured(returnedTokens: number): Savings {
  const tokenCount = Math.max(0, Math.round(returnedTokens) || 0);
  return {
    originalTokenCount: tokenCount,
    tokenCount,
    tokensSaved: 0,
    compressionRatio: 1,
  };
}

/**
 * WHAT A TOOL IS ALLOWED TO SAY ABOUT ITS OWN SAVING: the before, and nothing
 * else.
 *
 * `measured()` above asks a tool for both halves of its own ratio, and across
 * this fleet the second half was never the figure that reached the caller.
 * Measured over 37 bench readings: `smart_dependencies` published
 * `originalTokenCount: 0, tokensSaved: -11` on calls that really avoided 63.5%
 * and 98.2%; `smart_tsconfig` published `savingsPercent: 8.21` where the wire
 * said -2.9%; `smart_package_json` printed a `-92%` footer against a real
 * -20.9%; `smart_security` printed one flat 85% for three fixtures whose real
 * figures were 98.0%, 97.1% and 92.3%. None of those were lies about the
 * baseline. Every one was a tool counting an INTERNAL object -- a graph, a
 * compacted config, a findings array -- and calling it the response, when what
 * the caller pays for is the serialised reply with its report text and its
 * metadata around it. A tool cannot see that text: it is produced after the
 * tool returns.
 *
 * So the after is measured once, at the wire, by the party that holds it, and
 * a tool declares only the before -- the half that genuinely is its own
 * knowledge, because it read the file, received the raw output, or was handed
 * the code inline.
 *
 * NO ARITHMETIC HERE ON PURPOSE. A declaration with no second operand cannot
 * be wrong about the first, and there is no ratio to drift.
 */
export interface DisplacedBaseline {
  /** Tokens the caller would have paid without this tool. Measured. */
  readonly baselineTokens: number;
  /** What was counted to get there, so a reader can check the claim. */
  readonly baselineSource: BaselineSource;
}

/**
 * The kinds of before a tool in this fleet can actually measure.
 *
 * A UNION RATHER THAN FREE TEXT so the set stays reviewable: every member is
 * something that exists and can be counted, and adding a member is a decision
 * someone has to make rather than a string someone can type.
 */
export type BaselineSource =
  /** The file or files the caller's own arguments named. */
  | 'named-input-files'
  /** A file the tool located from a directory the caller named. */
  | 'resolved-project-file'
  /** Every file in a resolved `extends` chain, not just the entry point. */
  | 'resolved-config-chain'
  /** Text the caller passed inline, which exists nowhere on disk. */
  | 'inline-input'
  /** Raw output of a command this tool ran and then summarised. */
  | 'captured-command-output';

/**
 * Declare what this tool stood in for.
 *
 * A NON-POSITIVE BASELINE IS NOT A DECLARATION. Zero is what produced
 * `tokensSaved: -11` for a tool that avoided 63% of a file read: a baseline
 * nobody managed to measure, published as though it had been measured and
 * found to be nothing. It reads back as null so a missing before stays
 * missing.
 */
export function displaced(
  baselineTokens: number,
  baselineSource: BaselineSource
): DisplacedBaseline | null {
  const tokens = Math.round(baselineTokens) || 0;
  if (tokens <= 0) return null;
  return { baselineTokens: tokens, baselineSource };
}

/**
 * The key a tool hangs its declaration on, and the only one the dispatch lifts.
 *
 * WHY A RESERVED KEY AND NOT A FIELD IN THE REPLY. The declaration exists so a
 * row on disk can say what the call stood in for; it is not information the
 * caller asked for, and a figure in the reply is a figure the caller pays for
 * and a model may quote. So it travels on the result object, is removed before
 * the text is serialised, and is carried the rest of the way in `_meta`, which
 * never enters the text that gets counted.
 */
export const DECLARED_BASELINE_KEY = '__displacedBaseline';

/**
 * Take the declaration off a tool's result, leaving the payload the caller sees.
 *
 * The payload is rebuilt without the key rather than deleted from in place: a
 * tool may hand back a frozen object, and a tool that returns a string -- half
 * this fleet does -- has nowhere to put a key and simply declares nothing.
 */
export function liftDeclaredBaseline(result: unknown): {
  readonly payload: unknown;
  readonly declaration: DisplacedBaseline | null;
} {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { payload: result, declaration: null };
  }
  const record = result as Record<string, unknown>;
  if (!(DECLARED_BASELINE_KEY in record)) {
    return { payload: result, declaration: null };
  }
  const { [DECLARED_BASELINE_KEY]: raw, ...payload } = record;
  return { payload, declaration: asDeclaredBaseline(raw) };
}

/**
 * CHECKED EVERY TIME IT CROSSES A BOUNDARY, NOT TRUSTED ONCE. `displaced()` is the only sanctioned
 * producer, but the key is a plain property on a plain object, so whatever
 * arrives here is re-tested against the same rules before it is allowed to
 * reach a stored row.
 */
export function asDeclaredBaseline(raw: unknown): DisplacedBaseline | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const source = record.baselineSource;
  if (typeof source !== 'string') return null;
  if (!BASELINE_SOURCES.includes(source as BaselineSource)) return null;
  return displaced(Number(record.baselineTokens), source as BaselineSource);
}

/** The runtime half of `BaselineSource`, so the union can be checked. */
const BASELINE_SOURCES: readonly BaselineSource[] = [
  'named-input-files',
  'resolved-project-file',
  'resolved-config-chain',
  'inline-input',
  'captured-command-output',
];
