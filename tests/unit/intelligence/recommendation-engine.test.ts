import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CacheEngine } from '../../../src/core/cache-engine.js';
import { TokenCounter } from '../../../src/core/token-counter.js';
import { MetricsCollector } from '../../../src/core/metrics.js';
import {
  MODEL_KIND,
  RECOMMENDATIONENGINETOOL,
  RECOMMENDATION_ENGINE_OPERATIONS,
  RecommendationEngine,
  type Interaction,
  type RecommendationEngineOptions,
} from '../../../src/tools/intelligence/recommendation-engine.js';
import { toolSchemaMap } from '../../../src/validation/tool-schemas.js';

/**
 * Every test here pins a value derived from the INPUT.
 *
 * WHY THAT RULE: what this file replaces returned
 * `{ success: true, data: { result: "recommend completed successfully" },
 *    metadata: { confidence: 0.85 } }`
 * for all eight operations, having read none of their arguments. A test
 * asserting `success === true`, or that `recommendations` is an array, would
 * have passed against that. So each case states the similarity or the
 * allocation it expects, worked out from the records below.
 */

/**
 * The interaction set used by the collaborative-filtering cases, and its
 * algebra worked out once.
 *
 * Users sort to [alice, bob, carol] and items to [a, b, c, d], so each item is
 * a vector over those three users:
 *   a = [1,1,0]   b = [1,1,0]   c = [0,1,1]   d = [0,0,1]
 * The cosines are therefore exactly:
 *   a-b = 2/sqrt(2*2) = 1        a-c = 1/sqrt(2*2) = 0.5
 *   b-c = 1/sqrt(2*2) = 0.5      c-d = 1/sqrt(2*1) = 1/sqrt(2)
 *   a-d = 0 and b-d = 0, which are dropped rather than listed.
 */
const INTERACTIONS: Interaction[] = [
  { user: 'alice', item: 'a' },
  { user: 'alice', item: 'b' },
  { user: 'bob', item: 'a' },
  { user: 'bob', item: 'b' },
  { user: 'bob', item: 'c' },
  { user: 'carol', item: 'c' },
  { user: 'carol', item: 'd' },
];
const CD = 1 / Math.SQRT2;

