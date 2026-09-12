/**
 * Fixtures shaped like the wire, not like a payload.
 *
 * WHY THIS EXISTS, and it is the most expensive lesson in this package. The
 * corpus in `fixtures.mjs` contains ZERO `tool_result` blocks and builds every
 * request with `tools: []`. A real Claude Code request is the opposite: tool
 * definitions are 56% of it, the conversation 40%, and almost every compressible
 * byte in that conversation sits inside a `tool_result`. So the proof gate could
 * pass on every workload while the compressor removed 0 bytes from every real
 * request -- which is exactly what happened, through two paid campaigns.
 *
 * A fixture must mirror the CONTAINER the client actually sends, not merely the
 * content inside it. These do:
 *
 *   - tool definitions present and dominant, as they are on the wire;
 *   - a `system` role message whose content is a bare string, which the client
 *     alternates with the array-of-blocks form between turns;
 *   - `tool_use` blocks carrying `{ file_path }`, and `tool_result` blocks
 *     linked back to them by `tool_use_id` -- the link that lets the code engine
 *     resolve a language at all;
 *   - reads delivered line-numbered as `123<TAB>line`, the form that defeats
 *     every content detector until it is stripped;
 *   - `cache_control` on the final message only, which is where the client puts
 *     it and why "compress after the frontier" finds nothing.
 *
 * CONTENT IS REAL WHERE IT MATTERS AND SYNTHETIC WHERE IT DOES NOT. The read
 * payload is this repository's own source, so the code engine is exercised
 * against code it will genuinely meet; the instruction blocks are generated
 * filler of the measured size, because the originals are a developer's private
 * CLAUDE.md and have no business in a committed fixture.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Composition of a real captured request, in bytes of JSON.
 *
 * Measured off the wire with a recording forwarder while Claude Code read one
 * file: `tool-005.body.json`, 265,036 bytes total. The drift test compares a
 * fixture's shares against these so a corpus cannot quietly stop resembling
 * production again.
 */
export const PRODUCTION_SHAPE = Object.freeze({
  total: 265036,
  tools: 148328,
  system: 9410,
  messages: 106819,
  /** Shares of the whole request, which is what the test actually asserts. */
  shares: Object.freeze({ tools: 0.56, system: 0.035, messages: 0.403 }),
});

const TAB = String.fromCharCode(9);
const NL = String.fromCharCode(10);

/** Deterministic filler, so a fixture is byte-identical between runs. */
function filler(chars, seed) {
  const words = [
    'the',
    'agent',
    'must',
    'never',
    'weaken',
    'a',
    'test',
    'to',
    'make',
    'it',
    'pass',
    'and',
    'should',
    'record',
    'what',
    'it',
    'measured',
    'instead',
  ];
  let state = seed >>> 0;
  const out = [];
  let len = 0;
  while (len < chars) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const word = words[state % words.length];
    out.push(word);
    len += word.length + 1;
  }
  return out.join(' ').slice(0, chars);
}

/** A file as `Read` delivers it: every line prefixed with its number and a tab. */
export function numbered(source) {
  return source
    .split(NL)
    .map((line, i) => `${i + 1}${TAB}${line}`)
    .join(NL);
}

/** A tool definition of roughly the size the real ones run to. */
function toolDefinition(name, chars, seed) {
  return {
    name,
    description: filler(chars, seed),
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, pattern: { type: 'string' } },
    },
  };
}

/**
 * A request in the shape the client actually sends.
 *
 * `readFiles` are repository-relative paths whose contents become line-numbered
 * tool results, one per assistant/user turn pair.
 */
export function wireShapeRequest({
  root,
  readFiles,
  toolCount = 26,
  toolChars = 148000,
  systemChars = 9410,
  instructionChars = 54200,
  preambleChars = 23131,
}) {
  const tools = [];
  const per = Math.floor(toolChars / toolCount);
  for (let i = 0; i < toolCount; i += 1) {
    tools.push(toolDefinition(`Tool${i}`, per, 1000 + i));
  }

  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: filler(instructionChars, 7) },
        { type: 'text', text: filler(1338, 11) },
        { type: 'text', text: 'List the files, then read one and summarise it.' },
      ],
    },
    // THE STRING FORM, deliberately. The client alternates this with an
    // array-of-blocks between turns, and a prefix digest that skipped the
    // string form saw the text vanish and called every turn invalidated.
    { role: 'system', content: filler(preambleChars, 13) },
  ];

  readFiles.forEach((relative, i) => {
    const id = `toolu_fixture_${i}`;
    const source = readFileSync(join(root, relative), 'utf8');
    messages.push({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: filler(2424, 17 + i), signature: '' },
        {
          type: 'tool_use',
          id,
          name: 'Read',
          input: { file_path: relative },
        },
      ],
    });
    const last = i === readFiles.length - 1;
    messages.push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          content: [{ type: 'text', text: numbered(source) }],
          // Only the final message carries it, as the client does.
          ...(last ? { cache_control: { type: 'ephemeral' } } : {}),
        },
      ],
    });
  });

  return { model: 'claude', system: filler(systemChars, 23), messages, tools };
}

/** Bytes of JSON for each part of a request, for the drift assertions. */
export function composition(request) {
  const size = (value) => JSON.stringify(value ?? '').length;
  return {
    total: size(request),
    tools: size(request.tools),
    system: size(request.system),
    messages: size(request.messages),
  };
}
