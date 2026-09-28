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

// `baseContextTokens` IS NULL IN THE SHIPPED DEFAULTS, ON PURPOSE. It is a
// property of an environment -- its system prompt and its loaded tool schemas --
// and there is no defensible default, so the model refuses to cost a session
// rather than guess. The 12000 that used to ship understated this machine by
// 5.4x, and understating it inflates every savings figure.
//
// The cases below are synthetic arithmetic, not a claim about any machine, so
// they pin a fixture. It is deliberately that same 12000, so that the expected
// values here are unchanged by the refusal work: what changed is that the number
// must now be supplied out loud. cost-model.check.mjs pins the same fixture for
// the same reason.
const FIXTURE_BASE_CONTEXT = 12000;
const P = Object.freeze({ ...DEFAULTS, baseContextTokens: FIXTURE_BASE_CONTEXT });

describe('an unmeasured base context is refused, not defaulted', () => {
  // WITHOUT THIS THE NULL COULD QUIETLY COME BACK AS A NUMBER NOBODY MEASURED,
  // and every test above would keep passing because they all supply their own.
  it('refuses to cost a session when the environment was never measured', () => {
    expect(DEFAULTS.baseContextTokens).toBeNull();
    expect(() => costLine({ handed: 1000, params: DEFAULTS })).toThrow(
      /baseContextTokens has not been measured/
    );
  });

  it('accepts the measured value once it is supplied', () => {
    expect(() => costLine({ handed: 1000, params: P })).not.toThrow();
  });
});

describe('a payload that spills nothing costs its residency and no more', () => {
  it('bills one cache write and one read per following turn', () => {
    const line = costLine({ handed: 1000, blocks: [], params: P });
    // BOTH FETCH TERMS ZERO, not just the linear one. `perFetch` was the old
    // single coefficient; with the quadratic term there are two ways for a
    // nothing-to-fetch arm to be charged for fetching, and asserting only one
    // of them would miss the other.
    expect(line.c1).toBe(0);
    expect(line.c2).toBe(0);
    expect(line.c0).toBeCloseTo(
      1000 * (P.cacheWrite + P.cacheRead * P.turnsAfter),
      6
    );
  });

  it('is unaffected by the fetch rate, because there is nothing to fetch', () => {
    const line = costLine({ handed: 1000, params: P });
    expect(costAt(line, 1)).toBe(costAt(line, 0));
  });
});

describe('the cost of an arm is a quadratic in the fetch rate, and convex', () => {
  // IT USED TO BE ASSERTED AS A STRAIGHT LINE, AND THAT WAS THE APPROXIMATION.
  // The second block's extra request re-reads a prefix that contains the first
  // block only if the first block was also fetched, so that term carries p*p,
  // not p. Treating it as linear overcharged the low fetch rates and
  // undercharged the high ones, and the "cheaper while fetch < X%" claim is
  // stated from a crossing that a linear model puts in the wrong place.
  const line = costLine({ handed: 4000, blocks: [900, 300, 1200], params: P });

  it('is exactly c0 + c1 p + c2 p^2, with no term left out of costAt', () => {
    for (const p of [0, 0.25, 0.5, 0.75, 1]) {
      expect(costAt(line, p)).toBeCloseTo(
        line.c0 + p * line.c1 + p * p * line.c2,
        6
      );
    }
  });

  it('curves upward, so the midpoint is below the chord', () => {
    expect(line.c2).toBeGreaterThan(0);
    expect(costAt(line, 0.5)).toBeLessThan(
      (costAt(line, 0) + costAt(line, 1)) / 2
    );
  });

  it('only curves once a fetch can land on top of another fetch', () => {
    // ONE block has no earlier block to re-read, so its cost IS linear. This
    // pins the derivation rather than the coefficient: a c2 that appeared here
    // would mean the term was attached to the wrong thing.
    expect(costLine({ handed: 4000, blocks: [900], params: P }).c2).toBe(0);
    expect(
      costLine({ handed: 4000, blocks: [900, 300], params: P }).c2
    ).toBeGreaterThan(0);
  });

  it('never costs less for fetching more', () => {
    let previous = costAt(line, 0);
    for (const p of [0.1, 0.3, 0.6, 0.9, 1]) {
      const here = costAt(line, p);
      expect(here).toBeGreaterThan(previous);
      previous = here;
    }
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
      cheaperAbove: 'a',
      crossings: [],
    });
    expect(breakEven(strictlyWorse, strictlyBetter)).toEqual({
      p: null,
      cheaper: 'b',
      cheaperAbove: 'b',
      crossings: [],
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
    // `commonCost: 0` IS THE PAYLOAD-ONLY RATIO, and it has to be asked for.
    // The bare ratio is what a published multiple used to be, and it is wrong
    // for a subscription: the system prompt, the tool schemas and the turns
    // neither arm changes are paid on both sides, so they belong in the
    // denominator of both. Leaving them out states a 4x where a session sees
    // less.
    expect(usageMultiplier(4000, 1000, { commonCost: 0 })).toBe(4);
  });

  it('moves every multiple toward 1 once the shared cost is counted', () => {
    // THE DIRECTION IS THE CLAIM. A fold that could raise a multiple would be
    // a way to inflate a headline, so this asserts the inequality and not just
    // that the number changed.
    const bare = usageMultiplier(4000, 1000, { commonCost: 0 });
    const folded = usageMultiplier(4000, 1000, { commonCost: 3000 });
    expect(folded).toBeLessThan(bare);
    expect(folded).toBeGreaterThan(1);
    expect(folded).toBeCloseTo(7000 / 4000, 9);
  });

  it('refuses a multiple when the environment was never measured', () => {
    // The default `commonCost` is computed from the params, so the refusal has
    // to hold here too -- otherwise the one figure a subscriber reads is the
    // one figure that could be printed off an unmeasured base context.
    expect(() => usageMultiplier(4000, 1000)).toThrow(
      /baseContextTokens has not been measured/
    );
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
