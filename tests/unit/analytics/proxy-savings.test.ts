/**
 * WHAT A SHAPE-ONLY TEST WOULD MISS HERE. Every function below returns a number
 * of the right type whatever it did, and the three mistakes that actually move
 * a reported figure are invisible to a type check: reading Anthropic's
 * cache-exclusive `input_tokens` as the whole prompt, crediting a saving on a
 * request the provider never charged for, and pricing a delta at a tier the
 * request it came out of did not fall in. Each is pinned below against a
 * control that moves the other way.
 */

import {
  PROXY_SAVINGS,
  billedPromptTokens,
  classifyProxySavings,
  priceProxyDelta,
  proxyCalibration,
  proxyTokensBefore,
  proxyTransportDelta,
  wasBilled,
} from '../../../src/analytics/proxy-savings.js';
import { MODEL_PRICE_CATALOG } from '../../../src/analytics/provider-pricing.js';
import type { AccountingRecord } from '../../../src/proxy/accounting.js';

const METHOD = 'tiktoken-gpt-4-compatible-local-estimate';

function record(over: Partial<AccountingRecord> = {}): AccountingRecord {
  return {
    ts: '2026-10-01T12:00:00.000Z',
    path: '/v1/messages',
    status: 200,
    compressed: true,
    beforeBytes: 4000,
    afterBytes: 1000,
    usage: { input_tokens: 240 },
    tokens: {
      measured: true,
      beforeTokens: 1000,
      afterTokens: 250,
      method: METHOD,
    },
    ...over,
  };
}

describe('the provider count of the prompt we sent', () => {
  it('adds the cache classes Anthropic reports outside input_tokens', () => {
    // A cache-heavy Anthropic turn: four uncached tokens and 150,000 read.
    expect(
      billedPromptTokens({
        input_tokens: 4,
        cache_read_input_tokens: 150_000,
        cache_creation_input_tokens: 2_000,
      })
    ).toBe(152_004);
  });

  it('leaves the Responses dialect alone, where the subset is already inside', () => {
    // THE CONTROL FOR THE TEST ABOVE. Summing here would double-count 9,000
    // tokens, and reading input_tokens alone above would undercount 152,000.
    expect(
      billedPromptTokens({ input_tokens: 12_000, cached_input_tokens: 9_000 })
    ).toBe(12_000);
  });

  it('has no figure when the provider reported no input count', () => {
    expect(billedPromptTokens({ output_tokens: 40 })).toBeNull();
    // Positive control: the same shape with an input count does produce one.
    expect(billedPromptTokens({ output_tokens: 40, input_tokens: 7 })).toBe(7);
  });
});

describe('classifying one proxy ledger row', () => {
  it('names a reduction the provider also counted', () => {
    expect(classifyProxySavings(record())).toBe(
      PROXY_SAVINGS.CalibratedReduction
    );
  });

  it('names a reduction with no provider count to check it against', () => {
    expect(classifyProxySavings(record({ usage: {} }))).toBe(
      PROXY_SAVINGS.Reduction
    );
  });

  it('names a request we made bigger rather than calling it a saving', () => {
    const grown = record({
      tokens: {
        measured: true,
        beforeTokens: 1000,
        afterTokens: 1400,
        method: METHOD,
      },
    });
    expect(classifyProxySavings(grown)).toBe(PROXY_SAVINGS.ExpansionDebit);
    expect(proxyTransportDelta(grown)).toBe(-400);
  });

  it('names a pass-through, which is not a measurement failure', () => {
    const same = record({
      compressed: false,
      tokens: {
        measured: true,
        beforeTokens: 900,
        afterTokens: 900,
        method: METHOD,
      },
    });
    expect(classifyProxySavings(same)).toBe(PROXY_SAVINGS.NoChange);
    expect(proxyTransportDelta(same)).toBe(0);
  });

  it('credits nothing for a request the provider refused', () => {
    // 429: the body never reached a model, so neither side was charged and the
    // delta between them is a counterfactual about an unpaid request.
    const refused = record({ status: 429 });
    expect(classifyProxySavings(refused)).toBe(PROXY_SAVINGS.Unbilled);
    expect(proxyTransportDelta(refused)).toBe(0);
    // THE CONTROL: the identical row with a 200 does contribute its delta, so
    // the zero above is the status gate and not a broken fixture.
    expect(proxyTransportDelta(record())).toBe(750);
  });

  it('credits nothing for a request that never left the socket', () => {
    const dead = record({
      status: 0,
      transportError: 'ECONNREFUSED',
      usage: {},
    });
    expect(classifyProxySavings(dead)).toBe(PROXY_SAVINGS.Unbilled);
    expect(wasBilled(dead)).toBe(false);
    expect(wasBilled(record())).toBe(true);
  });

  it('names a billed request whose count was refused, never scoring it zero', () => {
    const refused = record({
      tokens: { measured: false, reason: 'queue-full' },
    });
    expect(classifyProxySavings(refused)).toBe(PROXY_SAVINGS.Uncounted);
    expect(proxyTokensBefore(refused)).toBe(0);
  });

  it('keeps a row written before token accounting existed readable', () => {
    const old = record({ tokens: undefined });
    expect(classifyProxySavings(old)).toBe(PROXY_SAVINGS.Uncounted);
    // The control: the same row with a count is measured, so the class above
    // is the missing field and not a rejected record.
    expect(classifyProxySavings(record())).toBe(
      PROXY_SAVINGS.CalibratedReduction
    );
  });
});

