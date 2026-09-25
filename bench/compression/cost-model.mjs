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
 * THE UNIT is an effective input token: what a token would cost if it were
 * billed once, at the plain input rate. Nothing here is denominated in money,
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
 * extra requests. `baseContextTokens` is a per-arm parameter rather than a
 * constant, because an arm that rewrites the tool schemas does not hand the
 * model the same prefix as one that does not; see THE SCHEMA TIE below.
 *
 * ------------------------------------------------------------------------
 * THREE THINGS THIS FILE GOT WRONG BEFORE, AND WHAT REPLACED THEM
 * ------------------------------------------------------------------------
 *
 * 1. IT CHARGED THE 5-MINUTE CACHE-WRITE RATE FOR TRAFFIC THAT IS ENTIRELY
 *    1-HOUR. A cache write is 1.25x the input rate at the 5-minute TTL and
 *    2.0x at the 1-hour TTL. This file asserted 1.25 for everything. Over the
 *    last seven days of real transcripts on the machine that runs this bench,
 *    15,093 distinct requests reported a TTL split and 100.00% of the
 *    56,477,162 cache-write tokens were `ephemeral_1h_input_tokens`; the
 *    5-minute counter was zero, and no request used the legacy undifferentiated
 *    field. So the rate that applied to every observed request was the one this
 *    file never used. `cacheWrite` now defaults to the 1-hour rate, `RATES`
 *    names both, and `sweep` can vary it like any other assumption.
 *
 * 2. IT CHARGED AN EXTRA REQUEST PER BLOCK RATHER THAN PER ROUND. A retrieval
 *    round is one extra request no matter how many blocks it resolves. In
 *    HeadRoom's proxy that is explicit: every `headroom_retrieve` call in one
 *    assistant response is executed together and followed by a single
 *    continuation call (`ccr/response_handler.py`, the `while rounds <
 *    max_retrieval_rounds` loop -- `results = [...]` over all `ccr_calls`, then
 *    one `api_call_fn`). The same is true of a client-side tool loop: several
 *    tool_use blocks in one response come back as several tool_results in one
 *    user message, and cost one request between them. `fetchBatch` is how many
 *    blocks a round resolves; the per-block terms stay per block, and only the
 *    pass over the prefix is divided by it.
 *
 * 3. IT PRICED EVERY FETCH AS IF EVERY EARLIER FETCH HAD ALREADY HAPPENED. The
 *    old loop grew `prefix` by each block unconditionally, so at a fetch rate
 *    of 10% it still charged the tenth fetch for re-reading all nine blocks
 *    before it. That is only true at p = 1. The honest expectation is that
 *    earlier blocks are present with probability p, which makes the round pass
 *    QUADRATIC in p rather than linear -- and the cost of an arm a quadratic,
 *    not a line. That is the whole change: `costAt` evaluates
 *    `c0 + c1*p + c2*p^2`, and `breakEven` solves a quadratic. At p = 1 the new
 *    model reproduces the old number to the last bit, which is asserted in
 *    `cost-model.check.mjs`; below p = 1 it stops overcharging, and the arm it
 *    was overcharging most was the one that spills into the most places, which
 *    is ours.
 *
 * ------------------------------------------------------------------------
 * THINGS THAT ARE DELIBERATELY NOT MODELLED, AND WHY
 * ------------------------------------------------------------------------
 *
 * THEIR THREE-ROUND CAP IS NOT A DELIVERY CEILING. `max_retrieval_rounds` is 3,
 * but `rounds` is initialised to 0 inside the per-response handler, so the cap
 * is three rounds PER ASSISTANT RESPONSE and resets on the next one. Modelling
 * it as a session-wide cap would both cheapen their arm and invent a
 * content-loss they do not have. It is a latency and liveness property, not a
 * cost term, so it does not appear here.
 *
 * THEIR MIXED-CALL BAILOUT IS NOT MODELLED EITHER. When the model calls
 * `headroom_retrieve` alongside a non-CCR tool, their proxy declines to resolve
 * it and hands the call back to the client, which then spends a real agent turn
 * on it. That is a cost their arm pays and this model does not charge them,
 * because the rate at which a model mixes the two is unmeasured. It is an
 * omission in THEIR favour and is recorded as such rather than guessed at.
 *
 * THE SCHEMA TIE IS ASSUMED, NOT MEASURED. Their proxy rewrites the tool
 * schemas before forwarding (`proxy/tool_schema_compaction.py`), and we do not.
 * `baseContextTokens` is therefore a per-arm parameter, but both arms are
 * currently given the same value, because the reduction has not been measured
 * against a real client's tool array. Until it is, this file assumes a tie it
 * has no evidence for, and the assumption favours us.
 */

