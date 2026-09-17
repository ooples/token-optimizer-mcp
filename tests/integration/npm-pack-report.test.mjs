import { test, expect } from '@jest/globals';
import { parsePackReport } from '../../scripts/npm-pack-report.mjs';
const name = '@ooples/token-optimizer-mcp';
const report = {
  name,
  version: '7.0.0',
  files: [{ path: 'dist/server/index.js' }],
};
test.each([[report], { [name]: report }].map((value) => [value]))(
  'reads supported npm pack JSON formats: %j',
  (value) => {
    expect(parsePackReport(JSON.stringify(value), name)).toEqual(report);
  }
);
test.each(
  [
    null,
    {},
    [],
    { error: { message: 'failed' } },
    [{ ...report, name: 'wrong' }],
    [report, report],
    [{ ...report, files: [] }],
    [{ ...report, files: [{}] }],
  ].map((value) => [value])
)('rejects invalid or ambiguous package reports: %j', (value) => {
  expect(() => parsePackReport(JSON.stringify(value), name)).toThrow();
});
