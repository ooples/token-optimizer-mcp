import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CacheEngine } from '../../../src/core/cache-engine.js';
import { TokenCounter } from '../../../src/core/token-counter.js';
import { MetricsCollector } from '../../../src/core/metrics.js';
import {
  MODEL_KIND,
  PREDICTIVEANALYTICSTOOL,
  PREDICTIVE_ANALYTICS_OPERATIONS,
  PredictiveAnalytics,
  type PredictiveAnalyticsOptions,
  type PredictiveModel,
} from '../../../src/tools/intelligence/predictive-analytics.js';
import { NORMAL_QUANTILE_95 } from '../../../src/tools/intelligence/analytics-core.js';
import { toolSchemaMap } from '../../../src/validation/tool-schemas.js';

/**
 * Every test here pins a value derived from the INPUT.
 *
 * WHY THAT RULE: what this file replaces returned
 * `{ success: true, data: { result: "predict completed successfully" },
 *    metadata: { confidence: 0.85 } }`
 * for all eight operations, having read none of their arguments. A test
 * asserting `result.success === true`, or that `data` is an object, or that a
 * forecast "has points", would have passed against that. So each case states
 * the arithmetic it expects and, where floating point lands a step off the
 * algebra, says so in the comment rather than loosening the assertion.
 */

/**
 * The fitted model used throughout: x = [0,1,2,3], y = [1,3,2,4].
 *
 * Its algebra, worked once here so the expectations below can be read without
 * recomputing it. xBar = 1.5, yBar = 2.5; Sxy = 4, Sxx = 5, so slope = 0.8 and
 * intercept = 2.5 - 1.2 = 1.3. Residuals are (-0.3, 0.9, -0.9, 0.3), so the
 * residual sum of squares is 1.8 against a total of 5: r2 = 0.64 and the
 * residual standard error is sqrt(1.8 / 2) = sqrt(0.9).
 */
const FIT_X = [0, 1, 2, 3];
const FIT_Y = [1, 3, 2, 4];
const FIT_RSE = Math.sqrt(0.9);

