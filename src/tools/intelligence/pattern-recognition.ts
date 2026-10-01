/**
 * PatternRecognition -- frequency, clustering, correlation, sequence and trend
 * analysis over event and metric data the caller supplies.
 *
 * WHAT WAS HERE: all eight published operations returned
 * `{ success: true, data: { result: "<operation> completed successfully" } }`
 * with a hard-coded `confidence: 0.85`, having read none of their input. The
 * tool was wired into the server and listed in tools/list with no test.
 *
 * TWO CONSEQUENCES FOR THE SHAPE OF THIS FILE, the same two that
 * smart-summarization now carries:
 *
 * 1. `confidence` is gone. Every operation here has a real statistic to report
 *    instead -- a share, an r, a p-value, an inertia -- and those are numbers a
 *    caller can recompute from their own data. A single invented number that
 *    stands for all of them cannot be checked against anything.
 *
 * 2. An operation whose inputs are absent REFUSES, naming the missing key.
 *
 * There is no pattern library and no model: every figure is computed from the
 * array passed in, by analytics-core, whose own refusals name each method's
 * minimum sample size.
 */

import type { CacheEngine } from '../../core/cache-engine.js';
import type { TokenCounter } from '../../core/token-counter.js';
import type { MetricsCollector } from '../../core/metrics.js';
import { generateCacheKey } from '../shared/hash-utils.js';
import {
  MINIMUM_SAMPLES,
  frequencies,
  kMeans,
  linearFit,
  mannKendall,
  mineSequences,
  pearson,
  strongestSeasonalLag,
} from './analytics-core.js';
import {
  EXPORT_FORMATS,
  isExportFormat,
  renderPayload,
  barChart,
  sparkline,
  type BarRow,
  type ExportFormat,
} from './render-core.js';
import {
  sharedCache,
  sharedTokenCounter,
  sharedMetricsCollector,
} from './shared-instances.js';

/**
 * The operations, in one place: the TS union and the published enum are both
 * derived from this array, so they cannot drift apart.
 */
export const PATTERN_RECOGNITION_OPERATIONS = [
  'detect-patterns',
  'cluster-events',
  'find-correlations',
  'mine-sequences',
  'identify-trends',
  'compare-patterns',
  'visualize',
  'export',
] as const;

export type PatternRecognitionOperation =
  (typeof PATTERN_RECOGNITION_OPERATIONS)[number];

/** The chart kinds `visualize` draws, each with its own required input. */
export const PATTERN_CHARTS = ['sparkline', 'bars'] as const;
export type PatternChart = (typeof PATTERN_CHARTS)[number];

export { EXPORT_FORMATS, type ExportFormat };

/**
 * Defaults, collected so all of them are visible at once. Each is a
 * presentation or reproducibility choice, never a stand-in for missing data:
 * `seed` fixes k-means++ so two identical calls cluster identically, and
 * `minOccurrences` is 2 because a run seen once is not a pattern.
 */
export const PATTERN_RECOGNITION_DEFAULTS = Object.freeze({
  minOccurrences: 2,
  seed: 1,
  maxLag: 12,
  topPatterns: 20,
});

export interface PatternRecognitionOptions {
  operation: PatternRecognitionOperation;
  /** detect-patterns, mine-sequences: the event stream, in order. */
  events?: string[];
  /** cluster-events: one numeric feature vector per event. */
  points?: number[][];
  /** cluster-events: a name per point, same order; reported with its cluster. */
  labels?: string[];
  k?: number;
  seed?: number;
  /** find-correlations: named metric series, all of equal length. */
  series?: Record<string, number[]>;
  /** identify-trends: one metric series, in time order. */
  values?: number[];
  maxLag?: number;
  /** mine-sequences. */
  length?: number;
  minOccurrences?: number;
  /** detect-patterns. */
  topPatterns?: number;
  /** compare-patterns: two event streams. */
  before?: string[];
  after?: string[];
  /** visualize. */
  chart?: PatternChart;
  bars?: BarRow[];
  /** export. */
  format?: ExportFormat;
  payload?: unknown;
  useCache?: boolean;
}

