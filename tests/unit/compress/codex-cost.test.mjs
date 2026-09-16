import { test, expect } from '@jest/globals';
import { costReport } from '../../../bench/live/codex-cost.mjs';

const manifest = {
  model: 'gpt-6-astra',
  tasks: ['refresh'],
  arms: ['proxy', 'headroom'],
  reps: 1,
};
const summary = { model: manifest.model, valid: true };
function row(arm, input, cached, output) {
  return {
    task: 'refresh',
    arm,
    rep: 1,
    verdict: 'PASS',
    usage: { input, cached, output },
    ledgerUsage: [
      {
        status: 200,
        usage: {
          input_tokens: input,
          cached_input_tokens: cached,
          output_tokens: output,
        },
      },
    ],
  };
}
test('cached tokens are a subset; output can reverse an input win', () => {
  const result = costReport(manifest, summary, [
    row('proxy', 1000, 900, 100),
    row('headroom', 2000, 0, 1),
  ]);
  expect(result.valid).toBe(true);
  expect(result.measured[0].estimatedUsd).toBeCloseTo(0.0069, 10);
  expect(result.measured[1].estimatedUsd).toBeCloseTo(0.02005, 10);
  const reversed = costReport(manifest, summary, [
    row('proxy', 1000, 900, 1000),
    row('headroom', 2000, 0, 1),
  ]);
  expect(reversed.comparisons[0].reductionPercent).toBeLessThan(0);
});
test.each([
  'missing',
  'duplicate',
  'failed',
  'invalid-audit',
  'ledger-mismatch',
  'negative',
  'cached-overflow',
])('invalid %s cannot publish a cost win', (kind) => {
  const rows = [row('proxy', 1000, 900, 100), row('headroom', 2000, 0, 1)];
  const audit = { ...summary };
  if (kind === 'missing') rows.pop();
  if (kind === 'duplicate') rows[1] = rows[0];
  if (kind === 'failed') {
    rows[0].verdict = 'PROVIDER_ERROR';
    rows[0].usage = null;
  }
  if (kind === 'invalid-audit') audit.valid = false;
  if (kind === 'ledger-mismatch') rows[0].usage.input++;
  if (kind === 'negative') rows[0].usage.output = -1;
  if (kind === 'cached-overflow') rows[0].usage.cached = 1001;
  const result = costReport(manifest, audit, rows);
  expect(result.valid).toBe(false);
  expect(result.comparisons).toEqual([]);
});
test('unknown model cannot inherit astra rates', () => {
  expect(() =>
    costReport({ ...manifest, model: 'other' }, summary, [])
  ).toThrow('model mismatch');
});

test('independent audit supersedes the original runner verdict and must cover every run', () => {
  const rows = [row('proxy', 1000, 900, 100), row('headroom', 2000, 0, 1)];
  const audit = structuredClone(rows);
  rows[1].verdict = 'INVALID_READ';
  expect(costReport(manifest, summary, rows, audit).valid).toBe(true);
  expect(
    costReport(manifest, summary, rows, audit.slice(0, 1)).comparisons
  ).toEqual([]);
  audit[1].verdict = 'FAIL';
  expect(costReport(manifest, summary, rows, audit).comparisons).toEqual([]);
});
