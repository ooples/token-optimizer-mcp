import { describe, it, expect } from '@jest/globals';

import {
  wilsonInterval,
  regressionMetrics,
  MINIMUM_SAMPLES,
  NORMAL_QUANTILE_95,
  OutlierMethod,
  TrendDirection,
  autocorrelation,
  cosineSimilarity,
  ewma,
  forecastLinear,
  frequencies,
  holtLinear,
  kMeans,
  linearFit,
  mannKendall,
  mean,
  median,
  mineSequences,
  outliers,
  pearson,
  percentile,
  stdDev,
  strongestSeasonalLag,
  variance,
  zScores,
} from '../../src/tools/intelligence/analytics-core.js';

/**
 * Known-answer tests for the numeric core.
 *
 * Every expected value below was computed independently -- by hand or by a
 * separate implementation of the same textbook formula -- and is written out
 * to full precision rather than to a tolerance that would hide a wrong
 * formula. This matters more here than in most places: the six tools that
 * compute with this file used to return a confidence of 0.85 that was a
 * literal in their source, so a figure these functions report is only worth
 * anything if the function was checked against a figure that came from
 * somewhere else.
 *
 * The sample [2, 4, 4, 4, 5, 5, 7, 9] is the standard textbook example whose
 * mean is 5 and whose POPULATION standard deviation is 2; the 2.138... below
 * is the SAMPLE standard deviation, and the difference is the whole point of
 * stating which one a function computes.
 */
const TEXTBOOK = [2, 4, 4, 4, 5, 5, 7, 9] as const;
const PAIRED_X = [1, 2, 3, 4, 5] as const;
const PAIRED_Y = [2, 4, 5, 4, 5] as const;

describe('analytics core: location and spread', () => {
  it('computes the mean', () => {
    expect(mean(TEXTBOOK)).toBe(5);
  });

  it('computes the SAMPLE variance, dividing by n-1', () => {
    expect(variance(TEXTBOOK)).toBeCloseTo(4.571428571428571, 15);
    // The population variance of this sample is exactly 4. A function that
    // divided by n would pass a loose tolerance and be the wrong statistic.
    expect(variance(TEXTBOOK)).not.toBeCloseTo(4, 6);
  });

  it('computes the sample standard deviation', () => {
    expect(stdDev(TEXTBOOK)).toBeCloseTo(2.138089935299395, 15);
  });

  it('interpolates percentiles the way numpy does by default', () => {
    expect(percentile(TEXTBOOK, 25)).toBe(4);
    expect(percentile(TEXTBOOK, 75)).toBe(5.5);
    expect(percentile(TEXTBOOK, 90)).toBeCloseTo(7.6, 12);
    expect(percentile(TEXTBOOK, 0)).toBe(2);
    expect(percentile(TEXTBOOK, 100)).toBe(9);
  });

  it('takes the median as the 50th percentile', () => {
    expect(median(TEXTBOOK)).toBe(4.5);
  });

  it('standardises to zero mean and unit sample deviation', () => {
    const scores = zScores(TEXTBOOK);
    expect(mean(scores)).toBeCloseTo(0, 12);
    expect(stdDev(scores)).toBeCloseTo(1, 12);
    expect(scores[0]).toBeCloseTo((2 - 5) / 2.138089935299395, 12);
  });

  it('reports every z-score as zero for a constant series rather than NaN', () => {
    expect(zScores([7, 7, 7])).toEqual([0, 0, 0]);
  });
});

describe('analytics core: outliers', () => {
  it('flags by z-score above the given threshold only', () => {
    const series = [10, 10, 10, 10, 10, 10, 10, 10, 10, 40];
    const found = outliers(series, OutlierMethod.ZScore, 2);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ index: 9, value: 40 });
    expect(outliers(series, OutlierMethod.ZScore, 3)).toEqual([]);
  });

  it('flags by the interquartile rule', () => {
    // q1 = 2, q3 = 4, iqr = 2; the 1.5 fence is [-1, 7], so only 100 is out.
    const series = [1, 2, 3, 4, 5, 100];
    const found = outliers(series, OutlierMethod.Iqr, 1.5);
    expect(found.map((entry) => entry.value)).toEqual([100]);
  });

  it('refuses a sample too small to have a variance', () => {
    expect(() => outliers([1], OutlierMethod.ZScore, 2)).toThrow(
      `at least ${MINIMUM_SAMPLES.variance} values`
    );
  });
});

