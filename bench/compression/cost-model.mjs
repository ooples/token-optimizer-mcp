/**
 * WHAT AN AGENT LOOP IS ACTUALLY BILLED FOR.
 *
 * The cost columns this harness printed before were two raw token counts:
 * `handed`, the compressed text alone, and `whole`, that text plus every
 * spilled block fetched back. Both are wrong in the same way. They price a
 * payload as if it were sent once, to a stateless endpoint, and then forgotten.
 *
 * An agent session does not work like that. The conversation is re-sent on
 * every request, so a token that enters context is paid for again on every turn
 * that follows it. Prompt caching makes that repeat cheap rather than free: the
 * request that first carries new content writes it to the cache at CACHE_WRITE
 * times the input rate, and each later request reads it back at CACHE_READ
 * times. And a retrieval is not merely the bytes it returns -- it is an EXTRA
 * REQUEST, which re-reads the whole prefix one more time and costs the output
 * tokens of the tool call that asked for it.
 *
 * That last term is the one a byte column cannot see, and it is the one that
 * decides this comparison: at 41 round trips against 14, our arm pays for 27
 * passes over the conversation that theirs never makes.
 *
 * THE UNIT is an effective input token: what a token would cost if it were
 * billed once, at the plain input rate. A cache write counts 1.25 of them, a
 * cache read 0.1, an output token 5. Nothing here is denominated in money,
 * because a dollar figure bakes in a model and a price list and is stale the
 * day either moves. Multiply by your own rate for money; read it as-is for a
 * subscription, whose cap is metered on the same quantity.
 *
 * WHAT IS COUNTED. Only what is ATTRIBUTABLE TO THE PAYLOAD. The system prompt,
 * the tool schemas and the rest of the conversation are read on every request
 * whatever a compressor does; counting them would pull every ratio here toward
 * 1 without changing which arm is cheaper. They enter in one place,
 * `baseContextTokens`, and only in the term where the arms genuinely differ --
 * an extra request re-reads them, and the arms do not make the same number of
 * extra requests.
 */

/**
 * Published Anthropic multipliers, plus two facts about a session that are not
 * published anywhere because they are properties of how it is used.
 *
 * `turnsAfter` and `baseContextTokens` are the two guesses in this file. The
 * break-even rate below is reported precisely because it does not depend on
 * either being right, and `sweep` exists so the sensitivity to both is printed
 * rather than asserted.
 */
export const DEFAULTS = Object.freeze({
  /** A cache write bills at 1.25x the base input rate. */
  cacheWrite: 1.25,
  /** A cache read bills at 0.1x. */
  cacheRead: 0.1,
  /** Output bills at 5x input across the current line-up. */
  outputPerInput: 5,
  /** Assistant requests following the one the payload lands in. */
  turnsAfter: 20,
  /** System prompt, tool schemas and prior conversation, in tokens. */
  baseContextTokens: 12000,
  /** Output tokens the model writes to issue one retrieval call. */
  fetchCallTokens: 60,
});

/**
 * One arm's cost as a straight line in the fetch rate `p`.
 *
 * Returns `{ fixed, perFetch }`, so the cost at rate `p` is
 * `fixed + p * perFetch`. Keeping both arms linear is what makes a single
 * break-even rate meaningful instead of a curve to be eyeballed, and it costs
 * one modelling approximation, stated here rather than buried:
 *
 * THE EXTRA PASS IS CHARGED OVER A PREFIX THAT ALREADY HOLDS THE EARLIER
 * BLOCKS, whether or not those earlier fetches happened. At a high fetch rate
 * that is simply true. At a low one it overcharges -- but it overcharges per
 * fetch, so it falls hardest on the arm that spills into the most places, which
 * is ours. The approximation errs AGAINST the arm this file belongs to.
 */
