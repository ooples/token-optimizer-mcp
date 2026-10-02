/**
 * The provenance gate for the OTHER input: what the proxy saved on the wire.
 *
 * WHY A SECOND GATE AND NOT THE EXISTING ONE. `savings-classification.ts`
 * decides whether an MCP tool row proves a saving, and the evidence it looks
 * for is two materialized payloads with matching hashes. A proxy request has
 * entirely different evidence available, and more of it:
 *
 *   - the exact byte length of the body we were given and the one we sent,
 *     because we held both in memory at the same instant;
 *   - our own token count of both of those bodies under a named encoder;
 *   - the provider's billed prompt count for the body we actually sent.
 *
 * That last one is the part no other surface in this product has. Nobody will
 * ever bill us for a request we chose not to make, so the before-side can only
 * ever be a local estimate -- but the after-side is counted twice, once by us
 * and once by the party sending the invoice, and the two can be compared on
 * every single request for free. A systematic error in our encoder shows up as
 * a systematic gap between those two columns, which makes this the only savings
 * claim in the product that carries its own calibration.
 *
 * ONLY A 2xx PROVES A BILL. A request that failed in transport was never
 * delivered, and a 4xx or 429 is generally not charged -- so a token delta on
 * one of those rows is a counterfactual about a request nobody paid for either
 * way. Those rows are counted and named, never folded into a saving. This is a
 * strictly harder gate than the MCP path applies, and it is affordable here
 * precisely because the status is on the row.
 *
 * A REFUSAL IS NAMED, NEVER A ZERO -- the same rule the ledger writer follows.
 * Every row lands in exactly one class, and the classes that cannot support a
 * claim say which one they are rather than contributing nothing silently.
 */

import type { AccountingRecord, RequestUsage } from '../proxy/accounting.js';
import { priceTokenUsage, type PriceCurrency } from './provider-pricing.js';

/**
 * Version 1 is the first proxy ledger line that carries a token count at all.
 * Rows written before it are retained and classified `uncounted`, because a
 * ledger whose older half silently vanished would make the proxy look as
 * though it had only just started working.
 */
export const PROXY_MEASUREMENT_SCHEMA_VERSION = 1;

export const PROXY_SAVINGS = Object.freeze({
  /** Counted both sides, request billed, and the provider's count to check it. */
  CalibratedReduction: 'verified-wire-reduction-provider-calibrated',
  /** Counted both sides and billed, but the response reported no usage. */
  Reduction: 'verified-wire-reduction',
  /** We made the request bigger -- an injected knowledge block, usually. */
  ExpansionDebit: 'verified-wire-expansion-debit',
  /** Counted, billed, and identical: a pass-through, not a failure. */
  NoChange: 'counted-no-change',
  /** Not a 2xx: nothing was charged for either body, so nothing was saved. */
  Unbilled: 'unbilled-request',
  /** The row carries no token count; `tokens.reason` says why. */
  Uncounted: 'uncounted-request',
} as const);

export type ProxySavingsClassification =
  (typeof PROXY_SAVINGS)[keyof typeof PROXY_SAVINGS];

