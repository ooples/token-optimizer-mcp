import { test, expect } from '@jest/globals';
import {
  compressJsonFragments,
  compressJsonArray,
} from '../../../src/compress/json-fragments.js';
import { compressResponses } from '../../../src/proxy/responses.js';

import {
  expandJsonRecords,
  expandJsonRecordsByPosition,
} from '../../../src/compress/rehydrate.js';

/**
 * THE SHIPPED DECODER, NOT A LOCAL COPY OF IT.
 *
 * This file used to carry its own thirty-line reimplementation of the records
 * grammar, which is the arrangement `rehydrate` exists to end: a decoder that
 * lives beside the one test using it is free to drift into accepting something
 * the real one does not, and then every round trip here is green while the
 * product cannot invert its own output. It had already drifted -- it still
 * matched a `raw JSON lexemes` header the encoder stopped writing -- and it knew
 * nothing of the by-position family, so a payload encoded that way failed here
 * as a lost record rather than as the missing decoder call it was.
 */
function expand(text: string): string {
  return expandJsonRecords(expandJsonRecordsByPosition(text));
}

/**
 * The array header claims completeness; the fragment header does not. Swapping
 * one for the other is how a complete encoding is fed to the fragment decoder.
 */
function asFragmentRecords(text: string): string {
  return text.replace(
    /\[JSON array records; ALL \d+ records preserved(?:, \d+ encoded here)?\./g,
    '[JSON fragment records; missing records remain unknown.'
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
  'complete numeric arrays reconstruct every original byte %j',
  (nl) => {
    const input = JSON.stringify(
      Array.from({ length: 120 }, (_, i) => ({
        id: `sensor-shared-prefix-${i}`,
        value: i === 77 ? 912 : i % 13,
        explicit: null,
      })),
      null,
      2
    )
      .split('\n')
      .join(nl);
    const out = compressJsonArray(input);
    expect(out.text).toContain('ALL 120 records preserved');
    expect(out.text.length).toBeLessThan(input.length * 0.5);
    expect(expand(asFragmentRecords(out.text))).toBe(input);
  }
);

test('an incomplete array still cannot claim complete flat-record encoding', () => {
  // A TRUNCATED ARRAY IS LEFT ALONE, which is the safety property: the count in
  // an array header is a promise that every record is accounted for, and a body
  // that was cut off cannot keep it.
  expect(compressJsonArray(fixture()).text).toBe(fixture());
});

test('a nested array is templated, and comes back byte for byte', () => {
  // NESTING USED TO DISQUALIFY A RECORD from flat templating, and this test
  // asserted the refusal. b71868df made the nesting part of the template text
  // instead, so the refusal is gone -- but the promise in the header is not, and
  // that promise is what is worth testing. Encoding without checking the decode
  // would leave the count asserted and the contents unverified.
  const nested = JSON.stringify(
    Array.from({ length: 40 }, (_, i) => ({ i, nested: { i } })),
    null,
    2
  );
  const out = compressJsonArray(nested);
  expect(out.text).not.toBe(nested);
  expect(out.lossless).toBe(true);
  expect(out.text).toContain('ALL 40 records preserved');
  expect(expand(asFragmentRecords(out.text))).toBe(nested);
});
test.each(['\n', '\r\n', '\\n', '\\r\\n'])(
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
  // A NESTED VALUE IS NOW TEMPLATED RATHER THAN REFUSED (b71868df). What must
  // not change is that no record is invented or lost on the way back, so the
  // assertion moved from "left alone" to "restored exactly".
  const varied = fixture().replaceAll(
    '"region": "east"',
    '"region": {"code":"east"}'
  );
  const variedOut = compressJsonFragments(varied);
  expect(variedOut.text).not.toBe(varied);
  expect(expand(variedOut.text)).toBe(varied);
  const changed = fixture().replace('"enabled": false', '"other": false');
  expect(expand(compressJsonFragments(changed).text)).toBe(changed);
});
test('lexical numeric and escaped-string values reconstruct exactly', () => {
  const input = fixture()
    .replace('"limit": 100', '"limit": -0.00e+0')
    .replace('"extra": null', '"extra": "\\u0061\\\\b"');
  expect(expand(compressJsonFragments(input).text)).toBe(input);
});

test('escaped structural newlines never decode escapes inside string values', () => {
  const input = fixture('\\r\\n').replaceAll(
    '"region": "east"',
    '"region": "east\\nwest\\r\\n\\\\n"'
  );
  const out = compressJsonFragments(input);
  expect(out.text.length).toBeLessThan(input.length * 0.8);
  expect(expand(out.text)).toBe(input);
});

test('factors long ID prefixes while retaining every exact value and categorical fact', () => {
  const input = fixture().replaceAll('route-', 'route-long-shared-prefix-');
  const out = compressJsonFragments(input);
  expect(out.text.match(/route-long-shared-prefix-/g)?.length).toBe(2);
  expect(out.text).toContain('false');
  expect(expand(out.text)).toBe(input);
});

test('compresses complete escaped records inside an outer truncated shell envelope', () => {
  const inner = fixture('\r\n').replaceAll(
    'route-',
    'route-long-shared-prefix-'
  );
  const serialized = JSON.stringify({ output: inner, exit_code: 0 });
  const input =
    'Warning: truncated output (original token count: 10000)\nTotal output lines: 1\n\n' +
    serialized.replace('broken', 'broken\n...2000 tokens truncated...\n');
  const out = compressJsonFragments(input);
  expect(out.text.length).toBeLessThan(input.length * 0.65);
  expect(expand(out.text)).toBe(input);
  expect(out.text).toContain('2000 tokens truncated');
});

/**
 * A RUN WHOSE SHAPES ARE INTERLEAVED, which is the case the by-position family
 * exists for and the one the old adjacency grouping could not touch: every third
 * record carries a `region` and the rest a `zone`, so no three records of one
 * shape are ever neighbours. Real agent transcripts look like this -- one had 47
 * records in 16 shapes with not a single adjacent triple among them.
 */
function scattered(): string {
  return JSON.stringify(
    Array.from({ length: 40 }, (_, i) =>
      i % 3 === 0
        ? { id: `edge-node-${i}`, region: 'east', weight: i, enabled: true }
        : { id: `edge-node-${i}`, zone: `z${i}`, weight: i, enabled: i !== 7 }
    ),
    null,
    2
  );
}

test('interleaved shapes are templated by position and come back byte for byte', () => {
  const input = scattered(),
    out = compressJsonArray(input);
  expect(out.text).toContain('by position;');
  expect(out.lossless).toBe(true);
  expect(out.text.length).toBeLessThan(input.length * 0.5);
  expect(expand(out.text)).toBe(input);
});

/**
 * EVERY REFUSAL BELOW IS THE POINT OF THE GRAMMAR, not an edge case. A position
 * list can disagree with the body it heads in exactly these ways, and each one
 * means the decoder would have to invent a record to produce any output at all.
 * Mutating a real payload is what proves the checks are reachable: asserting them
 * on hand-written markers would only test the hand-writing.
 */
test.each([
  [
    'a position filled twice',
    (t: string) => t.replace('[rows at 0,3,6', '[rows at 0,0,6'),
    /position 0 stated twice/,
  ],
  [
    'a position no block fills',
    (t: string) => t.replace(/\[at (\d+); /, '[at 99; '),
    /position \d+ was never stated/,
  ],
  [
    'a header that does not parse',
    (t: string) => t.replace('[rows at 0,3,6', '[rows near 0,3,6'),
    /unreadable by-position block/,
  ],
  [
    'a record shorter than it declares',
    (t: string) => t.replace(/\[at (\d+); \d+ chars\]/, '[at $1; 99999 chars]'),
    /record at \d+ is shorter than 99999/,
  ],
])(
  'by-position decoding refuses to guess at %s',
  (_name, corrupt, complaint) => {
    const encoded = compressJsonArray(scattered()).text;
    expect(encoded).toMatch(/\[at \d+; \d+ chars\]/);
    expect(() => expand(corrupt(encoded))).toThrow(complaint);
  }
);
