/**
 * Versioned provider/model token prices.
 *
 * Prices are intentionally request-time contracts, not one global multiplier:
 * uncached input, cache reads, cache writes, and output are distinct billable
 * dimensions.  A catalog match is exact (or an explicitly documented alias),
 * and every result carries the source and effective date used to compute it.
 */

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
  tiers: readonly TokenPriceTier[];
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

const OPENAI_SOURCE = 'https://developers.openai.com/api/docs/models/compare';
const OPENAI_SOL_SOURCE =
  'https://developers.openai.com/api/docs/models/gpt-5.6-sol';
const ANTHROPIC_SOURCE =
  'https://platform.claude.com/docs/en/about-claude/pricing';
const ANTHROPIC_CACHE_SOURCE =
  'https://platform.claude.com/docs/en/build-with-claude/prompt-caching';
const GEMINI_SOURCE = 'https://ai.google.dev/gemini-api/docs/pricing';
const COPILOT_SOURCE =
  'https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing';
const CATALOG_VERIFIED_AT = '2026-08-12T00:00:00.000Z';

const openAi56Tier = (
  input: number,
  cached: number,
  output: number
): readonly TokenPriceTier[] => [
  {
    maxInputTokens: 272_000,
    uncachedInput: input,
    cachedInput: cached,
    cacheWrite5m: input * 1.25,
    cacheWrite1h: input * 1.25,
    cacheWrite: input * 1.25,
    output,
  },
  {
    uncachedInput: input * 2,
    cachedInput: cached * 2,
    cacheWrite5m: input * 2 * 1.25,
    cacheWrite1h: input * 2 * 1.25,
    cacheWrite: input * 2 * 1.25,
    output: output * 1.5,
  },
];

const anthropicTier = (
  input: number,
  output: number
): readonly TokenPriceTier[] => [
  {
    uncachedInput: input,
    cachedInput: input * 0.1,
    cacheWrite5m: input * 1.25,
    cacheWrite1h: input * 2,
    cacheWrite: input * 1.25,
    output,
  },
];

