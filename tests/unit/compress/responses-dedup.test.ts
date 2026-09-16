import { expect, test } from '@jest/globals';
import { compressResponses } from '../../../src/proxy/responses.js';
import { tokenBenefit } from '../../../src/proxy/token-gate.js';
import { compressJsonArray } from '../../../src/compress/json-fragments.js';
import {
  responseJsonEnvelope,
  replaceJsonText,
} from '../../../src/proxy/response-dedup.js';

test('cached shell field offsets preserve metadata and reject ambiguous fields', () => {
  const raw =
    '{"chunk_id":"a","wall_time_seconds":0.1,"exit_code":0,"output":"old","big":9007199254740993}';
  expect(responseJsonEnvelope(raw)).toBe('old');
  for (const value of ['one', 'two\\n"quoted"']) {
    expect(replaceJsonText(raw, 'output', value)).toBe(
      raw.replace('"old"', JSON.stringify(value))
    );
  }
  const changed = raw.replace('"exit_code":0', '"exit_code":1');
  expect(responseJsonEnvelope(changed)).toBe('old');
  expect(replaceJsonText(changed, 'output', 'new')).toContain('"exit_code":1');
  const ambiguous = raw.replace('"big":', '"nested":{"output":"other"},"big":');
  expect(responseJsonEnvelope(ambiguous)).toBe('old');
  expect(replaceJsonText(ambiguous, 'output', 'new')).toBe(ambiguous);
  expect(replaceJsonText(ambiguous, 'output', 'again')).toBe(ambiguous);
});

const rows = Array.from({ length: 80 }, (_, id) => ({
  id,
  status: 'healthy',
  description: 'The operation finished successfully',
  value: id * 3,
}));
const text = JSON.stringify(rows, null, 2);
const spill = () => '/tmp/response-recovery.txt';
const output = (value: unknown, n: number, type = 'function_call_output') => ({
  type,
  call_id: `c${n}`,
  output: value,
});
function run(input: unknown[]) {
  const request = { model: 'gpt-6-astra', input };
  return JSON.parse(
    compressResponses(
      Buffer.from(JSON.stringify(request)),
      request,
      spill
    ).body.toString()
  ).input;
}

test('repeated results keep a single compressed copy and never rewrite earlier items', () => {
  const input = [output(text, 1), output(text, 2), output(text, 3)];
  const a = run(input.slice(0, 1));
  const b = run(input.slice(0, 2));
  const c = run(input);
  expect(a[0].output.length).toBeLessThan(text.length / 2);
  expect(b.slice(0, 1)).toEqual(a);
  expect(c.slice(0, 2)).toEqual(b);
  expect(c[1].output).toContain('input[0].output');
  expect(c[2].output).toContain('input[0].output');
  expect(c[1].call_id).toBe('c2');
  expect(JSON.stringify(c).length).toBeLessThan(JSON.stringify(a).length + 400);
});

test('a changed row is a new observation and removing the referent restores content', () => {
  const changed = JSON.stringify(
    rows.map((r) => (r.id === 37 ? { ...r, value: 982761 } : r)),
    null,
    2
  );
  const result = run([output(text, 1), output(changed, 2)]);
  expect(result[1].output).toContain('982761');
  expect(result[1].output).not.toContain('Repeated observation');
  const trimmed = run([output(text, 2)]);
  expect(trimmed[0].output).toBe(result[0].output);
});

test('shell transport headers retain status and timing while only identical bodies fold', () => {
  const wrap = (id: string, code: number) =>
    `Chunk ID: ${id}\nWall time: 0.${code} seconds\nProcess exited with code ${code}\nFinal output:\n${text}`;
  const input = [output(wrap('aa', 1), 1), output(wrap('bb', 2), 2)];
  const result = run(input);
  expect(result[1].output).toContain(
    'Chunk ID: bb\nWall time: 0.2 seconds\nProcess exited with code 2'
  );
  expect(result[1].output).toContain('body after transport header');
  expect(result[1].output).toContain('Repeated observation');
  expect(result.slice(0, 1)).toEqual(run(input.slice(0, 1)));
});

test('unrecognized headers and changed error details are not stripped', () => {
  const a = `ERROR first\nOutput:\n${text}`;
  const b = `ERROR second\nOutput:\n${text}`;
  const result = run([output(a, 1), output(b, 2)]);
  expect(result[1].output).toContain('ERROR second');
  expect(result[1].output).not.toContain('Repeated observation');
});

test('real Codex JSON shell envelopes retain metadata while duplicate output folds', () => {
  const envelope = (chunk: string, time: number) =>
    JSON.stringify({
      chunk_id: chunk,
      wall_time_seconds: time,
      exit_code: 1,
      original_token_count: 5000,
      output: text,
    });
  const first = output(
    [{ type: 'input_text', text: envelope('aa', 0.1) }],
    1,
    'custom_tool_call_output'
  );
  const second = output(
    [{ type: 'input_text', text: envelope('bb', 0.2) }],
    2,
    'custom_tool_call_output'
  );
  const result = run([first, second]);
  const request = { input: [first, second] };
  expect(
    compressResponses(Buffer.from(JSON.stringify(request)), request, spill)
      .summary.dedupReferences
  ).toBe(1);
  expect(result.slice(0, 1)).toEqual(run([first]));
  const decoded = JSON.parse(result[1].output[0].text);
  expect(decoded.output).toContain(
    'input[0].output[0].text JSON field "output"'
  );
  expect(decoded.output).toContain('Repeated observation');
  expect({ ...decoded, output: null }).toEqual({
    ...JSON.parse(envelope('bb', 0.2)),
    output: null,
  });
});

