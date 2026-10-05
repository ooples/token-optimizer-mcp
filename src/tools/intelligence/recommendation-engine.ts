/**
 * RecommendationEngine -- item-based collaborative filtering, workflow
 * transition analysis, proportional allocation and marginal config comparison,
 * all computed from the caller's own records.
 *
 * WHAT WAS HERE: all eight published operations returned
 * `{ success: true, data: { result: "<operation> completed successfully" } }`
 * with a hard-coded `confidence: 0.85`, having read none of their input.
 *
 * WHAT "TRAINING" MEANS HERE, since the word invites the wrong expectation:
 * nothing is learned and nothing is stored. The model is the item-item cosine
 * similarity matrix of the interactions passed in, which is a function of that
 * data and nothing else -- so every operation recomputes it from
 * `interactions` rather than reading a hidden copy. `train` exists to return
 * that matrix and its diagnostics (how sparse, how many items are reachable at
 * all) because those are what decide whether a recommendation from this data
 * means anything, and a caller cannot see them from a ranked list.
 *
 * WHAT THE SCORES ARE NOT: a score here is a weighted sum of similarities to
 * things the user already used. It is not a probability, not a rating, and not
 * comparable between two different interaction sets. `explain-recommendation`
 * returns the individual terms, and they sum to the score -- so any figure this
 * tool reports can be taken apart into the caller's own records.
 *
 * An operation whose inputs are absent REFUSES, naming the missing key.
 */

import type { CacheEngine } from '../../core/cache-engine.js';
import type { TokenCounter } from '../../core/token-counter.js';
import type { MetricsCollector } from '../../core/metrics.js';
import { generateCacheKey } from '../shared/hash-utils.js';
import { cosineSimilarity, mean, mineSequences } from './analytics-core.js';
import {
  sharedCache,
  sharedTokenCounter,
  sharedMetricsCollector,
} from './shared-instances.js';

/**
 * The operations, in one place: the TS union and the published enum are both
 * derived from this array, so they cannot drift apart.
 */
export const RECOMMENDATION_ENGINE_OPERATIONS = [
  'recommend',
  'train',
  'find-similar',
  'personalize',
  'optimize-workflow',
  'allocate-resources',
  'tune-config',
  'explain-recommendation',
] as const;

export type RecommendationEngineOperation =
  (typeof RECOMMENDATION_ENGINE_OPERATIONS)[number];

/** The one similarity this engine computes, named in what it returns. */
export const MODEL_KIND = 'item-cosine';

/**
 * Defaults. Each is a presentation choice reported back in the result, never a
 * stand-in for a missing input: `minOccurrences` is 2 because a run seen once
 * is not a pattern, and `topK` only truncates a list that is already ranked.
 */
export const RECOMMENDATION_ENGINE_DEFAULTS = Object.freeze({
  topK: 10,
  sequenceLength: 2,
  minOccurrences: 2,
});

/** One observed use: who used what, and how much it counted. */
export interface Interaction {
  user: string;
  item: string;
  /** Defaults to 1, so a plain usage log needs no weights. */
  weight?: number;
}

/** One claim on a fixed capacity. */
export interface Demand {
  label: string;
  demand: number;
}

/** One measured run of a configuration. */
export interface ConfigTrial {
  config: Record<string, string | number | boolean>;
  score: number;
}

export interface RecommendationEngineOptions {
  operation: RecommendationEngineOperation;
  /** recommend, train, find-similar, personalize, explain-recommendation. */
  interactions?: Interaction[];
  user?: string;
  item?: string;
  candidates?: string[];
  topK?: number;
  /** optimize-workflow. */
  events?: string[];
  sequenceLength?: number;
  minOccurrences?: number;
  /** allocate-resources. */
  demands?: Demand[];
  capacity?: number;
  /** tune-config. */
  trials?: ConfigTrial[];
  useCache?: boolean;
}

export interface RecommendationEngineResult {
  success: boolean;
  operation: string;
  data: Record<string, unknown>;
  metadata: {
    tokensUsed: number;
    tokensSaved: number;
    cacheHit: boolean;
    processingTime: number;
  };
}

/** One item-item similarity, as returned and as used to score. */
export interface ItemSimilarity {
  a: string;
  b: string;
  similarity: number;
}

