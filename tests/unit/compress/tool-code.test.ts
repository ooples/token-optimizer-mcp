import ts from 'typescript';
import {
  compactToolCode,
  compactToolDefinitions,
} from '../../../src/proxy/tool-code.js';
import { compressResponses } from '../../../src/proxy/responses.js';

function tokens(source: string): [number, string][] {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    source
  );
  const result: [number, string][] = [];
  for (
    let kind = scanner.scan();
    kind !== ts.SyntaxKind.EndOfFileToken;
    kind = scanner.scan()
  )
    result.push([kind, scanner.getTokenText()]);
  return result;
}

test('compacts code whitespace with identical TypeScript tokens, comments and line breaks', () => {
  const code =
    'type Item = {\n  // Keep every instruction and  double space.\n  name: "two  spaces";\n  values: [string, number];\n  /* multiline\n    comment */\n};\n';
  const original = 'Prose  stays exact.\n```ts\n' + code + '```\n';
  const compact = compactToolCode(original);
  expect(compact.length).toBeLessThan(original.length);
  expect(
    tokens(
      compact.slice(compact.indexOf('type Item'), compact.lastIndexOf('```'))
    )
  ).toEqual(tokens(code));
  expect(compact).toContain('// Keep every instruction and  double space.');
  expect(compact).toContain('/* multiline\n    comment */');
  expect(compact.match(/\n/g)?.length).toBe(original.match(/\n/g)?.length);
  expect(compactToolCode(compact)).toBe(compact);
});

test.each([
  'const x = `  literal\n  spacing`;',
  'const r = /[  ]+/;',
  'const s = "a\\\nb";',
  'const x = "unterminated;',
])('leaves ambiguous code alone: %s', (code) => {
  const description = '```ts\n  ' + code + '\n```';
  expect(compactToolCode(description)).toBe(description);
});

test('preserves JSON strings, unsupported languages, prose, schemas and grammars', () => {
  const description = '```json\n{\n  "space": "  exact  ", "x": [1, 2]\n}\n```';
  const compact = compactToolCode(description);
  expect(JSON.parse(compact.slice(8, -3))).toEqual(
    JSON.parse(description.slice(8, -3))
  );
  const python = '```python\nif True:\n  print(1)\n```';
  expect(compactToolCode(python)).toBe(python);
  const tool = {
    type: 'custom',
    name: 'x',
    description,
    format: { type: 'grammar', definition: description },
    parameters: { description },
  };
  const result = compactToolDefinitions([tool]) as (typeof tool)[];
  expect(result[0].format).toBe(tool.format);
  expect(result[0].parameters).toBe(tool.parameters);
});

test('Responses experiment is opt-in, stable across turns, and preserves client cache keys', () => {
  const previous = process.env.TOKEN_OPTIMIZER_PROXY_TOOL_CODE;
  try {
    const item = {
      type: 'additional_tools',
      tools: [
        {
          type: 'namespace',
          name: 'n',
          tools: [
            {
              type: 'custom',
              name: 'x',
              description: '```ts\ntype X = {\n  name: string;\n};\n```',
            },
          ],
        },
      ],
    };
    const request = { prompt_cache_key: 'client-key', input: [item] };
    const body = Buffer.from(JSON.stringify(request));
    delete process.env.TOKEN_OPTIMIZER_PROXY_TOOL_CODE;
    expect(compressResponses(body, request, () => '').body).toBe(body);
    process.env.TOKEN_OPTIMIZER_PROXY_TOOL_CODE = '1';
    const first = JSON.parse(
      compressResponses(body, request, () => '').body.toString()
    );
    const appended = {
      ...request,
      input: [item, { type: 'message', role: 'user', content: 'next' }],
    };
    const second = JSON.parse(
      compressResponses(
        Buffer.from(JSON.stringify(appended)),
        appended,
        () => ''
      ).body.toString()
    );
    expect(first.input[0]).toEqual(second.input[0]);
    expect(first.input[0]).not.toEqual(item);
    expect(first.prompt_cache_key).toBe('client-key');
    expect(request.input[0]).toBe(item);
  } finally {
    if (previous === undefined)
      delete process.env.TOKEN_OPTIMIZER_PROXY_TOOL_CODE;
    else process.env.TOKEN_OPTIMIZER_PROXY_TOOL_CODE = previous;
  }
});
