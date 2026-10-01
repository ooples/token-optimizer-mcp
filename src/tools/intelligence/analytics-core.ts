/**
 * The numeric core the analytic intelligence tools compute with.
 *
 * WHY THIS EXISTS: six advertised tools -- intelligent-assistant,
 * natural-language-query, pattern-recognition, predictive-analytics,
 * recommendation-engine and smart-summarization -- published 48 operations
 * between them and implemented none. Every call returned
 * `{ success: true, confidence: 0.85, result: '<operation> completed
 * successfully' }`, a fabricated measurement: a caller asking
 * predictive-analytics to detect anomalies was told it had succeeded, with a
 * confidence that was a literal in the source.
 *
 * Everything those tools now report is computed here, from the caller's own
 * data, by a named method whose formula is written down and whose result is
 * checked against a hand-computed value in
 * tests/unit/analytics-core.test.ts. Three sibling tools in this directory
 * (anomaly-explainer, sentiment-analysis, knowledge-graph) each carry their
 * own copy of this arithmetic as private class methods; those are left alone
 * here, but nothing new duplicates them.
 *
 * WHAT IT WILL NOT DO: no function here invents a value for missing input.
 * A sample too short for a method is an error naming the method's minimum,
 * because the alternative -- a default, a zero, a 0.85 -- is how the thing
 * this file replaces came to exist.
 */

/** Sample sizes below which a method has no defined answer. */
export const MINIMUM_SAMPLES = Object.freeze({
  /** A mean needs one point. */
  mean: 1,
  /** A sample variance divides by n-1. */
  variance: 2,
  /** A correlation needs two paired points, and a slope needs two. */
  paired: 2,
  /** A residual standard error divides by n-2. */
  regressionInterval: 3,
  /** Mann-Kendall's normal approximation is stated for n >= 4. */
  mannKendall: 4,
} as const);

/** Methods for flagging a point as an outlier. */
export enum OutlierMethod {
  /** Distance from the mean in sample standard deviations. */
  ZScore = 'z-score',
  /** Distance outside the quartiles, in interquartile ranges. */
  Iqr = 'iqr',
}

/** The direction a monotonic trend test reports. */
export enum TrendDirection {
  Increasing = 'increasing',
  Decreasing = 'decreasing',
  /** The test did not reject "no trend" at the stated significance. */
  None = 'none',
}

/**
 * The normal quantile for a two-sided 95% interval. Written as a named
 * constant because every interval in this file is a normal approximation and
 * says so, rather than implying an exact t-distribution it does not use.
 */
export const NORMAL_QUANTILE_95 = 1.959963984540054;

/** Significance threshold paired with the quantile above. */
export const SIGNIFICANCE_95 = 0.05;

const requireSamples = (
  values: readonly number[],
  minimum: number,
  method: string
): void => {
  if (!Array.isArray(values))
    throw new Error(`${method} needs an array of numbers`);
  for (const value of values)
    if (typeof value !== 'number' || !Number.isFinite(value))
      throw new Error(
        `${method} needs finite numbers; received ${String(value)}`
      );
  if (values.length < minimum)
    throw new Error(
      `${method} needs at least ${minimum} values; received ${values.length}`
    );
};

/** Arithmetic mean. */
export const mean = (values: readonly number[]): number => {
  requireSamples(values, MINIMUM_SAMPLES.mean, 'mean');
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
};

/** Sample variance, dividing by n-1 (Bessel's correction). */
export const variance = (values: readonly number[]): number => {
  requireSamples(values, MINIMUM_SAMPLES.variance, 'variance');
  const centre = mean(values);
  let total = 0;
  for (const value of values) total += (value - centre) ** 2;
  return total / (values.length - 1);
};

/** Sample standard deviation. */
export const stdDev = (values: readonly number[]): number =>
  Math.sqrt(variance(values));

/**
 * The p-th percentile by linear interpolation between order statistics --
 * the same rule numpy applies by default, so a figure reported here can be
 * checked against it.
 */
