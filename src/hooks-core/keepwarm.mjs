/**
 * Keep-warm, decided in advance rather than regretted afterwards.
 *
 * A keep-warm refresh costs a cache WRITE -- a quarter more than a plain token
 * -- and returns nothing unless a real turn arrives before the entry expires.
 * The competitor's answer is a tripwire: refresh by default, and disable once
 * the trade has already gone negative. That pays for every lesson it learns.
 *
 * The gaps between turns are observable, so the decision can be made BEFORE the
 * write instead of after:
 *
 *     EV = P(next turn arrives before expiry) x saving-if-hit - cost-of-write
 *
 * Refresh when that is positive and not otherwise. The same distribution also
 * picks the TTL TIER, which is a decision nobody else appears to make at all: a
 * one-hour cache costs twice the write of a five-minute one and only pays for a
 * segment whose gaps are long. Choosing per segment beats choosing globally,
 * because a project's tool definitions and its conversation have completely
 * different gap profiles.
 *
 * THE TRIPWIRE STAYS UNDERNEATH. An expected-value decision is only as good as
 * the distribution it was fitted to, and distributions shift -- a user changes
 * working pattern, a project goes quiet. When realised savings go negative the
 * whole thing stops and says so, which is the same rule the forecast follows.
 */

import { record, readMetrics, readBalance } from './metrics.mjs';
import { WRITE_MULTIPLIER, READ_MULTIPLIER } from './cache.mjs';

/**
 * The shortest gap that counts as a NEW turn rather than a burst inside one.
 *
 * Shared by the gap distribution and by the hit test, because they have to
 * agree about what a turn is. Two copies of this number would let the decision
 * be fitted to one definition of a turn and scored against another.
 */
export const TURN_GAP_MS = 250;

/**
 * TTL tiers, with what a WRITE costs at each.
 *
 * A five-minute entry is written at 1.25x a plain input token; the one-hour
 * entry costs 2x. Reads are 0.1x at either tier -- which is the fact the naive
 * model of this gets wrong, because it makes holding a long cache warm cheap
 * and makes the tier decision turn entirely on how often the write is repaid.
 */
export const TIERS = [
  { name: '5m', ms: 5 * 60 * 1000, writeMultiplier: WRITE_MULTIPLIER },
  { name: '1h', ms: 60 * 60 * 1000, writeMultiplier: 2.0 },
];

/** Turns per session assumed when amortising the first write, if unknown. */
const DEFAULT_TURNS = 20;

/** Refreshes to observe before the tripwire is allowed to have an opinion. */
export const TRIPWIRE_MIN = 10;

/**
 * The gaps between turns in this project.
 *
 * Taken from our own event log rather than the transcript, because every client
 * produces it and the shape of the distribution is what matters, not which tool
 * was called.
 */
export function gapDistribution(dir, { events = readMetrics(dir) } = {}) {
  // PARTITIONED BY SESSION, because the interval between the last event of one session and the
  // first of the next is not a gap between turns at all. The log spans days, so an overnight
  // sixteen-hour boundary was counted as one -- dominating p90 and p99 and diluting
  // probabilityWithin in the conservative direction, so ttlTier answered "neither tier pays" on
  // projects where it would have paid. Silent, because that bias only ever declines to act.
  //
  // A long gap WITHIN a session is kept. It is real evidence that caching does not pay there, and
  // dropping it would bias the answer the other way -- making keep-warm look better than it is,
  // which is the direction this project cares about most.
  //
  // Events carrying no sessionId are pooled into one group rather than discarded: most kinds do
  // carry one, and discarding the rest would throw away whole projects' history for a technicality.
  const bySession = new Map();
  for (const event of events) {
    if (!Number.isFinite(event?.at)) continue;
    const key = event.sessionId || '';
    if (!bySession.has(key)) bySession.set(key, []);
    bySession.get(key).push(event.at);
  }

  const stamps = [...bySession.values()].flat();
  if (stamps.length < 8) return null;

  const gaps = [];
  for (const session of bySession.values()) {
    session.sort((a, b) => a - b);
    for (let i = 1; i < session.length; i++) {
      const gap = session[i] - session[i - 1];
      // A burst of events inside one turn is not a gap between turns.
      if (gap > TURN_GAP_MS) gaps.push(gap);
    }
  }
  if (gaps.length < 6) return null;

  gaps.sort((a, b) => a - b);
  const at = (q) => gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * q))];

  return {
    count: gaps.length,
    median: at(0.5),
    p75: at(0.75),
    p90: at(0.9),
    p99: at(0.99),
    /** The empirical probability the next gap is shorter than a TTL. */
    probabilityWithin: (ms) => gaps.filter((g) => g < ms).length / gaps.length,
  };
}

