import { test, expect } from '@jest/globals';
import { compressTap, looksLikeTap } from '../../../src/compress/tap.js';
import { compressResponses } from '../../../src/proxy/responses.js';

function pass(i: number, nl = '\n', name = `case ${i}`): string {
  return `# Subtest: ${name}${nl}ok ${i} - ${name}${nl}  ---${nl}  duration_ms: ${i}.001${nl}  type: 'test'${nl}  ...${nl}`;
}
function expand(text: string): string {
  return text.replace(
    /\[TAP (?:passing|failing) records: JSON rows \[name,id,ms\]; substitute into template ("[^\n]+")\]\r?\n([\s\S]*?)\[\/TAP (?:passing|failing) records\]\r?\n/g,
    (_all, encoded: string, rows: string) => {
      const template = JSON.parse(encoded) as string;
      return rows
        .trim()
        .split(/\r?\n/)
        .map((row) => {
          const [name, id, ms] = JSON.parse(row) as string[];
          return template.replace(
            /\{(name|id|ms)\}/g,
            (_s, key: string) => ({ name, id, ms })[key as 'name' | 'id' | 'ms']
          );
        })
        .join('');
    }
  );
}

test('actual Responses JSON envelope reaches TAP compression and preserves failure evidence', () => {
  const tap =
    Array.from({ length: 80 }, (_, i) => pass(i)).join('') + '# fail 0\n';
  const envelope = { chunk_id: 'x', exit_code: 0, output: tap };
  const request = {
    input: [
      {
        type: 'custom_tool_call_output',
        call_id: 'a',
        output: [{ type: 'input_text', text: JSON.stringify(envelope) }],
      },
    ],
  };
  const result = compressResponses(
    Buffer.from(JSON.stringify(request)),
    request,
    () => {
      throw Error('Lossless TAP should not spill');
    }
  );
  expect(result.summary.compressed).toBe(true);
  const decoded = JSON.parse(result.body.toString());
  const out = JSON.parse(decoded.input[0].output[0].text);
  expect(out.exit_code).toBe(0);
  expect(expand(out.output)).toBe(tap);
});
test.each(['\n', '\r\n'])(
  'TAP table reconstructs all bytes including wrapper and newline style %j',
  (nl) => {
    const input =
      `Chunk ID: x${nl}Output:${nl}TAP version 13${nl}` +
      Array.from({ length: 80 }, (_, i) =>
        pass(i, nl, `quoted "case" {id} \\ ${i}`)
      ).join('') +
      `1..80${nl}# pass 80${nl}# fail 0${nl}`;
    expect(looksLikeTap(input)).toBe(true);
    const result = compressTap(input);
    expect(result.lossless).toBe(true);
    expect(result.text.length).toBeLessThan(input.length * 0.6);
    expect(expand(result.text)).toBe(input);
  }
);
test('failure diagnostics, nested tests and skipped tests survive between passing groups', () => {
  const failure =
    "# Subtest: bad\nnot ok 9 - bad\n  ---\n  error: 'wrong value'\n  expected: 3\n  actual: 4\n  ...\n";
  const unusual =
    '  # Subtest: nested\n  ok 1 - nested\n# Subtest: skipped\nok 10 - skipped # SKIP\n';
  const group = Array.from({ length: 8 }, (_, i) => pass(i)).join('');
  const input = group + failure + unusual + group;
  const result = compressTap(input);
  expect(result.text).toContain(failure + unusual);
  expect(expand(result.text)).toBe(input);
});
test('short, truncated or unfamiliar records do not grow or change', () => {
  for (const input of [
    pass(1),
    pass(1).slice(0, -8),
    pass(1).replace("'test'", "'suite'"),
    Array.from({ length: 5 }, (_, i) => pass(i))
      .join('')
      .trimEnd(),
  ])
    expect(expand(compressTap(input).text)).toBe(input);
});

test('repeated failures retain every identity and exact diagnostic; changed failures stay distinct', () => {
  const diagnostic =
    '  error: |-\n    Expected values to be strictly equal\n  expected: 125\n  actual: 250\n  stack: |-\n    TestContext (file:///repo/test/retry.test.mjs:5:56)\n';
  const failure = (i: number, diag = diagnostic) =>
    pass(i)
      .replace(`ok ${i}`, `not ok ${i}`)
      .replace('  ...', diag + '  ...');
  const input =
    Array.from({ length: 8 }, (_, i) => failure(i)).join('') +
    failure(9, diagnostic.replace('250', '500'));
  const result = compressTap(input);
  expect(result.text).toContain('TAP failing records');
  expect(result.text).toContain('actual: 500');
  expect(expand(result.text)).toBe(input);
});