/**
 * Published per-token multipliers, each relative to one plain input token.
 *
 * These are the only numbers here taken on authority rather than measured, and
 * `bench/subscription/` exists to stop that being true: `paramsFromMeter`
 * accepts what the meter actually solved for and replaces them.
 */
export const RATES = Object.freeze({
  /** A cache write at the 5-minute TTL. */
  cacheWrite5m: 1.25,
  /** A cache write at the 1-hour TTL. */
  cacheWrite1h: 2.0,
  /** A cache read, at either TTL. */
  cacheRead: 0.1,
  /** Output, across the current line-up. */
  outputPerInput: 5,
});

/**
 * The cache-write TTL census behind `cacheWrite` defaulting to the 1-hour rate.
 *
 * Re-derive with `bench/subscription/transcripts.mjs`; this is a note of what
 * it said, not a substitute for running it.
 */
export const WRITE_TTL_CENSUS = Object.freeze({
  windowDays: 7,
  requests: 15093,
  requestsWithoutTtlSplit: 0,
  ephemeral5mTokens: 0,
  ephemeral1hTokens: 56477162,
  legacyUndifferentiatedTokens: 0,
});

/**
 * WHAT THE BILL IS ACTUALLY MADE OF, and where `turnsAfter` comes from.
 *
 * `bench/subscription/cost-split.mjs` converts real transcript usage into this
 * unit and divides it four ways. The division that matters here is the last
 * one: `cacheRead / (cacheWrite5m + cacheWrite1h)` is, by the model's own
 * definition, the number of turns over which a written token is re-read. That
 * is `turnsAfter`, and it need not be guessed.
 *
 * The shares below are steady across every window from 1 to 30 days. The RATIO
 * is not: it reads 56.0 over 7 days, 57.0 over 14 and 70.3 over 30, a spread of
 * 23%. So the honest statement is a range, not a point -- which is why the
 * default sits at the bottom of it and the sensitivity sweep covers the top.
 * Every value in that range is at least 2.8x the 20 this model used to assume.
 *
 * Re-derive with `node bench/subscription/cost-split.mjs`; this is a note of
 * what it said on the date below, not a substitute for running it.
 */
export const BILL_SPLIT_CENSUS = Object.freeze({
  measuredOn: '2026-09-25',
  windowDays: 7,
  requests: 15176,
  effectiveInputTokens: 490_210_000,
  shares: Object.freeze({ input: 0.004, write: 0.232, read: 0.649, output: 0.115 }),
  thinkingShareOfOutput: 0.35,
  readsPerWrittenToken: Object.freeze({ d7: 56.02, d14: 56.97, d30: 70.34 }),
});

/**
 * The model's assumptions, all overridable per arm.
 *
 * `turnsAfter`, `baseContextTokens`, `fetchCallTokens` and `fetchBatch` are the
 * guesses. The break-even rate is reported precisely because it does not depend
 * on any of them being right, and `sweep` exists so the sensitivity is printed
 * rather than asserted.
 */
