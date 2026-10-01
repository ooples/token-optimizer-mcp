/**
 * WHAT A SHAPE-ONLY TEST WOULD MISS HERE. Every function in this module returns
 * a well-typed object whatever it read, and the three mistakes that actually
 * cost an operator money are invisible to a type check: a row that fails to
 * parse being dropped instead of refused, an omitted cache-write rate being
 * read as free rather than as unpublished, and an operator's own negotiated
 * rate losing to the shipped catalog it was written to override. Each is pinned
 * below against a control that moves the other way.
 */

import { describe, expect, it, beforeEach } from '@jest/globals';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  forgetOperatorPrices,
  loadOperatorPrices,
  operatorPriceContracts,
  operatorSourceLabel,
  OPERATOR_PRICE_TABLE_ENV,
} from '../../../src/analytics/operator-prices.js';
import { priceTokenUsage } from '../../../src/analytics/provider-pricing.js';

const AT = '2026-10-01T12:00:00.000Z';

function tableFile(body: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'op-prices-'));
  const path = join(dir, 'prices.json');
  writeFileSync(
    path,
    typeof body === 'string' ? body : JSON.stringify(body),
    'utf8'
  );
  return path;
}

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    route: 'self-hosted',
    model: 'llama-4-70b-local',
    uncachedInput: 0.2,
    cachedInput: 0.02,
    output: 0.6,
    ...over,
  };
}

beforeEach(() => {
  forgetOperatorPrices();
  delete process.env[OPERATOR_PRICE_TABLE_ENV];
});

describe('reading an operator price table', () => {
  it('prices a model the shipped catalog has never heard of', () => {
    const path = tableFile({ models: [row()] });
    const { contracts, status } = loadOperatorPrices(path, () => AT);

    expect(status).toEqual({ path, contracts: 1, error: null });
    expect(contracts[0]).toMatchObject({
      provider: 'operator',
      route: 'self-hosted',
      model: 'llama-4-70b-local',
      currency: 'USD',
      sourceLabel: operatorSourceLabel(path),
      verifiedAt: AT,
    });
    expect(contracts[0].tiers).toEqual([
      {
        uncachedInput: 0.2,
        cachedInput: 0.02,
        cacheWrite5m: null,
        cacheWrite1h: null,
        cacheWrite: null,
        output: 0.6,
      },
    ]);
  });

  it('leaves an unstated cache-write rate unpriced rather than free', () => {
    // THE DISTINCTION THIS PINS. A table that says nothing about cache writes
    // has not said they are free, so a request that wrote to cache must fail
    // closed. Reading the omission as 0 would report a saving on tokens the
    // operator was in fact billed for.
    const path = tableFile({ models: [row()] });
    const { contracts } = loadOperatorPrices(path, () => AT);
    expect(contracts[0].tiers[0].cacheWrite).toBeNull();

    // The control: the same table that DOES state a write rate carries it.
    const stated = loadOperatorPrices(
      tableFile({ models: [row({ cacheWrite: 0.25 })] }),
      () => AT
    );
    expect(stated.contracts[0].tiers[0].cacheWrite).toBe(0.25);
    expect(stated.contracts[0].tiers[0].cacheWrite5m).toBe(0.25);
  });

  it('keeps a zero rate as a zero rate', () => {
    // A FREE MODEL IS NOT AN UNPRICED ONE. A local model genuinely costs
    // nothing per token, and collapsing that to "no price" would drop it out
    // of the money column and out of the coverage percentage with it.
    const path = tableFile({
      models: [row({ uncachedInput: 0, cachedInput: 0, output: 0 })],
    });
    const { contracts } = loadOperatorPrices(path, () => AT);
    expect(contracts[0].tiers[0].uncachedInput).toBe(0);

    const priced = priceTokenUsage({
      route: 'self-hosted',
      model: 'llama-4-70b-local',
      timestamp: AT,
      usage: { uncachedInputTokens: 1_000_000 },
    });
    // Not yet in force -- the env names no table in this test.
    expect(priced.available).toBe(false);
  });
});

describe('refusing a table that does not parse', () => {
  it('names the row and the field rather than dropping it', () => {
    // A DROPPED ROW IS THE WHOLE FAILURE MODE. An operator who mistypes one
    // rate would otherwise see that model reported as unpriced, go back to the
    // catalog looking for it, and never learn that their own file was at fault.
    const path = tableFile({
      models: [row(), row({ model: 'mistral-x', output: 'free' })],
    });
    const { contracts, status } = loadOperatorPrices(path, () => AT);

    expect(contracts).toEqual([]);
    expect(status.error).toContain('mistral-x');
    expect(status.error).toContain('output');
    expect(status.contracts).toBe(0);
  });

  it('refuses the whole file, not just the bad row', () => {
    // HALF A TABLE IS WORSE THAN NONE. Loading the rows that happened to parse
    // would price some models and not others with nothing in the report saying
    // which, so the operator reads a partial total as a complete one.
    const { contracts } = loadOperatorPrices(
      tableFile({ models: [row(), { route: 'x' }] }),
      () => AT
    );
    expect(contracts).toEqual([]);

    // The control: the same two rows, both valid, both load.
    const good = loadOperatorPrices(
      tableFile({ models: [row(), row({ model: 'mistral-x' })] }),
      () => AT
    );
    expect(good.contracts).toHaveLength(2);
    expect(good.status.error).toBeNull();
  });

  it('names the path it could not read', () => {
    const missing = join(tmpdir(), 'no-such-price-table-9471.json');
    const { status } = loadOperatorPrices(missing, () => AT);
    expect(status.path).toBe(missing);
    expect(status.error).not.toBeNull();
    // The control: a table at a path that exists loads with no error.
    expect(loadOperatorPrices(tableFile({ models: [] }), () => AT).status.error)
      .toBeNull();
  });

  it('reads no table and reports no failure when none is named', () => {
    expect(loadOperatorPrices(null, () => AT).status).toEqual({
      path: null,
      contracts: 0,
      error: null,
    });
    expect(loadOperatorPrices('   ', () => AT).status.path).toBeNull();
  });

  it('refuses a long-context threshold with no rates past it', () => {
    const { status } = loadOperatorPrices(
      tableFile({ models: [row({ maxInputTokens: 200_000 })] }),
      () => AT
    );
    expect(status.error).toContain('aboveThreshold');

    // The control: the threshold plus the rates past it is accepted, and the
    // second tier is the operator's own figures rather than a guessed multiple
    // of the first -- vendors do not agree on that multiplier.
    const tiered = loadOperatorPrices(
      tableFile({
        models: [
          row({
            maxInputTokens: 200_000,
            aboveThreshold: {
              uncachedInput: 0.5,
              cachedInput: 0.05,
              output: 1,
            },
          }),
        ],
      }),
      () => AT
    );
    expect(tiered.contracts[0].tiers).toHaveLength(2);
    expect(tiered.contracts[0].tiers[0].maxInputTokens).toBe(200_000);
    expect(tiered.contracts[0].tiers[1]).toMatchObject({
      uncachedInput: 0.5,
      output: 1,
    });
  });
});

