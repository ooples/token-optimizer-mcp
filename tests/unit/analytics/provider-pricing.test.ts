import { describe, expect, it } from '@jest/globals';
import {
  inferProviderRoute,
  priceTokenUsage,
} from '../../../src/analytics/provider-pricing.js';

describe('provider-aware token pricing', () => {
  it('prices every OpenAI dimension at its own rate', () => {
    const priced = priceTokenUsage({
      client: 'codex',
      model: 'gpt-5.6-sol',
      timestamp: '2026-08-12T12:00:00.000Z',
      usage: {
        uncachedInputTokens: 100_000,
        cachedInputTokens: 50_000,
        cacheWriteInputTokens: 50_000,
        outputTokens: 100_000,
      },
    });

    expect(priced).toMatchObject({
      available: true,
      route: 'openai-api',
      resolvedModel: 'gpt-5.6-sol',
      currency: 'USD',
      amount: 0.5 + 0.025 + 0.3125 + 3,
    });
  });

  it('applies long-context rates to the whole request', () => {
    const priced = priceTokenUsage({
      model: 'gpt-5.6-sol',
      timestamp: '2026-08-12T12:00:00.000Z',
      usage: { uncachedInputTokens: 272_001, outputTokens: 1_000 },
    });

    expect(priced.ratesPerMillion).toMatchObject({
      uncachedInput: 10,
      cachedInput: 1,
      output: 45,
    });
  });

  it('uses the dated Claude Sonnet 5 promotion without changing cache multipliers', () => {
    const promotional = priceTokenUsage({
      model: 'claude-sonnet-5',
      timestamp: '2026-08-31T23:59:59.000Z',
      usage: {
        uncachedInputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        cacheWrite5mInputTokens: 1_000_000,
        cacheWrite1hInputTokens: 1_000_000,
        outputTokens: 1_000_000,
      },
    });
    const standard = priceTokenUsage({
      model: 'claude-sonnet-5',
      timestamp: '2026-09-01T00:00:00.000Z',
      usage: { uncachedInputTokens: 1_000_000, outputTokens: 1_000_000 },
    });

    expect(promotional.amount).toBe(2 + 0.2 + 2.5 + 4 + 10);
    expect(standard.amount).toBe(3 + 15);
  });

  it('does not guess an ambiguous model generation or billing route', () => {
    expect(
      priceTokenUsage({
        client: 'claude-code',
        model: 'claude-sonnet',
        usage: { uncachedInputTokens: 10_000 },
      })
    ).toMatchObject({ available: false, amount: null });
    expect(inferProviderRoute('github-copilot', 'gpt-5.6-sol')).toEqual({
      provider: 'github',
      route: 'github-copilot',
    });
  });

  it('fails closed when a route does not publish a captured cache-write rate', () => {
    const priced = priceTokenUsage({
      client: 'github-copilot',
      model: 'gpt-5.6-sol',
      usage: { cacheWriteInputTokens: 1_000 },
    });

    expect(priced.available).toBe(false);
    expect(priced.reason).toMatch(/cache writes/i);
  });
});