function whole(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/**
 * What the provider says the prompt we sent cost it, or null.
 *
 * THE TWO DIALECTS COUNT CACHING OPPOSITELY, and getting this wrong does not
 * produce a slightly-off number -- it discredits the instrument. Anthropic
 * reports `input_tokens` EXCLUSIVE of cache reads and cache writes, which are
 * their own fields; a cache-heavy turn can bill 150,000 read tokens and report
 * `input_tokens: 4`. Comparing our count of that body against the 4 would say
 * our encoder read four orders of magnitude high. The Responses dialect does
 * the reverse: `input_tokens` already INCLUDES the cached subset that
 * `cached_input_tokens` reports separately, so adding them double-counts.
 *
 * The presence of the exclusive fields is what distinguishes them, which is
 * the same signal `mergeUsage` uses when it keeps the two sets apart instead
 * of normalising them into one.
 */
export function billedPromptTokens(usage: RequestUsage): number | null {
  const input = whole(usage.input_tokens);
  if (input === null) return null;
  const creation = whole(usage.cache_creation_input_tokens);
  const read = whole(usage.cache_read_input_tokens);
  if (creation !== null || read !== null)
    return input + (creation ?? 0) + (read ?? 0);
  return input;
}

/** Whether the provider accepted and charged for this request. */
export function wasBilled(record: AccountingRecord): boolean {
  if (typeof record.transportError === 'string') return false;
  return record.status >= 200 && record.status < 300;
}

export function classifyProxySavings(
  record: AccountingRecord
): ProxySavingsClassification {
  // STATUS BEFORE COUNTS, because an uncounted row that was never billed is
  // not a measurement failure -- there was nothing there to measure. Reporting
  // it as one would put the proxy's own 429s in a column labelled "we could
  // not count this".
  if (!wasBilled(record)) return PROXY_SAVINGS.Unbilled;
  const tokens = record.tokens;
  if (tokens === undefined || !tokens.measured) return PROXY_SAVINGS.Uncounted;
  const before = whole(tokens.beforeTokens);
  const after = whole(tokens.afterTokens);
  if (before === null || after === null) return PROXY_SAVINGS.Uncounted;
  if (after > before) return PROXY_SAVINGS.ExpansionDebit;
  if (after === before) return PROXY_SAVINGS.NoChange;
  // A DEFERRED ROW IS A REDUCTION WE DO NOT CALIBRATE, and the reason is a bias
  // with a known direction rather than a doubt. The search tool the proxy
  // prepends when it defers is a two-field stub that the provider expands into
  // a full schema server-side, so the prompt the provider billed contains bytes
  // that were never in the body we counted. Our side therefore reads low by one
  // schema on exactly these rows, and a calibration column is worth having only
  // while every gap in it is encoder disagreement. The deferral holdout
  // measures these rows from the provider's own usage instead.
  if (record.deferredTools) return PROXY_SAVINGS.Reduction;
  return billedPromptTokens(record.usage) === null
    ? PROXY_SAVINGS.Reduction
    : PROXY_SAVINGS.CalibratedReduction;
}

/** Signed contribution to prompt tokens avoided on the wire. */
export function proxyTransportDelta(record: AccountingRecord): number {
  const classification = classifyProxySavings(record);
  if (
    classification !== PROXY_SAVINGS.CalibratedReduction &&
    classification !== PROXY_SAVINGS.Reduction &&
    classification !== PROXY_SAVINGS.ExpansionDebit
  ) {
    return 0;
  }
  const tokens = record.tokens;
  if (tokens === undefined || !tokens.measured) return 0;
  return tokens.beforeTokens - tokens.afterTokens;
}

/** The prompt size the request would have had, in tokens, or 0. */
export function proxyTokensBefore(record: AccountingRecord): number {
  const tokens = record.tokens;
  if (tokens === undefined || !tokens.measured) return 0;
  return proxyTransportDelta(record) === 0 ? 0 : tokens.beforeTokens;
}

/**
 * Our count of the body we sent against the provider's count of the same body.
 *
 * THE INSTRUMENT MEASURING ITSELF. Both numbers describe one identical byte
 * sequence, so any gap between them is encoder disagreement and nothing else:
 * there is no sampling, no modelling and no assumption in it. That is a claim
 * about the rows this admits, and it is why it admits so few: a request whose
 * tools were deferred is billed for a prompt the provider assembled, holding a
 * search schema we never sent and omitting the schemas we did, so its gap is
 * not encoder disagreement and `classifyProxySavings` keeps it out. Summed over a
 * window it is the answer to "how far should I trust the column next to this
 * one", which is a question no other savings surface in this product can
 * answer at all.
 *
 * RETURNED AS A PAIR, NOT A RATIO. A ratio from one request is noise, and a
 * mean of per-request ratios weights a 300-token request the same as a
 * 300,000-token one. The caller sums the two sides and divides once.
 */
export function proxyCalibration(
  record: AccountingRecord
): { readonly ours: number; readonly billed: number } | null {
  if (classifyProxySavings(record) !== PROXY_SAVINGS.CalibratedReduction)
    return null;
  const tokens = record.tokens;
  if (tokens === undefined || !tokens.measured) return null;
  const billed = billedPromptTokens(record.usage);
  if (billed === null) return null;
  return Object.freeze({ ours: tokens.afterTokens, billed });
}

/** One side of the request, priced as immediate uncached input. */
function priceSide(
  record: AccountingRecord,
  promptTokens: number
): number | null {
  const priced = priceTokenUsage({
    model: record.model ?? null,
    timestamp: record.ts,
    usage: { uncachedInputTokens: promptTokens },
  });
  const usd: PriceCurrency = 'USD';
  if (!priced.available || priced.currency !== usd || priced.amount === null)
    return null;
  return priced.amount;
}

/**
 * What the saving on one request was worth, or null.
 *
 * EACH SIDE IS PRICED AS A WHOLE PROMPT AND THE PRICES ARE SUBTRACTED, rather
 * than pricing the delta on its own. The unit is identical -- one immediate
 * uncached-input equivalent, the same definition `priceVerifiedDelta` uses for
 * the MCP path -- but provider prices are TIERED on prompt length, and the
 * delta is not a prompt. Pricing 50,000 saved tokens in isolation prices them
 * at the short-context rate even when the request they came out of was 250,000
 * tokens long and billed at the long-context one, which understates the
 * saving; and when compression carries a request back across that threshold,
 * the tier change IS part of what was saved and only this form captures it.
 *
 * NULL IS NOT ZERO. A model with no exact catalog entry -- and a row with no
 * model at all, which is every row a pass-through path wrote -- has an unknown
 * price, not a free one.
 */
export function priceProxyDelta(record: AccountingRecord): number | null {
  const delta = proxyTransportDelta(record);
  if (delta === 0) return null;
  const tokens = record.tokens;
  if (tokens === undefined || !tokens.measured) return null;
  const before = priceSide(record, tokens.beforeTokens);
  const after = priceSide(record, tokens.afterTokens);
  if (before === null || after === null) return null;
  return before - after;
}
