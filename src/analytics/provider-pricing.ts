/**
 * Versioned provider/model token prices.
 *
 * Prices are intentionally request-time contracts, not one global multiplier:
 * uncached input, cache reads, cache writes, and output are distinct billable
 * dimensions.  A catalog match is exact (or an explicitly documented alias),
 * and every result carries the source and effective date used to compute it.
 */

import { operatorPriceContracts } from './operator-prices.js';

export type PriceCurrency = 'USD' | 'CNY';

export interface TokenUsageDimensions {
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheWrite5mInputTokens: number;
  cacheWrite1hInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
}

export interface TokenPriceTier {
  maxInputTokens?: number;
  uncachedInput: number;
  cachedInput: number;
  cacheWrite5m: number | null;
  cacheWrite1h: number | null;
  cacheWrite: number | null;
  output: number;
}

/**
 * A price list with no tier prices nothing, so the type makes that
 * unrepresentable: every contract carries at least one tier, and the tier
 * lookup therefore never has to invent one for an empty list.
 */
export type NonEmptyTiers = readonly [TokenPriceTier, ...TokenPriceTier[]];

export interface ModelPriceContract {
  provider: string;
  route: string;
  model: string;
  aliases: readonly string[];
  currency: PriceCurrency;
  verifiedAt: string;
  effectiveFrom?: string;
  effectiveTo?: string;
  sourceUrl: string;
  sourceLabel: string;
  tiers: NonEmptyTiers;
}

export interface PricedTokenUsage {
  available: boolean;
  provider: string;
  route: string;
  requestedModel: string | null;
  resolvedModel: string | null;
  currency: PriceCurrency | null;
  amount: number | null;
  ratesPerMillion: TokenPriceTier | null;
  usage: TokenUsageDimensions;
  breakdown: {
    uncachedInput: number;
    cachedInput: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
    cacheWrite: number;
    output: number;
  } | null;
  sourceUrl: string | null;
  sourceLabel: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  verifiedAt: string | null;
  reason: string | null;
}

// Every current OpenAI model has its own page at a uniform path, and each one
// states that model's four rates plus the long-context and cache-write rules in
// prose. Deriving the URL from the id keeps the citation specific to the model
// whose price it justifies, rather than pointing every row at one index page.
const OPENAI_MODEL_SOURCE = 'https://developers.openai.com/api/docs/models/';
const ANTHROPIC_SOURCE =
  'https://platform.claude.com/docs/en/about-claude/pricing';
const GEMINI_SOURCE = 'https://ai.google.dev/gemini-api/docs/pricing';
const COPILOT_SOURCE =
  'https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing';
// Verified against the live pricing pages, model by model, on this date. It is
// deliberately separate from the older stamp: a row is only restamped when it
// was actually re-read, so a stale rate cannot hide behind a fresh date.
const VERIFIED_AT = '2026-10-01T00:00:00.000Z';
// Google publishes a dated step for the 3.6/3.7/3.8 Flash family -- one price
// "through December 31, 2026" and a higher one "starting January 1, 2027". That
// is what an effective window is for: a change the vendor has committed to in
// writing, as opposed to one we assumed would happen.
const GEMINI_2027_STEP = '2027-01-01T00:00:00.000Z';

