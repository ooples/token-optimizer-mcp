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
/**
 * The policies, priced against a liveness order that is not chosen to flatter
 * them.
 *
 * THE PREVIOUS VERSION OF THIS WAS INVALID AND READ AS A 47% WIN. It let the
 * drop-from-the-end policy remove the same NUMBER of units as drop-oldest while
 * the units that had actually died were at the FRONT -- so it bought its saving
 * by dropping live content and was never a policy anyone could ship. The
 * tension it papered over is the real finding here: in a conversation, dead
 * content is old content and sits at the front, where the cache makes it the
 * most expensive thing to remove, while the cheap end to remove from holds the
 * turn the model is working on. Cache economics and liveness economics point in
 * opposite directions.
 *
 * So `dropDead` drops from the front, because that is where the dead units are,
 * and pays the suffix re-write the cache charges for it. `dropBatched` drops the
 * same units at one turn instead of a few per turn, paying that penalty once.
 */
export function comparePolicies({ units, unitTokens, turns, deadAfter }) {
  const all = units * unitTokens;
  const schedule = (bodyAt, sharedAt) => {
    const bodies = [];
    const shared = [];
    for (let t = 0; t <= turns; t += 1) {
      bodies.push(bodyAt(t));
      shared.push(t === 0 ? 0 : sharedAt(t));
    }
    return { bodies, shared };
  };
  /** How many units have died by turn t, oldest first. */
  const deadBy = (t) => Math.min(units, Math.floor(t / deadAfter));

  // Nothing is ever removed: one write, then a re-read every turn. This is the
  // arm `costLine` prices, and `reducesToCostLine` below checks it agrees.
  const keepAll = schedule(
    () => all,
    () => all
  );

  // Remove each dead unit as it dies. The dead ones are the oldest, so the
  // first byte of the body moves and nothing before the drop survives: the
  // cached prefix is zero on every turn a drop happens.
  const dropDead = schedule(
    (t) => all - deadBy(t) * unitTokens,
    (t) => (deadBy(t) === deadBy(t - 1) ? all - deadBy(t) * unitTokens : 0)
  );

  // The same units, removed in one event at the half-way turn.
  const at = Math.ceil(turns / 2);
  const dropBatched = schedule(
    (t) => (t < at ? all : all - deadBy(at) * unitTokens),
    (t) => (t === at ? 0 : t < at ? all : all - deadBy(at) * unitTokens)
  );

  return {
    keepAll: assemblyCost(keepAll.bodies, keepAll.shared),
    dropDead: assemblyCost(dropDead.bodies, dropDead.shared),
    dropBatched: assemblyCost(dropBatched.bodies, dropBatched.shared),
  };
}

/**
 * THE CONTROL: this model has to agree with the one it generalises.
 *
 * A body that never changes costs `handed * W` on the first turn and
 * `handed * R` on each of the next N, which is `handed * (W + R*N)` -- exactly
 * `costLine`'s c0 with no cached prefix. The first version of this file claimed
 * that reduction and was off by one turn, because its schedule ran N turns
 * rather than the first turn plus N after it.
 */
export function reducesToCostLine(handed, turnsAfter, rates = RATES) {
  const bodies = Array.from({ length: turnsAfter + 1 }, () => handed);
  const shared = bodies.map((_, t) => (t === 0 ? 0 : handed));
  const mine = assemblyCost(bodies, shared, rates);
  const theirs = handed * (rates.cacheWrite + rates.cacheRead * turnsAfter);
  return { mine, theirs, agree: Math.abs(mine - theirs) < 1e-6 };
}
