/**
 * Optional cost equivalents for token measurements.
 *
 * The runtime cannot infer a user's bill from a client name. A CLI may route
 * through a subscription, direct API account, cloud marketplace, enterprise
 * agreement, included credits, or a provider whose cache-read/write prices
 * differ. Provider usage records are the source of truth when available.
 * Everywhere else this module fails closed until the user supplies an
 * effective blended input-token rate.
 */

const RATE_ENV = 'TOKEN_OPTIMIZER_EFFECTIVE_INPUT_USD_PER_MILLION';

/** The configured effective input rate, or null when billing is unobservable. */
export function effectiveRate() {
  const rate = Number(process.env[RATE_ENV]);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

/**
 * Dollars for a measured token quantity.
 *
 * `kind` is accepted for backwards compatibility but is not multiplied by a
 * universal cache constant. The configured rate must already reflect the
 * user's actual provider/model/cache/tier/credit mix.
 */
export function dollars(tokens, { rate = effectiveRate() } = {}) {
  if (!Number.isFinite(tokens) || !Number.isFinite(rate) || rate <= 0) {
    return null;
  }
  return (tokens / 1_000_000) * rate;
}

/** A dollar figure, or an honest absence of one. */
export function money(amount, { unmeasured = 'not priced' } = {}) {
  if (amount == null || !Number.isFinite(amount)) return unmeasured;
  if (amount === 0) return '$0.00';
  if (Math.abs(amount) < 0.01) return '<$0.01';
  return `$${amount.toFixed(2)}`;
}

/** Per-session tokens expressed with a stated monthly-frequency assumption. */
export function monthly(tokensPerSession, { sessionsPerMonth = 60 } = {}) {
  if (!Number.isFinite(tokensPerSession)) return null;
  const amount = dollars(tokensPerSession * sessionsPerMonth);
  return amount == null
    ? null
    : {
        amount,
        sessionsPerMonth,
        effectiveInputUsdPerMillion: effectiveRate(),
      };
}

/** The pricing basis printed beside any cost equivalent. */
export function priceNote() {
  const rate = effectiveRate();
  return rate == null
    ? `cost not priced: set ${RATE_ENV} to your effective blended input rate after provider, model, cache, tier, plan, and credits`
    : `cost equivalent: configured effective input rate $${rate}/M via ${RATE_ENV}`;
}

/** Compatibility surface: no built-in provider table is claimed. */
export function prices() {
  return {
    source:
      effectiveRate() == null ? 'unavailable' : 'configured-effective-rate',
    effectiveInputUsdPerMillion: effectiveRate(),
  };
}
