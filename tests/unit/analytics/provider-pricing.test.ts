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
      amount: 0.4 + 0.02 + 0.25 + 2,
    });
  });

  it('applies long-context rates to the whole request', () => {
    const priced = priceTokenUsage({
      model: 'gpt-5.6-sol',
      timestamp: '2026-08-12T12:00:00.000Z',
      usage: { uncachedInputTokens: 272_001, outputTokens: 1_000 },
    });

    expect(priced.ratesPerMillion).toMatchObject({
      uncachedInput: 8,
      cachedInput: 0.8,
      output: 30,
    });
  });

  it('charges one standard Claude Sonnet 5 rate because the step was cancelled', () => {
    // THIS TEST USED TO ASSERT THE OPPOSITE, and that is the point of it. The
    // catalog carried a window handing $2/$10 over to $3/$15 on 2026-09-01, so
    // every request after that date was billed 50% high. The pricing page's own
    // footnote settles it: the $2/$10 price, "announced at launch as
    // introductory pricing through August 31, 2026, is now the standard price.
    // The previously scheduled increase to $3/$15 per million input/output
    // tokens on September 1, 2026 will not occur."
    const dimensions = {
      uncachedInputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      cacheWrite5mInputTokens: 1_000_000,
      cacheWrite1hInputTokens: 1_000_000,
      outputTokens: 1_000_000,
    };
    const before = priceTokenUsage({
      model: 'claude-sonnet-5',
      timestamp: '2026-08-31T23:59:59.000Z',
      usage: dimensions,
    });
    const after = priceTokenUsage({
      model: 'claude-sonnet-5',
      timestamp: '2026-09-01T00:00:00.000Z',
      usage: dimensions,
    });

    // 0.1x cache reads, 1.25x five-minute writes and 2x one-hour writes, from
    // the multiplier table on the same page.
    expect(before.amount).toBe(2 + 0.2 + 2.5 + 4 + 10);
    expect(after.amount).toBe(before.amount);
    expect(after.effectiveTo).toBeNull();
  });

  it('still steps a price on the date a vendor has actually published one', () => {
    // The positive control for the assertion above: dated windows are not
    // broken, they were being used to encode a future nobody had announced.
    // Google does publish this one -- $0.75/$3.75 per million "through December
    // 31, 2026", then $1.50/$7.50 "starting January 1, 2027".
    const usage = {
      uncachedInputTokens: 1_000_000,
      outputTokens: 1_000_000,
    };
    const through2026 = priceTokenUsage({
      model: 'gemini-3.8-flash',
      timestamp: '2026-12-31T23:59:59.000Z',
      usage,
    });
    const from2027 = priceTokenUsage({
      model: 'gemini-3.8-flash',
      timestamp: '2027-01-01T00:00:00.000Z',
      usage,
    });

    expect(through2026.amount).toBe(0.75 + 3.75);
    expect(from2027.amount).toBe(1.5 + 7.5);
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

  it('names the gateway as the route when the provider says OrcaRouter', () => {
    // OrcaRouter resells many vendors behind one endpoint, so its models arrive with a
    // `vendor/model` namespace. The route follows the NAMED provider, not the namespace: a
    // namespaced model with no provider named stays unknown rather than being credited to a
    // gateway it may never have touched.
    expect(
      inferProviderRoute(
        'claude-code',
        'deepseek/deepseek-v4-pro',
        'orcarouter'
      )
    ).toEqual({ provider: 'orcarouter', route: 'orcarouter-api' });
    expect(
      inferProviderRoute('claude-code', 'deepseek/deepseek-v4-pro')
    ).toEqual({
      provider: 'unknown',
      route: 'unknown',
    });
  });

  it('fails closed when a route does not publish a captured cache-write rate', () => {
    const priced = priceTokenUsage({
      client: 'github-copilot',
      // This price list prints "Not applicable" in the cache-write column for
      // the GPT-5.4 generation. It does publish a write rate for GPT-5.6 Sol,
      // so that model no longer exercises the refusal.
      model: 'gpt-5.4',
      usage: { cacheWriteInputTokens: 1_000 },
    });

    expect(priced.available).toBe(false);
    expect(priced.reason).toMatch(/cache writes/i);
  });
});