export const DEFAULTS = Object.freeze({
  /**
   * A cache write, as a multiple of the input rate. Defaults to the 1-hour
   * rate because that is what 100% of observed traffic used; see
   * WRITE_TTL_CENSUS.
   */
  cacheWrite: RATES.cacheWrite1h,
  /** A cache read bills at 0.1x. */
  cacheRead: RATES.cacheRead,
  /** Output bills at 5x input across the current line-up. */
  outputPerInput: RATES.outputPerInput,
  /**
   * Assistant requests following the one the payload lands in, over which its
   * cached prefix is re-read.
   *
   * MEASURED, not guessed: 56 is reads per written token over 7 days of real
   * traffic (BILL_SPLIT_CENSUS). It was 20 here until that division was run,
   * and 20 turned out to understate the dominant term by at least 2.8x. The
   * bottom of the measured range is the default because it is the value least
   * favourable to the conclusion that cache reads dominate -- and cache reads
   * dominate anyway, at 64.9% of the bill.
   */
  turnsAfter: 56,
  /**
   * System prompt, tool schemas and prior conversation, in tokens.
   *
   * NULL, AND DELIBERATELY SO: THIS ONE HAS TO BE MEASURED PER ENVIRONMENT.
   *
   * It shipped as a hardcoded 12000. Measured on the machine this harness runs
   * on -- 13 sessions, the first request of each -- the median is 65063, so the
   * constant was understating the real prefix by 5.4x.
   *
   * It is not a harmless guess. The same constant is added to BOTH arms of
   * every savings ratio, so a smaller base pushes the ratio away from 1 and a
   * larger one pushes it toward 1. Understating base context therefore inflates
   * every savings figure the model prints, which is the flattering direction.
   *
   * It is also not portable: this machine loads roughly 80 MCP tools and another
   * will differ by tens of thousands of tokens. There is no defensible default,
   * so there is no default. `requireBaseContext` below refuses instead, the way
   * `weeklyClaimReadiness` refuses a weekly claim that has no offset-immune row.
   *
   * Measure it with `node bench/subscription/base-context.mjs`.
   */
  baseContextTokens: null,
  /** Output tokens the model writes to issue one retrieval call. */
  fetchCallTokens: 60,
  /**
   * The output tokens the assistant itself writes, per turn, averaged over real
   * traffic. Measured: 746.3 over the 7-day census (11,383,556 output tokens
   * across 15,252 requests). See BILL_SPLIT_CENSUS.
   *
   * It exists because the cost of an ARM and the cost of a SESSION are not the
   * same quantity, and only the first was ever computed. Compressing a payload
   * does not change how much the assistant writes back, so this term is
   * identical across every arm -- which is exactly why leaving it out was safe
   * for orderings and wrong for ratios. See `commonSessionCost`.
   */
  outputTokensPerTurn: 746,
  /**
   * Blocks resolved per retrieval round, i.e. per extra request.
   *
   * 1 is the conservative choice and is deliberate: a larger batch divides the
   * extra-request term, which helps whichever arm spills into more places, and
   * that arm is ours. Nothing in either mechanism forces 1 -- their proxy
   * resolves every call in a response together, and a client-side tool loop
   * returns every tool_result in one message -- so the true value is >= 1 for
   * both and unmeasured. Holding it at 1 charges us the most this model can
   * charge us; `sweep` prints what happens when it is not 1.
   */
  fetchBatch: 1,
});

/** The additive identity for `addLines`: an arm that costs nothing. */
export const ZERO_LINE = Object.freeze({
  c0: 0,
  c1: 0,
  c2: 0,
  blocks: 0,
  roundsAtFullFetch: 0,
});