const openAiTier = (
  input: number,
  cached: number,
  output: number,
  options: {
    readonly maxInputTokens?: number | null;
    readonly cacheWrites?: boolean;
  } = {}
): NonEmptyTiers => {
  // THE RULE, IN THE VENDOR'S OWN WORDS, identical on every current model page:
  // "Prompts with more than 272K input tokens are priced at 2x input and cache
  // rates and 1.5x output for the full request. Cache writes are billed at
  // 1.25x the uncached input token rate."
  //
  // The threshold is a parameter because the resold Copilot route publishes its
  // own (200K on GPT-5.6 Luna, where the first-party page says 272K), and null
  // means that price list publishes no long-context tier at all -- which is a
  // different fact from publishing one we do not know.
  const writes = options.cacheWrites ?? true;
  const write = (rate: number): number | null => (writes ? rate * 1.25 : null);
  const standard: TokenPriceTier = {
    uncachedInput: input,
    cachedInput: cached,
    cacheWrite5m: write(input),
    cacheWrite1h: write(input),
    cacheWrite: write(input),
    output,
  };
  const threshold =
    options.maxInputTokens === undefined ? 272_000 : options.maxInputTokens;
  if (threshold === null) return [standard];
  return [
    { ...standard, maxInputTokens: threshold },
    {
      uncachedInput: input * 2,
      cachedInput: cached * 2,
      cacheWrite5m: write(input * 2),
      cacheWrite1h: write(input * 2),
      cacheWrite: write(input * 2),
      output: output * 1.5,
    },
  ];
};

const anthropicTier = (
  input: number,
  output: number,
  // THE MULTIPLIER TABLE ON THE PRICING PAGE, verbatim: a cache read is "0.1x
  // base input price (0.025x on Claude Fable 5.1 and Claude Mythos 5.1; 0.05x
  // on Claude Opus 5.5)". Writes have no such exception -- 1.25x for five
  // minutes and 2x for an hour hold for every model listed.
  cacheRead = 0.1
): NonEmptyTiers => [
  {
    uncachedInput: input,
    cachedInput: input * cacheRead,
    cacheWrite5m: input * 1.25,
    cacheWrite1h: input * 2,
    cacheWrite: input * 1.25,
    output,
  },
];

// Resold Claude capacity publishes ONE cache-write rate, not the two Anthropic
// prices directly, so a 1h write is quoted at the same 1.25x as a 5m write
// rather than at Anthropic's 2x. The cache-read rate is taken from the column
// instead of multiplied out, because the page prints it per model.
const copilotClaudeTier = (
  input: number,
  cacheRead: number,
  output: number
): NonEmptyTiers => [
  {
    uncachedInput: input,
    cachedInput: cacheRead,
    cacheWrite5m: input * 1.25,
    cacheWrite1h: input * 1.25,
    cacheWrite: input * 1.25,
    output,
  },
];

// Resold Gemini capacity. The cache-write column on this price list reads
// "Not applicable" for every Gemini row, which is not the same fact as the
// first-party zero: there, a write genuinely costs nothing because caching is
// implicit. Here the rate is simply not published, so all three write fields
// are null and a cache-write dimension on this route stays unpriced.
const resoldGeminiTier = (
  input: number,
  cached: number,
  output: number
): NonEmptyTiers => [
  {
    uncachedInput: input,
    cachedInput: cached,
    cacheWrite5m: null,
    cacheWrite1h: null,
    cacheWrite: null,
    output,
  },
];

const geminiTier = (
  input: number,
  cached: number,
  output: number
): NonEmptyTiers => [
  {
    uncachedInput: input,
    cachedInput: cached,
    // Gemini reports cached reads in generation usage. Explicit cache storage
    // is a separate time-based charge and is not invented when unobserved.
    cacheWrite5m: 0,
    cacheWrite1h: null,
    cacheWrite: null,
    output,
  },
];

interface OpenAiRow {
  readonly model: string;
  readonly input: number;
  readonly cached: number;
  readonly output: number;
  readonly maxInputTokens?: number | null;
  readonly cacheWrites?: boolean;
}

interface AnthropicRow {
  readonly model: string;
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
}

/**
 * Prices read off each vendor's own page, model by model, on VERIFIED_AT.
 *
 * NO FALLBACK ROW. A model absent from this list is reported as unpriced, never
 * charged at some default rate: an absent number can be chased, a fabricated
 * one is indistinguishable from a measured one in the same column.
 *
 * NO ASSUMED FUTURE EITHER. An effective window is only written when the vendor
 * has published the change. Two rows here previously encoded a scheduled
 * increase that was then cancelled, which silently billed every request on
 * those models 50% high -- the reverse of the error everyone expects.
 */
