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
