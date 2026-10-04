/**
 * PER-TURN CONTEXT ASSEMBLY: THE COST MODEL A PROXY ACTUALLY HAS.
 *
 * `costLine` prices one body written once and re-read N times, plus a penalty
 * per fetch: a model-authored ask, an extra request, and residency for every
 * remaining turn. That is the shape of a withhold-to-a-store engine, and 86% of
 * its fetch cost is that residency term.
 *
 * A proxy has none of those. It rebuilds the request body on every turn, so
 * "retrieval" is not an event -- it is bytes being present in the next body.
 * There is no tool call, no extra request, and no round trip. A unit present
 * for turns 12 to 18 costs six turns of re-reads, not forty-four, and the fetch
 * rate `p` does not appear anywhere, because nothing is ever fetched.
 *
 * So the bill is a sum over turns, not a product:
 *
 *   cost = SUM over turns of [ shared(t) * R + changed(t) * W ]
 *
 * where `shared(t)` is the prefix the provider still has cached from turn t-1
 * and `changed(t)` is everything after the first byte that moved. It reduces to
 * `costLine` exactly when the body never changes: handed * W on the first turn
 * and handed * R on each of the next N, which is handed * (W + R*N).
 *
 * AND IT PRODUCES A DESIGN RULE THAT IS THE OPPOSITE OF CACHE INTUITION.
 * Dropping a unit saves R per remaining turn but costs W once on everything
 * after it in the body, because the cached prefix breaks at the drop point. So
 * a drop pays only when
 *
 *   W * suffix  <  R * dropped * (N - t)
 *
 * which at W=2, R=0.1 and N=56 means the suffix after the drop has to be under
 * about 2.8x the size of what was dropped. Dropping the OLDEST unit -- what an
 * LRU would do -- re-writes the whole conversation after it and is the most
 * expensive choice available. Dropping from the end is nearly free, and
 * batching every drop into one turn pays the suffix penalty once instead of
 * once per unit.
 */

/** Matches DEFAULTS in cost-model.mjs; duplicated here so this file is readable alone. */
export const RATES = Object.freeze({ cacheWrite: 2, cacheRead: 0.1 });

/**
 * Price a schedule.
 *
 * `bodies` is the token count of the assembled body at each turn, and
 * `shared` the prefix each turn still shares with the one before it. Both are
 * in tokens, and `shared[t] <= min(bodies[t], bodies[t-1])` is required rather
 * than clamped: a prefix longer than either body means the caller measured two
 * different things, and clamping would turn that into a plausible discount.
 */
export function assemblyCost(bodies, shared, rates = RATES) {
  if (bodies.length !== shared.length)
    throw new Error(
      `a schedule needs one shared-prefix figure per turn: ${bodies.length} bodies against ${shared.length}`
    );
  const { cacheWrite: W, cacheRead: R } = rates;
  let total = 0;
  for (let t = 0; t < bodies.length; t += 1) {
    const previous = t === 0 ? 0 : bodies[t - 1];
    const cached = t === 0 ? 0 : shared[t];
    if (cached > Math.min(bodies[t], previous))
      throw new Error(
        `turn ${t} shares ${cached} tokens with a body of ${previous} and sends ${bodies[t]}: a prefix cannot exceed either`
      );
    total += cached * R + (bodies[t] - cached) * W;
  }
  return total;
}

/**
 * The three policies, priced on one payload of equal-sized units.
 *
 * Deliberately a synthetic schedule rather than a corpus replay: the point is
 * the SHAPE of the three answers, and a replay would need a per-unit liveness
 * trace that nothing records yet. The absolute figures are therefore not a
 * measurement of our engine; the ordering between them is the claim.
 */
export function comparePolicies({ units, unitTokens, turns, deadAfter }) {
  const all = units * unitTokens;
  const keepAll = {
    bodies: Array.from({ length: turns }, () => all),
    shared: Array.from({ length: turns }, () => all),
  };
  // Drop the oldest dead unit each turn: the prefix breaks at the front, so
  // everything still resident is re-written.
  const oldest = { bodies: [], shared: [] };
  // Drop from the end instead: the prefix survives up to the drop point.
  const newest = { bodies: [], shared: [] };
  // Every drop batched into one turn, once.
  const batched = { bodies: [], shared: [] };
  for (let t = 0; t < turns; t += 1) {
    const dead = Math.min(units, Math.floor(t / deadAfter));
    const live = (units - dead) * unitTokens;
    oldest.bodies.push(live);
    oldest.shared.push(dead === 0 ? live : 0);
    newest.bodies.push(live);
    newest.shared.push(live);
    const cut = t >= turns / 2;
    batched.bodies.push(cut ? all - units * unitTokens * 0.5 : all);
    batched.shared.push(
      t === Math.ceil(turns / 2)
        ? all * 0.5
        : all - (cut ? units * unitTokens * 0.5 : 0)
    );
  }
  return {
    keepAll: assemblyCost(keepAll.bodies, keepAll.shared),
    dropOldest: assemblyCost(oldest.bodies, oldest.shared),
    dropNewest: assemblyCost(newest.bodies, newest.shared),
    dropBatched: assemblyCost(batched.bodies, batched.shared),
  };
}