/**
 * Refreshes to observe at a tier before the observation may bound the decision.
 *
 * THE SAME NUMBER THE BACKSTOP DEMANDS, deliberately. The decision and the
 * tripwire read the same ledger, so letting them disagree about when there is
 * enough evidence would mean one of them acting on a sample the other calls too
 * small. Below the floor the decision keeps its expected-value answer, so a
 * single unlucky miss changes nothing at all.
 *
 * NOT A CONFIDENCE INTERVAL, and the reason is arithmetic rather than taste. A
 * Wilson 95% upper bound at ten refreshes and zero hits is 0.28 -- so a policy
 * that missed ten times out of ten would still be recommended, which is exactly
 * the case the loop exists to catch. The point estimate is safe here because of
 * the bound below: an observation may only ever LOWER the modelled probability,
 * so sampling noise cannot manufacture a refresh, and the tripwire's realised
 * ledger is a second guard underneath.
 */
export const OBSERVATION_FLOOR = TRIPWIRE_MIN;

/**
 * The measured hit rate per tier, from recorded outcomes.
 *
 * Tiers below the floor are ABSENT rather than present with a small n, because
 * a rate carrying no weight is the thing most likely to be used as though it
 * did.
 */
export function observedHitRates(outcomes = []) {
  const byTier = new Map();
  for (const event of outcomes) {
    if (event?.kind !== 'keepwarm' || event.action !== 'outcome') continue;
    const name = TIERS.some((t) => t.name === event.tier) ? event.tier : TIERS[0].name;
    const row = byTier.get(name) || { refreshes: 0, hits: 0 };
    row.refreshes += 1;
    if (event.hit) row.hits += 1;
    byTier.set(name, row);
  }

  const qualified = new Map();
  for (const [name, row] of byTier) {
    if (row.refreshes < OBSERVATION_FLOOR) continue;
    qualified.set(name, { ...row, rate: row.hits / row.refreshes });
  }
  return qualified;
}

/**
 * What the refreshes at this tier actually did, if enough of them have.
 *
 * Tolerates being handed anything -- null, a plain object, a Map -- because the
 * callers are two public functions whose options object is assembled by other
 * people's code.
 */
function observationsFor(observed, tierName) {
  const row = observed instanceof Map ? observed.get(tierName) : null;
  return row && Number.isFinite(row.rate) ? row : null;
}

/**
 * The modelled probability, BOUNDED BY what was observed and never raised by it.
 *
 * The asymmetry is the whole point and runs against this project's interest. A
 * recorded `hit` says only that a turn arrived before the entry expired; it
 * cannot say the refresh is what kept the entry alive, because a turn arriving
 * one minute after a five-minute ping would have found the entry warm anyway.
 * So the observed rate is an UPPER bound on a refresh's value, and substituting
 * it for the model would flatter keep-warm badly: on the machine this was
 * written on, the modelled ping probability is 0.2% and the observable
 * before-expiry rate is 99.5%, so the substitution would recommend refreshing
 * forever. A low rate, by contrast, is real evidence against: if turns do not
 * even arrive inside the TTL, the refresh certainly bought nothing.
 */
function bounded(modelled, seen) {
  return seen ? Math.min(modelled, seen.rate) : modelled;
}

/**
 * Should we refresh this prefix now?
 *
 * Returns the arithmetic as well as the verdict, because a refusal to refresh
 * that cannot be checked is indistinguishable from a bug.
 *
 * `observed` is passed IN rather than read from disk here: this function is
 * pure, its purity is what lets the tests build a distribution by hand, and
 * `shouldKeepWarm` has already read the outcome log for the tripwire -- so
 * threading the reader in here would be a second read of the same file and a
 * second place for the window discipline to be got wrong.
 */