export const percentile = (values: readonly number[], p: number): number => {
  requireSamples(values, MINIMUM_SAMPLES.mean, 'percentile');
  if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 100)
    throw new Error(`percentile needs p in [0, 100]; received ${String(p)}`);
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const position = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
};

/** Median, which is the 50th percentile by the rule above. */
export const median = (values: readonly number[]): number =>
  percentile(values, 50);

/** Each value's distance from the mean, in sample standard deviations. */
export const zScores = (values: readonly number[]): number[] => {
  const spread = stdDev(values);
  const centre = mean(values);
  if (spread === 0) return values.map(() => 0);
  return values.map((value) => (value - centre) / spread);
};

/** A point the chosen rule places outside the sample's normal range. */
export interface Outlier {
  index: number;
  value: number;
  /** Z-score, or IQR distance outside the nearer quartile. */
  score: number;
}

/**
 * Outliers by z-score or by the interquartile rule. The threshold is the
 * caller's, because what counts as extreme is a property of their data and
 * not of this function; the two conventional defaults are 3 and 1.5.
 */
export const outliers = (
  values: readonly number[],
  method: OutlierMethod,
  threshold: number
): Outlier[] => {
  requireSamples(values, MINIMUM_SAMPLES.variance, 'outliers');
  if (typeof threshold !== 'number' || !Number.isFinite(threshold))
    throw new Error('outliers needs a finite threshold');
  if (method === OutlierMethod.ZScore) {
    const scores = zScores(values);
    return values.flatMap((value, index) =>
      Math.abs(scores[index]) > threshold
        ? [{ index, value, score: scores[index] }]
        : []
    );
  }
  const q1 = percentile(values, 25);
  const q3 = percentile(values, 75);
  const spread = q3 - q1;
  const low = q1 - threshold * spread;
  const high = q3 + threshold * spread;
  return values.flatMap((value, index) => {
    if (value >= low && value <= high) return [];
    const distance = value < low ? low - value : value - high;
    const score = spread === 0 ? Infinity : distance / spread;
    return [{ index, value, score }];
  });
};

/**
 * Pearson's product-moment correlation. Returns 0 when either series is
 * constant, because the coefficient is undefined there -- a constant series
 * has no variation to co-vary.
 */
export const pearson = (x: readonly number[], y: readonly number[]): number => {
  requireSamples(x, MINIMUM_SAMPLES.paired, 'pearson');
  requireSamples(y, MINIMUM_SAMPLES.paired, 'pearson');
  if (x.length !== y.length)
    throw new Error(
      `pearson needs series of equal length; received ${x.length} and ${y.length}`
    );
  const xBar = mean(x);
  const yBar = mean(y);
  let covariance = 0;
  let xSpread = 0;
  let ySpread = 0;
  for (let index = 0; index < x.length; index += 1) {
    const dx = x[index] - xBar;
    const dy = y[index] - yBar;
    covariance += dx * dy;
    xSpread += dx * dx;
    ySpread += dy * dy;
  }
  if (xSpread === 0 || ySpread === 0) return 0;
  return covariance / Math.sqrt(xSpread * ySpread);
};

/** An ordinary-least-squares straight line through paired points. */
export interface LinearFit {
  slope: number;
  intercept: number;
  /** Coefficient of determination, 1 - SSres/SStot. */
  r2: number;
  /** Residual standard error, sqrt(SSres/(n-2)); null when n < 3. */
  residualStdError: number | null;
  sampleSize: number;
}