const geminiTier = (
  input: number,
  cached: number,
  output: number
): readonly TokenPriceTier[] => [
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

/** Official prices that can be resolved without guessing a model generation. */
export const MODEL_PRICE_CATALOG: readonly ModelPriceContract[] = [
  {
    provider: 'openai',
    route: 'openai-api',
    model: 'gpt-5.6-sol',
    aliases: [],
    currency: 'USD',
    verifiedAt: CATALOG_VERIFIED_AT,
    sourceUrl: OPENAI_SOL_SOURCE,
    sourceLabel: 'OpenAI API price',
    tiers: openAi56Tier(5, 0.5, 30),
  },
  {
    provider: 'openai',
    route: 'openai-api',
    model: 'gpt-5.6-terra',
    aliases: [],
    currency: 'USD',
    verifiedAt: CATALOG_VERIFIED_AT,
    sourceUrl: OPENAI_SOURCE,
    sourceLabel: 'OpenAI API price',
    tiers: openAi56Tier(2.5, 0.25, 15),
  },
  {
    provider: 'openai',
    route: 'openai-api',
    model: 'gpt-5.6-luna',
    aliases: [],
    currency: 'USD',
    verifiedAt: CATALOG_VERIFIED_AT,
    sourceUrl: OPENAI_SOURCE,
    sourceLabel: 'OpenAI API price',
    tiers: openAi56Tier(1, 0.1, 6),
  },
  {
    provider: 'anthropic',
    route: 'anthropic-api',
    model: 'claude-opus-5',
    aliases: [],
    currency: 'USD',
    verifiedAt: CATALOG_VERIFIED_AT,
    sourceUrl: ANTHROPIC_SOURCE,
    sourceLabel: 'Anthropic API price',
    tiers: anthropicTier(5, 25),
  },
  {
    provider: 'anthropic',
    route: 'anthropic-api',
    model: 'claude-sonnet-5',
    aliases: [],
    currency: 'USD',
    verifiedAt: CATALOG_VERIFIED_AT,
    effectiveTo: '2026-09-01T00:00:00.000Z',
    sourceUrl: ANTHROPIC_SOURCE,
    sourceLabel: 'Anthropic introductory API price',
    tiers: anthropicTier(2, 10),
  },
  {
    provider: 'anthropic',
    route: 'anthropic-api',
    model: 'claude-sonnet-5',
    aliases: [],
    currency: 'USD',
    verifiedAt: CATALOG_VERIFIED_AT,
    effectiveFrom: '2026-09-01T00:00:00.000Z',
    sourceUrl: ANTHROPIC_SOURCE,
    sourceLabel: 'Anthropic standard API price',
    tiers: anthropicTier(3, 15),
  },
  ...[
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-opus-4-5',
  ].map(
    (model): ModelPriceContract => ({
      provider: 'anthropic',
      route: 'anthropic-api',
      model,
      aliases: [],
      currency: 'USD',
      verifiedAt: CATALOG_VERIFIED_AT,
      sourceUrl: ANTHROPIC_CACHE_SOURCE,
      sourceLabel: 'Anthropic API and prompt-cache price',
      tiers: anthropicTier(5, 25),
    })
  ),
  ...['claude-sonnet-4-6', 'claude-sonnet-4-5'].map(
    (model): ModelPriceContract => ({
      provider: 'anthropic',
      route: 'anthropic-api',
      model,
      aliases: [],
      currency: 'USD',
      verifiedAt: CATALOG_VERIFIED_AT,
      sourceUrl: ANTHROPIC_CACHE_SOURCE,
      sourceLabel: 'Anthropic API and prompt-cache price',
      tiers: anthropicTier(3, 15),
    })
  ),
  {
    provider: 'anthropic',
    route: 'anthropic-api',
    model: 'claude-haiku-4-5',
    aliases: [],
    currency: 'USD',
    verifiedAt: CATALOG_VERIFIED_AT,
    sourceUrl: ANTHROPIC_CACHE_SOURCE,
    sourceLabel: 'Anthropic API and prompt-cache price',
    tiers: anthropicTier(1, 5),
  },
  {
    provider: 'google',
    route: 'gemini-api',
    model: 'gemini-3.5-flash',
    aliases: [],
    currency: 'USD',
    verifiedAt: CATALOG_VERIFIED_AT,
    sourceUrl: GEMINI_SOURCE,
    sourceLabel: 'Gemini Developer API standard price',
    tiers: geminiTier(1.5, 0.15, 9),
  },
  {
    provider: 'google',
    route: 'gemini-api',
    model: 'gemini-3.5-flash-lite',
    aliases: [],
    currency: 'USD',
    verifiedAt: CATALOG_VERIFIED_AT,
    sourceUrl: GEMINI_SOURCE,
    sourceLabel: 'Gemini Developer API standard price',
    tiers: geminiTier(0.3, 0.03, 2.5),
  },
  {
    provider: 'google',
    route: 'gemini-api',
    model: 'gemini-2.5-flash',
    aliases: [],
    currency: 'USD',
    verifiedAt: CATALOG_VERIFIED_AT,
    sourceUrl: GEMINI_SOURCE,
    sourceLabel: 'Gemini Developer API standard price',
    tiers: geminiTier(0.3, 0.03, 2.5),
  },
  {
    provider: 'google',
    route: 'gemini-api',
    model: 'gemini-2.5-flash-lite',
    aliases: [],
    currency: 'USD',
    verifiedAt: CATALOG_VERIFIED_AT,
    sourceUrl: GEMINI_SOURCE,
    sourceLabel: 'Gemini Developer API standard price',
    tiers: geminiTier(0.1, 0.01, 0.4),
  },
  // GitHub Copilot is a distinct billing route even when the underlying model
  // id is identical to a direct provider model.
  ...[
    ['gpt-5.6-sol', 5, 0.5, 30, 272_000],
    ['gpt-5.6-terra', 2.5, 0.25, 15, 272_000],
    ['gpt-5.6-luna', 1, 0.1, 6, 200_000],
  ].map(
    ([model, input, cached, output, threshold]): ModelPriceContract => ({
      provider: 'github',
      route: 'github-copilot',
      model: String(model),
      aliases: [],
      currency: 'USD',
      verifiedAt: CATALOG_VERIFIED_AT,
      sourceUrl: COPILOT_SOURCE,
      sourceLabel: 'GitHub Copilot AI-credit token price',
      tiers: [
        {
          maxInputTokens: Number(threshold),
          uncachedInput: Number(input),
          cachedInput: Number(cached),
          cacheWrite5m: null,
          cacheWrite1h: null,
          cacheWrite: null,
          output: Number(output),
        },
        {
          uncachedInput: Number(input) * 2,
          cachedInput: Number(cached) * 2,
          cacheWrite5m: null,
          cacheWrite1h: null,
          cacheWrite: null,
          output: Number(output) * 1.5,
        },
      ],
    })
  ),
  {
    provider: 'github',
    route: 'github-copilot',
    model: 'claude-sonnet-5',
    aliases: [],
    currency: 'USD',
    verifiedAt: CATALOG_VERIFIED_AT,
    effectiveTo: '2026-09-01T00:00:00.000Z',
    sourceUrl: COPILOT_SOURCE,
    sourceLabel: 'GitHub Copilot promotional AI-credit token price',
    tiers: [
      {
        uncachedInput: 2,
        cachedInput: 0.2,
        cacheWrite5m: 2.5,
        cacheWrite1h: 4,
        cacheWrite: 2.5,
        output: 10,
      },
    ],
  },
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

function contractAt(
  route: string,
  model: string,
  timestamp: string
): ModelPriceContract | null {
  const at = Date.parse(timestamp);
  const key = model.toLowerCase();
  return (
    MODEL_PRICE_CATALOG.find((contract) => {
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
  return (
    contract.tiers.find(
      (tier) =>
        tier.maxInputTokens === undefined || promptTokens <= tier.maxInputTokens
    ) || contract.tiers.at(-1)!
  );
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
