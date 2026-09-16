import { test, expect } from '@jest/globals';
import { compressJsonFragments } from '../../../src/compress/json-fragments.js';
import { compressResponses } from '../../../src/proxy/responses.js';

function expand(text: string): string {
  return text.replace(
    /\[JSON fragment records; missing records remain unknown\. Join template parts, replacing numeric slots with raw JSON lexemes from each row\. Template: (\[[^\n]+\])\]\n([\s\S]*?)\[\/JSON fragment records\]\n/g,
    (_all, encoded: string, rows: string) => {
      const template = JSON.parse(encoded) as (number | string)[];
      return rows
        .trim()
        .split('\n')
        .map((row) => {
          const values = JSON.parse(row) as string[];
          return template
            .map((part) => (typeof part === 'number' ? values[part] : part))
            .join('');
        })
        .join('');
    }
  );
}
function fixture(nl = '\n'): string {
  const record = (i: number) =>
    JSON.stringify(
      {
        id: `route-${i} "quoted"`,
        enabled: i !== 7,
        limit: 100,
        region: 'east',
        extra: null,
      },
      null,
      2
    )
      .split('\n')
      .map((l) => '  ' + l)
      .join(nl) +
    ',' +
    nl;
  return (
    'Warning: truncated output (original token count: 6000)' +
    nl +
    'Total output lines: 1442' +
    nl +
    nl +
    '[' +
    nl +
    Array.from({ length: 12 }, (_, i) => record(i)).join('') +
    '  {' +
    nl +
    '    "id": "broken…2000 tokens truncated…tail"' +
    nl +
    '  },' +
    nl +
    Array.from({ length: 12 }, (_, i) => record(i + 50)).join('') +
    ']' +
    nl
  );
}
test.each(['\n', '\r\n'])(
  'truncated JSON preserves all visible bytes, gap, and rare values %j',
  (nl) => {
    const input = fixture(nl),
      out = compressJsonFragments(input);
    expect(out.lossless).toBe(true);
    expect(out.text.length).toBeLessThan(input.length * 0.8);
    expect(out.text).toContain('…2000 tokens truncated…');
    expect(out.text).toContain('missing records remain unknown');
    expect(out.text).toContain('false');
    expect(expand(out.text)).toBe(input);
  }
);
test('fragment routing works inside a real Responses tool envelope', () => {
  const input = fixture();
  const request = {
    input: [
      {
        type: 'custom_tool_call_output',
        call_id: 'a',
        output: [
          {
            type: 'input_text',
            text: JSON.stringify({ output: input, exit_code: 0 }),
          },
        ],
      },
    ],
  };
  const out = compressResponses(
    Buffer.from(JSON.stringify(request)),
    request,
    () => {
      throw Error('Must remain lossless');
    }
  );
  expect(out.summary.compressed).toBe(true);
  expect(
    expand(
      JSON.parse(JSON.parse(out.body.toString()).input[0].output[0].text).output
    )
  ).toBe(input);
});
test('ordinary JSON, nested values, changed keys, and short fragments cannot invent records', () => {
  const plain = fixture().replace(
    'Warning: truncated output',
    'ordinary output'
  );
  expect(compressJsonFragments(plain).text).toBe(plain);
  const varied = fixture().replaceAll(
    '"region": "east"',
    '"region": {"code":"east"}'
  );
  expect(compressJsonFragments(varied).text).toBe(varied);
  const changed = fixture().replace('"enabled": false', '"other": false');
  expect(expand(compressJsonFragments(changed).text)).toBe(changed);
});
test('lexical numeric and escaped-string values reconstruct exactly', () => {
  const input = fixture()
    .replace('"limit": 100', '"limit": -0.00e+0')
    .replace('"extra": null', '"extra": "\\u0061\\\\b"');
  expect(expand(compressJsonFragments(input).text)).toBe(input);
});