export function keepWarmDecision({ prefixTokens, gaps, tier = TIERS[0], observed = null }) {
  if (!prefixTokens || !gaps) {
    return { action: 'unknown', reason: 'no gap distribution yet -- needs a few sessions of history' };
  }

  // A ping READS the prefix, which is what extends the TTL -- it does not
  // rewrite it. Pricing the ping as a write, which is the obvious-looking
  // model, overstates its cost by more than twelvefold and rejects refreshes
  // that are clearly worth buying.
  const costOfPing = prefixTokens * READ_MULTIPLIER;

  // The ping only earns anything in the window where the entry WOULD have
  // expired but the next turn still arrives: before the TTL it was already
  // warm, and long after it, one ping does not reach.
  const modelled = Math.max(0, gaps.probabilityWithin(tier.ms * 2) - gaps.probabilityWithin(tier.ms));
  const seen = observationsFor(observed, tier.name);
  const probability = bounded(modelled, seen);
  const savingIfUsed = prefixTokens * (tier.writeMultiplier - READ_MULTIPLIER);
  const ev = probability * savingIfUsed - costOfPing;
  const note = seen && probability < modelled
    ? `; bounded by ${seen.refreshes} observed refreshes, ` +
      `${Math.round(seen.rate * 100)}% used before expiry`
    : '';

  return {
    action: ev > 0 ? 'refresh' : 'skip',
    tier: tier.name,
    probability,
    modelledProbability: modelled,
    observedHitRate: seen ? seen.rate : null,
    observedRefreshes: seen ? seen.refreshes : 0,
    savingIfUsed: Math.round(savingIfUsed),
    costOfPing: Math.round(costOfPing),
    expectedValue: Math.round(ev),
    reason: (ev > 0
      ? `${Math.round(probability * 100)}% of gaps land in the window one ${tier.name} refresh covers; ` +
        `expected gain ${Math.round(ev).toLocaleString()} tokens`
      : `only ${Math.round(probability * 100)}% of gaps land in the window a ${tier.name} refresh covers; ` +
        `expected loss ${Math.abs(Math.round(ev)).toLocaleString()} tokens`) + note,
  };
}

/**
 * Which TTL tier is worth buying for a prefix of this size.
 *
 * The longer tier costs twice the write, so it only wins where the gaps are
 * long enough that the short tier keeps missing. Returns null when neither tier
 * pays, which is a real answer and the one a default-on product never gives.
 */
export function ttlTier({
  prefixTokens,
  gaps,
  turnsPerSession = DEFAULT_TURNS,
  observed = null,
}) {
  if (!prefixTokens || !gaps) return null;

  // Expected cost of a turn under each tier, as a multiple of what the prefix
  // would cost uncached. A hit costs a read; a miss pays the tier's write
  // again; and the FIRST write is amortised over the session, which is what
  // stops the expensive tier from looking free whenever gaps are short.
  const costOf = (tier) => {
    // THE SAME QUANTITY THE OUTCOMES RECORD, which is what makes the
    // observation admissible here at all. `hit` is P(a turn arrives before the
    // entry expires) and `recordRefreshOutcome`'s `hit` is exactly that event,
    // measured -- unlike keepWarmDecision, whose probability is the narrower
    // ping window and for which the same observation is only an upper bound.
    // Bounded rather than replaced even so: a sample drawn only from moments we
    // CHOSE to refresh is not a sample of gaps, and its bias runs our way.
    const modelled = gaps.probabilityWithin(tier.ms);
    const seen = observationsFor(observed, tier.name);
    const hit = bounded(modelled, seen);
    const perTurn = hit * READ_MULTIPLIER + (1 - hit) * tier.writeMultiplier;
    // THE SUPPLIED VALUE, not only the computed one. Math.max(1, NaN) is NaN -- Math.max
    // propagates it rather than clamping -- so perTurn became NaN, the `perTurn >= 1` guard below
    // read `NaN >= 1` as false and PASSED, and this returned action:'refresh' with an
    // expectedValue of NaN and a reason string reading "NaN% of gaps land inside 5m". A positive
    // verdict built entirely out of NaN. The guard was on the wrong side of the computation.
    const turns = Number.isFinite(turnsPerSession) && turnsPerSession >= 1
      ? turnsPerSession
      : DEFAULT_TURNS;
    return {
      tier,
      hit,
      seen,
      boundedByObservation: Boolean(seen) && hit < modelled,
      perTurn: (tier.writeMultiplier + (turns - 1) * perTurn) / turns,
    };
  };

  const ranked = TIERS.map(costOf).sort((a, b) => a.perTurn - b.perTurn);
  const best = ranked[0];

  // Caching has to beat not caching. When gaps are so long that every entry
  // expires unused, the honest answer is that neither tier pays -- which a
  // default-on product never gives.
  if (!best || best.perTurn >= 1) return null;

  return {
    action: 'refresh',
    tier: best.tier.name,
    hitProbability: best.hit,
    observedHitRate: best.seen ? best.seen.rate : null,
    observedRefreshes: best.seen ? best.seen.refreshes : 0,
    expectedCostPerTurn: Number(best.perTurn.toFixed(3)),
    expectedValue: Math.round((1 - best.perTurn) * prefixTokens),
    reason: `${Math.round(best.hit * 100)}% of gaps land inside ${best.tier.name}; ` +
      `expected cost ${best.perTurn.toFixed(2)}x per turn against 1.00x uncached` +
      (best.boundedByObservation
        ? `, bounded by ${best.seen.refreshes} observed refreshes ` +
          `(${Math.round(best.seen.rate * 100)}% used before expiry)`
        : ''),
  };
}