/** Fit y = slope*x + intercept by ordinary least squares. */
export const linearFit = (
  x: readonly number[],
  y: readonly number[]
): LinearFit => {
  requireSamples(x, MINIMUM_SAMPLES.paired, 'linearFit');
  requireSamples(y, MINIMUM_SAMPLES.paired, 'linearFit');
  if (x.length !== y.length)
    throw new Error(
      `linearFit needs series of equal length; received ${x.length} and ${y.length}`
    );
  const xBar = mean(x);
  const yBar = mean(y);
  let sxy = 0;
  let sxx = 0;
  for (let index = 0; index < x.length; index += 1) {
    sxy += (x[index] - xBar) * (y[index] - yBar);
    sxx += (x[index] - xBar) ** 2;
  }
  if (sxx === 0)
    throw new Error(
      'linearFit needs at least two distinct x values; every x was identical'
    );
  const slope = sxy / sxx;
  const intercept = yBar - slope * xBar;
  let residual = 0;
  let total = 0;
  for (let index = 0; index < x.length; index += 1) {
    residual += (y[index] - (slope * x[index] + intercept)) ** 2;
    total += (y[index] - yBar) ** 2;
  }
  const r2 = total === 0 ? 1 : 1 - residual / total;
  const residualStdError =
    x.length >= MINIMUM_SAMPLES.regressionInterval
      ? Math.sqrt(residual / (x.length - 2))
      : null;
  return { slope, intercept, r2, residualStdError, sampleSize: x.length };
};

/** One forecast point with the interval the fit supports. */
export interface ForecastPoint {
  /** Index on the same axis the series was fitted over. */
  at: number;
  value: number;
  /** Lower/upper 95% prediction bound, or null when n < 3. */
  lower: number | null;
  upper: number | null;
}

/**
 * Extrapolate a series by least squares over its own index, with a 95%
 * prediction interval widened for distance from the mean -- the standard
 * se * sqrt(1 + 1/n + (x-xbar)^2/Sxx), using a normal quantile rather than a
 * t quantile, which this returns under the name `interval: 'normal-95'` at
 * the call sites so nobody reads it as exact.
 */
export const forecastLinear = (
  series: readonly number[],
  horizon: number
): { fit: LinearFit; points: ForecastPoint[] } => {
  requireSamples(series, MINIMUM_SAMPLES.paired, 'forecastLinear');
  if (!Number.isInteger(horizon) || horizon < 1)
    throw new Error(
      `forecastLinear needs a horizon of at least 1; received ${String(horizon)}`
    );
  const index = series.map((_, position) => position);
  const fit = linearFit(index, series);
  const xBar = mean(index);
  let sxx = 0;
  for (const position of index) sxx += (position - xBar) ** 2;
  const points: ForecastPoint[] = [];
  for (let step = 1; step <= horizon; step += 1) {
    const at = series.length - 1 + step;
    const value = fit.slope * at + fit.intercept;
    if (fit.residualStdError === null) {
      points.push({ at, value, lower: null, upper: null });
      continue;
    }
    const spread =
      fit.residualStdError *
      Math.sqrt(1 + 1 / series.length + (at - xBar) ** 2 / sxx);
    const margin = NORMAL_QUANTILE_95 * spread;
    points.push({ at, value, lower: value - margin, upper: value + margin });
  }
  return { fit, points };
};

/**
 * Exponentially weighted moving average, seeded with the first observation.
 * s[0] = x[0]; s[t] = alpha*x[t] + (1-alpha)*s[t-1].
 */
export const ewma = (series: readonly number[], alpha: number): number[] => {
  requireSamples(series, MINIMUM_SAMPLES.mean, 'ewma');
  if (typeof alpha !== 'number' || !(alpha > 0) || !(alpha <= 1))
    throw new Error(`ewma needs alpha in (0, 1]; received ${String(alpha)}`);
  const smoothed: number[] = [series[0]];
  for (let index = 1; index < series.length; index += 1)
    smoothed.push(alpha * series[index] + (1 - alpha) * smoothed[index - 1]);
  return smoothed;
};

/**
 * Holt's linear (double exponential) smoothing, for a series with a level
 * and a trend but no seasonal term. Seeded as level = x[0] and
 * trend = x[1] - x[0], which is Holt's own initialisation.
 */