describe('the table in force for the process', () => {
  it('prices a model the catalog does not publish', () => {
    process.env[OPERATOR_PRICE_TABLE_ENV] = tableFile({
      models: [row({ uncachedInput: 0.2, output: 0.6 })],
    });
    const priced = priceTokenUsage({
      route: 'self-hosted',
      model: 'llama-4-70b-local',
      timestamp: AT,
      usage: { uncachedInputTokens: 1_000_000, outputTokens: 1_000_000 },
    });

    expect(priced.available).toBe(true);
    expect(priced.amount).toBeCloseTo(0.8, 9);
    expect(priced.sourceLabel).toContain('operator price table');
  });

  it('lets the operator rate beat the shipped one for the same model', () => {
    // AN OPERATOR WHO WROTE DOWN A RATE KNOWS SOMETHING THE PAGE DOES NOT --
    // a negotiated discount, a gateway's margin. Losing to the public price
    // would make the table useless for the case it was asked for.
    const shipped = priceTokenUsage({
      route: 'anthropic-api',
      model: 'claude-sonnet-5',
      timestamp: AT,
      usage: { uncachedInputTokens: 1_000_000 },
    });
    expect(shipped.amount).toBe(2);
    expect(shipped.sourceLabel).toBe('Anthropic API price');

    process.env[OPERATOR_PRICE_TABLE_ENV] = tableFile({
      models: [
        {
          route: 'anthropic-api',
          model: 'claude-sonnet-5',
          uncachedInput: 1.4,
          cachedInput: 0.14,
          output: 7,
        },
      ],
    });
    forgetOperatorPrices();
    const negotiated = priceTokenUsage({
      route: 'anthropic-api',
      model: 'claude-sonnet-5',
      timestamp: AT,
      usage: { uncachedInputTokens: 1_000_000 },
    });

    expect(negotiated.amount).toBeCloseTo(1.4, 9);
    expect(negotiated.sourceLabel).toContain('operator price table');
  });

  it('falls back to the shipped catalog for everything the table omits', () => {
    process.env[OPERATOR_PRICE_TABLE_ENV] = tableFile({
      models: [row()],
    });
    forgetOperatorPrices();
    const shipped = priceTokenUsage({
      route: 'anthropic-api',
      model: 'claude-opus-5',
      timestamp: AT,
      usage: { uncachedInputTokens: 1_000_000 },
    });
    expect(shipped.amount).toBe(5);
    expect(shipped.sourceLabel).toBe('Anthropic API price');
  });

  it('serves no stale rates after the same file is edited in place', () => {
    // A DAEMON OUTLIVES AN EDIT, AND THE PATH DOES NOT CHANGE WHEN IT HAPPENS.
    // This test used to point the env at a second temp file, which a cache
    // keyed on the path alone passes while still serving an operator the rate
    // they had just corrected -- with nothing in the report saying so, because
    // a stale figure looks exactly like the figure that was once right.
    const path = tableFile({ models: [row({ uncachedInput: 0.2 })] });
    process.env[OPERATOR_PRICE_TABLE_ENV] = path;
    const priced = (): number | null =>
      priceTokenUsage({
        route: 'self-hosted',
        model: 'llama-4-70b-local',
        timestamp: AT,
        usage: { uncachedInputTokens: 1_000_000 },
      }).amount;
    expect(priced()).toBeCloseTo(0.2, 9);

    // The mtime has a resolution, so the edit is stamped forward rather than
    // relying on the two writes landing in different milliseconds.
    writeFileSync(
      path,
      JSON.stringify({ models: [row({ uncachedInput: 0.5 })] }),
      'utf8'
    );
    const later = new Date(Date.now() + 2000);
    utimesSync(path, later, later);
    expect(priced()).toBeCloseTo(0.5, 9);
  });

  it('reads the file once while nothing about it has changed', () => {
    // THE POSITIVE CONTROL FOR THE TEST ABOVE: re-reading on every price lookup
    // would also pass it, and would put a stat and a parse on a path called
    // once per hook invocation.
    const path = tableFile({ models: [row()] });
    process.env[OPERATOR_PRICE_TABLE_ENV] = path;
    const first = operatorPriceContracts();
    expect(operatorPriceContracts()).toBe(first);
  });
});
