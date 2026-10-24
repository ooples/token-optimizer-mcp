import { test, expect } from '@jest/globals';
import { classifyPair } from '../../../bench/live/joint-audit.mjs';
const arm = (cost, seconds, verdict = 'PASS') => ({
  estimatedUsd: cost,
  agentSeconds: seconds,
  verdict,
});
test('joint wins require both metrics and audited quality', () => {
  expect(classifyPair({ proxy: arm(1, 1), altA: arm(2, 2) })).toBe(
    'joint-win'
  );
  expect(classifyPair({ proxy: arm(1, 3), altA: arm(2, 2) })).toBe(
    'speed-loss'
  );
  expect(classifyPair({ proxy: arm(3, 1), altA: arm(2, 2) })).toBe(
    'cost-loss'
  );
  expect(classifyPair({ proxy: arm(3, 3), altA: arm(2, 2) })).toBe(
    'joint-loss'
  );
  expect(classifyPair({ proxy: arm(1, 1, 'FAIL'), altA: arm(2, 2) })).toBe(
    'quality-failure'
  );
  expect(classifyPair({ proxy: arm(null, 1), altA: arm(2, 2) })).toBe(
    'unknown'
  );
  expect(classifyPair({ proxy: arm(1, 2), altA: arm(2, 2) })).toBe('tie');
});