export interface PatternRecognitionResult {
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

/**
 * Refusals. Each names the key that is missing and the operation that needed
 * it, because a caller reading the error must be able to act on it without
 * reading this file.
 */
const requireEvents = (
  operation: string,
  key: string,
  events: string[] | undefined
): string[] => {
  if (!Array.isArray(events) || events.length === 0)
    throw new Error(
      `pattern-recognition ${operation}: \`${key}\` is required and must hold at least one event`
    );
  events.forEach((event, index) => {
    if (typeof event !== 'string')
      throw new Error(
        `pattern-recognition ${operation}: ${key}[${index}] must be a string; received ${String(event)}`
      );
  });
  return events;
};

const requireValues = (
  operation: string,
  key: string,
  values: number[] | undefined,
  minimum: number
): number[] => {
  if (!Array.isArray(values))
    throw new Error(
      `pattern-recognition ${operation}: \`${key}\` is required and must be an array of numbers`
    );
  values.forEach((value, index) => {
    if (typeof value !== 'number' || !Number.isFinite(value))
      throw new Error(
        `pattern-recognition ${operation}: ${key}[${index}] must be a finite number; received ${String(value)}`
      );
  });
  if (values.length < minimum)
    throw new Error(
      `pattern-recognition ${operation}: \`${key}\` needs at least ${minimum} points; received ${values.length}`
    );
  return values;
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
      `pattern-recognition ${operation}: \`${key}\` must be an integer of at least 1; received ${String(value)}`
    );
  return value;
};

/** Shares of each distinct value, as a lookup, for a share-delta comparison. */
const shareMap = (events: readonly string[]): Map<string, number> =>
  new Map(frequencies(events).map((entry) => [entry.value, entry.share]));

