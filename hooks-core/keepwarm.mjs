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
      if (gap > 250) gaps.push(gap);
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
 * Should we refresh this prefix now?
 *
 * Returns the arithmetic as well as the verdict, because a refusal to refresh
 * that cannot be checked is indistinguishable from a bug.
 */
export function keepWarmDecision({ prefixTokens, gaps, tier = TIERS[0] }) {
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
  const probability = Math.max(0, gaps.probabilityWithin(tier.ms * 2) - gaps.probabilityWithin(tier.ms));
  const savingIfUsed = prefixTokens * (tier.writeMultiplier - READ_MULTIPLIER);
  const ev = probability * savingIfUsed - costOfPing;

  return {
    action: ev > 0 ? 'refresh' : 'skip',
    tier: tier.name,
    probability,
    savingIfUsed: Math.round(savingIfUsed),
    costOfPing: Math.round(costOfPing),
    expectedValue: Math.round(ev),
    reason: ev > 0
      ? `${Math.round(probability * 100)}% of gaps land in the window one ${tier.name} refresh covers; ` +
        `expected gain ${Math.round(ev).toLocaleString()} tokens`
      : `only ${Math.round(probability * 100)}% of gaps land in the window a ${tier.name} refresh covers; ` +
        `expected loss ${Math.abs(Math.round(ev)).toLocaleString()} tokens`,
  };
}

/**
 * Which TTL tier is worth buying for a prefix of this size.
 *
 * The longer tier costs twice the write, so it only wins where the gaps are
 * long enough that the short tier keeps missing. Returns null when neither tier
 * pays, which is a real answer and the one a default-on product never gives.
 */
export function ttlTier({ prefixTokens, gaps, turnsPerSession = DEFAULT_TURNS }) {
  if (!prefixTokens || !gaps) return null;

  // Expected cost of a turn under each tier, as a multiple of what the prefix
  // would cost uncached. A hit costs a read; a miss pays the tier's write
  // again; and the FIRST write is amortised over the session, which is what
  // stops the expensive tier from looking free whenever gaps are short.
  const costOf = (tier) => {
    const hit = gaps.probabilityWithin(tier.ms);
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
    expectedCostPerTurn: Number(best.perTurn.toFixed(3)),
    expectedValue: Math.round((1 - best.perTurn) * prefixTokens),
    reason: `${Math.round(best.hit * 100)}% of gaps land inside ${best.tier.name}; ` +
      `expected cost ${best.perTurn.toFixed(2)}x per turn against 1.00x uncached`,
  };
}

/** Records a refresh so its outcome can be scored. */
export function recordRefresh(dir, { tier, prefixTokens, expectedValue }) {
  record(dir, { kind: 'keepwarm', action: 'refresh', tier, prefixTokens, expectedValue });
}

/**
 * Records whether the refresh was used.
 *
 * `hit` means a real turn arrived before expiry, so the write bought a read.
 */
export function recordRefreshOutcome(dir, { tier, prefixTokens, hit }) {
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
  record(dir, { kind: 'keepwarm', action: 'outcome', tier, prefixTokens, hit: Boolean(hit), realised: Math.round(realised) });
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

  const gaps = gapDistribution(dir, { events });
  const best = ttlTier({ prefixTokens, gaps });
  if (!best) {
    // THE TWO MODELS ANSWER DIFFERENT QUESTIONS, so they may legitimately disagree. ttlTier asks
    // whether holding a cache beats not caching at all; keepWarmDecision asks whether ONE ping
    // beats letting the entry lapse -- and a ping can pay where no tier does. Coercing everything
    // that was not 'unknown' to 'skip' while keeping the decision's reason verbatim produced a
    // refusal justified by a GAIN: `{ action: 'skip', reason: '...expected gain 130 tokens' }`.
    // This module's own docstring says a refusal that cannot be checked is indistinguishable from
    // a bug; one that contradicts itself is worse.
    const decision = keepWarmDecision({ prefixTokens, gaps });
    if (decision.action === 'refresh') return decision;
    return { action: decision.action === 'unknown' ? 'unknown' : 'skip', reason: decision.reason };
  }
  return best;
}
