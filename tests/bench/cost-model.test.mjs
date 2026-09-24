import {
  DEFAULTS,
  breakEven,
  costAt,
  costLine,
  markerBytes,
  usageMultiplier,
} from '../../bench/compression/cost-model.mjs';

/**
 * The gate on the model the head-to-head now reports in.
 *
 * Every published figure about what a session costs -- and every claim about
 * how much further a subscription goes -- is this file's arithmetic. It replaced
 * two raw token counts that were wrong in a specific way: they priced a payload
 * as if it were sent once, so an arm that moved content into a store and fetched
 * it back over thirteen round trips looked identical to one that sent it all at
 * once. The properties below are the ones that distinguish those two cases.
 */

const P = DEFAULTS;

describe('a payload that spills nothing costs its residency and no more', () => {
  it('bills one cache write and one read per following turn', () => {
    const line = costLine({ handed: 1000, blocks: [], params: P });
    expect(line.perFetch).toBe(0);
    expect(line.fixed).toBeCloseTo(
      1000 * (P.cacheWrite + P.cacheRead * P.turnsAfter),
      6
    );
  });

  it('is unaffected by the fetch rate, because there is nothing to fetch', () => {
    const line = costLine({ handed: 1000, params: P });
    expect(costAt(line, 1)).toBe(costAt(line, 0));
  });
});

describe('the cost of an arm is a straight line in the fetch rate', () => {
  // Linearity is not a nicety -- the break-even rate is a single number only
  // because both arms are lines. A term that curved would make the published
  // "cheaper while fetch < X%" claim false away from the endpoints.
  it('puts the midpoint exactly halfway between the two bounds', () => {
    const line = costLine({
      handed: 4000,
      blocks: [900, 300, 1200],
      params: P,
    });
    expect(costAt(line, 0.5)).toBeCloseTo(
      (costAt(line, 0) + costAt(line, 1)) / 2,
      6
    );
  });
});

describe('round trips cost something, which is the whole point of the model', () => {
  // THE DEFECT THIS FILE EXISTS TO CATCH. Under the old two-bound arithmetic
  // these two arms were indistinguishable: same text handed over, same bytes
  // recoverable. They are not the same thing to pay for.
  const spread = costLine({
    handed: 5000,
    blocks: Array(10).fill(600),
    params: P,
  });
  const once = costLine({ handed: 5000, blocks: [6000], params: P });

  it('charges more for the same bytes arriving in more places', () => {
    expect(costAt(spread, 1)).toBeGreaterThan(costAt(once, 1));
  });

  it('charges nothing extra for either of them when nothing is fetched', () => {
    expect(costAt(spread, 0)).toBe(costAt(once, 0));
  });

  it('charges at least the prior context for each extra request it forces', () => {
    // An extra request re-reads the prefix. A model that forgot that term would
    // still pass the two tests above, and would understate our 41 round trips.
    const floor = 10 * P.baseContextTokens * P.cacheRead;
    expect(costAt(spread, 1) - costAt(spread, 0)).toBeGreaterThan(floor);
  });
});

describe('break-even names the fetch rate where two arms cost the same', () => {
  const cheapTextManyFetches = costLine({
    handed: 1000,
    blocks: Array(8).fill(4000),
    params: P,
  });
  const dearTextNoFetches = costLine({ handed: 20000, params: P });

  it('finds a crossing and puts both arms at the same cost there', () => {
    const { p, cheaper } = breakEven(cheapTextManyFetches, dearTextNoFetches);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1);
    expect(cheaper).toBe('a');
    expect(costAt(cheapTextManyFetches, p)).toBeCloseTo(
      costAt(dearTextNoFetches, p),
      6
    );
  });

  it('reports no crossing when one arm is cheaper at every rate', () => {
    const strictlyBetter = costLine({ handed: 500, blocks: [100], params: P });
    const strictlyWorse = costLine({
      handed: 50000,
      blocks: [9000],
      params: P,
    });
    expect(breakEven(strictlyBetter, strictlyWorse)).toEqual({
      p: null,
      cheaper: 'a',
    });
    expect(breakEven(strictlyWorse, strictlyBetter)).toEqual({
      p: null,
      cheaper: 'b',
    });
  });

  it('is symmetric: swapping the arms swaps the verdict, not the rate', () => {
    const forward = breakEven(cheapTextManyFetches, dearTextNoFetches);
    const back = breakEven(dearTextNoFetches, cheapTextManyFetches);
    expect(back.p).toBeCloseTo(forward.p, 9);
    expect(back.cheaper).toBe('b');
  });
});

describe('the cap multiple is the cost ratio read the other way up', () => {
  it('turns "costs a quarter as much" into "the plan buys four times as much"', () => {
    expect(usageMultiplier(4000, 1000)).toBe(4);
  });
});

describe('their marker states the size of what it replaced', () => {
  it.each([
    ['<<ccr:88958df2c129,base64,156.3KB>>', 156.3 * 1024],
    ['<<ccr:5e9d227d57da,string,9.3KB>>', 9.3 * 1024],
    ['<<ccr:aaaaaaaaaaaa,html,2.0MB>>', 2 * 1024 * 1024],
    ['<<ccr:bbbbbbbbbbbb,string,512B>>', 512],
  ])('reads %s', (marker, bytes) => {
    expect(markerBytes(marker)).toBeCloseTo(bytes, 6);
  });

  it('returns zero rather than NaN for anything it does not recognise', () => {
    // A NaN here would propagate into the per-turn split and silently blank
    // their whole column, which reads as a win for us.
    expect(markerBytes('<<ccr:cccccccccccc,string>>')).toBe(0);
    expect(markerBytes('not a marker')).toBe(0);
  });
});