/**
 * Records a refresh so its outcome can be scored.
 *
 * `sessionId` IS REQUIRED FOR THE REFRESH TO BE SCOREABLE, and is not defaulted
 * to anything. The hit test asks whether a turn of THIS conversation arrived
 * before expiry; pooling arrivals across sessions would let a second concurrent
 * session's turn pay for this one's ping, which manufactures hits. A refresh
 * recorded without one is kept in the ledger and reported as unattributable
 * rather than guessed at.
 *
 * Returns the stored record, whose `id` is what `scoreRefreshes` pairs the
 * outcome to, so an issuer can hold onto it.
 */
export function recordRefresh(dir, { tier, prefixTokens, expectedValue, sessionId, at }) {
  return record(dir, {
    kind: 'keepwarm',
    action: 'refresh',
    tier,
    prefixTokens,
    expectedValue,
    sessionId,
    at,
  });
}

/**
 * Records whether the refresh was used.
 *
 * `hit` means a real turn arrived before expiry, so the write bought a read.
 * `refreshId` names the refresh this scores, so the same one cannot be scored
 * twice -- once per turn for the rest of the session, which is what an
 * unpaired outcome would become.
 */
export function recordRefreshOutcome(dir, { tier, prefixTokens, hit, refreshId = null }) {
  const tierSpec = TIERS.find((t) => t.name === tier) || TIERS[0];
  // THE SAME LEDGER keepWarmDecision BUYS THE REFRESH WITH. That function is explicit that a
  // refresh is a PING, which READS the prefix -- costOfPing = prefixTokens * READ_MULTIPLIER --
  // and its comment warns that pricing the ping as a write "overstates its cost by more than
  // twelvefold". This scored the very same refresh as a re-WRITE, charging (writeMultiplier - 1)
  // on both branches.
  //
  // The disagreement runs in the direction that kills the feature. Mean realised per refresh under
  // the old lines was p*(0.9h - 0.25), negative below a 27.8% hit rate, while the decision's own
  // model makes the ping pay above 8.7%. For any project whose gaps fall in that band, `tripwire`
  // accumulates a negative balance and permanently disables a policy that is genuinely paying --
  // and tells the user "keep-warm has lost N tokens ... stopping". The backstop fired on its own
  // accounting error rather than on a distribution shift.
  const realised = hit
    ? prefixTokens * (tierSpec.writeMultiplier - READ_MULTIPLIER) - prefixTokens * READ_MULTIPLIER
    : -prefixTokens * READ_MULTIPLIER;
  record(dir, {
    kind: 'keepwarm',
    action: 'outcome',
    tier,
    prefixTokens,
    hit: Boolean(hit),
    refreshId,
    realised: Math.round(realised),
  });
}