export const holtLinear = (
  series: readonly number[],
  alpha: number,
  beta: number,
  horizon: number
): { level: number; trend: number; fitted: number[]; forecast: number[] } => {
  requireSamples(series, MINIMUM_SAMPLES.paired, 'holtLinear');
  for (const [name, value] of [
    ['alpha', alpha],
    ['beta', beta],
  ] as const)
    if (typeof value !== 'number' || !(value > 0) || !(value <= 1))
      throw new Error(
        `holtLinear needs ${name} in (0, 1]; received ${String(value)}`
      );
  if (!Number.isInteger(horizon) || horizon < 0)
    throw new Error(
      `holtLinear needs a horizon of at least 0; received ${String(horizon)}`
    );
  let level = series[0];
  let trend = series[1] - series[0];
  const fitted: number[] = [level];
  for (let index = 1; index < series.length; index += 1) {
    const previousLevel = level;
    level = alpha * series[index] + (1 - alpha) * (previousLevel + trend);
    trend = beta * (level - previousLevel) + (1 - beta) * trend;
    fitted.push(level);
  }
  const forecast: number[] = [];
  for (let step = 1; step <= horizon; step += 1)
    forecast.push(level + step * trend);
  return { level, trend, fitted, forecast };
};

/** The outcome of a Mann-Kendall monotonic trend test. */
export interface TrendTest {
  /** Kendall's S statistic: concordant minus discordant pairs. */
  s: number;
  /** Kendall's tau-a, S divided by the number of pairs. */
  tau: number;
  /** Normal-approximation test statistic, tie-corrected. */
  z: number;
  /** Two-sided p-value from that normal approximation. */
  p: number;
  direction: TrendDirection;
}

/**
 * The standard normal cumulative distribution, via the complementary error
 * function in Abramowitz & Stegun 7.1.26 form. Accurate to about 1.5e-7,
 * which is far finer than any decision taken on it here.
 */
const normalCdf = (z: number): number => {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
};

/**
 * Mann-Kendall test for a monotonic trend -- a rank test, so it does not
 * assume the series is normal or linear, which is why it is used here for
 * "is this trending" and linearFit is used for "by how much". The variance
 * carries the standard correction for tied groups.
 */
export const mannKendall = (series: readonly number[]): TrendTest => {
  requireSamples(series, MINIMUM_SAMPLES.mannKendall, 'mannKendall');
  const n = series.length;
  let s = 0;
  for (let i = 0; i < n - 1; i += 1)
    for (let j = i + 1; j < n; j += 1) s += Math.sign(series[j] - series[i]);
  const pairs = (n * (n - 1)) / 2;
  const tau = s / pairs;
  const counts = new Map<number, number>();
  for (const value of series) counts.set(value, (counts.get(value) ?? 0) + 1);
  let tieCorrection = 0;
  for (const tied of counts.values())
    if (tied > 1) tieCorrection += tied * (tied - 1) * (2 * tied + 5);
  const varianceS = (n * (n - 1) * (2 * n + 5) - tieCorrection) / 18;
  const z =
    varianceS === 0 || s === 0 ? 0 : (s - Math.sign(s)) / Math.sqrt(varianceS);
  const p = 2 * (1 - normalCdf(Math.abs(z)));
  let direction = TrendDirection.None;
  if (p < SIGNIFICANCE_95 && s > 0) direction = TrendDirection.Increasing;
  if (p < SIGNIFICANCE_95 && s < 0) direction = TrendDirection.Decreasing;
  return { s, tau, z, p, direction };
};

/**
 * Autocorrelation at one lag, normalised by the series' own variance about
 * its mean -- the usual estimator, so r(0) = 1.
 */
export const autocorrelation = (
  series: readonly number[],
  lag: number
): number => {
  requireSamples(series, MINIMUM_SAMPLES.variance, 'autocorrelation');
  if (!Number.isInteger(lag) || lag < 0 || lag >= series.length)
    throw new Error(
      `autocorrelation needs an integer lag in [0, ${series.length - 1}]; received ${String(lag)}`
    );
  const centre = mean(series);
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < series.length; index += 1) {
    denominator += (series[index] - centre) ** 2;
    if (index + lag < series.length)
      numerator += (series[index] - centre) * (series[index + lag] - centre);
  }
  if (denominator === 0) return 0;
  return numerator / denominator;
};