describe('analytics core: association and fit', () => {
  it("computes Pearson's correlation", () => {
    expect(pearson(PAIRED_X, PAIRED_Y)).toBeCloseTo(0.7745966692414834, 15);
  });

  it('returns a perfect correlation for a line and its negative', () => {
    expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 12);
    expect(pearson([1, 2, 3], [-2, -4, -6])).toBeCloseTo(-1, 12);
  });

  it('returns zero for a constant series, where the coefficient is undefined', () => {
    expect(pearson([1, 2, 3], [5, 5, 5])).toBe(0);
  });

  it('refuses series of different length instead of truncating one', () => {
    expect(() => pearson([1, 2, 3], [1, 2])).toThrow('equal length');
  });

  it('fits a least-squares line with its r-squared and residual error', () => {
    const fit = linearFit(PAIRED_X, PAIRED_Y);
    expect(fit.slope).toBeCloseTo(0.6, 15);
    expect(fit.intercept).toBeCloseTo(2.2, 15);
    expect(fit.r2).toBeCloseTo(0.6, 12);
    expect(fit.residualStdError).toBeCloseTo(0.8944271909999159, 15);
    expect(fit.sampleSize).toBe(5);
  });

  it('withholds a residual standard error that would divide by zero', () => {
    const fit = linearFit([1, 2], [3, 5]);
    expect(fit.slope).toBeCloseTo(2, 12);
    expect(fit.residualStdError).toBeNull();
  });

  it('refuses a fit through a single x value instead of dividing by zero', () => {
    expect(() => linearFit([3, 3, 3], [1, 2, 3])).toThrow('distinct x values');
  });
});

describe('analytics core: forecasting', () => {
  it('extrapolates with a widening normal-95 prediction interval', () => {
    const { fit, points } = forecastLinear(PAIRED_Y, 2);
    expect(fit.slope).toBeCloseTo(0.6, 15);
    expect(fit.intercept).toBeCloseTo(2.8, 15);
    expect(points).toHaveLength(2);
    expect(points[0].at).toBe(5);
    expect(points[0].value).toBeCloseTo(5.8, 12);
    expect(points[0].lower).toBeCloseTo(3.2595963275955278, 12);
    expect(points[0].upper).toBeCloseTo(8.340403672404472, 12);
    expect(points[1].value).toBeCloseTo(6.4, 12);
    expect(points[1].lower).toBeCloseTo(3.4665945117739274, 12);
    expect(points[1].upper).toBeCloseTo(9.333405488226072, 12);
    // Further from the fitted mean means a wider interval, never a narrower.
    const first = (points[0].upper ?? 0) - (points[0].lower ?? 0);
    const second = (points[1].upper ?? 0) - (points[1].lower ?? 0);
    expect(second).toBeGreaterThan(first);
  });

  it('withholds the interval rather than inventing one when n < 3', () => {
    const { points } = forecastLinear([1, 3], 1);
    expect(points[0].value).toBeCloseTo(5, 12);
    expect(points[0].lower).toBeNull();
    expect(points[0].upper).toBeNull();
  });

  it('refuses a horizon below one', () => {
    expect(() => forecastLinear(PAIRED_Y, 0)).toThrow('horizon of at least 1');
  });

  it('smooths exponentially from the first observation', () => {
    expect(ewma(PAIRED_X, 0.5)).toEqual([1, 1.5, 2.25, 3.125, 4.0625]);
  });

  it('reproduces the series exactly at alpha = 1', () => {
    expect(ewma(PAIRED_Y, 1)).toEqual([...PAIRED_Y]);
  });

  it('refuses an alpha outside (0, 1]', () => {
    expect(() => ewma(PAIRED_X, 0)).toThrow('alpha in (0, 1]');
    expect(() => ewma(PAIRED_X, 1.5)).toThrow('alpha in (0, 1]');
  });

  it("tracks level and trend with Holt's linear method", () => {
    const held = holtLinear([3, 5, 7, 9], 0.5, 0.5, 2);
    expect(held.level).toBeCloseTo(9, 12);
    expect(held.trend).toBeCloseTo(2, 12);
    expect(held.fitted).toEqual([3, 5, 7, 9]);
    expect(held.forecast).toEqual([11, 13]);
  });
});

