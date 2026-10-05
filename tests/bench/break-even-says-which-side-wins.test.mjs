import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  breakEven,
  breakEvenLabel,
  costLine,
  DEFAULTS,
} from '../../bench/compression/cost-model.mjs';

// The published column is headed "ours wins below", so a bare percentage in it
// is a claim about OUR arm. `breakEvenLabel` is the only thing that decides
// whether a crossing is printed bare or qualified, and until it moved out of the
// harness nothing could reach it: the direction was argued from the source, and
// a review read the same source the other way round. These two suites pin it
// from both ends -- the formatter's own contract, and the records it wrote.

const P = {
  ...DEFAULTS,
  baseContextTokens: 20000,
  baseContextSource: 'measured',
};

const at = (name) =>
  fileURLToPath(
    new URL(`../../bench/compression/headroom/results/${name}`, import.meta.url)
  );
const load = (name) => JSON.parse(readFileSync(at(name), 'utf8'));
const num = (s) => Number(String(s).replace(/,/g, ''));

describe('a crossing is worded so it cannot be read the wrong way round', () => {
  it('prints a bare percentage only when OURS is the cheaper arm at rest', () => {
    expect(breakEvenLabel({ p: 0.77, cheaper: 'a', crossings: [0.77] })).toBe(
      '77%'
    );
  });

  it('qualifies the SAME rate with "above" when theirs is cheaper at rest', () => {
    // The inversion this guards: identical `p`, opposite meaning. Printed bare,
    // the second row would claim ours wins below 77% when ours wins ABOVE it.
    expect(breakEvenLabel({ p: 0.77, cheaper: 'b', crossings: [0.77] })).toBe(
      'above 77%'
    );
  });

  it('reads a tie at rest as not-ours, because the column claims a win', () => {
    // A dead heat at rest is not a win below any rate, so it never gets the bare
    // form. `rag-conversation` is exactly this row in the published record.
    expect(breakEvenLabel({ p: null, cheaper: 'tie', crossings: [] })).toBe(
      'never'
    );
    expect(breakEvenLabel({ p: 0.5, cheaper: 'tie', crossings: [0.5] })).toBe(
      'above 50%'
    );
  });

  it('says always or never when the arms never cross inside the interval', () => {
    expect(breakEvenLabel({ p: null, cheaper: 'a', crossings: [] })).toBe(
      'always'
    );
    expect(breakEvenLabel({ p: null, cheaper: 'b', crossings: [] })).toBe(
      'never'
    );
  });

  it('marks a second crossing instead of dropping it', () => {
    expect(
      breakEvenLabel({ p: 0.5, cheaper: 'a', crossings: [0.5, 0.9] })
    ).toBe('50%+');
  });

  it('words a real crossing from the model, not a hand-built one', () => {
    const cheapNowManyFetches = costLine({
      handed: 1000,
      blocks: Array(8).fill(4000),
      params: P,
    });
    const dearNowNoFetches = costLine({ handed: 20000, params: P });
    const forward = breakEven(cheapNowManyFetches, dearNowNoFetches);
    const back = breakEven(dearNowNoFetches, cheapNowManyFetches);
    expect(forward.p).toBeCloseTo(back.p, 9);
    expect(breakEvenLabel(forward)).toMatch(/^\d+%\+?$/);
    expect(breakEvenLabel(back)).toBe(`above ${breakEvenLabel(forward)}`);
  });
});

// Checked against the row's OWN recorded costs, so it does not depend on the
// label having been right when it was written.
const disagrees = (row) => {
  const s = row.cost.session;
  const oursCheaperAtRest = num(s.p0.ours) < num(s.p0.theirs);
  const oursCheaperWhenAllFetched = num(s.p1.ours) < num(s.p1.theirs);
  const label = s.breakEven;
  if (label === 'always')
    return oursCheaperAtRest && oursCheaperWhenAllFetched
      ? null
      : 'always, but ours is not cheaper at both ends';
  if (label === 'never')
    return oursCheaperAtRest ? 'never, but ours is cheaper at rest' : null;
  if (/^above /.test(label))
    return oursCheaperAtRest
      ? 'qualified, but ours already wins at rest'
      : null;
  if (/^\d+%\+?$/.test(label))
    return oursCheaperAtRest
      ? null
      : 'bare percentage, but THEIRS is cheaper at rest';
  return `unrecognised label ${JSON.stringify(label)}`;
};

describe.each(['head-to-head.json', 'head-to-head.store-empty.json'])(
  'every break-even in %s agrees with the costs beside it',
  (file) => {
    const rows = load(file).workloads;

    it('checks all 18 rows and finds no row worded against its own numbers', () => {
      expect(rows).toHaveLength(18);
      expect(rows.map((r) => disagrees(r)).filter(Boolean)).toEqual([]);
    });

    it('records the two crossings as qualified, which is what the review doubted', () => {
      const byName = Object.fromEntries(
        rows.map((r) => [r.name, r.cost.session.breakEven])
      );
      // PER RECORD, BECAUSE THEY ARE DIFFERENT RECORDINGS. This asserted one
      // pair of figures against BOTH files, which cannot be right: a sweep
      // with the store empty is a different measurement from a warm one, and
      // holding them to the same number only passed while neither had been
      // re-recorded. head-to-head.json has since been re-taken in Anthropic's
      // count_tokens -- it was counted in tiktoken cl100k_base, OpenAI's
      // tokenizer, while the claim it supports is about Claude subscription
      // spend -- and over 18 workloads rather than 12.
      //
      // head-to-head.store-empty.json has NOT been re-recorded, so its figures
      // are still in the old currency. That is a real gap and it is pinned here
      // rather than hidden: when that sweep is re-run these numbers move, and a
      // reader can see which record is which.
      const expected = {
        'head-to-head.json': {
          'grep-output': 'above 85%',
          'raw-build-log': 'above 95%',
        },
        'head-to-head.store-empty.json': {
          'grep-output': 'above 81%',
          'raw-build-log': 'above 93%',
        },
      }[file];
      expect(expected).toBeDefined();
      for (const [name, crossing] of Object.entries(expected))
        expect(byName[name]).toBe(crossing);
      expect(
        rows.filter((r) => /^\d+%\+?$/.test(r.cost.session.breakEven))
      ).toEqual([]);
    });
  }
);

describe('the check above can fail, so a clean pass is a reading', () => {
  const crossed = load('head-to-head.json').workloads.find(
    (r) => r.name === 'grep-output'
  );

  it('control: stripping the qualifier off grep-output is caught', () => {
    const stripped = {
      ...crossed,
      cost: {
        ...crossed.cost,
        session: { ...crossed.cost.session, breakEven: '81%' },
      },
    };
    expect(disagrees(stripped)).toBe(
      'bare percentage, but THEIRS is cheaper at rest'
    );
  });

  it('control: claiming a row never wins when it wins at rest is caught', () => {
    const won = load('head-to-head.json').workloads.find(
      (r) => r.cost.session.breakEven === 'always'
    );
    const relabelled = {
      ...won,
      cost: {
        ...won.cost,
        session: { ...won.cost.session, breakEven: 'never' },
      },
    };
    expect(relabelled.name).toBe('agent-loop');
    expect(disagrees(relabelled)).toBe('never, but ours is cheaper at rest');
  });

  it('control: an unrecognised wording is named rather than skipped', () => {
    const odd = {
      ...crossed,
      cost: {
        ...crossed.cost,
        session: { ...crossed.cost.session, breakEven: 'below 81%' },
      },
    };
    expect(disagrees(odd)).toBe('unrecognised label "below 81%"');
  });
});