/**
 * Scores every recorded refresh whose window has closed -- and NOTHING ELSE.
 *
 * This is the arm that was missing. `recordRefresh` and `recordRefreshOutcome`
 * were both correct and both called by nothing, so the decision spent money on
 * refreshes and could never find out whether one bought a read.
 *
 * THE SIGNAL IS REAL, not invented. `gapDistribution` already treats this log's
 * timestamps as turn arrivals -- that is the distribution the whole decision is
 * fitted to -- so the same log answers the outcome question directly: a refresh
 * at tier `5m` was used if a turn of the same session arrived within five
 * minutes of it. Four cases refuse to answer rather than guess, and every one
 * of them refuses in the direction that costs this project its own good news:
 *
 *   - `pending`: the window has not closed yet. A hit could be scored the
 *     instant it arrives while a miss must wait out the whole TTL, so scoring
 *     early would mean the recorded hits are always complete and the recorded
 *     misses always lagging -- right-censoring, biased upward, invisible in any
 *     test. So a hit waits exactly as long as a miss.
 *   - `uncovered`: the arrival log no longer reaches back to the refresh, so
 *     absence of an arrival is absence of evidence. RECORDING `hit: false` HERE
 *     WOULD BE THE INVENTION THIS IS FORBIDDEN TO MAKE: an absent signal is not
 *     a miss, and treating it as one biases every rate downward and would
 *     eventually switch keep-warm off on no evidence at all.
 *   - `unattributable`: the refresh names no session, so no arrival can be
 *     shown to belong to it.
 *   - already scored: an outcome already names this refresh.
 *
 * The firehose is READ LAZILY, and only when there is something to score. On a
 * machine where nothing issues refreshes -- which is every machine today, since
 * nothing in this repository issues one -- the whole cost is the outcome-log
 * read: median 70 ms on a 3.5 MB log, of which readBalance is 49 ms, because
 * that reader also scans the firehose tail for pre-split records.
 */
export function scoreRefreshes(dir, {
  refreshes = readBalance(dir),
  arrivals = null,
  now = Date.now(),
} = {}) {
  const summary = { scored: 0, hits: 0, pending: 0, uncovered: 0, unattributable: 0 };
  const keepwarm = refreshes.filter((event) => event?.kind === 'keepwarm');
  const alreadyScored = new Set(
    keepwarm
      .filter((event) => event.action === 'outcome' && event.refreshId)
      .map((event) => event.refreshId)
  );
  const unscored = keepwarm.filter(
    (event) =>
      event.action === 'refresh' &&
      Number.isFinite(event.at) &&
      event.id &&
      !alreadyScored.has(event.id)
  );

  // A refresh with no id cannot be paired, so scoring it would write a fresh
  // outcome on every turn forever. Reported, not silently dropped.
  summary.unattributable += keepwarm.filter(
    (event) => event.action === 'refresh' && (!event.id || !Number.isFinite(event.at))
  ).length;

  if (!unscored.length) return summary;

  const events = (arrivals ? arrivals() : readMetrics(dir)).filter((event) =>
    Number.isFinite(event?.at)
  );
  // Coverage is judged over EVERY event, including our own bookkeeping: the
  // refresh's own copy in the firehose is what proves the window is still
  // inside the read. Arrivals are judged over everything else, because a record
  // keep-warm wrote about itself is not a turn -- and counting one would
  // manufacture a hit out of the act of measuring.
  const earliest = events.reduce((min, event) => Math.min(min, event.at), Infinity);
  const turns = events.filter((event) => event.kind !== 'keepwarm');

  for (const refresh of unscored) {
    const tier = TIERS.find((t) => t.name === refresh.tier) || TIERS[0];
    if (now - refresh.at < tier.ms) {
      summary.pending += 1;
      continue;
    }
    const session = refresh.sessionId;
    if (!session) {
      summary.unattributable += 1;
      continue;
    }
    if (!(earliest <= refresh.at)) {
      summary.uncovered += 1;
      continue;
    }

    const opens = refresh.at + TURN_GAP_MS;
    const closes = refresh.at + tier.ms;
    const hit = turns.some(
      (event) =>
        (event.sessionId ?? event.episodeId) === session &&
        event.at > opens &&
        event.at <= closes
    );
    recordRefreshOutcome(dir, {
      tier: refresh.tier,
      prefixTokens: refresh.prefixTokens,
      hit,
      refreshId: refresh.id,
    });
    summary.scored += 1;
    if (hit) summary.hits += 1;
  }

  return summary;
}