describe('analytics core: trend and periodicity', () => {
  it('detects a monotonic increase by Mann-Kendall', () => {
    const test = mannKendall([1, 2, 3, 4, 5, 6]);
    expect(test.s).toBe(15);
    expect(test.tau).toBeCloseTo(1, 12);
    expect(test.z).toBeCloseTo(2.630142022557628, 12);
    /*
     * The exact two-sided p for z = 2.630142... is 0.008534920414227098.
     * normalCdf uses the Abramowitz & Stegun 7.1.26 erf form, whose stated
     * error bound is 1.5e-7, so the assertion is made AT that bound rather
     * than beyond it: a tighter tolerance would be testing the
     * approximation's luck, and a looser one would stop detecting a wrong
     * formula. The measured deviation is 7.8e-8.
     */
    const EXACT_P = 0.008534920414227098;
    const ERF_ERROR_BOUND = 1.5e-7;
    expect(Math.abs(test.p - EXACT_P)).toBeLessThan(ERF_ERROR_BOUND);
    expect(test.p).toBeCloseTo(EXACT_P, 6);
    expect(test.direction).toBe(TrendDirection.Increasing);
  });

  it('reports the mirrored series as decreasing with the same magnitude', () => {
    const test = mannKendall([6, 5, 4, 3, 2, 1]);
    expect(test.s).toBe(-15);
    expect(test.direction).toBe(TrendDirection.Decreasing);
    expect(Math.abs(test.z)).toBeCloseTo(2.630142022557628, 12);
  });

  it('does not claim a trend in a series that has none', () => {
    const test = mannKendall([5, 1, 4, 2, 3, 2, 4, 1]);
    expect(test.direction).toBe(TrendDirection.None);
    expect(test.p).toBeGreaterThan(0.05);
  });

  it('treats an all-ties series as no trend rather than dividing by zero', () => {
    const test = mannKendall([4, 4, 4, 4, 4]);
    expect(test.s).toBe(0);
    expect(test.z).toBe(0);
    expect(test.direction).toBe(TrendDirection.None);
  });

  it('refuses a series below the test’s stated minimum', () => {
    expect(() => mannKendall([1, 2, 3])).toThrow(
      `at least ${MINIMUM_SAMPLES.mannKendall} values`
    );
  });

  it('computes autocorrelation, with r(0) exactly one', () => {
    expect(autocorrelation(PAIRED_X, 0)).toBeCloseTo(1, 12);
    expect(autocorrelation(PAIRED_X, 1)).toBeCloseTo(0.4, 12);
  });

  it('finds the strongest lag of a repeating cycle', () => {
    const cycle = [1, 5, 1, 5, 1, 5, 1, 5, 1, 5];
    const best = strongestSeasonalLag(cycle, 5);
    expect(best).not.toBeNull();
    expect(best?.lag).toBe(2);
    expect(best?.correlation).toBeGreaterThan(0.5);
  });

  it('refuses a lag outside the series', () => {
    expect(() => autocorrelation(PAIRED_X, 5)).toThrow('integer lag in [0, 4]');
  });
});