/**
 * One arm's cost as a quadratic in the fetch rate `p`.
 *
 * Returns `{ c0, c1, c2, ... }`, so the cost at rate `p` is
 * `c0 + c1*p + c2*p^2` -- evaluate it with `costAt` rather than by hand.
 *
 * WHERE EACH TERM COMES FROM, with W the cache-write multiple, R the cache-read
 * multiple, O the output multiple, N the turns after the payload lands, B the
 * base context, F the output tokens of one retrieval call, and b the batch:
 *
 *   c0  the text the agent is handed: written once, read on every later
 *       request. This is the whole cost of an arm that spills nothing, and it
 *       is the only term that does not depend on p.
 *
 *   c1  per block, if fetched: the output tokens of the call that asks for it
 *       (F*O), the block written to cache and then resident for the rest of the
 *       session, and 1/b of an extra request re-reading the fixed part of the
 *       prefix (B + handed).
 *
 *   c2  per block, if fetched: 1/b of that same extra request re-reading the
 *       EARLIER BLOCKS -- which are themselves only present with probability p.
 *       Two independent p's multiply, and that is the whole reason this is a
 *       quadratic and not a line.
 *
 * RESIDENCY. A fetched block is assumed to land at turn `N*(i+1)/(n+1)` and to
 * stay for what is left. Spacing retrievals evenly is the only schedule that
 * does not quietly pick a side, and holding the schedule fixed as p falls is
 * unbiased: a random subset of evenly spaced positions has the same mean
 * position as the whole set.
 */
export function costLine({ handed, blocks = [], params = DEFAULTS }) {
  // Refuses rather than returning NaN: an unmeasured base context that flows
  // through as NaN is a silent wrong answer, and one of these printed "0.0k".
  requireBaseContext(params);
  const {
    cacheWrite: W,
    cacheRead: R,
    outputPerInput: O,
    turnsAfter: N,
    baseContextTokens: B,
    fetchCallTokens: F,
    fetchBatch: b,
  } = { ...DEFAULTS, ...params };

  if (!(b >= 1)) throw new Error(`fetchBatch must be >= 1, got ${b}`);

  const c0 = handed * (W + R * N);

  let c1 = 0;
  let c2 = 0;
  let earlier = 0; // tokens of blocks before this one, if they were all fetched
  const n = blocks.length;
  for (let i = 0; i < n; i++) {
    const at = (N * (i + 1)) / (n + 1);
    const size = blocks[i];
    c1 += F * O; // the call the model writes to ask for it
    c1 += size * (W + R * Math.max(0, N - at)); // written, then resident
    c1 += (R / b) * (B + handed); // its share of one extra request...
    c2 += (R / b) * earlier; // ...over a prefix that is itself only p-present
    earlier += size;
  }

  return {
    c0,
    c1,
    c2,
    blocks: n,
    /** Expected retrieval rounds when every block is fetched. */
    roundsAtFullFetch: n / b,
    /** Kept so a caller reading the old field name gets the fixed cost. */
    fixed: c0,
  };
}

/**
 * Two arms' costs, added.
 *
 * A quadratic plus a quadratic is a quadratic, so folding a corpus by adding
 * coefficients is exact rather than an approximation -- `costAt(a+b, p)` equals
 * `costAt(a, p) + costAt(b, p)` at every p, which `cost-model.check.mjs`
 * asserts on a grid. That is what makes a corpus-level break-even meaningful:
 * it is the rate at which the whole corpus costs the same, with every workload
 * fetching at that rate.
 */
export function addLines(a, b) {
  return {
    c0: a.c0 + b.c0,
    c1: a.c1 + b.c1,
    c2: a.c2 + b.c2,
    blocks: (a.blocks ?? 0) + (b.blocks ?? 0),
    roundsAtFullFetch: (a.roundsAtFullFetch ?? 0) + (b.roundsAtFullFetch ?? 0),
    fixed: a.c0 + b.c0,
  };
}

/** Every line, added. */
export function sumLines(lines) {
  return lines.reduce(addLines, ZERO_LINE);
}

/** Effective input tokens for a line at fetch rate `p`. */
export function costAt(line, p) {
  return line.c0 + p * line.c1 + p * p * line.c2;
}

/** Expected extra requests at fetch rate `p`. */
export function roundsAt(line, p) {
  return p * (line.roundsAtFullFetch ?? 0);
}

/** Real roots of `c2*x^2 + c1*x + c0`, computed without catastrophic cancellation. */
function quadraticRoots(c2, c1, c0) {
  if (c2 === 0) return c1 === 0 ? [] : [-c0 / c1];
  const disc = c1 * c1 - 4 * c2 * c0;
  if (disc < 0) return [];
  if (disc === 0) return [-c1 / (2 * c2)];
  const root = Math.sqrt(disc);
  // Pairing the sign with c1 keeps `q` away from zero, so neither root is the
  // difference of two nearly equal numbers.
  const q = -0.5 * (c1 + Math.sign(c1 || 1) * root);
  return [q / c2, c0 / q].sort((x, y) => x - y);
}