/**
 * The interaction set, indexed the two ways scoring needs it: per user, and
 * per item as a vector over users. Built fresh per call, because it is a pure
 * function of `interactions` and a cached copy could disagree with them.
 */
interface InteractionIndex {
  users: string[];
  items: string[];
  /** user -> item -> weight, with repeat observations summed. */
  byUser: Map<string, Map<string, number>>;
  /** item -> its vector over `users`, in that order. */
  vectors: Map<string, number[]>;
}

const requireInteractions = (
  operation: string,
  interactions: Interaction[] | undefined
): Interaction[] => {
  if (!Array.isArray(interactions) || interactions.length === 0)
    throw new Error(
      `recommendation-engine ${operation}: \`interactions\` is required and must hold at least one { user, item }`
    );
  interactions.forEach((entry, index) => {
    if (typeof entry?.user !== 'string' || entry.user.length === 0)
      throw new Error(
        `recommendation-engine ${operation}: interactions[${index}].user must be a non-empty string`
      );
    if (typeof entry.item !== 'string' || entry.item.length === 0)
      throw new Error(
        `recommendation-engine ${operation}: interactions[${index}].item must be a non-empty string`
      );
    if (
      entry.weight !== undefined &&
      !(Number.isFinite(entry.weight) && entry.weight > 0)
    )
      throw new Error(
        `recommendation-engine ${operation}: interactions[${index}].weight must be a positive number; received ${String(entry.weight)}`
      );
  });
  return interactions;
};

const requireName = (
  operation: string,
  key: string,
  value: string | undefined
): string => {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(
      `recommendation-engine ${operation}: \`${key}\` is required and must be a non-empty string`
    );
  return value;
};

const positiveInteger = (
  operation: string,
  key: string,
  value: number | undefined,
  fallback: number
): number => {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1)
    throw new Error(
      `recommendation-engine ${operation}: \`${key}\` must be an integer of at least 1; received ${String(value)}`
    );
  return value;
};

/** Sorted so two runs over the same records produce the same output order. */
const indexInteractions = (interactions: Interaction[]): InteractionIndex => {
  const byUser = new Map<string, Map<string, number>>();
  for (const entry of interactions) {
    const items = byUser.get(entry.user) ?? new Map<string, number>();
    items.set(entry.item, (items.get(entry.item) ?? 0) + (entry.weight ?? 1));
    byUser.set(entry.user, items);
  }
  const users = [...byUser.keys()].sort();
  const items = [...new Set(interactions.map((entry) => entry.item))].sort();
  const vectors = new Map<string, number[]>();
  for (const item of items)
    vectors.set(
      item,
      users.map((user) => byUser.get(user)?.get(item) ?? 0)
    );
  return { users, items, byUser, vectors };
};

/**
 * The upper triangle of the item-item cosine matrix, nonzero entries only.
 *
 * Zero entries are dropped rather than listed: two items no one used together
 * have a cosine of exactly 0, and carrying O(items^2) zeroes would bury the
 * entries that carry information. `coverage` in `train` reports how much of
 * the matrix that leaves.
 */
const similarities = (index: InteractionIndex): ItemSimilarity[] => {
  const found: ItemSimilarity[] = [];
  for (let i = 0; i < index.items.length; i += 1)
    for (let j = i + 1; j < index.items.length; j += 1) {
      const a = index.items[i];
      const b = index.items[j];
      const left = index.vectors.get(a);
      const right = index.vectors.get(b);
      if (left === undefined || right === undefined) continue;
      const similarity = cosineSimilarity(left, right);
      if (similarity !== 0) found.push({ a, b, similarity });
    }
  found.sort(
    (left, right) =>
      right.similarity - left.similarity ||
      left.a.localeCompare(right.a) ||
      left.b.localeCompare(right.b)
  );
  return found;
};

/** similarity(item, other) for every other item, from the pair list. */
const neighbourMap = (
  pairs: readonly ItemSimilarity[]
): Map<string, Map<string, number>> => {
  const map = new Map<string, Map<string, number>>();
  const add = (from: string, to: string, value: number) => {
    const row = map.get(from) ?? new Map<string, number>();
    row.set(to, value);
    map.set(from, row);
  };
  for (const pair of pairs) {
    add(pair.a, pair.b, pair.similarity);
    add(pair.b, pair.a, pair.similarity);
  }
  return map;
};

