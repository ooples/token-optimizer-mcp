/**
 * The launcher's long-lived timers (review on #537).
 *
 * - A delay above 2^31-1 ms makes Node fire after 1 ms, so a month-long re-check
 *   interval became a stat per millisecond. Every scheduled delay is capped.
 * - A launcher alive past the 30-day marker age lost its pruning protection, so
 *   it re-stamps its own marker daily on a timer that does not depend on the
 *   refresh re-check.
 */

import { describe, expect, test } from '@jest/globals';
import {
  MAX_TIMER_MS,
  boundedDelay,
  startMarkerRenewal,
  startPeriodicRefresh,
} from '../../plugin/launch.mjs';

/** A setInterval stand-in that records what it was asked to schedule. */
function recorder() {
  const calls = [];
  const every = (fn, ms) => {
    calls.push({ fn, ms });
    return { unref() {} };
  };
  return { calls, every };
}

describe('boundedDelay', () => {
  test('a delay Node honours is unchanged', () => {
    expect(boundedDelay(30 * 60 * 1000)).toBe(30 * 60 * 1000);
  });

  test('a delay past the 32-bit limit is capped, never left to fall back to 1 ms', () => {
    expect(boundedDelay(30 * 24 * 60 * 60 * 1000)).toBe(MAX_TIMER_MS);
  });
});

describe('startPeriodicRefresh', () => {
  test('schedules a month-long interval at the cap', () => {
    const { calls, every } = recorder();
    startPeriodicRefresh({ intervalMs: 30 * 24 * 60 * 60 * 1000, refresh: () => {}, every });
    expect(calls).toHaveLength(1);
    expect(calls[0].ms).toBe(MAX_TIMER_MS);
  });
});

describe('startMarkerRenewal', () => {
  test('re-stamps the served version daily, well inside the 30-day marker age', () => {
    const { calls, every } = recorder();
    const renewed = [];
    startMarkerRenewal('7.7.1', { every, renew: (v) => renewed.push(v) });
    expect(calls).toHaveLength(1);
    expect(calls[0].ms).toBeLessThan(30 * 24 * 60 * 60 * 1000);
    calls[0].fn();
    expect(renewed).toEqual(['7.7.1']);
  });

  test('nothing to renew when no managed version is served', () => {
    const { calls, every } = recorder();
    expect(startMarkerRenewal(null, { every })).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
