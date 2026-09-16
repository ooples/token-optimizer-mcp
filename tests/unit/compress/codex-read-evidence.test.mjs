import { expect, test } from '@jest/globals';
import {
  readEvidence,
  outerEnvelopeTruncated,
} from '../../../bench/live/codex-output.mjs';

const fixture = 'first\nneedle\nlast';
const capture = (output) => [
  {
    path: '/backend-api/codex/responses',
    body: JSON.stringify({
      input: [{ type: 'custom_tool_call_output', output }],
    }),
  },
];

test('finds a full Windows read inside a nested code-mode result', () => {
  const output = [
    {
      type: 'input_text',
      text: JSON.stringify({ output: 'first\r\nneedle\r\nlast\r\n' }),
    },
  ];
  expect(readEvidence(capture(output), fixture)).toEqual({
    complete: true,
    truncated: false,
    requests: 1,
  });
});

test('a surviving needle is insufficient when the read was truncated', () => {
  expect(
    readEvidence(capture('Warning: truncated output\nneedle'), fixture)
  ).toEqual({ complete: false, truncated: true, requests: 1 });
});

test('detects outer truncation even if a later read retrieved the full fixture', () => {
  const rows = [
    ...capture('Warning: truncated output\nneedle'),
    ...capture(fixture),
  ];
  expect(readEvidence(rows, fixture)).toEqual({
    complete: false,
    truncated: true,
    requests: 2,
  });
});

test('a later truncated recovery does not invalidate the complete initial read', () => {
  const rows = [
    ...capture(fixture),
    ...capture('Warning: truncated output\nrecovery'),
  ];
  expect(readEvidence(rows, fixture)).toEqual({
    complete: true,
    truncated: false,
    requests: 2,
  });
});

test('missing capture cannot certify a read', () => {
  expect(readEvidence([], fixture)).toEqual({
    complete: false,
    truncated: false,
    requests: 0,
  });
});

test('outer truncation requires the initial serialized shell envelope, not any later warning', () => {
  const outer =
    'Warning: truncated output\nTotal output lines: 1\n\n{"chunk_id":"x","output":"[...1000 tokens truncated...]"}';
  expect(
    outerEnvelopeTruncated(capture([{ type: 'input_text', text: outer }]))
  ).toBe(true);
  expect(
    outerEnvelopeTruncated(
      capture('Warning: truncated output\n1000 tokens truncated\n[]')
    )
  ).toBe(false);
  expect(outerEnvelopeTruncated([...capture(fixture), ...capture(outer)])).toBe(
    false
  );
});
