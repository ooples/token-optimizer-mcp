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
 */

export interface Savings {
  /** Tokens the alternative would have cost. Measured, never assumed. */
  originalTokenCount: number;
  /** Tokens actually returned to the caller. */
  tokenCount: number;
  /** originalTokenCount - tokenCount, floored at zero. */
  tokensSaved: number;
  /** tokenCount / originalTokenCount, guarded against a zero baseline. */
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
export function measured(baselineTokens: number, returnedTokens: number): Savings {
  const tokenCount = Math.max(0, Math.round(returnedTokens) || 0);
  // A baseline below what was returned means the "alternative" was cheaper, so
  // there was no saving. Clamping keeps the reported figure from going
  // negative, which downstream reports would sum into nonsense.
  const originalTokenCount = Math.max(tokenCount, Math.round(baselineTokens) || 0);

  return {
    originalTokenCount,
    tokenCount,
    tokensSaved: originalTokenCount - tokenCount,
    compressionRatio: originalTokenCount > 0 ? tokenCount / originalTokenCount : 1,
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