/**
 * The fetch rate at which two arms cost the same.
 *
 * THIS IS THE FIGURE TO PUBLISH. Every other number here rests on a guess about
 * session length, context size or batching; this one is a statement of the form
 * "we are cheaper unless your agent pulls back more than X% of what was moved
 * out", which a reader can check against their own behaviour and which is false
 * if we are wrong.
 *
 * Returns `{ p, cheaper, cheaperAbove, crossings }`:
 *
 *   p             the first crossing strictly inside (0, 1), or null if the
 *                 arms do not cross there -- in which case one arm is cheaper
 *                 at every fetch rate and `cheaper` names it.
 *   cheaper       which arm costs less at p = 0. 'a', 'b', or 'tie'.
 *   cheaperAbove  which arm costs less at p = 1. Equal to `cheaper` exactly
 *                 when there is no crossing.
 *   crossings     every root in (0, 1). Two arms whose costs are quadratics can
 *                 cross TWICE, and a caller that prints only `p` would be
 *                 stating a half-truth; this is here so that cannot happen
 *                 silently.
 *
 * `cheaper` is about p = 0 and `cheaperAbove` about p = 1 -- do not read either
 * as "the winner". A caller that prints "ours wins below X%" must check that
 * `cheaper` is actually ours; below a crossing it may not be.
 */
export function breakEven(a, b) {
  // d(p) > 0 means b costs more than a, i.e. a is cheaper.
  const d = (p) => costAt(b, p) - costAt(a, p);
  const side = (p) => Math.sign(d(p));
  const name = (s) => (s > 0 ? 'a' : s < 0 ? 'b' : 'tie');

  const cheaper = name(side(0));
  const cheaperAbove = name(side(1));

  const crossings = quadraticRoots(b.c2 - a.c2, b.c1 - a.c1, b.c0 - a.c0)
    .filter((p) => p > 0 && p < 1)
    .sort((x, y) => x - y);

  return {
    p: crossings.length > 0 ? crossings[0] : null,
    cheaper,
    cheaperAbove,
    crossings,
  };
}

/**
 * How much further the same subscription cap goes.
 *
 * A cap is a token budget, so "we cost 40% of doing nothing" and "the same plan
 * buys 2.5x as much of this work" are the same sentence. The second is the one
 * a subscriber asked, so it is the one this returns.
 */
/**
 * The fetch rate at which arm `a` fares WORST against arm `b`, and the margin
 * there -- `theirs` minus `ours`, so a positive margin means `a` is ahead.
 *
 * This exists because the cost stopped being a straight line. While it was
 * affine, an arm ahead at p = 0 and at p = 1 was ahead everywhere between, and
 * a gate could settle the question with two evaluations. A quadratic difference
 * that opens upward has its minimum in the MIDDLE, so both endpoints can show a
 * comfortable lead over an interval where the lead is briefly gone.
 *
 * A parabola has one turning point, so three candidates decide the whole
 * interval exactly: the two ends, and the vertex when it opens upward and falls
 * inside (0, 1). No scan, no sampling, no tolerance.
 */
export function worstAgainst(a, b) {
  const d2 = b.c2 - a.c2;
  const d1 = b.c1 - a.c1;
  const d0 = b.c0 - a.c0;
  const margin = (p) => d0 + d1 * p + d2 * p * p;
  const candidates = [0, 1];
  if (d2 > 0) {
    const vertex = -d1 / (2 * d2);
    if (vertex > 0 && vertex < 1) candidates.push(vertex);
  }
  let at = 0;
  for (const p of candidates) if (margin(p) < margin(at)) at = p;
  return { p: at, margin: margin(at) };
}