export const MODEL_PRICE_CATALOG: readonly ModelPriceContract[] = [
  ...(
    [
      // The GPT-6 generation, each from its own model page.
      { model: 'gpt-6-astra', input: 10, cached: 1, output: 50 },
      { model: 'gpt-6.1-sol', input: 2, cached: 0.1, output: 10 },
      { model: 'gpt-6-luna', input: 0.1, cached: 0.01, output: 0.5 },
      // The GPT-5.6 generation, previously carried here at $5/$0.50/$30,
      // $2.50/$0.25/$15 and $1/$0.10/$6 -- the rates from before a reduction
      // the model pages now describe as "a 20% reduction in input pricing and
      // a 33% reduction in output pricing". No end date is written for it: the
      // page says the lower price runs "at least through November 21, 2026",
      // and an effectiveTo would quietly revert to a figure nobody is charged.
      { model: 'gpt-5.6-sol', input: 4, cached: 0.4, output: 20 },
      { model: 'gpt-5.6-terra', input: 2, cached: 0.2, output: 12 },
      { model: 'gpt-5.6-luna', input: 0.2, cached: 0.02, output: 1.2 },
    ] satisfies readonly OpenAiRow[]
  ).map(
    (row): ModelPriceContract => ({
      provider: 'openai',
      route: 'openai-api',
      model: row.model,
      aliases: [],
      currency: 'USD',
      verifiedAt: VERIFIED_AT,
      sourceUrl: OPENAI_MODEL_SOURCE + row.model,
      sourceLabel: 'OpenAI API price',
      tiers: openAiTier(row.input, row.cached, row.output),
    })
  ),
  ...(
    [
      { model: 'claude-fable-5-1', input: 10, output: 50, cacheRead: 0.025 },
      { model: 'claude-mythos-5-1', input: 10, output: 50, cacheRead: 0.025 },
      { model: 'claude-opus-5-5', input: 4, output: 20, cacheRead: 0.05 },
      { model: 'claude-sonnet-5-5', input: 2, output: 10 },
      { model: 'claude-haiku-4-5', input: 1, output: 5 },
      { model: 'claude-fable-5', input: 10, output: 50 },
      { model: 'claude-mythos-5', input: 10, output: 50 },
      { model: 'claude-opus-5', input: 5, output: 25 },
      { model: 'claude-opus-4-8', input: 5, output: 25 },
      { model: 'claude-opus-4-7', input: 5, output: 25 },
      { model: 'claude-opus-4-6', input: 5, output: 25 },
      { model: 'claude-opus-4-5', input: 5, output: 25 },
      { model: 'claude-opus-4-1', input: 15, output: 75 },
      { model: 'claude-opus-4', input: 15, output: 75 },
      // ONE ROW, NOT TWO. This model used to carry a window that ended on
      // 2026-09-01 and handed over to a $3/$15 "standard" rate. The pricing
      // page now states the opposite in a footnote: the $2/$10 price
      // "announced at launch as introductory pricing through August 31, 2026,
      // is now the standard price. The previously scheduled increase to $3/$15
      // per million input/output tokens on September 1, 2026 will not occur."
      { model: 'claude-sonnet-5', input: 2, output: 10 },
      { model: 'claude-sonnet-4-6', input: 3, output: 15 },
      { model: 'claude-sonnet-4-5', input: 3, output: 15 },
      { model: 'claude-sonnet-4', input: 3, output: 15 },
      { model: 'claude-haiku-3-5', input: 0.8, output: 4 },
    ] satisfies readonly AnthropicRow[]
  ).map(
    (row): ModelPriceContract => ({
      provider: 'anthropic',
      route: 'anthropic-api',
      model: row.model,
      aliases: [],
      currency: 'USD',
      verifiedAt: VERIFIED_AT,
      sourceUrl: ANTHROPIC_SOURCE,
      sourceLabel: 'Anthropic API price',
      tiers: anthropicTier(row.input, row.output, row.cacheRead),
    })
  ),
  ...[
    { model: 'gemini-3.5-flash', input: 1.5, cached: 0.15, output: 9 },
    { model: 'gemini-3.5-flash-lite', input: 0.3, cached: 0.03, output: 2.5 },
    { model: 'gemini-2.5-flash', input: 0.3, cached: 0.03, output: 2.5 },
    { model: 'gemini-2.5-flash-lite', input: 0.1, cached: 0.01, output: 0.4 },
  ].map(
    (row): ModelPriceContract => ({
      provider: 'google',
      route: 'gemini-api',
      model: row.model,
      aliases: [],
      currency: 'USD',
      verifiedAt: VERIFIED_AT,
      sourceUrl: GEMINI_SOURCE,
      sourceLabel: 'Gemini Developer API standard price',
      tiers: geminiTier(row.input, row.cached, row.output),
    })
  ),
  ...['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash'].flatMap(
    (model): readonly ModelPriceContract[] => {
      const shared = {
        provider: 'google',
        route: 'gemini-api',
        model,
        aliases: [] as readonly string[],
        currency: 'USD' as PriceCurrency,
        verifiedAt: VERIFIED_AT,
        sourceUrl: GEMINI_SOURCE,
      };
      return [
        {
          ...shared,
          effectiveTo: GEMINI_2027_STEP,
          sourceLabel: 'Gemini Developer API price through 2026-12-31',
          tiers: geminiTier(0.75, 0.075, 3.75),
        },
        {
          ...shared,
          effectiveFrom: GEMINI_2027_STEP,
          sourceLabel: 'Gemini Developer API price from 2027-01-01',
          tiers: geminiTier(1.5, 0.15, 7.5),
        },
      ];
    }
  ),
  ...(
    [
      // Resold OpenAI capacity. The rates are GitHub's own, and they are not
      // always the first-party ones: GPT-5.6 Luna's long-context threshold is
      // 200K here where OpenAI's page says 272K, and the older models publish
      // no cache-write rate at all ("Not applicable" in the column).
      {
        model: 'gpt-5-mini',
        input: 0.25,
        cached: 0.025,
        output: 2,
        maxInputTokens: null,
        cacheWrites: false,
      },
      {
        model: 'gpt-5.3-codex',
        input: 1.75,
        cached: 0.175,
        output: 14,
        maxInputTokens: null,
        cacheWrites: false,
      },
      {
        model: 'gpt-5.4',
        input: 2.5,
        cached: 0.25,
        output: 15,
        cacheWrites: false,
      },
      {
        model: 'gpt-5.4-mini',
        input: 0.75,
        cached: 0.075,
        output: 4.5,
        maxInputTokens: null,
        cacheWrites: false,
      },
      {
        model: 'gpt-5.4-nano',
        input: 0.2,
        cached: 0.02,
        output: 1.25,
        maxInputTokens: null,
        cacheWrites: false,
      },
      {
        model: 'gpt-5.5',
        input: 5,
        cached: 0.5,
        output: 30,
        cacheWrites: false,
      },
      {
        model: 'gpt-5.6-luna',
        input: 0.2,
        cached: 0.02,
        output: 1.2,
        maxInputTokens: 200_000,
      },
      { model: 'gpt-5.6-sol', input: 4, cached: 0.4, output: 20 },
      { model: 'gpt-5.6-terra', input: 2, cached: 0.2, output: 12 },
      { model: 'gpt-6-astra', input: 10, cached: 1, output: 50 },
      { model: 'gpt-6-luna', input: 0.1, cached: 0.01, output: 0.5 },
      { model: 'gpt-6-sol', input: 2, cached: 0.2, output: 10 },
      { model: 'gpt-6.1-sol', input: 2, cached: 0.1, output: 10 },
    ] satisfies readonly OpenAiRow[]
  ).map(
    (row): ModelPriceContract => ({
      provider: 'github',
      route: 'github-copilot',
      model: row.model,
      aliases: [],
      currency: 'USD',
      verifiedAt: VERIFIED_AT,
      sourceUrl: COPILOT_SOURCE,
      sourceLabel: 'GitHub Copilot AI-credit token price',
      tiers: openAiTier(row.input, row.cached, row.output, {
        maxInputTokens: row.maxInputTokens,
        cacheWrites: row.cacheWrites,
      }),
    })
  ),
  ...[
    // Resold Claude capacity. The previous entry here priced claude-sonnet-5
    // only until 2026-09-01 and called it promotional, which left the model
    // unpriced on this route from that date on; GitHub still lists it at
    // $2/$0.20/$2.50/$10 with no end date.
    { model: 'claude-fable-5-1', input: 10, cacheRead: 0.25, output: 50 },
    { model: 'claude-fable-5', input: 10, cacheRead: 1, output: 50 },
    { model: 'claude-opus-5-5', input: 4, cacheRead: 0.2, output: 20 },
    { model: 'claude-opus-5', input: 5, cacheRead: 0.5, output: 25 },
    { model: 'claude-opus-4-8', input: 5, cacheRead: 0.5, output: 25 },
    { model: 'claude-opus-4-7', input: 5, cacheRead: 0.5, output: 25 },
    { model: 'claude-sonnet-5-5', input: 2, cacheRead: 0.2, output: 10 },
    { model: 'claude-sonnet-5', input: 2, cacheRead: 0.2, output: 10 },
    { model: 'claude-sonnet-4-6', input: 3, cacheRead: 0.3, output: 15 },
    { model: 'claude-sonnet-4', input: 3, cacheRead: 0.3, output: 15 },
    { model: 'claude-haiku-4-5', input: 1, cacheRead: 0.1, output: 5 },
  ].map(
    (row): ModelPriceContract => ({
      provider: 'github',
      route: 'github-copilot',
      model: row.model,
      aliases: [],
      currency: 'USD',
      verifiedAt: VERIFIED_AT,
      sourceUrl: COPILOT_SOURCE,
      sourceLabel: 'GitHub Copilot AI-credit token price',
      tiers: copilotClaudeTier(row.input, row.cacheRead, row.output),
    })
  ),
  ...[
    { model: 'gemini-3.8-flash', input: 0.75, cached: 0.075, output: 3.75 },
    { model: 'gemini-3.7-flash', input: 0.75, cached: 0.075, output: 3.75 },
    { model: 'gemini-3.6-flash', input: 0.75, cached: 0.075, output: 3.75 },
    { model: 'gemini-3.5-flash', input: 1.5, cached: 0.15, output: 9 },
  ].map(
    (row): ModelPriceContract => ({
      provider: 'github',
      route: 'github-copilot',
      model: row.model,
      aliases: [],
      currency: 'USD',
      verifiedAt: VERIFIED_AT,
      sourceUrl: COPILOT_SOURCE,
      sourceLabel: 'GitHub Copilot AI-credit token price',
      tiers: resoldGeminiTier(row.input, row.cached, row.output),
    })
  ),
  // NOT LISTED HERE, deliberately: the Grok, Kimi and MAI models the same page
  // prices. Their rates are published, but the identifier a client would send
  // for them is not, and a catalog keyed on a guessed id prices nothing while
  // looking as though it covers something.
];