export function costLine({ handed, blocks = [], params = DEFAULTS }) {
  const {
    cacheWrite: W,
    cacheRead: R,
    outputPerInput,
    turnsAfter: N,
    baseContextTokens,
    fetchCallTokens,
  } = params;

  // The text the agent is handed: written to the cache once, read on every
  // request after that. This is the whole cost of an arm that spills nothing.
  const fixed = handed * (W + R * N);

  let perFetch = 0;
  let prefix = baseContextTokens + handed;
  const n = blocks.length;
  for (let i = 0; i < n; i++) {
    // Retrievals are assumed spread evenly through the remaining session, so
    // the i-th lands here and is then resident for whatever is left. Bunching
    // them at the start would cost more and at the end less; even spacing is
    // the only choice that does not quietly pick a side.
    const at = (N * (i + 1)) / (n + 1);
    const size = blocks[i];
    perFetch += prefix * R; // one more pass over everything already there
    perFetch += fetchCallTokens * outputPerInput; // the call the model writes
    perFetch += size * (W + R * Math.max(0, N - at)); // the block, then resident
    prefix += size;
  }
  return { fixed, perFetch };
}

/** Effective input tokens for a line at fetch rate `p`. */
export function costAt(line, p) {
  return line.fixed + p * line.perFetch;
}

/**
 * The fetch rate at which two arms cost the same.
 *
 * THIS IS THE FIGURE TO PUBLISH. Every other number here rests on a guess about
 * session length or context size; this one is a statement of the form "we are
 * cheaper unless your agent pulls back more than X% of what was moved out",
 * which a reader can check against their own behaviour and which is false if we
 * are wrong. `p` is null when the lines do not cross inside [0, 1] -- then one
 * arm is cheaper at every fetch rate, and `cheaper` names it.
 */
export function breakEven(a, b) {
  const slope = a.perFetch - b.perFetch;
  const gap = b.fixed - a.fixed;
  const at = (p) => Math.sign(costAt(b, p) - costAt(a, p));
  // Sign of (theirs - ours) at p = 0 decides who is cheaper when they do not
  // cross; +1 means ours costs less.
  const end = at(1) !== 0 ? at(1) : at(0);
  const cheaper = end > 0 ? 'a' : end < 0 ? 'b' : 'tie';
  if (slope === 0) return { p: null, cheaper };
  const p = gap / slope;
  if (!(p > 0 && p < 1)) return { p: null, cheaper };
  // Below the crossing, whichever arm the p = 0 comparison favours is cheaper.
  return { p, cheaper: at(0) > 0 ? 'a' : 'b' };
}

/**
 * How much further the same subscription cap goes.
 *
 * A cap is a token budget, so "we cost 40% of doing nothing" and "the same plan
 * buys 2.5x as much of this work" are the same sentence. The second is the one
 * a subscriber asked, so it is the one this returns.
 */
export function usageMultiplier(baselineCost, armCost) {
  if (armCost <= 0) return Infinity;
  return baselineCost / armCost;
}

/**
 * The same comparison across a grid of session lengths and context sizes.
 *
 * The two guesses in DEFAULTS are the obvious place to attack these numbers, so
 * the harness prints the attack instead of waiting for it.
 */
export function sweep(build, grid) {
  const out = [];
  for (const turnsAfter of grid.turnsAfter)
    for (const baseContextTokens of grid.baseContextTokens) {
      const params = { ...DEFAULTS, turnsAfter, baseContextTokens };
      out.push({ turnsAfter, baseContextTokens, ...build(params) });
    }
  return out;
}

/**
 * Bytes as HeadRoom's markers declare them: `<<ccr:HASH,KIND,156.3KB>>`.
 *
 * Their marker states the size of what it replaced, which is the only per-block
 * split available without re-running their resolver. It is used for the SPLIT
 * only -- the total is measured from their resolver's own output -- so a
 * rounded `156.3KB` cannot move the totals, just the distribution across turns.
 */
export function markerBytes(marker) {
  const m = /,\s*([\d.]+)\s*(B|KB|MB|GB)\s*>>$/i.exec(marker);
  if (m === null) return 0;
  const scale = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };
  return Number(m[1]) * scale[m[2].toLowerCase()];
}
