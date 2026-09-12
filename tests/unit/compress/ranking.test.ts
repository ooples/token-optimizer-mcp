import { describe, it, expect, afterEach } from '@jest/globals';
import {
  activeRanker,
  rankerIsCustom,
  registerRanker,
  resetRanker,
} from '../../../src/compress/ranking.js';
import { ranker as lexicalRanker } from '../../../src/compress/relevance.js';
import { compressJson } from '../../../src/compress/json.js';
import type { Ranker } from '../../../src/compress/relevance.js';

/**
 * Bringing your own relevance model.
 *
 * The default is BM25 and that is a competitive position, not a shortcut: no
 * Python, no weights, no RAM floor, deterministic. But lexical has a real
 * ceiling, and somebody with a model and a reason to run it should be able to.
 *
 * NOTHING HERE IS EVIDENCE THAT AN ONNX MODEL HELPS. `onnxruntime-node` is not
 * installed and no weights are shipped. The fake below is a lookup table
 * standing in for an encoder; what these tests prove is that the seam works,
 * that the default is untouched when nothing is registered, and that a
 * misbehaving model degrades instead of failing the request.
 */

afterEach(() => resetRanker());

/**
 * A stand-in "semantic" ranker: a hand-written synonym table.
 *
 * Deliberately solves a case BM25 CANNOT -- the query and the answer share no
 * token at all -- so a test using it is checking that the registered ranker is
 * really in charge, not that some ranking happened.
 */
const SYNONYMS: Record<string, string[]> = {
  handles: ['pool', 'exhausted', 'connection'],
  database: ['pool', 'connection'],
};

function fakeSemanticRanker(query: string | undefined): Ranker {
  const terms = String(query ?? '')
    .toLowerCase()
    .match(/[a-z]+/g);
  const expanded = new Set<string>();
  for (const term of terms ?? []) {
    expanded.add(term);
    for (const synonym of SYNONYMS[term] ?? []) expanded.add(synonym);
  }
  return {
    active: expanded.size > 0,
    top(units, n) {
      const scored = units
        .map((unit, index) => {
          const words = unit.toLowerCase().match(/[a-z]+/g) ?? [];
          return { index, hits: words.filter((w) => expanded.has(w)).length };
        })
        .filter((s) => s.hits > 0)
        .sort((a, b) => b.hits - a.hits || a.index - b.index)
        .slice(0, n)
        .map((s) => s.index);
      return new Set(scored);
    },
    score: () => 0,
  };
}

describe('the seam', () => {
  it('uses the lexical ranker until something is registered', () => {
    expect(rankerIsCustom()).toBe(false);
    const units = ['worker 7 handled request 4471', 'the cache was warmed'];
    expect([...activeRanker('4471').top(units, 1)]).toEqual([
      ...lexicalRanker('4471').top(units, 1),
    ]);
  });

  it('hands over once a ranker is registered, and hands back on reset', () => {
    registerRanker(fakeSemanticRanker);
    expect(rankerIsCustom()).toBe(true);
    resetRanker();
    expect(rankerIsCustom()).toBe(false);
  });

  it('refuses something that is not a factory', () => {
    expect(() => registerRanker(null as never)).toThrow();
  });
});

describe('a registered ranker is really in charge', () => {
  /**
   * Rows sharing no token with the question, so lexical scoring cannot reach
   * the answer however it is tokenised.
   */
  const rows = (): string =>
    JSON.stringify(
      Array.from({ length: 60 }, (_, i) => ({
        id: `evt_${i}`,
        level: 'info',
        message:
          i === 47
            ? 'connection pool exhausted'
            : 'routine heartbeat from the scheduler',
      }))
    );

  const spill = (): string => '/spill/rows.json';
  const question = 'why did the database run out of handles';

  it('BM25 cannot find the answer, which is the point of the fixture', () => {
    // If this ever starts passing, the fixture stopped testing what it claims
    // and the test below proves nothing. The positive assertions matter as
    // much as the negative one: without them this would also pass if the call
    // threw, returned nothing, or was never reached.
    const out = compressJson(rows(), { spill, query: question });

    expect(out.text).toContain('evt_0');
    expect(out.text).toContain('more row');
    expect(out.text.length).toBeLessThan(rows().length);
    expect(out.text).not.toContain('connection pool exhausted');
  });

  it('the registered ranker does', () => {
    registerRanker(fakeSemanticRanker);
    const out = compressJson(rows(), { spill, query: question });
    expect(out.text).toContain('connection pool exhausted');
  });
});

describe('a misbehaving model degrades, it does not fail the request', () => {
  const units = ['alpha beta gamma', 'delta epsilon zeta', 'eta theta iota'];

  it('falls back when the factory throws', () => {
    registerRanker(() => {
      throw new Error('failed to load weights');
    });
    expect(activeRanker('alpha').active).toBe(true);
    expect([...activeRanker('alpha').top(units, 1)]).toEqual([0]);
  });

  it('falls back when top() throws at inference time', () => {
    // Construction succeeding and inference failing is the likelier shape: a
    // session loads, then an input has a shape it did not expect.
    registerRanker(() => ({
      active: true,
      top: () => {
        throw new Error('shape mismatch');
      },
      score: () => 0,
    }));
    expect([...activeRanker('alpha').top(units, 1)]).toEqual([0]);
  });

  it('falls back when the factory returns something malformed', () => {
    registerRanker(() => ({ active: true }) as never);
    expect([...activeRanker('alpha').top(units, 1)]).toEqual([0]);
  });

  it('rejects indices outside the input rather than corrupting the selection', () => {
    // An out-of-range index would silently select the wrong unit, or none,
    // which is worse than not ranking at all.
    registerRanker(() => ({
      active: true,
      top: () => new Set([0, 99]),
      score: () => 0,
    }));
    expect([...activeRanker('alpha').top(units, 2)]).toEqual([0]);
  });

  it('treats a non-finite score as zero', () => {
    registerRanker(() => ({
      active: true,
      top: () => new Set<number>(),
      score: () => Number.NaN,
    }));
    expect(activeRanker('alpha').score('alpha beta gamma', units)).toBe(0);
  });
});