/**
 * The backstop.
 *
 * An expected-value decision is only as good as the distribution it was fitted
 * to, and distributions shift. When realised savings go negative over enough
 * refreshes, keep-warm stops -- and says which tier and by how much, so the
 * stop is a finding rather than a silent behaviour change.
 */
/**
 * The backstop, read from the log that is NOT windowed.
 *
 * readBalance rather than readMetrics, and that distinction is the difference between a backstop
 * that works and one that cannot. There is one outcome per refresh, in a log dominated by reads
 * and captures, so through the 5000-event window the ten TRIPWIRE_MIN demands aged out before the
 * tenth was written -- and this returned "only N/10 refreshes observed" for the life of the
 * project. A guard that can never reach its own threshold is not a guard.
 */
export function tripwire(dir, { events = readBalance(dir) } = {}) {
  const outcomes = events.filter((e) => e.kind === 'keepwarm' && e.action === 'outcome');
  if (outcomes.length < TRIPWIRE_MIN) {
    return { tripped: false, observed: outcomes.length, reason: `only ${outcomes.length}/${TRIPWIRE_MIN} refreshes observed` };
  }

  const realised = outcomes.reduce((sum, o) => sum + (o.realised || 0), 0);
  const hits = outcomes.filter((o) => o.hit).length;

  return {
    tripped: realised < 0,
    observed: outcomes.length,
    realised: Math.round(realised),
    hitRate: hits / outcomes.length,
    reason: realised < 0
      ? `keep-warm has lost ${Math.abs(Math.round(realised)).toLocaleString()} tokens over ${outcomes.length} refreshes ` +
        `(${Math.round((hits / outcomes.length) * 100)}% used before expiry); stopping`
      : `keep-warm has gained ${Math.round(realised).toLocaleString()} tokens over ${outcomes.length} refreshes`,
  };
}

/**
 * The decision as it should actually be taken: expected value, with the
 * tripwire able to veto it.
 */
export function shouldKeepWarm(dir, {
  prefixTokens,
  events = readMetrics(dir),
  // TWO SOURCES, because the two consumers want different things. gapDistribution wants the
  // firehose -- every event is a timestamp and the recent ones describe the current rhythm. The
  // tripwire wants the unwindowed balance log, because its outcomes are rare and are exactly what
  // the window evicts. Passing one shared array to both, as this used to, meant whichever reader
  // was chosen was wrong for one of them.
  outcomes = readBalance(dir),
} = {}) {
  const trip = tripwire(dir, { events: outcomes });
  if (trip.tripped) return { action: 'skip', reason: trip.reason, trippedWire: true };

  // THE SAME ARRAY THE TRIPWIRE JUST READ, so closing the loop costs no extra
  // I/O -- and so the decision and its backstop cannot be looking at different
  // evidence about the same refreshes.
  const observed = observedHitRates(outcomes);
  const gaps = gapDistribution(dir, { events });
  const best = ttlTier({ prefixTokens, gaps, observed });
  if (!best) {
    // THE TWO MODELS ANSWER DIFFERENT QUESTIONS, so they may legitimately disagree. ttlTier asks
    // whether holding a cache beats not caching at all; keepWarmDecision asks whether ONE ping
    // beats letting the entry lapse -- and a ping can pay where no tier does. Coercing everything
    // that was not 'unknown' to 'skip' while keeping the decision's reason verbatim produced a
    // refusal justified by a GAIN: `{ action: 'skip', reason: '...expected gain 130 tokens' }`.
    // This module's own docstring says a refusal that cannot be checked is indistinguishable from
    // a bug; one that contradicts itself is worse.
    const decision = keepWarmDecision({ prefixTokens, gaps, observed });
    if (decision.action === 'refresh') return decision;
    return { action: decision.action === 'unknown' ? 'unknown' : 'skip', reason: decision.reason };
  }
  return best;
}