export class PatternRecognition {
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
    options: PatternRecognitionOptions
  ): Promise<PatternRecognitionResult> {
    const startTime = Date.now();
    const cacheKey = generateCacheKey('pattern-recognition', {
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
      operation: `pattern-recognition:${options.operation}`,
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
   * One branch per published operation, each naming the operation it performs.
   * No fall-through: a value added to the published enum without an
   * implementation here reaches the default and is refused, instead of being
   * silently serviced as whichever branch happened to be last.
   */
  private compute(options: PatternRecognitionOptions): Record<string, unknown> {
    const operation = options.operation;
    switch (operation) {
      case 'detect-patterns':
        return this.detectPatterns(options);
      case 'cluster-events':
        return this.clusterEvents(options);
      case 'find-correlations':
        return this.findCorrelations(options);
      case 'mine-sequences':
        return this.mineEventSequences(options);
      case 'identify-trends':
        return this.identifyTrends(options);
      case 'compare-patterns':
        return this.comparePatterns(options);
      case 'visualize':
        return this.visualize(options);
      case 'export':
        return this.exportPayload(options);
      default:
        throw new Error(
          `pattern-recognition: unknown operation ${JSON.stringify(operation)}`
        );
    }
  }

  /**
   * Which events recur, and how concentrated the stream is. `repeated` is the
   * subset seen more than once: a value seen once is an observation, not a
   * pattern, and reporting it as one is what made the old `detect-patterns`
   * return a finding for every call.
   */
  private detectPatterns(
    options: PatternRecognitionOptions
  ): Record<string, unknown> {
    const events = requireEvents('detect-patterns', 'events', options.events);
    const limit = positiveInteger(
      'detect-patterns',
      'topPatterns',
      options.topPatterns,
      PATTERN_RECOGNITION_DEFAULTS.topPatterns
    );
    const counted = frequencies(events);
    const repeated = counted.filter((entry) => entry.count > 1);
    return {
      total: events.length,
      distinct: counted.length,
      patterns: counted.slice(0, limit),
      repeated: repeated.slice(0, limit),
      repeatedShare: repeated.reduce((sum, entry) => sum + entry.share, 0),
      /*
       * The share held by the single most frequent event. Reported rather than
       * judged: whether one event dominating 80% of a stream is a problem is a
       * property of the caller's system, not of this function.
       */
      topShare: counted.length === 0 ? 0 : counted[0].share,
    };
  }

  private clusterEvents(
    options: PatternRecognitionOptions
  ): Record<string, unknown> {
    const points = options.points;
    if (!Array.isArray(points) || points.length === 0)
      throw new Error(
        'pattern-recognition cluster-events: `points` is required and must hold at least one numeric vector'
      );
    const k = options.k;
    if (!Number.isInteger(k) || k === undefined || k < 1)
      throw new Error(
        `pattern-recognition cluster-events: \`k\` must be an integer of at least 1; received ${String(k)}`
      );
    if (k > points.length)
      throw new Error(
        `pattern-recognition cluster-events: \`k\` is ${k} but only ${points.length} points were supplied; k cannot exceed the number of points`
      );
    const labels = options.labels;
    if (labels !== undefined && labels.length !== points.length)
      throw new Error(
        `pattern-recognition cluster-events: \`labels\` must match \`points\` in length; received ${labels.length} and ${points.length}`
      );
    const seed = options.seed ?? PATTERN_RECOGNITION_DEFAULTS.seed;
    if (!Number.isInteger(seed))
      throw new Error(
        `pattern-recognition cluster-events: \`seed\` must be an integer; received ${String(seed)}`
      );
    const result = kMeans(points, k, seed);
    return {
      /*
       * `clusters.length` can be below k: analytics-core drops a cluster that
       * ends up with no members instead of re-seeding it, so the count here is
       * the number of groups the data actually supports.
       */
      requested: k,
      found: result.clusters.length,
      iterations: result.iterations,
      converged: result.converged,
      inertia: result.inertia,
      seed,
      clusters: result.clusters.map((cluster) => ({
        centroid: cluster.centroid,
        size: cluster.members.length,
        inertia: cluster.inertia,
        members: cluster.members,
        ...(labels === undefined
          ? {}
          : { labels: cluster.members.map((index) => labels[index]) }),
      })),
    };
  }

  /**
   * Pearson's r for every pair of named series, strongest first. Every pair is
   * reported, including the weak ones: a function that returned only the
   * correlations above some cutoff would be answering "what correlates" with a
   * threshold the caller never chose.
   */
  private findCorrelations(
    options: PatternRecognitionOptions
  ): Record<string, unknown> {
    const series = options.series;
    if (series === null || series === undefined || typeof series !== 'object')
      throw new Error(
        'pattern-recognition find-correlations: `series` is required and must be an object of named numeric series'
      );
    const names = Object.keys(series);
    if (names.length < 2)
      throw new Error(
        `pattern-recognition find-correlations: needs at least two named series to correlate; received ${names.length}`
      );
    const lengths = new Set<number>();
    for (const name of names) {
      requireValues(
        'find-correlations',
        `series.${name}`,
        series[name],
        MINIMUM_SAMPLES.paired
      );
      lengths.add(series[name].length);
    }
    if (lengths.size > 1)
      throw new Error(
        `pattern-recognition find-correlations: every series must be the same length; received lengths ${[...lengths].sort((a, b) => a - b).join(', ')}`
      );
    const pairs: Array<{ a: string; b: string; r: number; r2: number }> = [];
    for (let i = 0; i < names.length - 1; i += 1)
      for (let j = i + 1; j < names.length; j += 1) {
        const r = pearson(series[names[i]], series[names[j]]);
        pairs.push({ a: names[i], b: names[j], r, r2: r * r });
      }
    pairs.sort(
      (left, right) =>
        Math.abs(right.r) - Math.abs(left.r) ||
        left.a.localeCompare(right.a) ||
        left.b.localeCompare(right.b)
    );
    return {
      series: names,
      sampleSize: [...lengths][0],
      pairs,
      strongest: pairs[0],
    };
  }

  private mineEventSequences(
    options: PatternRecognitionOptions
  ): Record<string, unknown> {
    const events = requireEvents('mine-sequences', 'events', options.events);
    const length = options.length;
    if (!Number.isInteger(length) || length === undefined || length < 1)
      throw new Error(
        `pattern-recognition mine-sequences: \`length\` must be an integer of at least 1; received ${String(length)}`
      );
    const minOccurrences =
      options.minOccurrences ?? PATTERN_RECOGNITION_DEFAULTS.minOccurrences;
    if (!Number.isInteger(minOccurrences) || minOccurrences < 2)
      throw new Error(
        `pattern-recognition mine-sequences: \`minOccurrences\` must be an integer of at least 2, since a run seen once is not a pattern; received ${String(minOccurrences)}`
      );
    const sequences = mineSequences(events, length, minOccurrences);
    return {
      length,
      minOccurrences,
      windows: Math.max(0, events.length - length + 1),
      sequences,
      /*
       * An empty result is a result. The old implementation could not return
       * one, which is the tell: a detector that always finds something is not
       * measuring anything.
       */
      found: sequences.length,
    };
  }

  /**
   * Two different questions, so two different tests: Mann-Kendall for "is this
   * trending", which is a rank test and assumes neither normality nor
   * linearity, and a least-squares fit for "by how much per step". A seasonal
   * lag is reported when the series is long enough to have one.
   */
  private identifyTrends(
    options: PatternRecognitionOptions
  ): Record<string, unknown> {
    const values = requireValues(
      'identify-trends',
      'values',
      options.values,
      MINIMUM_SAMPLES.mannKendall
    );
    const maxLag = positiveInteger(
      'identify-trends',
      'maxLag',
      options.maxLag,
      PATTERN_RECOGNITION_DEFAULTS.maxLag
    );
    const index = values.map((_unused, position) => position);
    const fit = linearFit(index, values);
    const test = mannKendall(values);
    return {
      sampleSize: values.length,
      direction: test.direction,
      test: { s: test.s, tau: test.tau, z: test.z, p: test.p },
      fit: {
        slopePerStep: fit.slope,
        intercept: fit.intercept,
        r2: fit.r2,
        residualStdError: fit.residualStdError,
      },
      /*
       * `null` when no lag in [2, maxLag] fits inside the series. Named
       * `strongestSeasonalLag`, not `seasonality`: it reports which lag is
       * strongest and how strong, and leaves "is that a season" to the caller.
       */
      strongestSeasonalLag: strongestSeasonalLag(values, maxLag),
    };
  }

  /**
   * How the mix of events changed between two streams. Shares rather than
   * counts, so two streams of different length are comparable, plus the
   * Jaccard overlap of the two distinct-event sets.
   */
  private comparePatterns(
    options: PatternRecognitionOptions
  ): Record<string, unknown> {
    const before = requireEvents('compare-patterns', 'before', options.before);
    const after = requireEvents('compare-patterns', 'after', options.after);
    const beforeShares = shareMap(before);
    const afterShares = shareMap(after);
    const every = [
      ...new Set([...beforeShares.keys(), ...afterShares.keys()]),
    ].sort();
    const shifts = every
      .map((value) => {
        const beforeShare = beforeShares.get(value) ?? 0;
        const afterShare = afterShares.get(value) ?? 0;
        return {
          value,
          beforeShare,
          afterShare,
          delta: afterShare - beforeShare,
        };
      })
      .sort(
        (left, right) =>
          Math.abs(right.delta) - Math.abs(left.delta) ||
          left.value.localeCompare(right.value)
      );
    const shared = every.filter(
      (value) => beforeShares.has(value) && afterShares.has(value)
    );
    return {
      beforeCount: before.length,
      afterCount: after.length,
      shifts,
      appeared: every.filter((value) => !beforeShares.has(value)),
      disappeared: every.filter((value) => !afterShares.has(value)),
      /** Shared distinct events over all distinct events: the Jaccard index. */
      overlap: every.length === 0 ? 0 : shared.length / every.length,
    };
  }

  private visualize(
    options: PatternRecognitionOptions
  ): Record<string, unknown> {
    const chart = options.chart;
    if (chart === 'sparkline') {
      const values = requireValues(
        'visualize',
        'values',
        options.values,
        MINIMUM_SAMPLES.mean
      );
      return {
        chart,
        /*
         * The series is returned beside the drawing. A sparkline is scaled
         * between its own minimum and maximum and carries no axis, so without
         * those two numbers the glyphs cannot be read as values at all.
         */
        rendered: sparkline(values),
        min: Math.min(...values),
        max: Math.max(...values),
        points: values.length,
      };
    }
    if (chart === 'bars') {
      const bars = options.bars;
      if (!Array.isArray(bars) || bars.length === 0)
        throw new Error(
          'pattern-recognition visualize: `bars` is required for the bars chart and must hold at least one row'
        );
      bars.forEach((bar, position) => {
        if (typeof bar?.label !== 'string')
          throw new Error(
            `pattern-recognition visualize: bars[${position}].label must be a string`
          );
        if (typeof bar.value !== 'number' || !Number.isFinite(bar.value))
          throw new Error(
            `pattern-recognition visualize: bars[${position}].value must be a finite number; received ${String(bar.value)}`
          );
      });
      return { chart, rendered: barChart(bars), rows: bars.length };
    }
    throw new Error(
      `pattern-recognition visualize: \`chart\` must be one of ${PATTERN_CHARTS.join(', ')}; received ${JSON.stringify(chart)}`
    );
  }

  private exportPayload(
    options: PatternRecognitionOptions
  ): Record<string, unknown> {
    const format = options.format;
    if (!isExportFormat(format))
      throw new Error(
        `pattern-recognition export: unknown format ${JSON.stringify(format)}; one of ${EXPORT_FORMATS.join(', ')}`
      );
    if (options.payload === undefined)
      throw new Error(
        'pattern-recognition export: `payload` is required; there is no default document to export'
      );
    const rendered = renderPayload(
      'pattern-recognition',
      options.payload,
      format
    );
    return {
      format: rendered.format,
      content: rendered.content,
      rows: rendered.rows,
      bytes: Buffer.byteLength(rendered.content, 'utf8'),
    };
  }
}

export const PATTERNRECOGNITIONTOOL = {
  name: 'pattern-recognition',
  description:
    'Frequency, clustering, correlation, sequence and trend analysis over event and metric arrays you supply',
  inputSchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: [...PATTERN_RECOGNITION_OPERATIONS],
        description: 'Operation to perform',
      },
      events: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        description:
          'Event stream in order, for detect-patterns and mine-sequences',
      },
      points: {
        type: 'array',
        items: { type: 'array', items: { type: 'number' }, minItems: 1 },
        minItems: 1,
        description: 'One numeric feature vector per event, for cluster-events',
      },
      labels: {
        type: 'array',
        items: { type: 'string' },
        description: 'A name per point, same order, reported with its cluster',
      },
      k: {
        type: 'integer',
        minimum: 1,
        description:
          'Number of clusters to seek; cannot exceed the point count',
      },
      seed: {
        type: 'integer',
        default: PATTERN_RECOGNITION_DEFAULTS.seed,
        description:
          'Seeds k-means++ so an identical call clusters identically',
      },
      series: {
        type: 'object',
        additionalProperties: { type: 'array', items: { type: 'number' } },
        description:
          'Named metric series of equal length, for find-correlations',
      },
      values: {
        type: 'array',
        items: { type: 'number' },
        minItems: 1,
        description:
          'One metric series in time order, for identify-trends and the sparkline',
      },
      maxLag: {
        type: 'integer',
        minimum: 1,
        default: PATTERN_RECOGNITION_DEFAULTS.maxLag,
        description: 'Highest lag identify-trends searches for a season',
      },
      length: {
        type: 'integer',
        minimum: 1,
        description: 'Subsequence length mine-sequences counts',
      },
      minOccurrences: {
        type: 'integer',
        minimum: 2,
        default: PATTERN_RECOGNITION_DEFAULTS.minOccurrences,
        description: 'Occurrences before a run counts as a sequence',
      },
      topPatterns: {
        type: 'integer',
        minimum: 1,
        default: PATTERN_RECOGNITION_DEFAULTS.topPatterns,
        description: 'How many frequency rows detect-patterns returns',
      },
      before: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        description: 'Earlier event stream, for compare-patterns',
      },
      after: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        description: 'Later event stream, for compare-patterns',
      },
      chart: {
        type: 'string',
        enum: [...PATTERN_CHARTS],
        description: 'Which chart visualize draws',
      },
      bars: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            value: { type: 'number' },
          },
          required: ['label', 'value'],
          additionalProperties: false,
        },
        minItems: 1,
        description: 'Rows for the bars chart',
      },
      format: {
        type: 'string',
        enum: [...EXPORT_FORMATS],
        description: 'Output format for export',
      },
      payload: { description: 'The document export renders' },
      useCache: {
        type: 'boolean',
        default: true,
        description: 'Enable caching',
      },
    },
    required: ['operation'],
    /*
     * The conditional requirements, published rather than described in prose.
     * A property description saying "Required by export" is something a human
     * reads and a client cannot act on; these branches are something a client
     * can act on, and are what the derived validation enforces. `visualize`
     * gets one branch per chart, because which key is required depends on the
     * chart and not only on the operation.
     */
    anyOf: [
      {
        properties: { operation: { const: 'detect-patterns' } },
        required: ['operation', 'events'],
      },
      {
        properties: { operation: { const: 'cluster-events' } },
        required: ['operation', 'points', 'k'],
      },
      {
        properties: { operation: { const: 'find-correlations' } },
        required: ['operation', 'series'],
      },
      {
        properties: { operation: { const: 'mine-sequences' } },
        required: ['operation', 'events', 'length'],
      },
      {
        properties: { operation: { const: 'identify-trends' } },
        required: ['operation', 'values'],
      },
      {
        properties: { operation: { const: 'compare-patterns' } },
        required: ['operation', 'before', 'after'],
      },
      {
        properties: {
          operation: { const: 'visualize' },
          chart: { const: 'sparkline' },
        },
        required: ['operation', 'chart', 'values'],
      },
      {
        properties: {
          operation: { const: 'visualize' },
          chart: { const: 'bars' },
        },
        required: ['operation', 'chart', 'bars'],
      },
      {
        properties: { operation: { const: 'export' } },
        required: ['operation', 'format', 'payload'],
      },
    ],
  },
} as const;

export async function runPatternRecognition(
  options: PatternRecognitionOptions
): Promise<PatternRecognitionResult> {
  const tool = new PatternRecognition(
    sharedCache,
    sharedTokenCounter,
    sharedMetricsCollector
  );
  return await tool.run(options);
}