/** One term of a score: a thing the user used, and what it contributed. */
interface Contribution {
  from: string;
  similarity: number;
  weight: number;
  contribution: number;
}

/**
 * The terms of the score for one candidate item, each naming the item the user
 * already used that produced it. The score is their sum, so the figure is
 * always decomposable into the caller's own records.
 */
const contributions = (
  profile: Map<string, number>,
  neighbours: Map<string, Map<string, number>>,
  candidate: string
): Contribution[] => {
  const terms: Contribution[] = [];
  for (const [used, weight] of profile) {
    if (used === candidate) continue;
    const similarity = neighbours.get(used)?.get(candidate) ?? 0;
    if (similarity === 0) continue;
    terms.push({
      from: used,
      similarity,
      weight,
      contribution: similarity * weight,
    });
  }
  terms.sort(
    (left, right) =>
      right.contribution - left.contribution ||
      left.from.localeCompare(right.from)
  );
  return terms;
};

const sumContributions = (terms: readonly Contribution[]): number =>
  terms.reduce((total, term) => total + term.contribution, 0);

export class RecommendationEngine {
  private cache: CacheEngine;
  private tokenCounter: TokenCounter;
  private metricsCollector: MetricsCollector;

  constructor(
    cache: CacheEngine,
    tokenCounter: TokenCounter,
    metricsCollector: MetricsCollector
  ) {
    this.cache = cache;
    this.tokenCounter = tokenCounter;
    this.metricsCollector = metricsCollector;
  }

