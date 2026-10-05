import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CacheEngine } from '../../../src/core/cache-engine.js';
import { TokenCounter } from '../../../src/core/token-counter.js';
import { MetricsCollector } from '../../../src/core/metrics.js';
import {
  PATTERN_RECOGNITION_DEFAULTS,
  PATTERN_RECOGNITION_OPERATIONS,
  PatternRecognition,
  type PatternRecognitionOptions,
} from '../../../src/tools/intelligence/pattern-recognition.js';
import { toolSchemaMap } from '../../../src/validation/tool-schemas.js';

/**
 * Every test here pins a value derived from the INPUT.
 *
 * WHY THAT RULE: what this file replaces returned `success: true` with
 * `data.result = "<operation> completed successfully"` and a hard-coded
 * `confidence: 0.85` for all eight operations. A test asserting
 * `result.success === true`, or that `data` is an object, would have passed
 * against that stub -- so a suite of those would have been worth nothing, which
 * is what the stub's complete absence of tests already was.
 *
 * The figures below are hand-computable from the arrays passed in, and the
 * comments say how, so a future reader can check the expectation rather than
 * trusting it.
 */

let directory: string;
let engine: CacheEngine;
let tool: PatternRecognition;

beforeEach(() => {
  // A temp cache, never the real home cache.
  directory = mkdtempSync(join(tmpdir(), 'pattern-recognition-'));
  engine = new CacheEngine(join(directory, 'c.db'));
  tool = new PatternRecognition(
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

/** Runs an operation with caching off, so each case measures a real compute. */
const run = (options: PatternRecognitionOptions) =>
  tool.run({ ...options, useCache: false });

describe('pattern-recognition detect-patterns', () => {
  it('counts each event and reports the share the repeats hold', async () => {
    const result = await run({
      operation: 'detect-patterns',
      events: ['timeout', 'timeout', 'ok', 'timeout', 'disk'],
    });
    expect(result.data.total).toBe(5);
    expect(result.data.distinct).toBe(3);
    expect(result.data.patterns).toEqual([
      { value: 'timeout', count: 3, share: 0.6 },
      { value: 'disk', count: 1, share: 0.2 },
      { value: 'ok', count: 1, share: 0.2 },
    ]);
    // Only `timeout` recurs, so the repeated share is its own share.
    expect(result.data.repeated).toEqual([
      { value: 'timeout', count: 3, share: 0.6 },
    ]);
    expect(result.data.repeatedShare).toBeCloseTo(0.6, 12);
    expect(result.data.topShare).toBeCloseTo(0.6, 12);
  });

  it('reports no repeats at all when nothing recurs', async () => {
    /*
     * The stub could not produce this answer: it reported a finding for every
     * call. A detector that always finds something is not measuring anything.
     */
    const result = await run({
      operation: 'detect-patterns',
      events: ['a', 'b', 'c'],
    });
    expect(result.data.repeated).toEqual([]);
    expect(result.data.repeatedShare).toBe(0);
    expect(result.data.distinct).toBe(3);
  });

  it('caps the rows at topPatterns without changing the totals', async () => {
    const result = await run({
      operation: 'detect-patterns',
      events: ['a', 'b', 'c'],
      topPatterns: 2,
    });
    expect(result.data.patterns).toHaveLength(2);
    expect(result.data.distinct).toBe(3);
  });

  it('refuses an absent or empty event stream', async () => {
    await expect(run({ operation: 'detect-patterns' })).rejects.toThrow(
      'pattern-recognition detect-patterns: `events` is required and must hold at least one event'
    );
    await expect(
      run({ operation: 'detect-patterns', events: [] })
    ).rejects.toThrow(/`events` is required/);
  });
});

describe('pattern-recognition cluster-events', () => {
  it('separates two groups and names their members', async () => {
    const result = await run({
      operation: 'cluster-events',
      points: [
        [0, 0],
        [0, 1],
        [10, 10],
        [10, 11],
      ],
      labels: ['a', 'b', 'c', 'd'],
      k: 2,
    });
    expect(result.data.found).toBe(2);
    const clusters = result.data.clusters as Array<{
      size: number;
      labels: string[];
      centroid: number[];
    }>;
    const grouped = clusters.map((cluster) => cluster.labels.sort()).sort();
    expect(grouped).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    // Each centroid is the mean of its own two points.
    const centroids = clusters.map((cluster) => cluster.centroid).sort();
    expect(centroids).toEqual([
      [0, 0.5],
      [10, 10.5],
    ]);
    expect(result.data.converged).toBe(true);
  });

  it('is reproducible under one seed and reports the seed it used', async () => {
    const points = [[1], [2], [3], [30], [31]];
    const first = await run({ operation: 'cluster-events', points, k: 2 });
    const again = await run({ operation: 'cluster-events', points, k: 2 });
    expect(first.data.clusters).toEqual(again.data.clusters);
    expect(first.data.seed).toBe(PATTERN_RECOGNITION_DEFAULTS.seed);
  });

  it('reports fewer clusters than asked when the data supports fewer', async () => {
    /*
     * Three identical points cannot fill three distinct centroids, so
     * analytics-core drops the empty ones rather than re-seeding. `requested`
     * and `found` are both returned so the gap is visible instead of being
     * padded out to the number the caller asked for.
     */
    const result = await run({
      operation: 'cluster-events',
      points: [[5], [5], [5]],
      k: 3,
    });
    expect(result.data.requested).toBe(3);
    expect(result.data.found).toBe(1);
    expect(result.data.inertia).toBe(0);
  });

  it('refuses a k above the point count and a mismatched label list', async () => {
    await expect(
      run({ operation: 'cluster-events', points: [[1], [2]], k: 3 })
    ).rejects.toThrow(
      'pattern-recognition cluster-events: `k` is 3 but only 2 points were supplied; k cannot exceed the number of points'
    );
    await expect(
      run({
        operation: 'cluster-events',
        points: [[1], [2]],
        k: 1,
        labels: ['only-one'],
      })
    ).rejects.toThrow(
      'pattern-recognition cluster-events: `labels` must match `points` in length; received 1 and 2'
    );
    await expect(run({ operation: 'cluster-events', k: 1 })).rejects.toThrow(
      /`points` is required/
    );
  });
});

describe('pattern-recognition find-correlations', () => {
  it('reports an exact r of 1 and -1 for the lines that produce them', async () => {
    const result = await run({
      operation: 'find-correlations',
      series: {
        requests: [1, 2, 3, 4],
        // Exactly 2x requests, so r is 1 and r2 is 1.
        bytes: [2, 4, 6, 8],
        // Exactly -requests, so r is -1.
        free: [-1, -2, -3, -4],
      },
    });
    expect(result.data.sampleSize).toBe(4);
    const pairs = result.data.pairs as Array<{
      a: string;
      b: string;
      r: number;
    }>;
    expect(pairs).toHaveLength(3);
    for (const pair of pairs) expect(Math.abs(pair.r)).toBeCloseTo(1, 12);
    const signs = new Map(
      pairs.map((pair) => [`${pair.a}|${pair.b}`, Math.sign(pair.r)])
    );
    expect(signs.get('requests|bytes')).toBe(1);
    expect(signs.get('requests|free')).toBe(-1);
    expect(signs.get('bytes|free')).toBe(-1);
  });

  it('sorts by strength and reports every pair, weak ones included', async () => {
    const result = await run({
      operation: 'find-correlations',
      series: {
        a: [1, 2, 3, 4],
        b: [1, 2, 3, 4],
        // Deliberately unrelated to a: its correlation is near zero, and it is
        // still reported. A cutoff here would be a threshold the caller never
        // chose.
        c: [5, 1, 6, 2],
      },
    });
    const pairs = result.data.pairs as Array<{
      a: string;
      b: string;
      r: number;
    }>;
    expect(pairs.map((pair) => `${pair.a}|${pair.b}`)).toEqual([
      'a|b',
      'a|c',
      'b|c',
    ]);
    expect(pairs[0].r).toBeCloseTo(1, 12);
    /*
     * Pearson on [1,2,3,4] against [5,1,6,2]: the covariance is -2, Sxx is 5
     * and Syy is 17, so r is -2/sqrt(85).
     */
    expect(pairs[1].r).toBeCloseTo(-2 / Math.sqrt(85), 12);
    expect(result.data.strongest).toEqual(pairs[0]);
  });

  it('refuses one series, unequal lengths and a non-numeric point', async () => {
    await expect(
      run({ operation: 'find-correlations', series: { only: [1, 2] } })
    ).rejects.toThrow(
      'pattern-recognition find-correlations: needs at least two named series to correlate; received 1'
    );
    await expect(
      run({
        operation: 'find-correlations',
        series: { a: [1, 2, 3], b: [1, 2] },
      })
    ).rejects.toThrow(
      'pattern-recognition find-correlations: every series must be the same length; received lengths 2, 3'
    );
    await expect(
      run({
        operation: 'find-correlations',
        series: { a: [1, Number.NaN], b: [1, 2] },
      })
    ).rejects.toThrow('series.a[1] must be a finite number; received NaN');
  });
});

describe('pattern-recognition mine-sequences', () => {
  it('counts a repeated pair and its support over the windows', async () => {
    const events = ['open', 'fail', 'retry', 'open', 'fail', 'retry'];
    const result = await run({
      operation: 'mine-sequences',
      events,
      length: 2,
    });
    // Six events, length 2, so five windows.
    expect(result.data.windows).toBe(5);
    // Both pairs occur twice, so the tie is broken lexicographically.
    expect(result.data.sequences).toEqual([
      { pattern: ['fail', 'retry'], occurrences: 2, support: 2 / 5 },
      { pattern: ['open', 'fail'], occurrences: 2, support: 2 / 5 },
    ]);
    expect(result.data.found).toBe(2);
  });

  it('returns nothing when no run repeats', async () => {
    const result = await run({
      operation: 'mine-sequences',
      events: ['a', 'b', 'c', 'd'],
      length: 2,
    });
    expect(result.data.sequences).toEqual([]);
    expect(result.data.found).toBe(0);
  });

  it('refuses a minOccurrences of one, which would report every window', async () => {
    await expect(
      run({
        operation: 'mine-sequences',
        events: ['a', 'b'],
        length: 1,
        minOccurrences: 1,
      })
    ).rejects.toThrow(
      'pattern-recognition mine-sequences: `minOccurrences` must be an integer of at least 2, since a run seen once is not a pattern; received 1'
    );
    await expect(
      run({ operation: 'mine-sequences', events: ['a'] })
    ).rejects.toThrow(/`length` must be an integer of at least 1/);
  });
});

describe('pattern-recognition identify-trends', () => {
  it('reports the exact slope of a straight line and calls it increasing', async () => {
    const result = await run({
      operation: 'identify-trends',
      values: [1, 2, 3, 4, 5, 6],
    });
    const fit = result.data.fit as { slopePerStep: number; r2: number };
    // y = x + 1 over index 0..5, so the slope is exactly 1 and r2 exactly 1.
    expect(fit.slopePerStep).toBeCloseTo(1, 12);
    expect(fit.r2).toBeCloseTo(1, 12);
    expect(result.data.direction).toBe('increasing');
    const test = result.data.test as { s: number; tau: number; p: number };
    // Every one of the 15 pairs is concordant, so S is 15 and tau is 1.
    expect(test.s).toBe(15);
    expect(test.tau).toBeCloseTo(1, 12);
    expect(test.p).toBeLessThan(0.05);
  });

  it('calls a flat series no trend and gives the test a p of 1', async () => {
    const result = await run({
      operation: 'identify-trends',
      values: [7, 7, 7, 7, 7],
    });
    expect(result.data.direction).toBe('none');
    const test = result.data.test as { s: number; p: number };
    expect(test.s).toBe(0);
    /*
     * The exact p for z = 0 is 1. normalCdf uses the Abramowitz & Stegun
     * 7.1.26 erf form, whose stated error bound is 1.5e-7, so the assertion is
     * made AT that bound as analytics-core's own tests are: tighter would be
     * testing the approximation's luck, looser would stop detecting a wrong
     * formula. The measured deviation is 1e-9.
     */
    const ERF_ERROR_BOUND = 1.5e-7;
    expect(Math.abs(test.p - 1)).toBeLessThan(ERF_ERROR_BOUND);
  });

  it('calls a falling series decreasing', async () => {
    const result = await run({
      operation: 'identify-trends',
      values: [9, 7, 5, 3, 1, -1],
    });
    expect(result.data.direction).toBe('decreasing');
    expect(
      (result.data.fit as { slopePerStep: number }).slopePerStep
    ).toBeCloseTo(-2, 12);
  });

  it('finds the lag of a repeating cycle', async () => {
    const result = await run({
      operation: 'identify-trends',
      values: [0, 5, 0, 5, 0, 5, 0, 5],
    });
    const seasonal = result.data.strongestSeasonalLag as {
      lag: number;
      correlation: number;
    };
    // A period-2 square wave: lag 2 is the strongest, and perfectly so.
    expect(seasonal.lag).toBe(2);
    expect(seasonal.correlation).toBeGreaterThan(0.7);
  });

  it('refuses a series too short for the rank test, naming the minimum', async () => {
    await expect(
      run({ operation: 'identify-trends', values: [1, 2, 3] })
    ).rejects.toThrow(
      'pattern-recognition identify-trends: `values` needs at least 4 points; received 3'
    );
    await expect(run({ operation: 'identify-trends' })).rejects.toThrow(
      /`values` is required/
    );
  });
});

describe('pattern-recognition compare-patterns', () => {
  it('reports the share each event gained or lost', async () => {
    const result = await run({
      operation: 'compare-patterns',
      before: ['timeout', 'timeout', 'ok', 'ok'],
      after: ['ok', 'ok', 'ok', 'disk'],
    });
    /*
     * Largest absolute shift first, and the two 0.25 shifts tie, so they are
     * ordered by value: disk before ok.
     */
    expect(result.data.shifts).toEqual([
      { value: 'timeout', beforeShare: 0.5, afterShare: 0, delta: -0.5 },
      { value: 'disk', beforeShare: 0, afterShare: 0.25, delta: 0.25 },
      { value: 'ok', beforeShare: 0.5, afterShare: 0.75, delta: 0.25 },
    ]);
    expect(result.data.appeared).toEqual(['disk']);
    expect(result.data.disappeared).toEqual(['timeout']);
    // One shared event of three distinct: the Jaccard index is 1/3.
    expect(result.data.overlap).toBeCloseTo(1 / 3, 12);
  });

  it('compares streams of different length on shares, not counts', async () => {
    const result = await run({
      operation: 'compare-patterns',
      before: ['a'],
      after: ['a', 'a', 'a', 'a'],
    });
    // Same mix either side, so nothing shifted despite 1 event against 4.
    expect(result.data.shifts).toEqual([
      { value: 'a', beforeShare: 1, afterShare: 1, delta: 0 },
    ]);
    expect(result.data.overlap).toBe(1);
    expect(result.data.beforeCount).toBe(1);
    expect(result.data.afterCount).toBe(4);
  });

  it('refuses a missing side', async () => {
    await expect(
      run({ operation: 'compare-patterns', before: ['a'] })
    ).rejects.toThrow(
      'pattern-recognition compare-patterns: `after` is required and must hold at least one event'
    );
  });
});

describe('pattern-recognition visualize', () => {
  it('draws a sparkline and returns the bounds it was scaled between', async () => {
    const result = await run({
      operation: 'visualize',
      chart: 'sparkline',
      values: [1, 5, 3],
    });
    expect(result.data.min).toBe(1);
    expect(result.data.max).toBe(5);
    expect(result.data.points).toBe(3);
    expect(String(result.data.rendered)).toHaveLength(3);
  });

  it('draws bars labelled with their own values', async () => {
    const result = await run({
      operation: 'visualize',
      chart: 'bars',
      bars: [
        { label: 'timeout', value: 3 },
        { label: 'disk', value: 1 },
      ],
    });
    expect(result.data.rows).toBe(2);
    const rendered = String(result.data.rendered).split('\n');
    expect(rendered).toHaveLength(2);
    expect(rendered[0].endsWith(' 3')).toBe(true);
    expect(rendered[1].endsWith(' 1')).toBe(true);
    // Scaled on the peak, so the smaller bar is shorter.
    expect(rendered[0].split('#').length).toBeGreaterThan(
      rendered[1].split('#').length
    );
  });

  it('refuses an unknown chart and a chart missing its own input', async () => {
    await expect(
      run({
        operation: 'visualize',
        chart: 'pie' as unknown as 'bars',
        values: [1],
      })
    ).rejects.toThrow(
      'pattern-recognition visualize: `chart` must be one of sparkline, bars; received "pie"'
    );
    await expect(
      run({ operation: 'visualize', chart: 'bars', values: [1, 2] })
    ).rejects.toThrow(
      'pattern-recognition visualize: `bars` is required for the bars chart and must hold at least one row'
    );
    await expect(
      run({ operation: 'visualize', chart: 'sparkline', bars: [] })
    ).rejects.toThrow(/`values` is required/);
  });
});

describe('pattern-recognition export', () => {
  it('writes csv with escaped fields and counts the bytes', async () => {
    const result = await run({
      operation: 'export',
      format: 'csv',
      payload: [
        { value: 'timeout', count: 3 },
        { value: 'with,comma', count: 1 },
      ],
    });
    expect(result.data.content).toBe('value,count\ntimeout,3\n"with,comma",1');
    expect(result.data.rows).toBe(2);
    expect(result.data.bytes).toBe(
      Buffer.byteLength(String(result.data.content), 'utf8')
    );
  });

  it('refuses an unknown format and an absent payload', async () => {
    await expect(
      run({
        operation: 'export',
        format: 'yaml' as unknown as 'csv',
        payload: {},
      })
    ).rejects.toThrow(
      'pattern-recognition export: unknown format "yaml"; one of markdown, json, csv'
    );
    await expect(run({ operation: 'export', format: 'csv' })).rejects.toThrow(
      'pattern-recognition export: `payload` is required; there is no default document to export'
    );
  });
});

describe('pattern-recognition result shape', () => {
  it('reports no confidence, because nothing here is a probabilistic claim', async () => {
    const result = await run({
      operation: 'detect-patterns',
      events: ['a', 'a'],
    });
    expect(Object.keys(result.metadata).sort()).toEqual([
      'cacheHit',
      'processingTime',
      'tokensSaved',
      'tokensUsed',
    ]);
    expect(result.metadata.tokensUsed).toBeGreaterThan(0);
  });

  it('serves a repeated call from the cache without recomputing', async () => {
    const options: PatternRecognitionOptions = {
      operation: 'detect-patterns',
      events: ['a', 'a', 'b'],
    };
    const first = await tool.run(options);
    const second = await tool.run(options);
    expect(second.data).toEqual(first.data);
    expect(first.metadata.cacheHit).toBe(false);
    expect(second.metadata.cacheHit).toBe(true);
    expect(second.metadata.tokensSaved).toBeGreaterThan(0);
  });

  it('refuses an operation outside the published enum', async () => {
    await expect(
      run({ operation: 'invent-patterns' as PatternRecognitionOperation })
    ).rejects.toThrow(
      'pattern-recognition: unknown operation "invent-patterns"'
    );
  });
});

/**
 * The published schema is the only description of these arguments: validation
 * is derived from it. Each row names a call and whether the schema accepts it,
 * so a requirement that exists only in this file's prose fails here.
 */
const SCHEMA_CASES: ReadonlyArray<readonly [string, unknown, boolean]> =
  Object.freeze([
    [
      'detect-patterns with events',
      { operation: 'detect-patterns', events: ['a'] },
      true,
    ],
    ['detect-patterns without events', { operation: 'detect-patterns' }, false],
    [
      'detect-patterns with an empty stream',
      { operation: 'detect-patterns', events: [] },
      false,
    ],
    [
      'cluster-events with points and k',
      { operation: 'cluster-events', points: [[1]], k: 1 },
      true,
    ],
    [
      'cluster-events without k',
      { operation: 'cluster-events', points: [[1]] },
      false,
    ],
    [
      'cluster-events with a zero k',
      { operation: 'cluster-events', points: [[1]], k: 0 },
      false,
    ],
    [
      'find-correlations with named series',
      { operation: 'find-correlations', series: { a: [1, 2], b: [3, 4] } },
      true,
    ],
    [
      'find-correlations with a non-numeric series',
      { operation: 'find-correlations', series: { a: ['x'] } },
      false,
    ],
    [
      'mine-sequences with length',
      { operation: 'mine-sequences', events: ['a'], length: 1 },
      true,
    ],
    [
      'mine-sequences without length',
      { operation: 'mine-sequences', events: ['a'] },
      false,
    ],
    [
      'mine-sequences with minOccurrences of one',
      {
        operation: 'mine-sequences',
        events: ['a'],
        length: 1,
        minOccurrences: 1,
      },
      false,
    ],
    [
      'identify-trends with values',
      { operation: 'identify-trends', values: [1, 2, 3, 4] },
      true,
    ],
    ['identify-trends without values', { operation: 'identify-trends' }, false],
    [
      'compare-patterns with both sides',
      { operation: 'compare-patterns', before: ['a'], after: ['b'] },
      true,
    ],
    [
      'compare-patterns with one side',
      { operation: 'compare-patterns', before: ['a'] },
      false,
    ],
    [
      'visualize sparkline with values',
      { operation: 'visualize', chart: 'sparkline', values: [1] },
      true,
    ],
    [
      'visualize sparkline with bars instead',
      {
        operation: 'visualize',
        chart: 'sparkline',
        bars: [{ label: 'a', value: 1 }],
      },
      false,
    ],
    [
      'visualize bars with bars',
      {
        operation: 'visualize',
        chart: 'bars',
        bars: [{ label: 'a', value: 1 }],
      },
      true,
    ],
    [
      'visualize bars with values instead',
      { operation: 'visualize', chart: 'bars', values: [1] },
      false,
    ],
    [
      'visualize with an unknown chart',
      { operation: 'visualize', chart: 'pie', values: [1] },
      false,
    ],
    [
      'export with format and payload',
      { operation: 'export', format: 'csv', payload: {} },
      true,
    ],
    ['export without payload', { operation: 'export', format: 'csv' }, false],
    [
      'export with an unknown format',
      { operation: 'export', format: 'yaml', payload: {} },
      false,
    ],
    [
      'an unpublished argument',
      { operation: 'detect-patterns', events: ['a'], hint: 'please' },
      false,
    ],
    [
      'an unpublished operation',
      { operation: 'invent-patterns', events: ['a'] },
      false,
    ],
  ]);

describe('pattern-recognition published schema', () => {
  const schema = toolSchemaMap['pattern-recognition'];

  it.each(SCHEMA_CASES)('%s', (_name, value, accepted) => {
    expect(schema.safeParse(value).success).toBe(accepted);
  });

  it('is a table of refusals as well as acceptances', () => {
    // So a schema that accepted everything could not pass the rows above.
    const refusals = SCHEMA_CASES.filter(([, , accepted]) => !accepted);
    expect(refusals.length).toBeGreaterThan(SCHEMA_CASES.length / 2);
  });

  it('publishes exactly the operations the tool dispatches', () => {
    expect([...PATTERN_RECOGNITION_OPERATIONS]).toEqual([
      'detect-patterns',
      'cluster-events',
      'find-correlations',
      'mine-sequences',
      'identify-trends',
      'compare-patterns',
      'visualize',
      'export',
    ]);
  });
});