describe('analytics core: similarity and clustering', () => {
  it('computes the cosine of the angle between two vectors', () => {
    expect(cosineSimilarity([1, 0, 1], [1, 1, 0])).toBeCloseTo(0.5, 12);
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 12);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 12);
  });

  it('returns zero for a zero vector rather than NaN', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it('separates two well-spaced groups', () => {
    const points = [
      [0, 0],
      [0.1, 0.1],
      [0, 0.2],
      [10, 10],
      [10.1, 9.9],
      [9.9, 10.1],
    ];
    const result = kMeans(points, 2, 1);
    expect(result.clusters).toHaveLength(2);
    expect(result.converged).toBe(true);
    const sizes = result.clusters
      .map((cluster) => cluster.members.length)
      .sort();
    expect(sizes).toEqual([3, 3]);
    const groups = result.clusters.map((cluster) => cluster.members.join(','));
    expect(groups.sort()).toEqual(['0,1,2', '3,4,5']);
  });

  it('is reproducible for the same seed and differs only by seed', () => {
    const points = [[1], [2], [3], [10], [11], [12]];
    const first = kMeans(points, 2, 7);
    const again = kMeans(points, 2, 7);
    expect(again.clusters).toEqual(first.clusters);
    expect(again.inertia).toBe(first.inertia);
  });

  it('drops empty clusters instead of padding to k', () => {
    const result = kMeans([[1], [1], [1]], 3, 3);
    expect(result.clusters.length).toBeLessThanOrEqual(3);
    for (const cluster of result.clusters)
      expect(cluster.members.length).toBeGreaterThan(0);
  });

  it('refuses a k larger than the number of points', () => {
    expect(() => kMeans([[1], [2]], 5, 1)).toThrow('k in [1, 2]');
  });

  it('refuses points of unequal width instead of reading past the shorter', () => {
    expect(() => kMeans([[1, 2], [3]], 1, 1)).toThrow('equal width');
  });
});

describe('analytics core: sequences and frequencies', () => {
  it('counts repeated contiguous runs, overlaps included', () => {
    // Four windows over abab a: ab, ba, ab, ba -- so BOTH runs repeat twice
    // and both are patterns. Counting only the first would be the overlap bug
    // this case exists to catch.
    const found = mineSequences(['a', 'b', 'a', 'b', 'a'], 2, 2);
    expect(found).toHaveLength(2);
    expect(found).toEqual([
      { pattern: ['a', 'b'], occurrences: 2, support: 0.5 },
      { pattern: ['b', 'a'], occurrences: 2, support: 0.5 },
    ]);
  });

  it('reports nothing when no run repeats', () => {
    expect(mineSequences(['a', 'b', 'c'], 2, 2)).toEqual([]);
  });

  it('refuses to call a single occurrence a pattern', () => {
    expect(() => mineSequences(['a', 'b'], 1, 1)).toThrow(
      'minOccurrences of at least 2'
    );
  });

  it('counts values with their share of the whole', () => {
    expect(frequencies(['x', 'y', 'x', 'x'])).toEqual([
      { value: 'x', count: 3, share: 0.75 },
      { value: 'y', count: 1, share: 0.25 },
    ]);
  });

  it('breaks count ties by value, so the order is stable', () => {
    expect(frequencies(['b', 'a']).map((entry) => entry.value)).toEqual([
      'a',
      'b',
    ]);
  });
});

describe('analytics core: refusals name what is missing', () => {
  it('names the minimum a method needs', () => {
    expect(() => variance([1])).toThrow(
      'variance needs at least 2 values; received 1'
    );
  });

  it('refuses a non-finite value rather than propagating NaN', () => {
    expect(() => mean([1, Number.NaN])).toThrow('finite numbers');
    expect(() => mean([1, Number.POSITIVE_INFINITY])).toThrow('finite numbers');
  });

  it('states the quantile it uses for a 95% interval', () => {
    expect(NORMAL_QUANTILE_95).toBeCloseTo(1.959963984540054, 15);
  });
});