/**
 * The lag in [2, maxLag] with the highest autocorrelation, and that value.
 * A caller decides whether the strength is worth calling a season; this only
 * reports which lag is strongest and how strong it is.
 */
export const strongestSeasonalLag = (
  series: readonly number[],
  maxLag: number
): { lag: number; correlation: number } | null => {
  requireSamples(series, MINIMUM_SAMPLES.variance, 'strongestSeasonalLag');
  const ceiling = Math.min(maxLag, series.length - 1);
  let best: { lag: number; correlation: number } | null = null;
  for (let lag = 2; lag <= ceiling; lag += 1) {
    const correlation = autocorrelation(series, lag);
    if (best === null || correlation > best.correlation)
      best = { lag, correlation };
  }
  return best;
};

/** Cosine of the angle between two equal-length vectors. */
export const cosineSimilarity = (
  a: readonly number[],
  b: readonly number[]
): number => {
  requireSamples(a, MINIMUM_SAMPLES.mean, 'cosineSimilarity');
  requireSamples(b, MINIMUM_SAMPLES.mean, 'cosineSimilarity');
  if (a.length !== b.length)
    throw new Error(
      `cosineSimilarity needs vectors of equal length; received ${a.length} and ${b.length}`
    );
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    aNorm += a[index] ** 2;
    bNorm += b[index] ** 2;
  }
  if (aNorm === 0 || bNorm === 0) return 0;
  return dot / Math.sqrt(aNorm * bNorm);
};

/**
 * A seeded, deterministic generator, used only where an algorithm needs an
 * arbitrary starting choice (k-means seeding). It is NOT a source of
 * security-relevant randomness and must never be used as one: the whole
 * point is that the same input gives the same clustering, so a reported
 * cluster can be reproduced and checked.
 */
const deterministicGenerator = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** One cluster of a k-means partition. */
export interface Cluster {
  centroid: number[];
  /** Indices into the input, ascending. */
  members: number[];
  /** Mean squared distance from the centroid to its own members. */
  inertia: number;
}

export interface KMeansResult {
  clusters: Cluster[];
  iterations: number;
  /** Whether assignments stopped changing before the iteration ceiling. */
  converged: boolean;
  /** Total within-cluster sum of squares. */
  inertia: number;
}

const squaredDistance = (
  a: readonly number[],
  b: readonly number[]
): number => {
  let total = 0;
  for (let index = 0; index < a.length; index += 1)
    total += (a[index] - b[index]) ** 2;
  return total;
};

/**
 * k-means by Lloyd's algorithm with k-means++ seeding, made reproducible by
 * a seeded generator. Empty clusters are dropped rather than re-seeded, so
 * the result reports the clusters that actually have members instead of
 * padding the count the caller asked for.
 */
