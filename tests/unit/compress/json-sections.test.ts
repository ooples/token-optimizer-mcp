import { expect, test } from '@jest/globals';
import { compressBlock } from '../../../src/compress/router.js';
const rows = Array.from({ length: 240 }, (_, id) => ({
  id: `route-${id}`,
  enabled: id !== 179,
  description: 'quoted "brace }" and [bracket]',
}));
const json = JSON.stringify(rows, null, 2);
const spill = () => '/complete.json';

test('mixed file output preserves surrounding text and the exceptional record', () => {
  const prefix = 'Only work in this directory.\r\n';
  const suffix = '\r\nWARNING: override applies\n{"limit":7}\n';
  const result = compressBlock(prefix + json + suffix, { spill });
  expect(result.text.startsWith(prefix)).toBe(true);
  expect(result.text.endsWith(suffix)).toBe(true);
  expect(result.text).toContain('route-179');
  expect(result.text).toContain('exact boolean counts over all 240 rows');
  expect(result.text.length).toBeLessThan(json.length / 4);
});

test('two complete documents stay separate, including with CRLF', () => {
  const text = `${json}\r\n${json.replaceAll('route-', 'other-')}\r\n`;
  const result = compressBlock(text, { spill });
  expect(result.text).toContain('route-179');
  expect(result.text).toContain('other-179');
  expect(result.text.endsWith('\r\n')).toBe(true);
});

test('partial JSON and JavaScript trailing syntax are not treated as complete documents', () => {
  for (const text of [
    'NOTICE\n' + json.slice(0, -2),
    'NOTICE\n' + json + ';',
    'NOTICE\n' + json.replace('"route-100"', 'undefined'),
  ]) {
    expect(compressBlock(text, { spill }).text).toBe(text);
  }
});