test('output_text parts preserve annotations, image data, order, and unknown parts', () => {
  const image = { type: 'input_image', image_url: 'data:image/png;base64,abc' };
  const unknown = { type: 'future_text', text };
  const parts = [
    { type: 'output_text', text, annotations: [{ type: 'test', id: 7 }] },
    image,
    unknown,
  ];
  const result = run([output(parts, 1)]);
  expect(result[0].output[0].text.length).toBeLessThan(text.length);
  expect(result[0].output[0].annotations).toEqual(parts[0].annotations);
  expect(result[0].output.slice(1)).toEqual([image, unknown]);
});

test('local-shell output stays JSON with exact status, nontext data and error fields', () => {
  const shell = {
    stdout: text,
    stderr: 'failed at x:32',
    exit_code: 3,
    metadata: { duration: 7 },
    rows,
  };
  const item = {
    type: 'local_shell_call_output',
    id: 'lc1',
    status: 'completed',
    output: JSON.stringify(shell),
  };
  const result = run([item])[0];
  const decoded = JSON.parse(result.output);
  expect(result.id).toBe(item.id);
  expect(result.status).toBe(item.status);
  expect(decoded.stdout.length).toBeLessThan(text.length);
  expect({ ...decoded, stdout: null }).toEqual({ ...shell, stdout: null });
});

test('malformed and non-object local-shell envelopes pass through exactly', () => {
  const items = [
    output(text, 1, 'local_shell_call_output'),
    output('invalid:' + text, 2, 'local_shell_call_output'),
  ];
  expect(run(items)).toEqual(items);
});

test('local-shell metadata numbers preserve their original lexical precision', () => {
  const raw = `{"stdout":${JSON.stringify(text)},"stderr":"","counter":9007199254740993123}`;
  const result = run([
    { type: 'local_shell_call_output', id: 'lc2', output: raw },
  ])[0];
  expect(result.output).toContain('"counter":9007199254740993123');
  expect(result.output.length).toBeLessThan(raw.length);
});

test('patch output preserves failed status, call ID, and absent output', () => {
  const item = {
    ...output(text, 1, 'apply_patch_call_output'),
    status: 'failed',
    id: 'patch-1',
  };
  const empty = {
    type: 'apply_patch_call_output',
    call_id: 'c2',
    status: 'completed',
  };
  const result = run([item, empty]);
  expect(result[0].output.length).toBeLessThan(text.length);
  expect({ ...result[0], output: null }).toEqual({ ...item, output: null });
  expect(result[1]).toEqual(empty);
});

test('exact source reads retain edit anchors, including repeated reads', () => {
  const code = Array.from(
    { length: 40 },
    (_, i) =>
      `export function fn${i}() {\n  const value = ${i};\n  return value + 1;\n}`
  ).join('\n');
  const input = [
    {
      type: 'function_call',
      call_id: 'c1',
      name: 'read_file',
      arguments: '{"path":"x.ts"}',
    },
    output(code, 1),
    {
      type: 'function_call',
      call_id: 'c2',
      name: 'read_file',
      arguments: '{"path":"x.ts"}',
    },
    output(code, 2),
  ];
  expect(run(input)).toEqual(input);
});

test('byte savings do not accept a candidate with more estimated tokens', () => {
  const before = 'a'.repeat(8192);
  const after = Array.from({ length: 600 }, (_, i) =>
    i.toString(16).padStart(4, '0')
  ).join(':');
  expect(after.length).toBeLessThan(before.length);
  expect(tokenBenefit(before, after)).toBe(false);
  expect(tokenBenefit(text, 'All records healthy.')).toBe(true);
});

test('small outputs can compress independently without changing earlier small outputs', () => {
  const small = JSON.stringify(rows.slice(0, 9));
  expect(small.length).toBeLessThan(1024);
  const a = run([output(small, 1)]);
  const b = run([output(small, 1), output(small, 2)]);
  expect(a[0].output.length).toBeLessThan(small.length);
  expect(b.slice(0, 1)).toEqual(a);
});

test('index eviction and identical call IDs do not produce references to absent results', () => {
  const input = Array.from({ length: 300 }, (_, i) =>
    output(`${i}\n${text}`, 1)
  );
  const result = run([...input, output(input[0].output, 1)]);
  expect(result.at(-1).output).not.toContain('Repeated observation');
  expect(result.slice(0, input.length)).toEqual(run(input));
});

test('small lexical tables reconstruct escapes, nulls and oversized integers exactly', () => {
  const record = (i: number) =>
    `{"key":"x${i}","note":"quoted \\" and { braces } \\n","number":9007199254740993123,"missing":null,"same":"unchanged repeated long value"}`;
  const original =
    '[' + Array.from({ length: 9 }, (_, i) => record(i)).join(',') + ']';
  const compact = compressJsonArray(original, 3);
  expect(compact.text.length).toBeLessThan(original.length);
  const expanded = compact.text.replace(
    /\[All \d+ JSON records; join template strings and row\[integer\] verbatim\. Template: (\[[^\n]+\])\]\n([\s\S]*?)\[\/JSON fragment records\]\n/g,
    (_all, encoded: string, data: string) => {
      const template = JSON.parse(encoded) as (string | number)[];
      return data
        .trim()
        .split('\n')
        .map((line) => {
          const row = JSON.parse(line) as string[];
          return template
            .map((part) => (typeof part === 'number' ? row[part] : part))
            .join('');
        })
        .join('');
    }
  );
  expect(expanded).toBe(original);
});