export const kMeans = (
  points: ReadonlyArray<readonly number[]>,
  k: number,
  seed: number,
  maxIterations = 100
): KMeansResult => {
  if (!Array.isArray(points) || points.length === 0)
    throw new Error('kMeans needs at least one point');
  const width = points[0].length;
  if (width === 0)
    throw new Error('kMeans needs points with at least one dimension');
  for (const point of points) {
    if (!Array.isArray(point) || point.length !== width)
      throw new Error(
        `kMeans needs points of equal width; expected ${width}, received ${
          Array.isArray(point) ? point.length : String(point)
        }`
      );
    for (const value of point)
      if (typeof value !== 'number' || !Number.isFinite(value))
        throw new Error(
          `kMeans needs finite numbers; received ${String(value)}`
        );
  }
  if (!Number.isInteger(k) || k < 1 || k > points.length)
    throw new Error(
      `kMeans needs k in [1, ${points.length}]; received ${String(k)}`
    );

  const random = deterministicGenerator(seed);
  const centroids: number[][] = [
    [...points[Math.floor(random() * points.length)]],
  ];
  while (centroids.length < k) {
    const distances = points.map((point) =>
      Math.min(...centroids.map((centroid) => squaredDistance(point, centroid)))
    );
    const total = distances.reduce((sum, value) => sum + value, 0);
    if (total === 0) {
      centroids.push([...points[centroids.length % points.length]]);
      continue;
    }
    let target = random() * total;
    let chosen = distances.length - 1;
    for (let index = 0; index < distances.length; index += 1) {
      target -= distances[index];
      if (target <= 0) {
        chosen = index;
        break;
      }
    }
    centroids.push([...points[chosen]]);
  }

  let assignment = points.map(() => -1);
  let iterations = 0;
  let converged = false;
  while (iterations < maxIterations) {
    iterations += 1;
    const next = points.map((point) => {
      let best = 0;
      let bestDistance = Infinity;
      for (let index = 0; index < centroids.length; index += 1) {
        const distance = squaredDistance(point, centroids[index]);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = index;
        }
      }
      return best;
    });
    if (next.every((value, index) => value === assignment[index])) {
      converged = true;
      break;
    }
    assignment = next;
    for (let index = 0; index < centroids.length; index += 1) {
      const members = points.filter(
        (_, position) => assignment[position] === index
      );
      if (members.length === 0) continue;
      const centre = new Array<number>(width).fill(0);
      for (const member of members)
        for (let axis = 0; axis < width; axis += 1)
          centre[axis] += member[axis];
      centroids[index] = centre.map((total) => total / members.length);
    }
  }

  const clusters: Cluster[] = [];
  let inertia = 0;
  for (let index = 0; index < centroids.length; index += 1) {
    const members = assignment.flatMap((value, position) =>
      value === index ? [position] : []
    );
    if (members.length === 0) continue;
    let within = 0;
    for (const member of members)
      within += squaredDistance(points[member], centroids[index]);
    inertia += within;
    clusters.push({
      centroid: centroids[index],
      members,
      inertia: within / members.length,
    });
  }
  return { clusters, iterations, converged, inertia };
};

/** A repeated subsequence found in an ordered event stream. */
export interface Sequence {
  /** The repeated run, in order. */
  pattern: string[];
  /** How many times it occurs, counting overlapping occurrences. */
  occurrences: number;
  /** Occurrences divided by the number of windows of that length. */
  support: number;
}

/**
 * Frequent contiguous subsequences of length `length`, by exact count over a
 * sliding window. `minOccurrences` is the caller's, and a run occurring once
 * is never reported as a pattern.
 */
export const mineSequences = (
  events: readonly string[],
  length: number,
  minOccurrences: number
): Sequence[] => {
  if (!Array.isArray(events)) throw new Error('mineSequences needs an array');
  if (!Number.isInteger(length) || length < 1)
    throw new Error(
      `mineSequences needs a length of at least 1; received ${String(length)}`
    );
  if (!Number.isInteger(minOccurrences) || minOccurrences < 2)
    throw new Error(
      `mineSequences needs minOccurrences of at least 2, since a run seen once is not a pattern; received ${String(minOccurrences)}`
    );
  const windows = events.length - length + 1;
  if (windows < 1) return [];
  const counts = new Map<string, { pattern: string[]; count: number }>();
  for (let index = 0; index < windows; index += 1) {
    const pattern = events.slice(index, index + length);
    const key = JSON.stringify(pattern);
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { pattern, count: 1 });
  }
  return [...counts.values()]
    .filter((entry) => entry.count >= minOccurrences)
    .map((entry) => ({
      pattern: entry.pattern,
      occurrences: entry.count,
      support: entry.count / windows,
    }))
    .sort(
      (a, b) =>
        b.occurrences - a.occurrences ||
        a.pattern.join('\u0000').localeCompare(b.pattern.join('\u0000'))
    );
};

/** Counts of each distinct value, descending by count then by value. */
export const frequencies = (
  values: readonly string[]
): Array<{ value: string; count: number; share: number }> => {
  if (!Array.isArray(values)) throw new Error('frequencies needs an array');
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .map(([value, count]) => ({
      value,
      count,
      share: values.length === 0 ? 0 : count / values.length,
    }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
};