describe('recommendation-engine', () => {
  let directory: string;
  let engine: CacheEngine;
  let tool: RecommendationEngine;

  beforeEach(() => {
    // A temp cache, never the real home cache.
    directory = mkdtempSync(join(tmpdir(), 'recommendation-engine-'));
    engine = new CacheEngine(join(directory, 'c.db'));
    tool = new RecommendationEngine(
      engine,
      new TokenCounter(),
      new MetricsCollector()
    );
  });

  afterEach(() => {
    try {
      engine.close();
    } catch {
      /* already closed */
    }
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      /* windows holds the handle briefly */
    }
  });

  const run = (options: RecommendationEngineOptions) =>
    tool.run({ ...options, useCache: false });

  describe('train', () => {
    it('returns the item-item cosines of the records it was given', async () => {
      const result = await run({
        operation: 'train',
        interactions: INTERACTIONS,
      });
      expect(result.data.kind).toBe(MODEL_KIND);
      expect(result.data.users).toBe(3);
      expect(result.data.items).toBe(4);
      expect(result.data.observations).toBe(7);
      expect(result.data.similarities).toEqual([
        { a: 'a', b: 'b', similarity: 1 },
        { a: 'c', b: 'd', similarity: CD },
        // The two 0.5 pairs tie, so they order by name: a-c before b-c.
        { a: 'a', b: 'c', similarity: 0.5 },
        { a: 'b', b: 'c', similarity: 0.5 },
      ]);
    });

    it('reports how much of the matrix is connected at all', async () => {
      const result = await run({
        operation: 'train',
        interactions: INTERACTIONS,
      });
      /*
       * Four items give six possible pairs and four of them are nonzero. A
       * coverage of 0 would mean no co-use whatsoever, which is why it is
       * reported beside the matrix: an empty recommendation list does not say
       * whether the model or the user is the reason.
       */
      expect(result.data.coverage).toBeCloseTo(4 / 6, 15);
      expect(result.data.isolated).toEqual([]);
      expect(result.data.meanSimilarity).toBeCloseTo(
        (1 + CD + 0.5 + 0.5) / 4,
        15
      );
    });

    it('names an item no pair reaches', async () => {
      const result = await run({
        operation: 'train',
        interactions: [
          { user: 'alice', item: 'a' },
          { user: 'alice', item: 'b' },
          { user: 'bob', item: 'lonely' },
        ],
      });
      /*
       * `lonely` shares no user with anything, so nothing can ever be
       * recommended from it. Listing it is the honest form of that fact.
       */
      expect(result.data.isolated).toEqual(['lonely']);
      expect(result.data.similarities).toEqual([
        { a: 'a', b: 'b', similarity: 1 },
      ]);
      expect(result.data.coverage).toBeCloseTo(1 / 3, 15);
    });

    it('sums repeat observations into one weight', async () => {
      const result = await run({
        operation: 'train',
        interactions: [
          { user: 'alice', item: 'a' },
          { user: 'alice', item: 'a' },
          { user: 'alice', item: 'b', weight: 2 },
          { user: 'bob', item: 'a' },
          { user: 'bob', item: 'b', weight: 1 },
        ],
      });
      /*
       * alice used a twice, so a = [2,1] and b = [2,1]: the vectors stay
       * parallel and the cosine is 1. Counting the repeat as a second
       * dimension instead would have changed the answer.
       */
      expect(result.data.similarities).toEqual([
        { a: 'a', b: 'b', similarity: 1 },
      ]);
      expect(result.data.observations).toBe(5);
    });

    it('refuses an empty or malformed record set', async () => {
      await expect(
        run({ operation: 'train', interactions: [] })
      ).rejects.toThrow(
        'recommendation-engine train: `interactions` is required and must hold at least one { user, item }'
      );
      await expect(
        run({
          operation: 'train',
          interactions: [{ user: 'alice', item: '' }],
        })
      ).rejects.toThrow(
        'recommendation-engine train: interactions[0].item must be a non-empty string'
      );
      await expect(
        run({
          operation: 'train',
          interactions: [{ user: 'alice', item: 'a', weight: 0 }],
        })
      ).rejects.toThrow(
        'recommendation-engine train: interactions[0].weight must be a positive number; received 0'
      );
    });
  });

  describe('recommend', () => {
    it('scores an unused item by its similarity to the used ones', async () => {
      const result = await run({
        operation: 'recommend',
        interactions: INTERACTIONS,
        user: 'alice',
      });
      expect(result.data.profile).toEqual(['a', 'b']);
      expect(result.data.considered).toBe(2);
      /*
       * c scores sim(a,c)*1 + sim(b,c)*1 = 0.5 + 0.5 = 1, from two terms.
       * d scores 0 -- no one who used d used anything alice uses -- and a
       * zero-scoring candidate is dropped rather than ranked last, because a
       * ranked zero reads as a weak recommendation instead of no evidence.
       */
      expect(result.data.recommendations).toEqual([
        { item: 'c', score: 1, from: 2 },
      ]);
      expect(result.data.found).toBe(1);
    });

    it('never recommends something the user already uses', async () => {
      const result = await run({
        operation: 'recommend',
        interactions: INTERACTIONS,
        user: 'bob',
      });
      /*
       * bob uses a, b and c, so the only candidate is d -- which he can reach,
       * through sim(c,d). Returning a, b or c back to him is how a recommender
       * looks accurate while saying nothing, so the decisive part of this case
       * is that the three he already uses are absent from a list that still
       * has something in it.
       */
      expect(result.data.profile).toEqual(['a', 'b', 'c']);
      expect(result.data.considered).toBe(1);
      expect(result.data.recommendations).toEqual([
        { item: 'd', score: CD, from: 1 },
      ]);
    });

    it('breaks a score tie by item name, so two runs agree', async () => {
      const result = await run({
        operation: 'recommend',
        interactions: INTERACTIONS,
        user: 'carol',
      });
      // sim(c,a) = sim(c,b) = 0.5 and d contributes nothing to either.
      expect(result.data.recommendations).toEqual([
        { item: 'a', score: 0.5, from: 1 },
        { item: 'b', score: 0.5, from: 1 },
      ]);
    });

    it('truncates to topK but reports how many scored', async () => {
      const result = await run({
        operation: 'recommend',
        interactions: INTERACTIONS,
        user: 'carol',
        topK: 1,
      });
      expect(result.data.recommendations).toHaveLength(1);
      // The count before truncation, so topK cannot be mistaken for the total.
      expect(result.data.found).toBe(2);
      expect(result.data.topK).toBe(1);
    });

    it('names the known users when asked about an unknown one', async () => {
      await expect(
        run({
          operation: 'recommend',
          interactions: INTERACTIONS,
          user: 'dave',
        })
      ).rejects.toThrow(
        'recommendation-engine recommend: `user` "dave" has no interactions; known users are alice, bob, carol'
      );
      await expect(
        run({ operation: 'recommend', interactions: INTERACTIONS })
      ).rejects.toThrow(
        'recommendation-engine recommend: `user` is required and must be a non-empty string'
      );
      await expect(
        run({
          operation: 'recommend',
          interactions: INTERACTIONS,
          user: 'alice',
          topK: 0,
        })
      ).rejects.toThrow(
        'recommendation-engine recommend: `topK` must be an integer of at least 1; received 0'
      );
    });
  });

  describe('find-similar', () => {
    it('ranks the neighbours of one item and names the users it was taken over', async () => {
      const result = await run({
        operation: 'find-similar',
        interactions: INTERACTIONS,
        item: 'a',
      });
      expect(result.data.similar).toEqual([
        { item: 'b', similarity: 1 },
        { item: 'c', similarity: 0.5 },
      ]);
      // d never appears: a cosine of exactly 0 is not a weak similarity.
      expect(result.data.found).toBe(2);
      expect(result.data.users).toEqual(['alice', 'bob']);
    });

    it('computes the asymmetric-looking pair the same way from either side', async () => {
      const fromC = await run({
        operation: 'find-similar',
        interactions: INTERACTIONS,
        item: 'c',
      });
      const fromD = await run({
        operation: 'find-similar',
        interactions: INTERACTIONS,
        item: 'd',
      });
      const c = fromC.data.similar as Array<{
        item: string;
        similarity: number;
      }>;
      const d = fromD.data.similar as Array<{
        item: string;
        similarity: number;
      }>;
      expect(c.find((entry) => entry.item === 'd')!.similarity).toBeCloseTo(
        CD,
        15
      );
      expect(d).toEqual([
        { item: 'c', similarity: c.find((e) => e.item === 'd')!.similarity },
      ]);
    });

    it('refuses an item that is not in the records', async () => {
      await expect(
        run({
          operation: 'find-similar',
          interactions: INTERACTIONS,
          item: 'zzz',
        })
      ).rejects.toThrow(
        'recommendation-engine find-similar: `item` "zzz" does not appear in `interactions`'
      );
    });
  });

  describe('personalize', () => {
    it('ranks the caller list and marks what cannot be scored', async () => {
      const result = await run({
        operation: 'personalize',
        interactions: INTERACTIONS,
        user: 'alice',
        candidates: ['d', 'c', 'zzz'],
      });
      expect(result.data.ranked).toEqual([
        { item: 'c', score: 1, known: false, observed: true },
        { item: 'd', score: 0, known: false, observed: true },
        { item: 'zzz', score: 0, known: false, observed: false },
      ]);
      /*
       * d and zzz both score 0, and `observed` is the difference: d was used by
       * someone and simply does not fit, zzz was never used at all. A bare 0
       * for both would hide that.
       */
      expect(result.data.unscorable).toEqual(['zzz']);
    });

    it('marks a candidate the user already uses rather than dropping it', async () => {
      const result = await run({
        operation: 'personalize',
        interactions: INTERACTIONS,
        user: 'alice',
        candidates: ['a', 'c'],
      });
      const ranked = result.data.ranked as Array<Record<string, unknown>>;
      // Unlike recommend, personalize ranks the list it was handed -- so the
      // already-used entry is flagged, because dropping it would silently
      // shorten the caller's own list.
      expect(ranked.find((entry) => entry.item === 'a')!.known).toBe(true);
      expect(ranked.find((entry) => entry.item === 'c')!.known).toBe(false);
      expect(ranked).toHaveLength(2);
    });

    it('refuses an empty candidate list', async () => {
      await expect(
        run({
          operation: 'personalize',
          interactions: INTERACTIONS,
          user: 'alice',
          candidates: [],
        })
      ).rejects.toThrow(
        'recommendation-engine personalize: `candidates` is required and must hold at least one item'
      );
    });
  });

  describe('optimize-workflow', () => {
    const EVENTS = [
      'open',
      'edit',
      'save',
      'open',
      'edit',
      'save',
      'open',
      'edit',
      'test',
    ];

    it('counts every transition and its share of the step it leaves', async () => {
      const result = await run({
        operation: 'optimize-workflow',
        events: EVENTS,
      });
      expect(result.data.events).toBe(9);
      expect(result.data.distinct).toBe(4);
      expect(result.data.transitions).toEqual([
        { from: 'open', to: 'edit', count: 3, share: 1 },
        // edit leaves 3 times: twice to save, once to test.
        { from: 'edit', to: 'save', count: 2, share: 2 / 3 },
        { from: 'save', to: 'open', count: 2, share: 1 },
        { from: 'edit', to: 'test', count: 1, share: 1 / 3 },
      ]);
    });

    it('lists only the steps whose successor never varies', async () => {
      const result = await run({
        operation: 'optimize-workflow',
        events: EVENTS,
      });
      /*
       * open and save each have exactly one successor across the whole log, so
       * they can be merged with it. edit does not, and is absent -- which is
       * the actionable half of this operation and a statement about the
       * caller's log rather than a suggestion invented for them.
       */
      expect(result.data.deterministic).toEqual([
        { from: 'open', to: 'edit', count: 3 },
        { from: 'save', to: 'open', count: 2 },
      ]);
    });

    it('mines the repeated runs at the requested length', async () => {
      const result = await run({
        operation: 'optimize-workflow',
        events: EVENTS,
      });
      // Eight windows of length 2; a run seen once is not reported.
      expect(result.data.repeated).toEqual([
        { pattern: ['open', 'edit'], occurrences: 3, support: 3 / 8 },
        { pattern: ['edit', 'save'], occurrences: 2, support: 0.25 },
        { pattern: ['save', 'open'], occurrences: 2, support: 0.25 },
      ]);
      expect(result.data.sequenceLength).toBe(2);
      expect(result.data.minOccurrences).toBe(2);
    });

    it('follows a longer requested run length', async () => {
      const result = await run({
        operation: 'optimize-workflow',
        events: EVENTS,
        sequenceLength: 3,
      });
      /*
       * Seven windows. Three distinct runs recur twice each -- the same cycle
       * entered at each of its three points -- and open-edit-test, the one
       * window that breaks the cycle, is seen once and so is not reported.
       * They tie on count, so they order lexicographically.
       */
      expect(result.data.repeated).toEqual([
        { pattern: ['edit', 'save', 'open'], occurrences: 2, support: 2 / 7 },
        { pattern: ['open', 'edit', 'save'], occurrences: 2, support: 2 / 7 },
        { pattern: ['save', 'open', 'edit'], occurrences: 2, support: 2 / 7 },
      ]);
    });

    it('refuses a stream with no transition in it', async () => {
      await expect(
        run({ operation: 'optimize-workflow', events: ['open'] })
      ).rejects.toThrow(
        'recommendation-engine optimize-workflow: `events` is required and needs at least 2 events; received 1'
      );
      await expect(run({ operation: 'optimize-workflow' })).rejects.toThrow(
        'recommendation-engine optimize-workflow: `events` is required and needs at least 2 events; received none'
      );
      await expect(
        run({
          operation: 'optimize-workflow',
          events: ['a', 'b'],
          minOccurrences: 1,
        })
      ).rejects.toThrow(
        'recommendation-engine optimize-workflow: `minOccurrences` must be an integer of at least 2, since a run seen once is not a pattern; received 1'
      );
    });
  });

  describe('allocate-resources', () => {
    it('allocates in proportion and spends the capacity exactly', async () => {
      const result = await run({
        operation: 'allocate-resources',
        demands: [
          { label: 'a', demand: 3 },
          { label: 'b', demand: 3 },
          { label: 'c', demand: 1 },
        ],
        capacity: 10,
      });
      /*
       * Quotas are 30/7, 30/7 and 10/7, which floor to 4, 4 and 1 -- nine of
       * ten units. c holds the largest fractional part (0.4285...) so it takes
       * the leftover.
       */
      expect(result.data.allocated).toBe(10);
      expect(result.data.unallocated).toBe(0);
      expect(result.data.remainderOrder).toEqual(['c']);
      const allocations = result.data.allocations as Array<
        Record<string, number | string>
      >;
      expect(
        allocations.map((entry) => [entry.label, entry.allocated])
      ).toEqual([
        ['a', 4],
        ['b', 4],
        ['c', 2],
      ]);
      expect(allocations[2].rounding).toBeCloseTo(2 - 10 / 7, 15);
    });

    it('spends the whole capacity where independent rounding would not', async () => {
      const result = await run({
        operation: 'allocate-resources',
        demands: [
          { label: 'x', demand: 1 },
          { label: 'y', demand: 1 },
          { label: 'z', demand: 1 },
        ],
        capacity: 10,
      });
      /*
       * Three equal claims on ten units: every quota is 3.333..., and rounding
       * each one on its own gives 9 or 12 units, neither of which is the
       * capacity. Largest remainder gives 4+3+3 = 10, with the tie broken by
       * label so the result is reproducible.
       */
      const allocations = result.data.allocations as Array<
        Record<string, number | string>
      >;
      expect(allocations.map((entry) => entry.allocated)).toEqual([4, 3, 3]);
      expect(
        allocations.reduce((sum, entry) => sum + (entry.allocated as number), 0)
      ).toBe(10);
      expect(result.data.remainderOrder).toEqual(['x']);
    });

    it('names the claims that received nothing', async () => {
      const result = await run({
        operation: 'allocate-resources',
        demands: [
          { label: 'big', demand: 100 },
          { label: 'tiny', demand: 1 },
        ],
        capacity: 2,
      });
      /*
       * tiny's quota is 2/101, which floors to 0 and loses the remainder to
       * big. A zero is a result here, so it is named rather than left for the
       * caller to notice as an absence.
       */
      expect(result.data.starved).toEqual(['tiny']);
      expect(result.data.allocated).toBe(2);
    });

    it('allocates nothing from a capacity of zero', async () => {
      const result = await run({
        operation: 'allocate-resources',
        demands: [{ label: 'a', demand: 5 }],
        capacity: 0,
      });
      expect(result.data.allocated).toBe(0);
      expect(result.data.starved).toEqual(['a']);
    });

    it('refuses a missing capacity and an all-zero demand set', async () => {
      await expect(
        run({
          operation: 'allocate-resources',
          demands: [{ label: 'a', demand: 1 }],
        })
      ).rejects.toThrow(
        'recommendation-engine allocate-resources: `capacity` is required and must be an integer of at least 0; received undefined'
      );
      await expect(
        run({
          operation: 'allocate-resources',
          demands: [{ label: 'a', demand: 1 }],
          capacity: 1.5,
        })
      ).rejects.toThrow(
        'recommendation-engine allocate-resources: `capacity` is required and must be an integer of at least 0; received 1.5'
      );
      await expect(
        run({
          operation: 'allocate-resources',
          demands: [
            { label: 'a', demand: 0 },
            { label: 'b', demand: 0 },
          ],
          capacity: 4,
        })
      ).rejects.toThrow(
        'recommendation-engine allocate-resources: every demand is 0, so there is no ratio to allocate by'
      );
      await expect(
        run({
          operation: 'allocate-resources',
          demands: [{ label: 'a', demand: -1 }],
          capacity: 4,
        })
      ).rejects.toThrow(
        'recommendation-engine allocate-resources: demands[0].demand must be a number of at least 0; received -1'
      );
    });
  });

  describe('tune-config', () => {
    const TRIALS = [
      { config: { mode: 'fast', depth: 1 }, score: 10 },
      { config: { mode: 'fast', depth: 2 }, score: 12 },
      { config: { mode: 'safe', depth: 1 }, score: 4 },
      { config: { mode: 'safe', depth: 2 }, score: 6 },
    ];

    it('compares each parameter by the mean score of its values', async () => {
      const result = await run({ operation: 'tune-config', trials: TRIALS });
      expect(result.data.trials).toBe(4);
      const parameters = result.data.parameters as Array<
        Record<string, unknown>
      >;
      /*
       * mode moves the mean score from 5 to 11 and depth from 7 to 9, so mode
       * leads on spread. Ordering by spread is what makes the list actionable:
       * the parameter at the top is the one worth varying.
       */
      expect(parameters.map((entry) => entry.name)).toEqual(['mode', 'depth']);
      expect(parameters[0].values).toEqual([
        { value: 'fast', trials: 2, meanScore: 11 },
        { value: 'safe', trials: 2, meanScore: 5 },
      ]);
      expect(parameters[0].spread).toBe(6);
      expect(parameters[1].values).toEqual([
        { value: 2, trials: 2, meanScore: 9 },
        { value: 1, trials: 2, meanScore: 7 },
      ]);
      expect(parameters[1].spread).toBe(2);
    });

    it('reports the best run beside the per-parameter bests', async () => {
      const result = await run({ operation: 'tune-config', trials: TRIALS });
      expect(result.data.bestTrial).toEqual({
        config: { mode: 'fast', depth: 2 },
        score: 12,
      });
      expect(result.data.suggested).toEqual({ mode: 'fast', depth: 2 });
      // A full grid, so every parameter was observed against both others.
      expect(result.data.confounded).toEqual([]);
      expect(result.data.unvaried).toEqual([]);
    });

    it('names parameters that moved together, because the credit cannot be split', async () => {
      const result = await run({
        operation: 'tune-config',
        trials: [
          { config: { a: 1, b: 1 }, score: 1 },
          { config: { a: 2, b: 2 }, score: 5 },
        ],
      });
      /*
       * a and b changed in lockstep, so each one's apparent effect may belong
       * entirely to the other. Both are named: without this the marginal means
       * would read as two independent findings of the same size.
       */
      expect(result.data.confounded).toEqual(['a', 'b']);
      const parameters = result.data.parameters as Array<
        Record<string, unknown>
      >;
      expect(parameters[0].spread).toBe(4);
      expect(parameters[0].independent).toBe(false);
    });

    it('names a parameter observed at one value only', async () => {
      const result = await run({
        operation: 'tune-config',
        trials: [
          { config: { fixed: 'on', depth: 1 }, score: 1 },
          { config: { fixed: 'on', depth: 2 }, score: 9 },
        ],
      });
      // Nothing can be said about a parameter that never changed.
      expect(result.data.unvaried).toEqual(['fixed']);
      const parameters = result.data.parameters as Array<
        Record<string, unknown>
      >;
      const fixed = parameters.find((entry) => entry.name === 'fixed');
      expect(fixed!.spread).toBe(0);
      expect(fixed!.varied).toBe(false);
    });

    it('handles a parameter only some trials set', async () => {
      const result = await run({
        operation: 'tune-config',
        trials: [
          { config: { depth: 1 }, score: 2 },
          { config: { depth: 1, extra: true }, score: 8 },
        ],
      });
      const parameters = result.data.parameters as Array<
        Record<string, unknown>
      >;
      const extra = parameters.find((entry) => entry.name === 'extra');
      // Grouped over the two trials that set it, which is one of them.
      expect(extra!.values).toEqual([{ value: true, trials: 1, meanScore: 8 }]);
      expect(extra!.varied).toBe(false);
    });

    it('refuses a single trial and a non-numeric score', async () => {
      await expect(
        run({
          operation: 'tune-config',
          trials: [{ config: { a: 1 }, score: 1 }],
        })
      ).rejects.toThrow(
        'recommendation-engine tune-config: `trials` is required and needs at least 2 trials to compare; received 1'
      );
      await expect(
        run({
          operation: 'tune-config',
          trials: [
            { config: { a: 1 }, score: 1 },
            { config: { a: 2 }, score: Number.NaN },
          ],
        })
      ).rejects.toThrow(
        'recommendation-engine tune-config: trials[1].score must be a finite number; received NaN'
      );
      await expect(
        run({
          operation: 'tune-config',
          trials: [
            { config: {}, score: 1 },
            { config: {}, score: 2 },
          ],
        })
      ).rejects.toThrow(
        'recommendation-engine tune-config: no trial names a parameter, so there is nothing to compare'
      );
    });
  });

  describe('explain-recommendation', () => {
    it('returns terms that sum to the score it reported', async () => {
      const result = await run({
        operation: 'explain-recommendation',
        interactions: INTERACTIONS,
        user: 'alice',
        item: 'c',
      });
      expect(result.data.contributions).toEqual([
        { from: 'a', similarity: 0.5, weight: 1, contribution: 0.5 },
        { from: 'b', similarity: 0.5, weight: 1, contribution: 0.5 },
      ]);
      /*
       * The decisive property: the score is the sum of the listed terms, so the
       * figure can be taken apart into the caller's own records rather than
       * being a summary of something computed out of sight.
       */
      const terms = result.data.contributions as Array<{
        contribution: number;
      }>;
      expect(result.data.score).toBe(
        terms.reduce((sum, term) => sum + term.contribution, 0)
      );
      expect(result.data.score).toBe(1);
    });

    it('agrees with the score recommend reported for the same pair', async () => {
      const ranked = await run({
        operation: 'recommend',
        interactions: INTERACTIONS,
        user: 'alice',
      });
      const explained = await run({
        operation: 'explain-recommendation',
        interactions: INTERACTIONS,
        user: 'alice',
        item: 'c',
      });
      const first = (
        ranked.data.recommendations as Array<{ score: number }>
      )[0];
      expect(explained.data.score).toBe(first.score);
    });

    it('says the data is empty rather than implying the item is a poor fit', async () => {
      const result = await run({
        operation: 'explain-recommendation',
        interactions: INTERACTIONS,
        user: 'alice',
        item: 'd',
      });
      expect(result.data.score).toBe(0);
      expect(result.data.contributions).toEqual([]);
      expect(result.data.reason).toBe(
        'no item this user has used was ever used alongside this item'
      );
    });

    it('counts the terms against the profile they came from', async () => {
      const result = await run({
        operation: 'explain-recommendation',
        interactions: INTERACTIONS,
        user: 'bob',
        item: 'd',
      });
      // Only c, of bob's three items, was ever used alongside d.
      expect(result.data.reason).toBe(
        "1 of the user's 3 used items were also used alongside this item"
      );
      expect(result.data.score).toBeCloseTo(CD, 15);
    });

    it('carries the weight into the term, not just the similarity', async () => {
      const result = await run({
        operation: 'explain-recommendation',
        interactions: [
          { user: 'alice', item: 'a', weight: 4 },
          { user: 'bob', item: 'a' },
          { user: 'bob', item: 'b' },
        ],
        user: 'alice',
        item: 'b',
      });
      const terms = result.data.contributions as Array<Record<string, number>>;
      expect(terms).toHaveLength(1);
      expect(terms[0].weight).toBe(4);
      // a = [4,1], b = [0,1], so the cosine is 1/sqrt(17*1).
      expect(terms[0].similarity).toBeCloseTo(1 / Math.sqrt(17), 15);
      expect(terms[0].contribution).toBeCloseTo(4 / Math.sqrt(17), 15);
      expect(result.data.score).toBe(terms[0].contribution);
    });

    it('refuses an unknown user or item', async () => {
      await expect(
        run({
          operation: 'explain-recommendation',
          interactions: INTERACTIONS,
          user: 'alice',
        })
      ).rejects.toThrow(
        'recommendation-engine explain-recommendation: `item` is required and must be a non-empty string'
      );
      await expect(
        run({
          operation: 'explain-recommendation',
          interactions: INTERACTIONS,
          user: 'dave',
          item: 'a',
        })
      ).rejects.toThrow(
        'recommendation-engine explain-recommendation: `user` "dave" has no interactions; known users are alice, bob, carol'
      );
    });
  });

  describe('result envelope', () => {
    it('carries no confidence field at all', async () => {
      const result = await run({
        operation: 'train',
        interactions: INTERACTIONS,
      });
      /*
       * The exact key list, because the stub this replaces reported
       * `confidence: 0.85` for every operation -- a number with no computation
       * behind it. Nothing here may quietly reintroduce one.
       */
      expect(Object.keys(result.metadata).sort()).toEqual([
        'cacheHit',
        'processingTime',
        'tokensSaved',
        'tokensUsed',
      ]);
    });

    it('serves a repeated call from the cache', async () => {
      const options: RecommendationEngineOptions = {
        operation: 'find-similar',
        interactions: INTERACTIONS,
        item: 'a',
      };
      const first = await tool.run(options);
      expect(first.metadata.cacheHit).toBe(false);
      const second = await tool.run(options);
      expect(second.metadata.cacheHit).toBe(true);
      expect(second.data).toEqual(first.data);
    });

    it('refuses an operation that is not published', async () => {
      await expect(run({ operation: 'auto-tune' as never })).rejects.toThrow(
        'recommendation-engine: unknown operation "auto-tune"'
      );
    });
  });

  describe('published schema', () => {
    const schema = toolSchemaMap['recommendation-engine'];
    const ONE: Interaction[] = [{ user: 'u', item: 'i' }];

    /**
     * These rows check that the conditional requirements are enforced by the
     * schema `tools/list` publishes, not merely described in a property
     * description a client cannot act on.
     */
    const SCHEMA_CASES: ReadonlyArray<readonly [string, unknown, boolean]> = [
      [
        'train with interactions',
        { operation: 'train', interactions: ONE },
        true,
      ],
      ['train without interactions', { operation: 'train' }, false],
      [
        'train with an empty set',
        { operation: 'train', interactions: [] },
        false,
      ],
      [
        'train with an extra interaction key',
        {
          operation: 'train',
          interactions: [{ user: 'u', item: 'i', note: 'x' }],
        },
        false,
      ],
      [
        'train with a zero weight',
        {
          operation: 'train',
          interactions: [{ user: 'u', item: 'i', weight: 0 }],
        },
        false,
      ],
      [
        'recommend with a user',
        { operation: 'recommend', interactions: ONE, user: 'u' },
        true,
      ],
      [
        'recommend without a user',
        { operation: 'recommend', interactions: ONE },
        false,
      ],
      [
        'recommend with a zero topK',
        { operation: 'recommend', interactions: ONE, user: 'u', topK: 0 },
        false,
      ],
      [
        'find-similar with an item',
        { operation: 'find-similar', interactions: ONE, item: 'i' },
        true,
      ],
      [
        'find-similar without an item',
        { operation: 'find-similar', interactions: ONE },
        false,
      ],
      [
        'personalize with candidates',
        {
          operation: 'personalize',
          interactions: ONE,
          user: 'u',
          candidates: ['i'],
        },
        true,
      ],
      [
        'personalize without candidates',
        { operation: 'personalize', interactions: ONE, user: 'u' },
        false,
      ],
      [
        'personalize with an empty candidate list',
        {
          operation: 'personalize',
          interactions: ONE,
          user: 'u',
          candidates: [],
        },
        false,
      ],
      [
        'explain-recommendation with both names',
        {
          operation: 'explain-recommendation',
          interactions: ONE,
          user: 'u',
          item: 'i',
        },
        true,
      ],
      [
        'explain-recommendation without an item',
        { operation: 'explain-recommendation', interactions: ONE, user: 'u' },
        false,
      ],
      [
        'optimize-workflow with two events',
        { operation: 'optimize-workflow', events: ['a', 'b'] },
        true,
      ],
      [
        'optimize-workflow with one event',
        { operation: 'optimize-workflow', events: ['a'] },
        false,
      ],
      [
        'optimize-workflow without events',
        { operation: 'optimize-workflow' },
        false,
      ],
      [
        'optimize-workflow with minOccurrences of one',
        {
          operation: 'optimize-workflow',
          events: ['a', 'b'],
          minOccurrences: 1,
        },
        false,
      ],
      [
        'allocate-resources with demands and capacity',
        {
          operation: 'allocate-resources',
          demands: [{ label: 'a', demand: 1 }],
          capacity: 1,
        },
        true,
      ],
      [
        'allocate-resources without a capacity',
        {
          operation: 'allocate-resources',
          demands: [{ label: 'a', demand: 1 }],
        },
        false,
      ],
      [
        'allocate-resources with a negative demand',
        {
          operation: 'allocate-resources',
          demands: [{ label: 'a', demand: -1 }],
          capacity: 1,
        },
        false,
      ],
      [
        'allocate-resources with a fractional capacity',
        {
          operation: 'allocate-resources',
          demands: [{ label: 'a', demand: 1 }],
          capacity: 1.5,
        },
        false,
      ],
      [
        'tune-config with two trials',
        {
          operation: 'tune-config',
          trials: [
            { config: { a: 1 }, score: 1 },
            { config: { a: 2 }, score: 2 },
          ],
        },
        true,
      ],
      [
        'tune-config with one trial',
        { operation: 'tune-config', trials: [{ config: { a: 1 }, score: 1 }] },
        false,
      ],
      ['tune-config without trials', { operation: 'tune-config' }, false],
      [
        'an unknown key',
        { operation: 'train', interactions: ONE, depth: 2 },
        false,
      ],
      ['an unpublished operation', { operation: 'auto-tune' }, false],
    ];

    it('publishes exactly the operations the tool dispatches', () => {
      /*
       * The enum in the definition and the array the switch reads are the same
       * array by construction; this pins that the published enum is that array
       * and nothing else, so an operation cannot be advertised without a branch
       * to serve it.
       */
      expect(
        RECOMMENDATIONENGINETOOL.inputSchema.properties.operation.enum
      ).toEqual([...RECOMMENDATION_ENGINE_OPERATIONS]);
      expect(RECOMMENDATION_ENGINE_OPERATIONS).toHaveLength(8);
    });

    it.each(SCHEMA_CASES)('%s', (_label, input, accepted) => {
      expect(schema.safeParse(input).success).toBe(accepted);
    });

    it('refuses more of these cases than it accepts', () => {
      /*
       * A guard on the table itself: a schema that accepted everything would
       * pass every positive row above, so the negative rows have to dominate.
       */
      const refusals = SCHEMA_CASES.filter(
        ([, , accepted]) => !accepted
      ).length;
      expect(refusals).toBeGreaterThan(SCHEMA_CASES.length / 2);
    });
  });
});
