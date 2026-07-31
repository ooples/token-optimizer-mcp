/**
 * Tokens in the unit people actually feel.
 *
 * The same data as everywhere else in this project, converted once, in one
 * place, under three rules that keep a dollar figure honest:
 *
 *   THE TABLE IS VISIBLE AND OVERRIDABLE. Prices change. A figure computed from
 *   rates buried in code goes stale silently and keeps looking authoritative,
 *   which is worse than no figure. The rates are printed next to the number and
 *   can be replaced without a release.
 *
 *   DOLLARS BESIDE TOKENS, NOT INSTEAD OF THEM. The token count is exact and
 *   never goes out of date; the dollar figure is the token count times a rate
 *   that will. Showing both means the durable number survives the perishable
 *   one.
 *
 *   NEVER A PRICE ON AN UNMEASURED SAVING. An invented number is worse in
 *   dollars than in tokens, because dollars get quoted to other people. A
 *   saving we cannot measure returns null and renders as "not yet measurable",
 *   never as "$0.00" -- which reads as "saved nothing" and is a different
 *   claim entirely.
 */

/** Cache multipliers, relative to an input token. */
const CACHE_WRITE = 1.25;
const CACHE_READ = 0.1;

/**
 * Dollars per million tokens, by tier.
 *
 * Approximate published list rates as of 2026-07, carried with their date so a
 * stale table is visible rather than silent. Override wholesale with
 * TOKEN_OPTIMIZER_PRICES as JSON, e.g.
 * {"asOf":"2026-09","opus":{"input":15,"output":75}}.
 */
const DEFAULT_PRICES = {
  asOf: '2026-07',
  haiku: { input: 1, output: 5 },
  sonnet: { input: 3, output: 15 },
  opus: { input: 15, output: 75 },
};

export function prices() {
  const raw = process.env.TOKEN_OPTIMIZER_PRICES;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return { ...DEFAULT_PRICES, ...parsed, overridden: true };
    } catch { /* an unparseable override is ignored rather than fatal */ }
  }
  return DEFAULT_PRICES;
}

/**
 * What a number of tokens costs.
 *
 * Returns null for a null input and says why: this is the single place the
 * "unmeasured must not become $0.00" rule is enforced, so every caller inherits
 * it rather than each remembering.
 */
export function dollars(tokens, { tier = 'opus', kind = 'input' } = {}) {
  if (!Number.isFinite(tokens)) return null;

  const table = prices();
  const rate = table[tier]?.[kind === 'output' ? 'output' : 'input'];
  if (!Number.isFinite(rate)) return null;

  const multiplier = kind === 'cacheWrite' ? CACHE_WRITE : kind === 'cacheRead' ? CACHE_READ : 1;
  return (tokens / 1_000_000) * rate * multiplier;
}

/** A dollar figure, or an honest absence of one. */
export function money(amount, { unmeasured = 'not yet measurable' } = {}) {
  if (amount == null || !Number.isFinite(amount)) return unmeasured;
  if (amount === 0) return '$0.00';
  if (Math.abs(amount) < 0.01) return '<$0.01';
  return `$${amount.toFixed(2)}`;
}

/**
 * Per-session tokens expressed as a monthly cost.
 *
 * `sessionsPerMonth` is an assumption, so it is stated in the output rather
 * than folded invisibly into the number.
 */
export function monthly(tokensPerSession, { tier = 'opus', sessionsPerMonth = 60 } = {}) {
  if (!Number.isFinite(tokensPerSession)) return null;
  const amount = dollars(tokensPerSession * sessionsPerMonth, { tier });
  return amount == null ? null : { amount, sessionsPerMonth, tier };
}

/** The rates behind the figures, for printing beside them. */
export function priceNote(tier = 'opus') {
  const table = prices();
  const rate = table[tier];
  if (!rate) return null;
  return `prices: ${tier} $${rate.input}/$${rate.output} per Mtok (${table.asOf}` +
    `${table.overridden ? ', overridden' : ''}); override with TOKEN_OPTIMIZER_PRICES`;
}