describe('predictive-analytics', () => {
  let directory: string;
  let engine: CacheEngine;
  let tool: PredictiveAnalytics;

  beforeEach(() => {
    // A temp cache, never the real home cache.
    directory = mkdtempSync(join(tmpdir(), 'predictive-analytics-'));
    engine = new CacheEngine(join(directory, 'c.db'));
    tool = new PredictiveAnalytics(
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

  const run = (options: PredictiveAnalyticsOptions) =>
    tool.run({ ...options, useCache: false });

  const trainedModel = async (): Promise<PredictiveModel> => {
    const result = await run({ operation: 'train-model', x: FIT_X, y: FIT_Y });
    return result.data.model as PredictiveModel;
  };

  describe('train-model', () => {
    it('returns the least-squares coefficients of the data it was given', async () => {
      const model = await trainedModel();
      expect(model.kind).toBe(MODEL_KIND);
      expect(model.slope).toBe(0.8);
      // 2.5 - 0.8 * 1.5 is 1.3 exactly in algebra and 1.2999999999999998 in
      // binary floating point; asserted at that scale rather than loosened.
      expect(model.intercept).toBeCloseTo(1.3, 15);
      expect(model.r2).toBeCloseTo(0.64, 15);
      expect(model.residualStdError).toBeCloseTo(FIT_RSE, 15);
      expect(model.sampleSize).toBe(4);
      expect(model.xMean).toBe(1.5);
      expect(model.sxx).toBe(5);
    });

    it('fits an exact line exactly, with no residual spread', async () => {
      const result = await run({
        operation: 'train-model',
        x: [1, 2, 3, 4],
        y: [2, 4, 6, 8],
      });
      const model = result.data.model as PredictiveModel;
      expect(model.slope).toBe(2);
      expect(model.intercept).toBe(0);
      expect(model.r2).toBe(1);
      expect(model.residualStdError).toBe(0);
      expect(result.data.intervalsAvailable).toBe(true);
    });

    it('says intervals are unavailable from a two-point fit', async () => {
      /*
       * The residual standard error divides by n - 2, so two points give it no
       * degrees of freedom. `intervalsAvailable: false` says that up front
       * instead of leaving the caller to discover null bounds from `predict`.
       */
      const result = await run({
        operation: 'train-model',
        x: [0, 1],
        y: [0, 3],
      });
      const model = result.data.model as PredictiveModel;
      expect(model.slope).toBe(3);
      expect(model.residualStdError).toBeNull();
      expect(result.data.intervalsAvailable).toBe(false);
    });

    it('refuses a missing series, a mismatched pair and a non-numeric point', async () => {
      await expect(run({ operation: 'train-model', y: FIT_Y })).rejects.toThrow(
        'predictive-analytics train-model: `x` is required and must be an array of numbers'
      );
      await expect(
        run({ operation: 'train-model', x: [1, 2, 3], y: [1, 2] })
      ).rejects.toThrow(
        'predictive-analytics train-model: `x` and `y` must be the same length; received 3 and 2'
      );
      await expect(
        run({ operation: 'train-model', x: [1], y: [1] })
      ).rejects.toThrow(
        'predictive-analytics train-model: `x` needs at least 2 points; received 1'
      );
      await expect(
        run({
          operation: 'train-model',
          x: [1, 2],
          y: [1, Number.NaN] as number[],
        })
      ).rejects.toThrow(
        'predictive-analytics train-model: y[1] must be a finite number; received NaN'
      );
    });
  });

  describe('predict', () => {
    it('returns the line value with a 95% prediction interval around it', async () => {
      const model = await trainedModel();
      const result = await run({ operation: 'predict', model, at: [4] });
      expect(result.data.interval).toBe('normal-95');
      const points = result.data.points as Array<Record<string, number>>;
      expect(points).toHaveLength(1);
      // 0.8 * 4 + 1.3
      expect(points[0].value).toBeCloseTo(4.5, 15);
      /*
       * The margin is z * s * sqrt(1 + 1/n + (x - xBar)^2 / Sxx), which at
       * x = 4 is 1.959963984540054 * sqrt(0.9) * sqrt(1 + 0.25 + 6.25/5).
       * Recomputed here from the model rather than pasted, so the test states
       * the formula it is checking.
       */
      const margin =
        NORMAL_QUANTILE_95 * FIT_RSE * Math.sqrt(1 + 1 / 4 + 6.25 / 5);
      expect(points[0].lower).toBeCloseTo(4.5 - margin, 13);
      expect(points[0].upper).toBeCloseTo(4.5 + margin, 13);
      expect(points[0].upper - points[0].lower).toBeCloseTo(2 * margin, 13);
    });

    it('widens the interval with distance from the fitted data', async () => {
      const model = await trainedModel();
      const result = await run({ operation: 'predict', model, at: [2, 10] });
      const points = result.data.points as Array<Record<string, number>>;
      const near = points[0].upper - points[0].lower;
      const far = points[1].upper - points[1].lower;
      expect(far).toBeGreaterThan(near);
      /*
       * `extrapolation` is |x - xBar| divided by the fitted data's own standard
       * deviation of x, sqrt(Sxx/n) = sqrt(1.25). At x = 10 that is 8.5 of
       * them -- the figure that says a straight line is being read far outside
       * the range it was fitted on, which the arithmetic alone will not say.
       */
      expect(points[1].extrapolation).toBeCloseTo(8.5 / Math.sqrt(1.25), 13);
      expect(points[0].extrapolation).toBeCloseTo(0.5 / Math.sqrt(1.25), 13);
    });

    it('returns null bounds, not zero-width ones, when the fit had no spread estimate', async () => {
      const trained = await run({
        operation: 'train-model',
        x: [0, 1],
        y: [0, 3],
      });
      const result = await run({
        operation: 'predict',
        model: trained.data.model as PredictiveModel,
        at: [2],
      });
      const points = result.data.points as Array<Record<string, unknown>>;
      expect(points[0].value).toBe(6);
      // A zero-width interval would read as certainty from two points.
      expect(points[0].lower).toBeNull();
      expect(points[0].upper).toBeNull();
    });

    it('refuses a missing, foreign or half-populated model', async () => {
      await expect(run({ operation: 'predict', at: [1] })).rejects.toThrow(
        'predictive-analytics predict: `model` is required; pass the model train-model returned'
      );
      await expect(
        run({
          operation: 'predict',
          at: [1],
          model: { kind: 'random-forest' } as unknown as PredictiveModel,
        })
      ).rejects.toThrow(
        'predictive-analytics predict: `model.kind` must be "ols-linear"; received "random-forest"'
      );
      await expect(
        run({
          operation: 'predict',
          at: [1],
          model: {
            kind: MODEL_KIND,
            intercept: 0,
            r2: 1,
            residualStdError: 0,
            sampleSize: 4,
            xMean: 0,
            sxx: 1,
          } as unknown as PredictiveModel,
        })
      ).rejects.toThrow(
        'predictive-analytics predict: `model.slope` must be a finite number; received undefined'
      );
      const model = await trainedModel();
      await expect(run({ operation: 'predict', model })).rejects.toThrow(
        'predictive-analytics predict: `at` is required and must be an array of numbers'
      );
    });
  });

  describe('detect-anomalies', () => {
    it('flags only the points past the z-score threshold, with their scores', async () => {
      const result = await run({
        operation: 'detect-anomalies',
        values: [10, 11, 10, 12, 40],
        threshold: 1.5,
      });
      expect(result.data.method).toBe('z-score');
      expect(result.data.threshold).toBe(1.5);
      expect(result.data.sampleSize).toBe(5);
      expect(result.data.found).toBe(1);
      const found = result.data.anomalies as Array<Record<string, number>>;
      expect(found).toHaveLength(1);
      expect(found[0].index).toBe(4);
      expect(found[0].value).toBe(40);
      // (40 - 16.6) / sd, with sd the n-1 sample deviation 13.1072...
      expect(found[0].score).toBeCloseTo(1.7852715233563494, 13);
    });

    it('measures distance past the iqr fence, not past the quartile', async () => {
      const result = await run({
        operation: 'detect-anomalies',
        values: [1, 2, 3, 4, 5, 6, 7, 8, 100],
        method: 'iqr' as never,
      });
      expect(result.data.method).toBe('iqr');
      // The iqr default, reported back so two runs can be compared.
      expect(result.data.threshold).toBe(1.5);
      const found = result.data.anomalies as Array<Record<string, number>>;
      expect(found).toHaveLength(1);
      expect(found[0].value).toBe(100);
      /*
       * Q1 = 3, Q3 = 7, so the spread is 4 and the upper fence 7 + 1.5*4 = 13.
       * The score is (100 - 13) / 4 = 21.75: how far past the FENCE, which is
       * the quantity the threshold is about.
       */
      expect(found[0].score).toBe(21.75);
    });

    it('finds nothing in a series with nothing extreme', async () => {
      const result = await run({
        operation: 'detect-anomalies',
        values: [5, 5, 6, 5, 6, 5],
      });
      expect(result.data.found).toBe(0);
      expect(result.data.anomalies).toEqual([]);
      // The default is stated, not implied by the absence of findings.
      expect(result.data.threshold).toBe(3);
    });

    it('refuses an unknown method and a missing series', async () => {
      await expect(
        run({
          operation: 'detect-anomalies',
          values: [1, 2, 3],
          method: 'isolation-forest' as never,
        })
      ).rejects.toThrow(
        'predictive-analytics detect-anomalies: `method` must be z-score or iqr; received "isolation-forest"'
      );
      await expect(run({ operation: 'detect-anomalies' })).rejects.toThrow(
        'predictive-analytics detect-anomalies: `values` is required and must be an array of numbers'
      );
    });
  });

  describe('forecast-capacity', () => {
    /** Sxx = 10, xBar = 2, slope = 10.4, intercept = 9.8, s = sqrt(1.2). */
    const SERIES = [10, 21, 29, 41, 52];

    it('projects the requested number of steps past the last observation', async () => {
      const result = await run({
        operation: 'forecast-capacity',
        values: SERIES,
        horizon: 3,
      });
      expect(result.data.slopePerStep).toBeCloseTo(10.4, 13);
      expect(result.data.sampleSize).toBe(5);
      const points = result.data.points as Array<Record<string, number>>;
      // The series occupies indices 0..4, so the forecast starts at 5.
      expect(points.map((point) => point.at)).toEqual([5, 6, 7]);
      expect(points[0].value).toBeCloseTo(61.8, 13);
      expect(points[2].value).toBeCloseTo(82.6, 13);
      expect(points[0].lower).toBeLessThan(points[0].value);
      expect(points[2].upper! - points[2].lower!).toBeGreaterThan(
        points[0].upper! - points[0].lower!
      );
      expect(result.data.crossing).toBeUndefined();
    });

    it('reports the point crossing and the upper-bound crossing separately', async () => {
      const result = await run({
        operation: 'forecast-capacity',
        values: SERIES,
        horizon: 3,
        limit: 63,
      });
      /*
       * The two differ, and the difference is the answer: the projection
       * reaches 63 at step 6, but its upper bound already reaches it at step 5.
       * Capacity planning acts on the earlier one, which a single "forecast
       * crosses at 6" would have hidden.
       */
      expect(result.data.crossing).toEqual({
        limit: 63,
        atPoint: 6,
        atUpperBound: 5,
      });
    });

    it('reports null rather than the last step when the limit is not reached', async () => {
      const result = await run({
        operation: 'forecast-capacity',
        values: SERIES,
        horizon: 2,
        limit: 1000,
      });
      expect(result.data.crossing).toEqual({
        limit: 1000,
        atPoint: null,
        atUpperBound: null,
      });
    });

    it('defaults to a single step and refuses a bad horizon or limit', async () => {
      const result = await run({
        operation: 'forecast-capacity',
        values: SERIES,
      });
      expect(result.data.points).toHaveLength(1);
      await expect(
        run({ operation: 'forecast-capacity', values: SERIES, horizon: 0 })
      ).rejects.toThrow(
        'predictive-analytics forecast-capacity: `horizon` must be an integer of at least 1; received 0'
      );
      await expect(
        run({
          operation: 'forecast-capacity',
          values: SERIES,
          limit: Number.NaN,
        })
      ).rejects.toThrow(
        'predictive-analytics forecast-capacity: `limit` must be a finite number; received NaN'
      );
    });
  });

  describe('predict-failures', () => {
    const RECORDS = [
      { label: 'clean', failures: 0, total: 10 },
      { label: 'flaky', failures: 3, total: 10 },
    ];

    it('gives a clean group a non-zero upper bound', async () => {
      const result = await run({
        operation: 'predict-failures',
        records: RECORDS,
      });
      const byLabel = result.data.byLabel as Array<Record<string, number>>;
      const clean = byLabel.find((entry) => entry.label === 'clean');
      expect(clean!.rate).toBe(0);
      expect(clean!.lower).toBe(0);
      /*
       * The textbook normal interval at 0 of 10 is [0, 0] -- it says the event
       * cannot happen on the strength of ten clean trials. Wilson says the rate
       * could still be better than one in four, which is the honest reading and
       * z^2 / (10 + z^2) exactly.
       */
      expect(clean!.upper).toBeCloseTo(0.2775327998628892, 15);
    });

    it('ranks by observed rate and totals the whole set', async () => {
      const result = await run({
        operation: 'predict-failures',
        records: RECORDS,
      });
      const byLabel = result.data.byLabel as Array<Record<string, number>>;
      expect(byLabel.map((entry) => entry.label)).toEqual(['flaky', 'clean']);
      expect(result.data.worst).toEqual(byLabel[0]);
      expect(byLabel[0].rate).toBe(0.3);
      expect(byLabel[0].lower).toBeCloseTo(0.10779126740630099, 15);
      expect(byLabel[0].upper).toBeCloseTo(0.6032218525388546, 15);
      // Pooled over both groups: 3 failures in 20 trials, not the mean of rates.
      expect(result.data.overall).toEqual({
        failures: 3,
        total: 20,
        rate: 0.15,
        lower: 0.052368745896216595,
        upper: 0.36041886474075696,
      });
      expect(result.data.interval).toBe('normal-95');
    });

    it('scales the observed rate over the trials ahead, only when asked', async () => {
      const bare = await run({
        operation: 'predict-failures',
        records: RECORDS,
      });
      const byLabel = bare.data.byLabel as Array<Record<string, unknown>>;
      // No `upcoming`, so no count is projected -- not a count of zero.
      expect(byLabel[0].expectedFailures).toBeUndefined();
      expect(bare.data.upcoming).toBeUndefined();

      const projected = await run({
        operation: 'predict-failures',
        records: RECORDS,
        upcoming: 100,
      });
      expect(projected.data.upcoming).toBe(100);
      const scaled = projected.data.byLabel as Array<Record<string, number>>;
      expect(scaled[0].expectedFailures).toBe(30);
      expect(scaled[1].expectedFailures).toBe(0);
    });

    it('refuses no records, an impossible count and a bad projection', async () => {
      await expect(
        run({ operation: 'predict-failures', records: [] })
      ).rejects.toThrow(
        'predictive-analytics predict-failures: `records` is required and must hold at least one { label, failures, total }'
      );
      await expect(
        run({
          operation: 'predict-failures',
          records: [{ label: 'x', failures: 5, total: 2 }],
        })
      ).rejects.toThrow('wilsonInterval needs 0 <= successes <= trials');
      await expect(
        run({
          operation: 'predict-failures',
          records: [{ label: 'x', failures: 0, total: 0 }],
        })
      ).rejects.toThrow('wilsonInterval needs at least one trial');
      await expect(
        run({ operation: 'predict-failures', records: RECORDS, upcoming: -1 })
      ).rejects.toThrow(
        'predictive-analytics predict-failures: `upcoming` must be an integer of at least 0; received -1'
      );
    });
  });

  describe('analyze-trends', () => {
    it('separates whether a series is trending from how fast it is', async () => {
      const result = await run({
        operation: 'analyze-trends',
        series: { up: [1, 2, 3, 4, 5], flat: [2, 2, 2, 2, 2] },
      });
      const trends = result.data.trends as Array<Record<string, number>>;
      // Ordered by |tau|, so the series with a trend leads.
      expect(trends.map((entry) => entry.name)).toEqual(['up', 'flat']);
      expect(trends[0].direction).toBe('increasing');
      expect(trends[0].tau).toBe(1);
      expect(trends[0].p).toBeLessThan(0.05);
      expect(trends[0].slopePerStep).toBe(1);
      expect(trends[0].r2).toBe(1);
      expect(trends[1].direction).toBe('none');
      expect(trends[1].tau).toBe(0);
      expect(trends[1].slopePerStep).toBe(0);
      expect(result.data.increasing).toBe(1);
      expect(result.data.decreasing).toBe(0);
    });

    it('reports the ewma level at the final observation, at the stated alpha', async () => {
      const result = await run({
        operation: 'analyze-trends',
        series: { up: [1, 2, 3, 4, 5] },
      });
      expect(result.data.alpha).toBe(0.3);
      const trends = result.data.trends as Array<Record<string, number>>;
      /*
       * Seeded at x[0] = 1 and folded forward at alpha 0.3:
       * 1 -> 1.3 -> 1.81 -> 2.467 -> 3.2269. It lags the last observation of 5
       * because that is what smoothing does, so the level is reported beside
       * the slope rather than instead of it.
       */
      expect(trends[0].level).toBeCloseTo(3.2269, 13);
      expect(trends[0].sampleSize).toBe(5);
    });

    it('follows the alpha it is given', async () => {
      const result = await run({
        operation: 'analyze-trends',
        series: { up: [1, 2, 3, 4, 5] },
        alpha: 1,
      });
      expect(result.data.alpha).toBe(1);
      const trends = result.data.trends as Array<Record<string, number>>;
      // Alpha 1 keeps no history, so the level is the last observation itself.
      expect(trends[0].level).toBe(5);
    });

    it('counts a falling series as decreasing', async () => {
      const result = await run({
        operation: 'analyze-trends',
        series: { down: [9, 7, 5, 3, 1] },
      });
      const trends = result.data.trends as Array<Record<string, number>>;
      expect(trends[0].direction).toBe('decreasing');
      expect(trends[0].tau).toBe(-1);
      expect(trends[0].slopePerStep).toBe(-2);
      expect(result.data.decreasing).toBe(1);
      expect(result.data.increasing).toBe(0);
    });

    it('names the series it could not use and refuses an empty set', async () => {
      await expect(
        run({ operation: 'analyze-trends', series: { short: [1, 2, 3] } })
      ).rejects.toThrow(
        'predictive-analytics analyze-trends: `series.short` needs at least 4 points; received 3'
      );
      await expect(
        run({ operation: 'analyze-trends', series: {} })
      ).rejects.toThrow(
        'predictive-analytics analyze-trends: `series` must name at least one series'
      );
      await expect(run({ operation: 'analyze-trends' })).rejects.toThrow(
        'predictive-analytics analyze-trends: `series` is required and must be an object of named numeric series'
      );
      await expect(
        run({
          operation: 'analyze-trends',
          series: { a: [1, 2, 3, 4] },
          alpha: 0,
        })
      ).rejects.toThrow(
        'predictive-analytics analyze-trends: `alpha` must be in (0, 1]; received 0'
      );
    });
  });

  describe('evaluate', () => {
    it('scores predictions the caller made, not a fit to them', async () => {
      const result = await run({
        operation: 'evaluate',
        actual: [10, 20, 30],
        predicted: [11, 19, 32],
      });
      expect(result.data.sampleSize).toBe(3);
      // Errors +1, -1, +2: mean absolute 4/3, root mean square sqrt(2).
      expect(result.data.mae).toBeCloseTo(4 / 3, 15);
      expect(result.data.rmse).toBeCloseTo(Math.SQRT2, 15);
      // Signed, so it says the predictions run high rather than just by how much.
      expect(result.data.bias).toBeCloseTo(2 / 3, 15);
      expect(result.data.mape).toBeCloseTo((0.1 + 0.05 + 2 / 30) / 3, 15);
      expect(result.data.mapeOmitted).toBe(false);
      // Actuals vary by 200 in total; squared error is 6, so r2 = 1 - 6/200.
      expect(result.data.r2).toBeCloseTo(0.97, 15);
      expect(result.data.worseThanMean).toBe(false);
    });

    it('omits mape rather than substituting a number for an undefined one', async () => {
      const result = await run({
        operation: 'evaluate',
        actual: [0, 10],
        predicted: [1, 11],
      });
      // The percentage error at an actual of zero does not exist.
      expect(result.data.mape).toBeNull();
      expect(result.data.mapeOmitted).toBe(true);
      expect(result.data.mae).toBe(1);
    });

    it('lets r2 go negative and says what that means', async () => {
      const result = await run({
        operation: 'evaluate',
        actual: [1, 2, 3],
        predicted: [100, 100, 100],
      });
      /*
       * Clamping to [0, 1] would destroy exactly this information: the
       * predictions are worse than always guessing the actuals' own mean.
       */
      expect(result.data.r2).toBeLessThan(0);
      expect(result.data.worseThanMean).toBe(true);
    });

    it('refuses a mismatched or missing pair', async () => {
      await expect(
        run({ operation: 'evaluate', actual: [1, 2], predicted: [1] })
      ).rejects.toThrow(
        'predictive-analytics evaluate: `actual` and `predicted` must be the same length; received 2 and 1'
      );
      await expect(
        run({ operation: 'evaluate', actual: [1, 2] })
      ).rejects.toThrow(
        'predictive-analytics evaluate: `predicted` is required and must be an array of numbers'
      );
    });
  });

  describe('export-model', () => {
    it('writes every coefficient and the fit quality beside them', async () => {
      const trained = await run({
        operation: 'train-model',
        x: [1, 2, 3, 4],
        y: [2, 4, 6, 8],
      });
      const result = await run({
        operation: 'export-model',
        model: trained.data.model as PredictiveModel,
        format: 'csv',
      });
      expect(result.data.content).toBe(
        [
          'field,value',
          'kind,ols-linear',
          'slope,2',
          'intercept,0',
          'r2,1',
          'residualStdError,0',
          'sampleSize,4',
          'xMean,2.5',
          'sxx,5',
        ].join('\n')
      );
      expect(result.data.rows).toBe(8);
      expect(result.data.bytes).toBe(
        Buffer.byteLength(result.data.content as string, 'utf8')
      );
    });

    it('writes the same rows as a markdown table', async () => {
      const result = await run({
        operation: 'export-model',
        model: (await trainedModel()) satisfies PredictiveModel,
        format: 'markdown',
      });
      const lines = (result.data.content as string).split('\n');
      expect(lines[0]).toBe('| field | value |');
      expect(lines[1]).toBe('| --- | --- |');
      expect(lines[2]).toBe('| kind | ols-linear |');
      expect(lines).toHaveLength(10);
    });

    it('refuses an unknown format', async () => {
      await expect(
        run({
          operation: 'export-model',
          model: await trainedModel(),
          format: 'xlsx' as never,
        })
      ).rejects.toThrow(
        'predictive-analytics export-model: unknown format "xlsx"; one of markdown, json, csv'
      );
    });
  });

  describe('result envelope', () => {
    it('carries no confidence field at all', async () => {
      const result = await run({
        operation: 'detect-anomalies',
        values: [1, 2, 3],
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
      const options: PredictiveAnalyticsOptions = {
        operation: 'evaluate',
        actual: [1, 2, 3],
        predicted: [1, 2, 4],
      };
      const first = await tool.run(options);
      expect(first.metadata.cacheHit).toBe(false);
      const second = await tool.run(options);
      expect(second.metadata.cacheHit).toBe(true);
      expect(second.data).toEqual(first.data);
    });

    it('refuses an operation that is not published', async () => {
      await expect(run({ operation: 'auto-ml' as never })).rejects.toThrow(
        'predictive-analytics: unknown operation "auto-ml"'
      );
    });
  });

  describe('published schema', () => {
    const schema = toolSchemaMap['predictive-analytics'];

    /**
     * The schema `tools/list` publishes is the one validated here, derived from
     * the same definition. These rows check that the conditional requirements
     * are enforced by it and not merely described in a property description a
     * client cannot act on.
     */
    const SCHEMA_CASES: ReadonlyArray<readonly [string, unknown, boolean]> = [
      [
        'train-model with both series',
        { operation: 'train-model', x: [1, 2], y: [1, 2] },
        true,
      ],
      ['train-model without y', { operation: 'train-model', x: [1, 2] }, false],
      [
        'train-model with a one-point series',
        { operation: 'train-model', x: [1], y: [1] },
        false,
      ],
      [
        'predict with a model and positions',
        {
          operation: 'predict',
          model: {
            kind: 'ols-linear',
            slope: 1,
            intercept: 0,
            sampleSize: 4,
            xMean: 0,
            sxx: 1,
          },
          at: [1],
        },
        true,
      ],
      ['predict without a model', { operation: 'predict', at: [1] }, false],
      [
        'predict with a foreign model kind',
        {
          operation: 'predict',
          at: [1],
          model: {
            kind: 'random-forest',
            slope: 1,
            intercept: 0,
            sampleSize: 4,
            xMean: 0,
            sxx: 1,
          },
        },
        false,
      ],
      [
        'predict with an empty position list',
        {
          operation: 'predict',
          model: {
            kind: 'ols-linear',
            slope: 1,
            intercept: 0,
            sampleSize: 4,
            xMean: 0,
            sxx: 1,
          },
          at: [],
        },
        false,
      ],
      [
        'detect-anomalies with values',
        { operation: 'detect-anomalies', values: [1, 2] },
        true,
      ],
      [
        'detect-anomalies without values',
        { operation: 'detect-anomalies' },
        false,
      ],
      [
        'detect-anomalies with an unknown method',
        {
          operation: 'detect-anomalies',
          values: [1, 2],
          method: 'isolation-forest',
        },
        false,
      ],
      [
        'detect-anomalies with a zero threshold',
        { operation: 'detect-anomalies', values: [1, 2], threshold: 0 },
        false,
      ],
      [
        'forecast-capacity with values',
        { operation: 'forecast-capacity', values: [1, 2] },
        true,
      ],
      [
        'forecast-capacity with a zero horizon',
        { operation: 'forecast-capacity', values: [1, 2], horizon: 0 },
        false,
      ],
      [
        'predict-failures with one record',
        {
          operation: 'predict-failures',
          records: [{ label: 'a', failures: 0, total: 1 }],
        },
        true,
      ],
      [
        'predict-failures with no records',
        { operation: 'predict-failures', records: [] },
        false,
      ],
      [
        'predict-failures with a zero-trial record',
        {
          operation: 'predict-failures',
          records: [{ label: 'a', failures: 0, total: 0 }],
        },
        false,
      ],
      [
        'predict-failures with an extra record key',
        {
          operation: 'predict-failures',
          records: [{ label: 'a', failures: 0, total: 1, note: 'x' }],
        },
        false,
      ],
      [
        'analyze-trends with a named series',
        { operation: 'analyze-trends', series: { a: [1, 2] } },
        true,
      ],
      ['analyze-trends without series', { operation: 'analyze-trends' }, false],
      [
        'analyze-trends with a non-numeric series',
        { operation: 'analyze-trends', series: { a: ['x'] } },
        false,
      ],
      [
        'analyze-trends with alpha above one',
        { operation: 'analyze-trends', series: { a: [1] }, alpha: 1.5 },
        false,
      ],
      [
        'evaluate with both series',
        { operation: 'evaluate', actual: [1], predicted: [1] },
        true,
      ],
      [
        'evaluate without predicted',
        { operation: 'evaluate', actual: [1] },
        false,
      ],
      [
        'export-model with a model and format',
        {
          operation: 'export-model',
          format: 'csv',
          model: {
            kind: 'ols-linear',
            slope: 1,
            intercept: 0,
            sampleSize: 4,
            xMean: 0,
            sxx: 1,
          },
        },
        true,
      ],
      ['export-model without a format', { operation: 'export-model' }, false],
      [
        'export-model with an unknown format',
        {
          operation: 'export-model',
          format: 'xlsx',
          model: {
            kind: 'ols-linear',
            slope: 1,
            intercept: 0,
            sampleSize: 4,
            xMean: 0,
            sxx: 1,
          },
        },
        false,
      ],
      [
        'an unknown key',
        { operation: 'detect-anomalies', values: [1, 2], depth: 3 },
        false,
      ],
      ['an unpublished operation', { operation: 'auto-ml' }, false],
    ];

    it('publishes exactly the operations the tool dispatches', () => {
      /*
       * The enum in the definition and the array the switch reads are the same
       * array by construction; this pins that the published enum is that array
       * and nothing else, so an operation cannot be advertised without a
       * branch to serve it.
       */
      expect(
        PREDICTIVEANALYTICSTOOL.inputSchema.properties.operation.enum
      ).toEqual([...PREDICTIVE_ANALYTICS_OPERATIONS]);
      expect(PREDICTIVE_ANALYTICS_OPERATIONS).toHaveLength(8);
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