  async run(
    options: RecommendationEngineOptions
  ): Promise<RecommendationEngineResult> {
    const startTime = Date.now();
    const cacheKey = generateCacheKey('recommendation-engine', {
      op: options.operation,
      args: JSON.stringify(options),
    });

    if (options.useCache !== false) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        try {
          const data = JSON.parse(cached.toString()) as Record<string, unknown>;
          return {
            success: true,
            operation: options.operation,
            data,
            metadata: {
              tokensUsed: 0,
              tokensSaved: this.tokenCounter.count(JSON.stringify(data)).tokens,
              cacheHit: true,
              processingTime: Date.now() - startTime,
            },
          };
        } catch {
          // A corrupt entry is recomputed rather than served.
        }
      }
    }

    const data = this.compute(options);
    const dataStr = JSON.stringify(data);
    this.cache.set(cacheKey, dataStr, dataStr.length, dataStr.length);
    this.metricsCollector.record({
      operation: `recommendation-engine:${options.operation}`,
      duration: Date.now() - startTime,
      success: true,
      cacheHit: false,
    });

    return {
      success: true,
      operation: options.operation,
      data,
      metadata: {
        tokensUsed: this.tokenCounter.count(dataStr).tokens,
        tokensSaved: 0,
        cacheHit: false,
        processingTime: Date.now() - startTime,
      },
    };
  }

  /**
   * One branch per published operation. No fall-through: a value added to the
   * published enum without an implementation here reaches the default and is
   * refused rather than quietly served by a neighbour.
   */
  private compute(
    options: RecommendationEngineOptions
  ): Record<string, unknown> {
    const operation = options.operation;
    switch (operation) {
      case 'recommend':
        return this.recommend(options);
      case 'train':
        return this.train(options);
      case 'find-similar':
        return this.findSimilar(options);
      case 'personalize':
        return this.personalize(options);
      case 'optimize-workflow':
        return this.optimizeWorkflow(options);
      case 'allocate-resources':
        return this.allocateResources(options);
      case 'tune-config':
        return this.tuneConfig(options);
      case 'explain-recommendation':
        return this.explainRecommendation(options);
      default:
        throw new Error(
          `recommendation-engine: unknown operation ${JSON.stringify(operation)}`
        );
    }
  }

  /**
   * The item-item model and the diagnostics that say whether anything built on
   * it can mean much: how many of the possible pairs are connected at all, and
   * how many items no pair reaches.
   */
  private train(options: RecommendationEngineOptions): Record<string, unknown> {
    const interactions = requireInteractions('train', options.interactions);
    const index = indexInteractions(interactions);
    const pairs = similarities(index);
    const possible = (index.items.length * (index.items.length - 1)) / 2;
    const connected = new Set<string>();
    for (const pair of pairs) {
      connected.add(pair.a);
      connected.add(pair.b);
    }
    return {
      kind: MODEL_KIND,
      users: index.users.length,
      items: index.items.length,
      observations: interactions.length,
      /*
       * The fraction of item pairs with a nonzero cosine. A model at 0 has no
       * co-use at all and every recommendation from it would be empty -- which
       * a ranked list of nothing does not explain.
       */
      coverage: possible === 0 ? 0 : pairs.length / possible,
      /** Items no pair reaches: nothing can ever be recommended from them. */
      isolated: index.items.filter((item) => !connected.has(item)),
      meanSimilarity:
        pairs.length === 0 ? 0 : mean(pairs.map((pair) => pair.similarity)),
      similarities: pairs,
    };
  }

  /**
   * Items the user has not used, scored by similarity to the ones they have.
   * Items already in the profile are excluded -- recommending something back
   * to the person already using it is the classic way a recommender looks
   * accurate while saying nothing.
   */
  private recommend(
    options: RecommendationEngineOptions
  ): Record<string, unknown> {
    const interactions = requireInteractions('recommend', options.interactions);
    const user = requireName('recommend', 'user', options.user);
    const topK = positiveInteger(
      'recommend',
      'topK',
      options.topK,
      RECOMMENDATION_ENGINE_DEFAULTS.topK
    );
    const index = indexInteractions(interactions);
    const profile = index.byUser.get(user);
    if (profile === undefined)
      throw new Error(
        `recommendation-engine recommend: \`user\` ${JSON.stringify(user)} has no interactions; known users are ${index.users.join(', ')}`
      );
    const neighbours = neighbourMap(similarities(index));
    const scored = index.items
      .filter((item) => !profile.has(item))
      .map((item) => {
        const terms = contributions(profile, neighbours, item);
        return { item, score: sumContributions(terms), from: terms.length };
      })
      .filter((entry) => entry.score > 0);
    scored.sort(
      (left, right) =>
        right.score - left.score || left.item.localeCompare(right.item)
    );
    return {
      user,
      /*
       * What the user already uses, returned because it is what the scores are
       * built from: a reader cannot check a ranking without it.
       */
      profile: [...profile.keys()].sort(),
      considered: index.items.length - profile.size,
      recommendations: scored.slice(0, topK),
      /** Candidates with a score, before topK truncated the list. */
      found: scored.length,
      topK,
    };
  }

  private findSimilar(
    options: RecommendationEngineOptions
  ): Record<string, unknown> {
    const interactions = requireInteractions(
      'find-similar',
      options.interactions
    );
    const item = requireName('find-similar', 'item', options.item);
    const topK = positiveInteger(
      'find-similar',
      'topK',
      options.topK,
      RECOMMENDATION_ENGINE_DEFAULTS.topK
    );
    const index = indexInteractions(interactions);
    if (!index.vectors.has(item))
      throw new Error(
        `recommendation-engine find-similar: \`item\` ${JSON.stringify(item)} does not appear in \`interactions\``
      );
    const row = neighbourMap(similarities(index)).get(item);
    const neighbours = [...(row?.entries() ?? [])]
      .map(([other, similarity]) => ({ item: other, similarity }))
      .sort(
        (left, right) =>
          right.similarity - left.similarity ||
          left.item.localeCompare(right.item)
      );
    return {
      item,
      /** Users who used it: the vector every similarity below is taken over. */
      users: index.users.filter(
        (user) => (index.byUser.get(user)?.get(item) ?? 0) > 0
      ),
      similar: neighbours.slice(0, topK),
      found: neighbours.length,
      topK,
    };
  }

  /**
   * Rank a list the caller already chose, rather than choosing one. Each
   * candidate is marked `known` when the user already uses it, because a
   * ranking that silently mixed the two would be read as all-new.
   */
  private personalize(
    options: RecommendationEngineOptions
  ): Record<string, unknown> {
    const interactions = requireInteractions(
      'personalize',
      options.interactions
    );
    const user = requireName('personalize', 'user', options.user);
    const candidates = options.candidates;
    if (!Array.isArray(candidates) || candidates.length === 0)
      throw new Error(
        'recommendation-engine personalize: `candidates` is required and must hold at least one item'
      );
    const index = indexInteractions(interactions);
    const profile = index.byUser.get(user);
    if (profile === undefined)
      throw new Error(
        `recommendation-engine personalize: \`user\` ${JSON.stringify(user)} has no interactions; known users are ${index.users.join(', ')}`
      );
    const neighbours = neighbourMap(similarities(index));
    const ranked = candidates.map((candidate) => {
      if (typeof candidate !== 'string' || candidate.length === 0)
        throw new Error(
          'recommendation-engine personalize: every candidate must be a non-empty string'
        );
      const terms = contributions(profile, neighbours, candidate);
      return {
        item: candidate,
        score: sumContributions(terms),
        known: profile.has(candidate),
        /*
         * A candidate absent from `interactions` scores 0 for want of data,
         * not for want of fit -- a distinction a bare 0 would hide.
         */
        observed: index.vectors.has(candidate),
      };
    });
    ranked.sort(
      (left, right) =>
        right.score - left.score || left.item.localeCompare(right.item)
    );
    return {
      user,
      ranked,
      unscorable: ranked.filter((entry) => !entry.observed).map((e) => e.item),
    };
  }

  /**
   * Transition counts over one ordered event stream, plus the steps whose next
   * step never varies.
   *
   * The deterministic transitions are the actionable part: a step always
   * followed by the same step can be merged, and that is a statement about the
   * caller's log rather than a suggestion invented for them.
   */
  private optimizeWorkflow(
    options: RecommendationEngineOptions
  ): Record<string, unknown> {
    const events = options.events;
    if (!Array.isArray(events) || events.length < 2)
      throw new Error(
        `recommendation-engine optimize-workflow: \`events\` is required and needs at least 2 events; received ${Array.isArray(events) ? events.length : 'none'}`
      );
    events.forEach((event, position) => {
      if (typeof event !== 'string' || event.length === 0)
        throw new Error(
          `recommendation-engine optimize-workflow: events[${position}] must be a non-empty string`
        );
    });
    const sequenceLength = positiveInteger(
      'optimize-workflow',
      'sequenceLength',
      options.sequenceLength,
      RECOMMENDATION_ENGINE_DEFAULTS.sequenceLength
    );
    const minOccurrences =
      options.minOccurrences ?? RECOMMENDATION_ENGINE_DEFAULTS.minOccurrences;
    if (!Number.isInteger(minOccurrences) || minOccurrences < 2)
      throw new Error(
        `recommendation-engine optimize-workflow: \`minOccurrences\` must be an integer of at least 2, since a run seen once is not a pattern; received ${String(minOccurrences)}`
      );
    const outgoing = new Map<string, Map<string, number>>();
    for (let position = 0; position < events.length - 1; position += 1) {
      const from = events[position];
      const row = outgoing.get(from) ?? new Map<string, number>();
      row.set(events[position + 1], (row.get(events[position + 1]) ?? 0) + 1);
      outgoing.set(from, row);
    }
    const transitions: Array<{
      from: string;
      to: string;
      count: number;
      share: number;
    }> = [];
    const deterministic: Array<{ from: string; to: string; count: number }> =
      [];
    for (const [from, row] of outgoing) {
      const total = [...row.values()].reduce((sum, count) => sum + count, 0);
      for (const [to, count] of row)
        transitions.push({ from, to, count, share: count / total });
      if (row.size === 1) {
        const [to, count] = [...row.entries()][0];
        // Only worth collapsing when it was seen more than once.
        if (count >= minOccurrences) deterministic.push({ from, to, count });
      }
    }
    transitions.sort(
      (left, right) =>
        right.count - left.count ||
        left.from.localeCompare(right.from) ||
        left.to.localeCompare(right.to)
    );
    deterministic.sort(
      (left, right) =>
        right.count - left.count || left.from.localeCompare(right.from)
    );
    return {
      events: events.length,
      distinct: new Set(events).size,
      transitions,
      deterministic,
      sequenceLength,
      minOccurrences,
      repeated: mineSequences(events, sequenceLength, minOccurrences),
    };
  }

  /**
   * Proportional allocation of an integer capacity by the largest-remainder
   * method: floor each share, then hand the leftover units to the largest
   * fractional parts.
   *
   * WHY LARGEST REMAINDER: rounding each share independently does not sum to
   * the capacity, so the allocation either overspends or leaves units
   * unassigned without saying so. Here the allocated units equal `capacity`
   * exactly, and `remainderOrder` shows which claims received a leftover unit
   * and why, so the arithmetic can be checked by hand.
   */
  private allocateResources(
    options: RecommendationEngineOptions
  ): Record<string, unknown> {
    const demands = options.demands;
    if (!Array.isArray(demands) || demands.length === 0)
      throw new Error(
        'recommendation-engine allocate-resources: `demands` is required and must hold at least one { label, demand }'
      );
    demands.forEach((entry, position) => {
      if (typeof entry?.label !== 'string' || entry.label.length === 0)
        throw new Error(
          `recommendation-engine allocate-resources: demands[${position}].label must be a non-empty string`
        );
      if (!Number.isFinite(entry.demand) || entry.demand < 0)
        throw new Error(
          `recommendation-engine allocate-resources: demands[${position}].demand must be a number of at least 0; received ${String(entry.demand)}`
        );
    });
    const requested = options.capacity;
    if (
      requested === undefined ||
      !Number.isInteger(requested) ||
      requested < 0
    )
      throw new Error(
        `recommendation-engine allocate-resources: \`capacity\` is required and must be an integer of at least 0; received ${String(requested)}`
      );
    // Bound after the check so the arithmetic below is over a known integer.
    const capacity: number = requested;
    const total = demands.reduce((sum, entry) => sum + entry.demand, 0);
    if (total === 0)
      throw new Error(
        'recommendation-engine allocate-resources: every demand is 0, so there is no ratio to allocate by'
      );
    const quotas = demands.map((entry) => {
      const share = entry.demand / total;
      const quota = share * capacity;
      const floor = Math.floor(quota);
      return {
        label: entry.label,
        demand: entry.demand,
        share,
        quota,
        allocated: floor,
        remainder: quota - floor,
      };
    });
    let assigned = quotas.reduce((sum, entry) => sum + entry.allocated, 0);
    /*
     * Ties broken by larger demand then label, so the same input always
     * produces the same allocation -- an allocation that moved between runs
     * would be unauditable.
     */
    const byRemainder = [...quotas].sort(
      (left, right) =>
        right.remainder - left.remainder ||
        right.demand - left.demand ||
        left.label.localeCompare(right.label)
    );
    const awarded: string[] = [];
    for (const entry of byRemainder) {
      if (assigned >= capacity) break;
      entry.allocated += 1;
      assigned += 1;
      awarded.push(entry.label);
    }
    const allocations = quotas.map((entry) => ({
      label: entry.label,
      demand: entry.demand,
      share: entry.share,
      quota: entry.quota,
      allocated: entry.allocated,
      /** Allocated minus the exact quota: who gained and who lost on rounding. */
      rounding: entry.allocated - entry.quota,
    }));
    allocations.sort(
      (left, right) =>
        right.allocated - left.allocated ||
        right.demand - left.demand ||
        left.label.localeCompare(right.label)
    );
    return {
      capacity,
      totalDemand: total,
      /** Equals `capacity` by construction; reported so it can be checked. */
      allocated: assigned,
      unallocated: capacity - assigned,
      allocations,
      remainderOrder: awarded,
      /** Claims that received nothing: a zero is a result, not an omission. */
      starved: allocations
        .filter((entry) => entry.allocated === 0)
        .map((entry) => entry.label),
    };
  }

  /**
   * Per-parameter marginal comparison of the caller's own measured trials.
   *
   * WHAT THIS IS NOT: a causal estimate or a search. It groups the trials by
   * each parameter's value and reports the mean score of each group, so a
   * parameter whose groups differ is worth varying and one whose groups agree
   * is not. Because the trials were not necessarily varied one factor at a
   * time, `independent` says whether each parameter's values were observed
   * against more than one setting of the others -- without that, a difference
   * here may belong to a different parameter entirely.
   */
  private tuneConfig(
    options: RecommendationEngineOptions
  ): Record<string, unknown> {
    const trials = options.trials;
    if (!Array.isArray(trials) || trials.length < 2)
      throw new Error(
        `recommendation-engine tune-config: \`trials\` is required and needs at least 2 trials to compare; received ${Array.isArray(trials) ? trials.length : 'none'}`
      );
    trials.forEach((trial, position) => {
      if (
        trial?.config === null ||
        trial?.config === undefined ||
        typeof trial.config !== 'object'
      )
        throw new Error(
          `recommendation-engine tune-config: trials[${position}].config must be an object of parameter values`
        );
      if (!Number.isFinite(trial.score))
        throw new Error(
          `recommendation-engine tune-config: trials[${position}].score must be a finite number; received ${String(trial.score)}`
        );
    });
    const names = [
      ...new Set(trials.flatMap((trial) => Object.keys(trial.config))),
    ].sort();
    if (names.length === 0)
      throw new Error(
        'recommendation-engine tune-config: no trial names a parameter, so there is nothing to compare'
      );
    const parameters = names.map((name) => {
      const groups = new Map<
        string,
        { value: unknown; scores: number[]; others: Set<string> }
      >();
      for (const trial of trials) {
        if (!(name in trial.config)) continue;
        const raw = trial.config[name];
        const key = JSON.stringify(raw);
        const group = groups.get(key) ?? {
          value: raw,
          scores: [],
          others: new Set<string>(),
        };
        group.scores.push(trial.score);
        const rest = Object.fromEntries(
          Object.entries(trial.config).filter(([other]) => other !== name)
        );
        group.others.add(JSON.stringify(rest));
        groups.set(key, group);
      }
      const values = [...groups.values()]
        .map((group) => ({
          value: group.value as string | number | boolean,
          trials: group.scores.length,
          meanScore: mean(group.scores),
        }))
        .sort(
          (left, right) =>
            right.meanScore - left.meanScore ||
            JSON.stringify(left.value).localeCompare(
              JSON.stringify(right.value)
            )
        );
      const spread =
        values.length < 2
          ? 0
          : values[0].meanScore - values[values.length - 1].meanScore;
      return {
        name,
        values,
        best: values[0],
        /** Best mean minus worst mean: 0 means this parameter changed nothing. */
        spread,
        varied: values.length > 1,
        independent: [...groups.values()].some(
          (group) => group.others.size > 1
        ),
      };
    });
    parameters.sort(
      (left, right) =>
        right.spread - left.spread || left.name.localeCompare(right.name)
    );
    const best = trials.reduce((leader, trial) =>
      trial.score > leader.score ? trial : leader
    );
    return {
      trials: trials.length,
      parameters,
      /*
       * The best trial as it was actually run, beside the per-parameter bests.
       * They can disagree, and when they do the marginal reading is the one to
       * distrust -- which is why both are reported.
       */
      bestTrial: { config: best.config, score: best.score },
      suggested: Object.fromEntries(
        parameters.map((parameter) => [parameter.name, parameter.best.value])
      ),
      /** Parameters observed at one value only: nothing can be said about them. */
      unvaried: parameters
        .filter((parameter) => !parameter.varied)
        .map((parameter) => parameter.name),
      /** Parameters whose values never moved against a changing remainder. */
      confounded: parameters
        .filter((parameter) => parameter.varied && !parameter.independent)
        .map((parameter) => parameter.name),
    };
  }

  /**
   * The score for one user-item pair, taken apart into the terms that produced
   * it. `score` equals the sum of `contributions`, so nothing here is a
   * summary of a number computed somewhere else.
   */
  private explainRecommendation(
    options: RecommendationEngineOptions
  ): Record<string, unknown> {
    const interactions = requireInteractions(
      'explain-recommendation',
      options.interactions
    );
    const user = requireName('explain-recommendation', 'user', options.user);
    const item = requireName('explain-recommendation', 'item', options.item);
    const index = indexInteractions(interactions);
    const profile = index.byUser.get(user);
    if (profile === undefined)
      throw new Error(
        `recommendation-engine explain-recommendation: \`user\` ${JSON.stringify(user)} has no interactions; known users are ${index.users.join(', ')}`
      );
    if (!index.vectors.has(item))
      throw new Error(
        `recommendation-engine explain-recommendation: \`item\` ${JSON.stringify(item)} does not appear in \`interactions\``
      );
    const terms = contributions(
      profile,
      neighbourMap(similarities(index)),
      item
    );
    const score = sumContributions(terms);
    return {
      user,
      item,
      score,
      known: profile.has(item),
      contributions: terms,
      /*
       * Named so the empty case is readable: no term means no one used this
       * item alongside anything the user uses, which is a statement about the
       * data rather than a judgement about the item.
       */
      reason:
        terms.length === 0
          ? 'no item this user has used was ever used alongside this item'
          : `${terms.length} of the user's ${profile.size} used items were also used alongside this item`,
    };
  }
}