function nonnegative(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function normalizeUsageDimensions(
  usage: Partial<TokenUsageDimensions> = {}
): TokenUsageDimensions {
  return {
    uncachedInputTokens: nonnegative(usage.uncachedInputTokens),
    cachedInputTokens: nonnegative(usage.cachedInputTokens),
    cacheWrite5mInputTokens: nonnegative(usage.cacheWrite5mInputTokens),
    cacheWrite1hInputTokens: nonnegative(usage.cacheWrite1hInputTokens),
    cacheWriteInputTokens: nonnegative(usage.cacheWriteInputTokens),
    outputTokens: nonnegative(usage.outputTokens),
  };
}

export function inferProviderRoute(
  client: string | null | undefined,
  model: string | null | undefined,
  provider?: string | null
): { provider: string; route: string } {
  const clientKey = String(client || '').toLowerCase();
  const modelKey = String(model || '').toLowerCase();
  if (clientKey.includes('copilot'))
    return { provider: 'github', route: 'github-copilot' };
  const explicit = String(provider || '').toLowerCase();
  // A gateway is named, never inferred from the model. OrcaRouter resells many vendors behind one
  // endpoint, so its models keep a `vendor/model` namespace -- but so do several other gateways, and
  // reading a namespace as "this went through OrcaRouter" would attribute one company's traffic to
  // another. The billing route is only OrcaRouter when the provider says so.
  if (explicit.includes('orcarouter'))
    return { provider: 'orcarouter', route: 'orcarouter-api' };
  if (explicit.includes('openai'))
    return { provider: 'openai', route: 'openai-api' };
  if (explicit.includes('anthropic'))
    return { provider: 'anthropic', route: 'anthropic-api' };
  if (explicit.includes('google'))
    return { provider: 'google', route: 'gemini-api' };
  if (explicit.includes('alibaba') || explicit.includes('dashscope'))
    return { provider: 'alibaba', route: 'dashscope-api' };
  if (/^(gpt-|o\d|chatgpt-)/.test(modelKey))
    return { provider: 'openai', route: 'openai-api' };
  if (modelKey.startsWith('claude-'))
    return { provider: 'anthropic', route: 'anthropic-api' };
  if (modelKey.startsWith('gemini-'))
    return { provider: 'google', route: 'gemini-api' };
  if (modelKey.startsWith('qwen'))
    return { provider: 'alibaba', route: 'dashscope-api' };
  return { provider: explicit || 'unknown', route: 'unknown' };
}

/**
 * Every contract in force for this process: the operator's own table first,
 * then the shipped catalog.
 *
 * The order is the point. An operator who has written down a rate knows
 * something a public page cannot -- a negotiated discount, a gateway's margin,
 * their own hardware -- so their row wins, and it carries its own source label
 * out to the report so the two are never confused for one another.
 */
function contractsInForce(): readonly ModelPriceContract[] {
  const operator = operatorPriceContracts();
  if (operator.length === 0) return MODEL_PRICE_CATALOG;
  return [...operator, ...MODEL_PRICE_CATALOG];
}

function contractAt(
  route: string,
  model: string,
  timestamp: string
): ModelPriceContract | null {
  const at = Date.parse(timestamp);
  const key = model.toLowerCase();
  return (
    contractsInForce().find((contract) => {
      const begins = contract.effectiveFrom
        ? Date.parse(contract.effectiveFrom)
        : Number.NEGATIVE_INFINITY;
      const ends = contract.effectiveTo
        ? Date.parse(contract.effectiveTo)
        : Number.POSITIVE_INFINITY;
      return (
        contract.route === route &&
        (contract.model === key || contract.aliases.includes(key)) &&
        at >= begins &&
        at < ends
      );
    }) || null
  );
}

function tierFor(
  contract: ModelPriceContract,
  promptTokens: number
): TokenPriceTier {
  // Tiers are ordered by threshold, so the first one the prompt fits under is
  // the one that applies, and an unbounded tier matches everything. Walking the
  // list keeps the last tier in hand for a prompt that overruns every published
  // threshold, which is what a provider charges for it -- and because the type
  // guarantees at least one tier, there is nothing to assert away here.
  const [first] = contract.tiers;
  let last: TokenPriceTier = first;
  for (const tier of contract.tiers) {
    if (
      tier.maxInputTokens === undefined ||
      promptTokens <= tier.maxInputTokens
    ) {
      return tier;
    }
    last = tier;
  }
  return last;
}

function tierInputTokens(usage: TokenUsageDimensions): number {
  // Provider threshold rules apply to the logical prompt length. Cache-write
  // dimensions describe how those input tokens were billed; adding them to
  // uncached/read input a second time can incorrectly push a request over a
  // long-context threshold.
  return (
    usage.uncachedInputTokens +
    usage.cachedInputTokens +
    Math.max(
      usage.cacheWriteInputTokens,
      usage.cacheWrite5mInputTokens + usage.cacheWrite1hInputTokens
    )
  );
}

export function priceTokenUsage(input: {
  client?: string | null;
  provider?: string | null;
  route?: string | null;
  model?: string | null;
  timestamp?: string;
  usage?: Partial<TokenUsageDimensions>;
}): PricedTokenUsage {
  const usage = normalizeUsageDimensions(input.usage);
  const inferred = inferProviderRoute(
    input.client,
    input.model,
    input.provider
  );
  const provider = input.provider || inferred.provider;
  const route = input.route || inferred.route;
  const timestamp = input.timestamp || new Date().toISOString();
  const model = String(input.model || '')
    .trim()
    .toLowerCase();
  const contract = model ? contractAt(route, model, timestamp) : null;
  if (!contract) {
    return {
      available: false,
      provider,
      route,
      requestedModel: input.model || null,
      resolvedModel: null,
      currency: null,
      amount: null,
      ratesPerMillion: null,
      usage,
      breakdown: null,
      sourceUrl: null,
      sourceLabel: 'No exact versioned price contract',
      effectiveFrom: null,
      effectiveTo: null,
      verifiedAt: null,
      reason: model
        ? `No exact ${route} price for model ${model} at ${timestamp}`
        : 'The client did not report a model id',
    };
  }

  const promptTokens = tierInputTokens(usage);
  const tier = tierFor(contract, promptTokens);
  const unsupportedDimension = [
    [usage.cacheWrite5mInputTokens, tier.cacheWrite5m, '5-minute cache writes'],
    [usage.cacheWrite1hInputTokens, tier.cacheWrite1h, '1-hour cache writes'],
    [usage.cacheWriteInputTokens, tier.cacheWrite, 'cache writes'],
  ].find(([tokens, rate]) => Number(tokens) > 0 && rate === null);
  if (unsupportedDimension) {
    return {
      available: false,
      provider: contract.provider,
      route: contract.route,
      requestedModel: input.model || null,
      resolvedModel: contract.model,
      currency: contract.currency,
      amount: null,
      ratesPerMillion: tier,
      usage,
      breakdown: null,
      sourceUrl: contract.sourceUrl,
      sourceLabel: contract.sourceLabel,
      effectiveFrom: contract.effectiveFrom || null,
      effectiveTo: contract.effectiveTo || null,
      verifiedAt: contract.verifiedAt,
      reason: `The official ${contract.route} price source does not define ${unsupportedDimension[2]} for this model`,
    };
  }
  const perMillion = (tokens: number, rate: number | null): number =>
    rate === null ? 0 : (tokens / 1_000_000) * rate;
  const breakdown = {
    uncachedInput: perMillion(usage.uncachedInputTokens, tier.uncachedInput),
    cachedInput: perMillion(usage.cachedInputTokens, tier.cachedInput),
    cacheWrite5m: perMillion(usage.cacheWrite5mInputTokens, tier.cacheWrite5m),
    cacheWrite1h: perMillion(usage.cacheWrite1hInputTokens, tier.cacheWrite1h),
    cacheWrite: perMillion(usage.cacheWriteInputTokens, tier.cacheWrite),
    output: perMillion(usage.outputTokens, tier.output),
  };
  return {
    available: true,
    provider: contract.provider,
    route: contract.route,
    requestedModel: input.model || null,
    resolvedModel: contract.model,
    currency: contract.currency,
    amount: Object.values(breakdown).reduce((sum, value) => sum + value, 0),
    ratesPerMillion: tier,
    usage,
    breakdown,
    sourceUrl: contract.sourceUrl,
    sourceLabel: contract.sourceLabel,
    effectiveFrom: contract.effectiveFrom || null,
    effectiveTo: contract.effectiveTo || null,
    verifiedAt: contract.verifiedAt,
    reason: null,
  };
}