describe('the instrument checking itself', () => {
  it('pairs our count of the body we sent with the bill for that body', () => {
    expect(proxyCalibration(record())).toEqual({ ours: 250, billed: 240 });
  });

  it('pairs nothing when the provider reported no count', () => {
    expect(proxyCalibration(record({ usage: {} }))).toBeNull();
    // Positive control: the same row with usage does pair.
    expect(proxyCalibration(record())).not.toBeNull();
  });

  it('pairs nothing for a request nobody was billed for', () => {
    expect(proxyCalibration(record({ status: 500 }))).toBeNull();
    expect(proxyCalibration(record({ status: 201 }))).not.toBeNull();
  });
});

describe('pricing one proxy row', () => {
  /**
   * THE TIER IS THE WHOLE POINT OF THIS BLOCK. gpt-5.6-sol bills $4 per million
   * uncached input tokens up to a 272,000-token prompt and $8 above it, so a
   * request cut from 300,000 tokens to 200,000 crosses the threshold. Pricing
   * the 100,000 saved tokens on their own puts them in the cheap tier and
   * reports $0.40; pricing each side as the prompt it actually was reports the
   * $2.40 we would have paid less the $0.80 we did.
   */
  const crossing = record({
    model: 'gpt-5.6-sol',
    tokens: {
      measured: true,
      beforeTokens: 300_000,
      afterTokens: 200_000,
      method: METHOD,
    },
  });

  it('prices each side as the prompt it was, not the delta in isolation', () => {
    expect(priceProxyDelta(crossing)).toBeCloseTo(1.6, 6);
  });

  it('is not the cheap-tier price of the delta alone', () => {
    // The control for the figure above: $0.40 is what the delta-only rule
    // produces, and reading it here would mean the tiering was lost.
    expect(priceProxyDelta(crossing)).not.toBeCloseTo(0.4, 6);
  });

  it('carries the sign of an expansion through to the money', () => {
    const grown = record({
      model: 'gpt-5.6-sol',
      tokens: {
        measured: true,
        beforeTokens: 100_000,
        afterTokens: 120_000,
        method: METHOD,
      },
    });
    const priced = priceProxyDelta(grown);
    expect(priced).not.toBeNull();
    expect(priced).toBeCloseTo(-0.08, 6);
  });

  it('refuses a price for a row that never named a model', () => {
    expect(priceProxyDelta(record())).toBeNull();
    // The control: the identical row that names a catalog model is priced.
    expect(priceProxyDelta(record({ model: 'gpt-5.6-sol' }))).not.toBeNull();
  });

  it('refuses a price for a model the catalog does not have', () => {
    // The absence is ASSERTED, not assumed. This fixture used to name a real
    // model that the catalog simply had not been widened to yet; once it was,
    // the test went on passing for the wrong reason until the price arrived.
    // The id keeps a vendor prefix so the route still resolves and the refusal
    // is the catalog's, not the router's.
    const absent = 'gpt-0-not-a-model';
    expect(MODEL_PRICE_CATALOG.some((row) => row.model === absent)).toBe(false);
    expect(priceProxyDelta(record({ model: absent }))).toBeNull();
    expect(
      priceProxyDelta(record({ model: 'claude-sonnet-5' }))
    ).not.toBeNull();
  });
});