export const RECOMMENDATIONENGINETOOL = {
  name: 'recommendation-engine',
  description:
    'Item-based collaborative filtering, workflow transition analysis, proportional allocation and config trial comparison over records you supply',
  inputSchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: [...RECOMMENDATION_ENGINE_OPERATIONS],
        description: 'Operation to perform',
      },
      interactions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            user: { type: 'string', minLength: 1 },
            item: { type: 'string', minLength: 1 },
            weight: { type: 'number', exclusiveMinimum: 0 },
          },
          required: ['user', 'item'],
          additionalProperties: false,
        },
        minItems: 1,
        description: 'Observed uses: who used what, optionally how much',
      },
      user: {
        type: 'string',
        minLength: 1,
        description: 'Which user to score for',
      },
      item: {
        type: 'string',
        minLength: 1,
        description: 'Which item to compare or explain',
      },
      candidates: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        minItems: 1,
        description: 'The list personalize ranks',
      },
      topK: {
        type: 'integer',
        minimum: 1,
        default: RECOMMENDATION_ENGINE_DEFAULTS.topK,
        description: 'How many ranked entries to return',
      },
      events: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        minItems: 2,
        description: 'One ordered event stream, for optimize-workflow',
      },
      sequenceLength: {
        type: 'integer',
        minimum: 1,
        default: RECOMMENDATION_ENGINE_DEFAULTS.sequenceLength,
        description: 'Run length to mine for repeats',
      },
      minOccurrences: {
        type: 'integer',
        minimum: 2,
        default: RECOMMENDATION_ENGINE_DEFAULTS.minOccurrences,
        description: 'How often a run must repeat to count as a pattern',
      },
      demands: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', minLength: 1 },
            demand: { type: 'number', minimum: 0 },
          },
          required: ['label', 'demand'],
          additionalProperties: false,
        },
        minItems: 1,
        description: 'Claims on the capacity, for allocate-resources',
      },
      capacity: {
        type: 'integer',
        minimum: 0,
        description: 'Whole units available to allocate',
      },
      trials: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            config: { type: 'object' },
            score: { type: 'number' },
          },
          required: ['config', 'score'],
          additionalProperties: false,
        },
        minItems: 2,
        description: 'Measured configuration runs, for tune-config',
      },
      useCache: {
        type: 'boolean',
        default: true,
        description: 'Enable caching',
      },
    },
    required: ['operation'],
    /*
     * The conditional requirements, published rather than described in prose.
     * A property description saying "Required by recommend" is something a
     * human reads and a client cannot act on; these branches are something a
     * client can act on, and are what the derived validation enforces.
     */
    anyOf: [
      {
        properties: { operation: { const: 'train' } },
        required: ['operation', 'interactions'],
      },
      {
        properties: { operation: { const: 'recommend' } },
        required: ['operation', 'interactions', 'user'],
      },
      {
        properties: { operation: { const: 'find-similar' } },
        required: ['operation', 'interactions', 'item'],
      },
      {
        properties: { operation: { const: 'personalize' } },
        required: ['operation', 'interactions', 'user', 'candidates'],
      },
      {
        properties: { operation: { const: 'explain-recommendation' } },
        required: ['operation', 'interactions', 'user', 'item'],
      },
      {
        properties: { operation: { const: 'optimize-workflow' } },
        required: ['operation', 'events'],
      },
      {
        properties: { operation: { const: 'allocate-resources' } },
        required: ['operation', 'demands', 'capacity'],
      },
      {
        properties: { operation: { const: 'tune-config' } },
        required: ['operation', 'trials'],
      },
    ],
  },
} as const;

export async function runRecommendationEngine(
  options: RecommendationEngineOptions
): Promise<RecommendationEngineResult> {
  const tool = new RecommendationEngine(
    sharedCache,
    sharedTokenCounter,
    sharedMetricsCollector
  );
  return await tool.run(options);
}