describe('wilsonInterval', () => {
  it('does not claim a clean run rules the event out', () => {
    /*
     * This is the whole reason the Wilson form is used. The textbook normal
     * interval at 0 successes is p +- z*sqrt(0/n), which is [0, 0]: it asserts
     * the event cannot happen on the strength of ten trials. Wilson's upper
     * bound for 0 of 10 is 1.96^2 / (10 + 1.96^2) = 0.2775.
     */
    const measured = wilsonInterval(0, 10);
    expect(measured.rate).toBe(0);
    expect(measured.lower).toBe(0);
    const z2 = NORMAL_QUANTILE_95 ** 2;
    expect(measured.upper).toBeCloseTo(z2 / (10 + z2), 12);
    expect(measured.upper).toBeGreaterThan(0.27);
  });

  it('mirrors a clean run at the other end', () => {
    const measured = wilsonInterval(10, 10);
    expect(measured.rate).toBe(1);
    /*
     * Algebraically the upper bound at p = 1 is exactly 1: centre + half is
     * (1 + z^2/n) / (1 + z^2/n). The computed value lands one float epsilon
     * short of it, so the assertion is made at that scale rather than on
     * exact equality.
     */
    expect(measured.upper).toBeCloseTo(1, 15);
    expect(measured.upper).toBeLessThanOrEqual(1);
    const z2 = NORMAL_QUANTILE_95 ** 2;
    expect(measured.lower).toBeCloseTo(10 / (10 + z2), 12);
  });

  it('centres a half-and-half result on the rate itself', () => {
    const measured = wilsonInterval(50, 100);
    expect(measured.rate).toBe(0.5);
    // At p = 0.5 the Wilson centre is exactly 0.5, so the interval is
    // symmetric about it.
    expect(measured.lower + measured.upper).toBeCloseTo(1, 12);
    expect(measured.lower).toBeCloseTo(0.4038, 3);
    expect(measured.upper).toBeCloseTo(0.5962, 3);
  });

  it('narrows as the trials grow at a fixed rate', () => {
    const few = wilsonInterval(5, 10);
    const many = wilsonInterval(500, 1000);
    expect(many.upper - many.lower).toBeLessThan(few.upper - few.lower);
  });

  it('refuses impossible counts rather than reporting a rate above one', () => {
    expect(() => wilsonInterval(3, 2)).toThrow(
      'wilsonInterval needs 0 <= successes <= trials; received 3 of 2'
    );
    expect(() => wilsonInterval(-1, 2)).toThrow(/0 <= successes/);
    expect(() => wilsonInterval(0, 0)).toThrow(
      'wilsonInterval needs at least one trial; received 0'
    );
  });
});

describe('regressionMetrics', () => {
  it('reports zero error for predictions that were exactly right', () => {
    const measured = regressionMetrics([1, 2, 3], [1, 2, 3]);
    expect(measured.mae).toBe(0);
    expect(measured.rmse).toBe(0);
    expect(measured.bias).toBe(0);
    expect(measured.mape).toBe(0);
    expect(measured.r2).toBe(1);
  });

  it('computes each metric from errors worked out by hand', () => {
    /*
     * Errors (predicted - actual) are +1, -1, +2: absolute 1, 1, 2 so mae is
     * 4/3; squared 1, 1, 4 so rmse is sqrt(2); signed sum +2 so bias is 2/3.
     * Percentages are 1/10, 1/20, 2/30, so mape is (0.1 + 0.05 + 2/30)/3.
     */
    const measured = regressionMetrics([10, 20, 30], [11, 19, 32]);
    expect(measured.mae).toBeCloseTo(4 / 3, 12);
    expect(measured.rmse).toBeCloseTo(Math.sqrt(2), 12);
    expect(measured.bias).toBeCloseTo(2 / 3, 12);
    expect(measured.mape).toBeCloseTo((0.1 + 0.05 + 2 / 30) / 3, 12);
  });

  it('separates bias from magnitude', () => {
    // Same absolute errors either way; only the sign of the mean differs.
    const high = regressionMetrics([10, 10], [12, 12]);
    const mixed = regressionMetrics([10, 10], [12, 8]);
    expect(high.mae).toBe(mixed.mae);
    expect(high.bias).toBe(2);
    expect(mixed.bias).toBe(0);
  });

  it('returns a null mape rather than a number when an actual is zero', () => {
    const measured = regressionMetrics([0, 10], [1, 10]);
    expect(measured.mape).toBeNull();
    expect(measured.mae).toBe(0.5);
  });

  it('scores a prediction worse than the actuals mean below zero', () => {
    /*
     * r2 is measured against the actuals' own mean, 20. Predicting 100 every
     * time is far worse than predicting that mean, so r2 is negative -- which
     * is the information a clamp to [0, 1] would destroy.
     */
    const measured = regressionMetrics([10, 20, 30], [100, 100, 100]);
    expect(measured.r2).toBeLessThan(0);
  });

  it('refuses series of different length', () => {
    expect(() => regressionMetrics([1, 2], [1])).toThrow(
      'regressionMetrics needs series of equal length; received 2 and 1'
    );
  });
});