/**
 * The part of a session's bill that every arm incurs identically: the output
 * the assistant writes over the turns that follow the payload.
 *
 * It scales with `turnsAfter`, so a sweep that attacks that assumption moves
 * this term with it rather than holding it fixed at the default's value.
 */
export function commonSessionCost(params = DEFAULTS) {
  requireBaseContext(params);
  return params.turnsAfter * params.outputTokensPerTurn * params.outputPerInput;
}

/**
 * What the same subscription cap buys, arm against baseline.
 *
 * THE COMMON TERM IS NOT OPTIONAL HERE, AND ITS OMISSION ONLY EVER FLATTERED
 * US. A subscription meters the whole session, and the output the assistant
 * writes is 11.6% of this user's measured bill. No arm changes it: the same
 * question gets the same answer however its context was packed. Left out of
 * both sides of a ratio, a term that cancels in a DIFFERENCE does not cancel
 * in a QUOTIENT -- it pushes the quotient away from 1, and always in the
 * direction that makes the arm look better. `ours` read 1.96x with it missing.
 *
 * So orderings, break-evens and the must-win gate are untouched by this (they
 * are all differences), and every published multiple moves toward 1.
 *
 * Pass `{ commonCost: 0 }` to recover the payload-only ratio deliberately.
 */
export function usageMultiplier(baselineCost, armCost, { params = DEFAULTS, commonCost } = {}) {
  requireBaseContext(params);
  const common = commonCost ?? commonSessionCost(params);
  if (armCost + common <= 0) return Infinity;
  return (baselineCost + common) / (armCost + common);
}

/**
 * The same comparison across a grid of assumptions.
 *
 * The guesses in DEFAULTS are the obvious place to attack these numbers, so the
 * harness prints the attack instead of waiting for it. Any DEFAULTS key may be
 * swept; `build` is called once per combination with the resulting params.
 */
export function sweep(build, grid) {
  const keys = Object.keys(grid);
  const out = [];
  const walk = (i, chosen) => {
    if (i === keys.length) {
      const params = { ...DEFAULTS, ...chosen };
      out.push({ ...chosen, ...build(params) });
      return;
    }
    for (const value of grid[keys[i]]) walk(i + 1, { ...chosen, [keys[i]]: value });
  };
  walk(0, {});
  return out;
}

/**
 * Params built from what the subscription meter actually solved for, rather
 * than from the price list.
 *
 * `ratios` are per-token weights RELATIVE TO ONE INPUT TOKEN -- exactly what
 * `bench/subscription/calibrate.mjs` can recover, because the unknown plan cap
 * cancels in a ratio and never in an absolute. Any ratio left out keeps its
 * published value, so a partial calibration is usable rather than all-or-
 * nothing. Passing a measured ratio here is the only way a number in this file
 * stops being an assertion.
 */
export function paramsFromMeter(ratios = {}, overrides = {}) {
  const measured = {};
  if (Number.isFinite(ratios.cacheWrite)) measured.cacheWrite = ratios.cacheWrite;
  if (Number.isFinite(ratios.cacheRead)) measured.cacheRead = ratios.cacheRead;
  if (Number.isFinite(ratios.output)) measured.outputPerInput = ratios.output;
  return { ...DEFAULTS, ...measured, ...overrides };
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

/**
 * Refuse a cost claim whose base context was never measured.
 *
 * Returns the parameters unchanged when they carry a measured base, and throws
 * otherwise. It throws rather than returning a flag because the alternative to
 * refusing is printing a number, and a number printed from an unmeasured
 * constant is indistinguishable from a measured one once it is on the page.
 */
export function requireBaseContext(params) {
  const b = params?.baseContextTokens;
  if (typeof b === 'number' && Number.isFinite(b) && b > 0) return params;
  throw new Error(
    'baseContextTokens has not been measured for this environment, so no cost claim ' +
      'can be printed. Run `node bench/subscription/base-context.mjs` and pass the ' +
      'measured median. It is intentionally null by default: the 12000 it replaced ' +
      'understated this machine by 5.4x, and understating it inflates every savings figure.'
  );
}
