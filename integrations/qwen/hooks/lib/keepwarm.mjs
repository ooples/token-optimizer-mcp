// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/keepwarm.mjs. Regenerate with `npm run sync:hooks`.
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

import { record, readMetrics } from './metrics.mjs';
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
  const stamps = events.map((e) => e.at).filter(Number.isFinite).sort((a, b) => a - b);
  if (stamps.length < 8) return null;

  const gaps = [];
  for (let i = 1; i < stamps.length; i++) {
    const gap = stamps[i] - stamps[i - 1];
    // A burst of events inside one turn is not a gap between turns.
    if (gap > 250) gaps.push(gap);
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
    const turns = Math.max(1, turnsPerSession);
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
  const realised = hit
    ? prefixTokens * (1 - READ_MULTIPLIER) - prefixTokens * (tierSpec.writeMultiplier - 1)
    : -prefixTokens * (tierSpec.writeMultiplier - 1);
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
export function tripwire(dir, { events = readMetrics(dir) } = {}) {
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
export function shouldKeepWarm(dir, { prefixTokens, events = readMetrics(dir) } = {}) {
  const trip = tripwire(dir, { events });
  if (trip.tripped) return { action: 'skip', reason: trip.reason, trippedWire: true };

  const gaps = gapDistribution(dir, { events });
  const best = ttlTier({ prefixTokens, gaps });
  if (!best) {
    const decision = keepWarmDecision({ prefixTokens, gaps });
    return { action: decision.action === 'unknown' ? 'unknown' : 'skip', reason: decision.reason };
  }
  return best;
}
