/**
 * PredictiveAnalytics -- fitting, forecasting and scoring over numeric series
 * the caller supplies.
 *
 * WHAT WAS HERE: all eight published operations returned
 * `{ success: true, data: { result: "<operation> completed successfully" } }`
 * with a hard-coded `confidence: 0.85`, having read none of their input.
 *
 * WHAT A "MODEL" IS HERE, since the word invites the wrong expectation: an
 * ordinary-least-squares straight line, returned to the caller as its
 * coefficients plus the two quantities a prediction interval needs. There is
 * no training loop, no hidden store and no model file; `train-model` hands back
 * the fit, and `predict` takes that object straight from the caller. A tool
 * that kept a model somewhere the caller could not see, and reported
 * predictions from it, would be unfalsifiable -- which is what the thing this
 * file replaces was.
 *
 * EVERY INTERVAL IS A NORMAL APPROXIMATION and says so in the field name
 * (`interval: 'normal-95'`). None of them is an exact t interval, and none of
 * them is a probability that the caller's system will fail.
 *
 * An operation whose inputs are absent REFUSES, naming the missing key.
 */

import type { CacheEngine } from '../../core/cache-engine.js';
import type { TokenCounter } from '../../core/token-counter.js';
import type { MetricsCollector } from '../../core/metrics.js';
import { generateCacheKey } from '../shared/hash-utils.js';
import {
  MINIMUM_SAMPLES,
  NORMAL_QUANTILE_95,
  OutlierMethod,
  ewma,
  forecastLinear,
  linearFit,
  mannKendall,
  mean,
  outliers,
  regressionMetrics,
  TrendDirection,
  wilsonInterval,
} from './analytics-core.js';
import {
  EXPORT_FORMATS,
  isExportFormat,
  renderPayload,
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
export const PREDICTIVE_ANALYTICS_OPERATIONS = [
  'predict',
  'train-model',
  'detect-anomalies',
  'forecast-capacity',
  'predict-failures',
  'analyze-trends',
  'evaluate',
  'export-model',
] as const;

export type PredictiveAnalyticsOperation =
  (typeof PREDICTIVE_ANALYTICS_OPERATIONS)[number];

/** The one model form this tool fits, named in the model it returns. */
export const MODEL_KIND = 'ols-linear';

/** The interval every bound here is, named so none of them reads as exact. */
export const INTERVAL_KIND = 'normal-95';

export { EXPORT_FORMATS, type ExportFormat };

/**
 * Defaults. Each is a presentation or convention choice, never a stand-in for
 * a missing input: 3 and 1.5 are the conventional z-score and IQR thresholds,
 * and 0.3 is a middling EWMA weight -- all three are the caller's to override,
 * which is why each is reported back in the result.
 */
export const PREDICTIVE_ANALYTICS_DEFAULTS = Object.freeze({
  zScoreThreshold: 3,
  iqrThreshold: 1.5,
  alpha: 0.3,
  horizon: 1,
});

/**
 * A fitted line, plus the two quantities needed to widen a prediction interval
 * for distance from the data: the mean of x, and the sum of squared deviations
 * about it. They are part of the model because without them `predict` could
 * only return a point, and a point with no interval reads as certainty.
 */
export interface PredictiveModel {
  kind: typeof MODEL_KIND;
  slope: number;
  intercept: number;
  r2: number;
  residualStdError: number | null;
  sampleSize: number;
  xMean: number;
  sxx: number;
}

/** One trial group `predict-failures` reads: how many of how many failed. */
export interface FailureRecord {
  label: string;
  failures: number;
  total: number;
}

export interface PredictiveAnalyticsOptions {
  operation: PredictiveAnalyticsOperation;
  /** train-model: paired observations. */
  x?: number[];
  y?: number[];
  /** predict, export-model: the object train-model returned. */
  model?: PredictiveModel;
  /** predict: the x positions to predict at. */
  at?: number[];
  /** detect-anomalies, forecast-capacity: one series in order. */
  values?: number[];
  method?: OutlierMethod;
  threshold?: number;
  /** forecast-capacity. */
  horizon?: number;
  limit?: number;
  /** predict-failures. */
  records?: FailureRecord[];
  upcoming?: number;
  /** analyze-trends: named series, each in time order. */
  series?: Record<string, number[]>;
  alpha?: number;
  /** evaluate. */
  actual?: number[];
  predicted?: number[];
  /** export-model. */
  format?: ExportFormat;
  useCache?: boolean;
}

export interface PredictiveAnalyticsResult {
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
 * it, because a caller must be able to act on the error without reading this
 * file.
 */
const requireValues = (
  operation: string,
  key: string,
  values: number[] | undefined,
  minimum: number
): number[] => {
  if (!Array.isArray(values))
    throw new Error(
      `predictive-analytics ${operation}: \`${key}\` is required and must be an array of numbers`
    );
  values.forEach((value, index) => {
    if (typeof value !== 'number' || !Number.isFinite(value))
      throw new Error(
        `predictive-analytics ${operation}: ${key}[${index}] must be a finite number; received ${String(value)}`
      );
  });
  if (values.length < minimum)
    throw new Error(
      `predictive-analytics ${operation}: \`${key}\` needs at least ${minimum} points; received ${values.length}`
    );
  return values;
};

/**
 * A model the caller sent back. Every field is checked, because a prediction
 * computed from a half-populated model would be a number with no provenance --
 * and this file exists because of numbers with no provenance.
 */
const requireModel = (
  operation: string,
  model: PredictiveModel | undefined
): PredictiveModel => {
  if (model === null || model === undefined || typeof model !== 'object')
    throw new Error(
      `predictive-analytics ${operation}: \`model\` is required; pass the model train-model returned`
    );
  if (model.kind !== MODEL_KIND)
    throw new Error(
      `predictive-analytics ${operation}: \`model.kind\` must be ${JSON.stringify(MODEL_KIND)}; received ${JSON.stringify(model.kind)}`
    );
  for (const key of ['slope', 'intercept', 'xMean', 'sxx'] as const)
    if (typeof model[key] !== 'number' || !Number.isFinite(model[key]))
      throw new Error(
        `predictive-analytics ${operation}: \`model.${key}\` must be a finite number; received ${String(model[key])}`
      );
  if (!Number.isInteger(model.sampleSize) || model.sampleSize < 2)
    throw new Error(
      `predictive-analytics ${operation}: \`model.sampleSize\` must be an integer of at least 2; received ${String(model.sampleSize)}`
    );
  return model;
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
      `predictive-analytics ${operation}: \`${key}\` must be an integer of at least 1; received ${String(value)}`
    );
  return value;
};

export class PredictiveAnalytics {
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
    options: PredictiveAnalyticsOptions
  ): Promise<PredictiveAnalyticsResult> {
    const startTime = Date.now();
    const cacheKey = generateCacheKey('predictive-analytics', {
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
      operation: `predictive-analytics:${options.operation}`,
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
   * implementation here reaches the default and is refused.
   */
  private compute(
    options: PredictiveAnalyticsOptions
  ): Record<string, unknown> {
    const operation = options.operation;
    switch (operation) {
      case 'predict':
        return this.predict(options);
      case 'train-model':
        return this.trainModel(options);
      case 'detect-anomalies':
        return this.detectAnomalies(options);
      case 'forecast-capacity':
        return this.forecastCapacity(options);
      case 'predict-failures':
        return this.predictFailures(options);
      case 'analyze-trends':
        return this.analyzeTrends(options);
      case 'evaluate':
        return this.evaluate(options);
      case 'export-model':
        return this.exportModel(options);
      default:
        throw new Error(
          `predictive-analytics: unknown operation ${JSON.stringify(operation)}`
        );
    }
  }

  /**
   * Fit y = slope*x + intercept by ordinary least squares and hand the fit
   * back. The caller holds the model; nothing is stored here.
   */
  private trainModel(
    options: PredictiveAnalyticsOptions
  ): Record<string, unknown> {
    const x = requireValues(
      'train-model',
      'x',
      options.x,
      MINIMUM_SAMPLES.paired
    );
    const y = requireValues(
      'train-model',
      'y',
      options.y,
      MINIMUM_SAMPLES.paired
    );
    if (x.length !== y.length)
      throw new Error(
        `predictive-analytics train-model: \`x\` and \`y\` must be the same length; received ${x.length} and ${y.length}`
      );
    const fit = linearFit(x, y);
    const xMean = mean(x);
    let sxx = 0;
    for (const value of x) sxx += (value - xMean) ** 2;
    const model: PredictiveModel = {
      kind: MODEL_KIND,
      slope: fit.slope,
      intercept: fit.intercept,
      r2: fit.r2,
      residualStdError: fit.residualStdError,
      sampleSize: fit.sampleSize,
      xMean,
      sxx,
    };
    return {
      model,
      /*
       * `residualStdError` is null below three points, because it divides by
       * n-2. Said plainly here rather than left for the caller to discover
       * when `predict` returns null bounds.
       */
      intervalsAvailable: fit.residualStdError !== null,
      r2: fit.r2,
      sampleSize: fit.sampleSize,
    };
  }

  /**
   * Point predictions with a 95% prediction interval, widened for distance
   * from the data the model was fitted on. The bounds are null when the fit
   * had too few points to estimate residual spread -- a null interval, not a
   * zero-width one, because zero width would read as certainty.
   */
  private predict(
    options: PredictiveAnalyticsOptions
  ): Record<string, unknown> {
    const model = requireModel('predict', options.model);
    const at = requireValues('predict', 'at', options.at, 1);
    const points = at.map((x) => {
      const value = model.slope * x + model.intercept;
      if (model.residualStdError === null || model.sxx === 0)
        return { at: x, value, lower: null, upper: null, extrapolation: 0 };
      const spread =
        model.residualStdError *
        Math.sqrt(
          1 + 1 / model.sampleSize + (x - model.xMean) ** 2 / model.sxx
        );
      const margin = NORMAL_QUANTILE_95 * spread;
      return {
        at: x,
        value,
        lower: value - margin,
        upper: value + margin,
        /*
         * How far outside the fitted data this x sits, in units of that data's
         * own spread. Reported because a straight line extrapolated far past
         * its data is still a straight line, and nothing in the arithmetic
         * will say so.
         */
        extrapolation:
          Math.abs(x - model.xMean) / Math.sqrt(model.sxx / model.sampleSize),
      };
    });
    return { interval: INTERVAL_KIND, points, model: model.kind };
  }

  private detectAnomalies(
    options: PredictiveAnalyticsOptions
  ): Record<string, unknown> {
    const values = requireValues(
      'detect-anomalies',
      'values',
      options.values,
      MINIMUM_SAMPLES.variance
    );
    const method = options.method ?? OutlierMethod.ZScore;
    if (method !== OutlierMethod.ZScore && method !== OutlierMethod.Iqr)
      throw new Error(
        `predictive-analytics detect-anomalies: \`method\` must be ${OutlierMethod.ZScore} or ${OutlierMethod.Iqr}; received ${JSON.stringify(method)}`
      );
    const threshold =
      options.threshold ??
      (method === OutlierMethod.ZScore
        ? PREDICTIVE_ANALYTICS_DEFAULTS.zScoreThreshold
        : PREDICTIVE_ANALYTICS_DEFAULTS.iqrThreshold);
    if (typeof threshold !== 'number' || !Number.isFinite(threshold))
      throw new Error(
        `predictive-analytics detect-anomalies: \`threshold\` must be a finite number; received ${String(threshold)}`
      );
    const found = outliers(values, method, threshold);
    return {
      method,
      /*
       * Returned because what counts as extreme is a property of the caller's
       * data and not of this tool: a reader comparing two runs needs to know
       * which threshold produced each count.
       */
      threshold,
      sampleSize: values.length,
      anomalies: found,
      found: found.length,
    };
  }

  /**
   * Extrapolate a series and, when a limit is given, say which step first
   * crosses it -- at the point estimate and, separately, at the upper bound.
   * The two differ, and the earlier of them is the one capacity planning
   * cares about.
   */
  private forecastCapacity(
    options: PredictiveAnalyticsOptions
  ): Record<string, unknown> {
    const values = requireValues(
      'forecast-capacity',
      'values',
      options.values,
      MINIMUM_SAMPLES.paired
    );
    const horizon = positiveInteger(
      'forecast-capacity',
      'horizon',
      options.horizon,
      PREDICTIVE_ANALYTICS_DEFAULTS.horizon
    );
    const limit = options.limit;
    if (
      limit !== undefined &&
      (typeof limit !== 'number' || !Number.isFinite(limit))
    )
      throw new Error(
        `predictive-analytics forecast-capacity: \`limit\` must be a finite number; received ${String(limit)}`
      );
    const { fit, points } = forecastLinear(values, horizon);
    const crossing =
      limit === undefined
        ? undefined
        : {
            limit,
            /*
             * null means the limit is not reached inside the horizon, which is
             * an answer. Reporting the last step instead would turn "not in
             * this window" into "right at the end of it".
             */
            atPoint: points.find((point) => point.value >= limit)?.at ?? null,
            atUpperBound:
              points.find(
                (point) => point.upper !== null && point.upper >= limit
              )?.at ?? null,
          };
    return {
      interval: INTERVAL_KIND,
      slopePerStep: fit.slope,
      r2: fit.r2,
      sampleSize: fit.sampleSize,
      points,
      ...(crossing === undefined ? {} : { crossing }),
    };
  }

  /**
   * Empirical failure rates with Wilson score intervals, worst first.
   *
   * Nothing here predicts an individual failure. It reports the rate each
   * group actually ran at, an interval that does not collapse to zero on a
   * clean run, and the expected count over `upcoming` trials, which is that
   * rate times a number the caller supplied.
   */
  private predictFailures(
    options: PredictiveAnalyticsOptions
  ): Record<string, unknown> {
    const records = options.records;
    if (!Array.isArray(records) || records.length === 0)
      throw new Error(
        'predictive-analytics predict-failures: `records` is required and must hold at least one { label, failures, total }'
      );
    const upcoming = options.upcoming;
    if (upcoming !== undefined && (!Number.isInteger(upcoming) || upcoming < 0))
      throw new Error(
        `predictive-analytics predict-failures: \`upcoming\` must be an integer of at least 0; received ${String(upcoming)}`
      );
    const scored = records.map((record, index) => {
      if (typeof record?.label !== 'string')
        throw new Error(
          `predictive-analytics predict-failures: records[${index}].label must be a string`
        );
      const measured = wilsonInterval(record.failures, record.total);
      return {
        label: record.label,
        failures: measured.successes,
        total: measured.trials,
        rate: measured.rate,
        lower: measured.lower,
        upper: measured.upper,
        ...(upcoming === undefined
          ? {}
          : { expectedFailures: measured.rate * upcoming }),
      };
    });
    scored.sort(
      (left, right) =>
        right.rate - left.rate ||
        right.total - left.total ||
        left.label.localeCompare(right.label)
    );
    const failures = scored.reduce((sum, entry) => sum + entry.failures, 0);
    const trials = scored.reduce((sum, entry) => sum + entry.total, 0);
    const overall = wilsonInterval(failures, trials);
    return {
      interval: INTERVAL_KIND,
      ...(upcoming === undefined ? {} : { upcoming }),
      overall: {
        failures: overall.successes,
        total: overall.trials,
        rate: overall.rate,
        lower: overall.lower,
        upper: overall.upper,
      },
      byLabel: scored,
      /*
       * Ranked by observed rate, so a label with one failure in one trial
       * leads. Its interval is what says the rate is not established; the
       * ordering alone must not be read as a ranking of risk.
       */
      worst: scored[0],
    };
  }

  /**
   * Per-series trend: the rank test for whether, the fit for how much, and the
   * last EWMA level for where the series currently sits.
   */
  private analyzeTrends(
    options: PredictiveAnalyticsOptions
  ): Record<string, unknown> {
    const series = options.series;
    if (series === null || series === undefined || typeof series !== 'object')
      throw new Error(
        'predictive-analytics analyze-trends: `series` is required and must be an object of named numeric series'
      );
    const names = Object.keys(series);
    if (names.length === 0)
      throw new Error(
        'predictive-analytics analyze-trends: `series` must name at least one series'
      );
    const alpha = options.alpha ?? PREDICTIVE_ANALYTICS_DEFAULTS.alpha;
    if (typeof alpha !== 'number' || !(alpha > 0) || !(alpha <= 1))
      throw new Error(
        `predictive-analytics analyze-trends: \`alpha\` must be in (0, 1]; received ${String(alpha)}`
      );
    const trends = names.map((name) => {
      const values = requireValues(
        'analyze-trends',
        `series.${name}`,
        series[name],
        MINIMUM_SAMPLES.mannKendall
      );
      const index = values.map((_unused, position) => position);
      const fit = linearFit(index, values);
      const test = mannKendall(values);
      const smoothed = ewma(values, alpha);
      return {
        name,
        direction: test.direction,
        tau: test.tau,
        p: test.p,
        slopePerStep: fit.slope,
        r2: fit.r2,
        /** The EWMA level at the final observation, at this alpha. */
        level: smoothed[smoothed.length - 1],
        sampleSize: values.length,
      };
    });
    trends.sort(
      (left, right) =>
        Math.abs(right.tau) - Math.abs(left.tau) ||
        left.name.localeCompare(right.name)
    );
    return {
      alpha,
      trends,
      /*
       * Counted rather than summarised in prose: "two of five series are
       * rising" is a number the caller can check against `trends`.
       */
      increasing: trends.filter(
        (entry) => entry.direction === TrendDirection.Increasing
      ).length,
      decreasing: trends.filter(
        (entry) => entry.direction === TrendDirection.Decreasing
      ).length,
    };
  }

  /**
   * Score predictions the caller already made against what happened. Nothing
   * is fitted: both series come in, so these numbers measure the predictions
   * rather than describing a fit to them.
   */
  private evaluate(
    options: PredictiveAnalyticsOptions
  ): Record<string, unknown> {
    const actual = requireValues('evaluate', 'actual', options.actual, 1);
    const predicted = requireValues(
      'evaluate',
      'predicted',
      options.predicted,
      1
    );
    if (actual.length !== predicted.length)
      throw new Error(
        `predictive-analytics evaluate: \`actual\` and \`predicted\` must be the same length; received ${actual.length} and ${predicted.length}`
      );
    const measured = regressionMetrics(actual, predicted);
    return {
      sampleSize: measured.sampleSize,
      mae: measured.mae,
      rmse: measured.rmse,
      bias: measured.bias,
      /*
       * null, not 0, when any actual is zero: the percentage error is
       * undefined there. `mapeOmitted` says why, so a caller does not read the
       * null as "no error".
       */
      mape: measured.mape,
      mapeOmitted: measured.mape === null,
      r2: measured.r2,
      /*
       * r2 below zero means the predictions did worse than always guessing the
       * actuals' own mean. Stated as a flag because a negative r2 is routinely
       * misread as a small positive one.
       */
      worseThanMean: measured.r2 < 0,
    };
  }

  private exportModel(
    options: PredictiveAnalyticsOptions
  ): Record<string, unknown> {
    const model = requireModel('export-model', options.model);
    const format = options.format;
    if (!isExportFormat(format))
      throw new Error(
        `predictive-analytics export-model: unknown format ${JSON.stringify(format)}; one of ${EXPORT_FORMATS.join(', ')}`
      );
    /*
     * One row per named quantity rather than the model object itself, so csv
     * and markdown both have a table to write and the exported file carries
     * the fit's quality beside its coefficients.
     */
    const rows = [
      { field: 'kind', value: model.kind },
      { field: 'slope', value: model.slope },
      { field: 'intercept', value: model.intercept },
      { field: 'r2', value: model.r2 },
      { field: 'residualStdError', value: model.residualStdError },
      { field: 'sampleSize', value: model.sampleSize },
      { field: 'xMean', value: model.xMean },
      { field: 'sxx', value: model.sxx },
    ];
    const rendered = renderPayload('predictive-analytics', rows, format);
    return {
      format: rendered.format,
      content: rendered.content,
      rows: rendered.rows,
      bytes: Buffer.byteLength(rendered.content, 'utf8'),
    };
  }
}

export const PREDICTIVEANALYTICSTOOL = {
  name: 'predictive-analytics',
  description:
    'Least-squares fitting, forecasting, anomaly detection and prediction scoring over numeric series you supply',
  inputSchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: [...PREDICTIVE_ANALYTICS_OPERATIONS],
        description: 'Operation to perform',
      },
      x: {
        type: 'array',
        items: { type: 'number' },
        minItems: 2,
        description: 'Independent observations, for train-model',
      },
      y: {
        type: 'array',
        items: { type: 'number' },
        minItems: 2,
        description: 'Dependent observations, same length as x',
      },
      model: {
        type: 'object',
        properties: {
          kind: { const: MODEL_KIND },
          slope: { type: 'number' },
          intercept: { type: 'number' },
          r2: { type: 'number' },
          residualStdError: { type: 'number' },
          sampleSize: { type: 'integer', minimum: 2 },
          xMean: { type: 'number' },
          sxx: { type: 'number', minimum: 0 },
        },
        required: ['kind', 'slope', 'intercept', 'sampleSize', 'xMean', 'sxx'],
        description: 'The model train-model returned, passed back unchanged',
      },
      at: {
        type: 'array',
        items: { type: 'number' },
        minItems: 1,
        description: 'x positions to predict at',
      },
      values: {
        type: 'array',
        items: { type: 'number' },
        minItems: 2,
        description:
          'One series in order, for detect-anomalies and forecast-capacity',
      },
      method: {
        type: 'string',
        enum: ['z-score', 'iqr'],
        default: 'z-score',
        description: 'Which rule flags an anomaly',
      },
      threshold: {
        type: 'number',
        exclusiveMinimum: 0,
        description:
          'Standard deviations, or interquartile ranges; defaults to 3 and 1.5 respectively',
      },
      horizon: {
        type: 'integer',
        minimum: 1,
        default: PREDICTIVE_ANALYTICS_DEFAULTS.horizon,
        description: 'How many steps forecast-capacity projects',
      },
      limit: {
        type: 'number',
        description:
          'Capacity ceiling; the forecast reports when it is crossed',
      },
      records: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', minLength: 1 },
            failures: { type: 'integer', minimum: 0 },
            total: { type: 'integer', minimum: 1 },
          },
          required: ['label', 'failures', 'total'],
          additionalProperties: false,
        },
        minItems: 1,
        description: 'Observed trial groups, for predict-failures',
      },
      upcoming: {
        type: 'integer',
        minimum: 0,
        description: 'Trials ahead, for an expected failure count',
      },
      series: {
        type: 'object',
        additionalProperties: { type: 'array', items: { type: 'number' } },
        description: 'Named series in time order, for analyze-trends',
      },
      alpha: {
        type: 'number',
        exclusiveMinimum: 0,
        maximum: 1,
        default: PREDICTIVE_ANALYTICS_DEFAULTS.alpha,
        description: 'EWMA weight on the newest observation',
      },
      actual: {
        type: 'array',
        items: { type: 'number' },
        minItems: 1,
        description: 'What happened, for evaluate',
      },
      predicted: {
        type: 'array',
        items: { type: 'number' },
        minItems: 1,
        description: 'What was predicted, same length as actual',
      },
      format: {
        type: 'string',
        enum: [...EXPORT_FORMATS],
        description: 'Output format for export-model',
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
     * A property description saying "Required by predict" is something a human
     * reads and a client cannot act on; these branches are something a client
     * can act on, and are what the derived validation enforces.
     */
    anyOf: [
      {
        properties: { operation: { const: 'train-model' } },
        required: ['operation', 'x', 'y'],
      },
      {
        properties: { operation: { const: 'predict' } },
        required: ['operation', 'model', 'at'],
      },
      {
        properties: { operation: { const: 'detect-anomalies' } },
        required: ['operation', 'values'],
      },
      {
        properties: { operation: { const: 'forecast-capacity' } },
        required: ['operation', 'values'],
      },
      {
        properties: { operation: { const: 'predict-failures' } },
        required: ['operation', 'records'],
      },
      {
        properties: { operation: { const: 'analyze-trends' } },
        required: ['operation', 'series'],
      },
      {
        properties: { operation: { const: 'evaluate' } },
        required: ['operation', 'actual', 'predicted'],
      },
      {
        properties: { operation: { const: 'export-model' } },
        required: ['operation', 'model', 'format'],
      },
    ],
  },
} as const;

export async function runPredictiveAnalytics(
  options: PredictiveAnalyticsOptions
): Promise<PredictiveAnalyticsResult> {
  const tool = new PredictiveAnalytics(
    sharedCache,
    sharedTokenCounter,
    sharedMetricsCollector
  );
  return await tool.run(options);
}
