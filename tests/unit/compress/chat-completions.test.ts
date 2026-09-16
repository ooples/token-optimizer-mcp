import { describe, it, expect } from '@jest/globals';
import { compressBody } from '../../../src/proxy/server.js';
import { anchorStore } from '../../../src/compress/anchor.js';
import type { Finding } from '../../../src/compress/knowledge.js';

const rows = JSON.stringify(
  Array.from({ length: 100 }, (_, id) => ({
    id,
    status: 'ready',
    region: 'east',
    description: 'A long shared description of a record',
  }))
);
const tool = (id: string, content: unknown = rows) => ({
  role: 'tool',
  tool_call_id: id,
  content,
  custom_metadata: { preserve: true },
});
const call = (id: string) => ({
  role: 'assistant',
  content: null,
  reasoning_content: 'preserve reasoning',
  tool_calls: [
    {
      id,
      type: 'function',
      function: { name: 'list_records', arguments: '{}' },
    },
  ],
});
const encode = (request: unknown) => Buffer.from(JSON.stringify(request));
const spill = () => '/synthetic-recovery-path';
const compress = (
  request: unknown,
  anchors = anchorStore(),
  findings: readonly Finding[] = []
) =>
  compressBody(
    encode(request),
    spill,
    anchors,
    findings,
    undefined,
    false,
    'chat-completions'
  );

describe('Chat Completions adapter', () => {
  it('freezes graph knowledge across turns and adjusts dedup references for its system message', () => {
    const anchors = anchorStore();
    const findings = [
      {
        key: 'marker',
        claim: 'The project marker is CHAT_GRAPH_ALPHA.',
        confidence: 1,
        confidenceLabel: 'verified',
        scope: 'project',
        pinned: true,
      },
    ];
    const opening = [
      { role: 'system', content: 'Preserve these rules.' },
      { role: 'user', content: 'Find the project marker and records.' },
    ];
    const first = JSON.parse(
      compress({ messages: opening }, anchors, findings).body.toString()
    );
    expect(first.messages[0].role).toBe('system');
    expect(first.messages[0].content).toContain('CHAT_GRAPH_ALPHA');
    expect(first.messages.slice(1)).toEqual(opening);
    const later = [...opening, call('a'), tool('a'), call('b'), tool('b')];
    const next = JSON.parse(
      compress({ messages: later }, anchors, [
        { ...findings[0], claim: 'Changed marker BETA.' },
      ]).body.toString()
    );
    expect(next.messages[0]).toEqual(first.messages[0]);
    expect(next.messages[6].content).toContain('messages[4].content');
    expect(next).not.toHaveProperty('instructions');
    expect(
      JSON.parse(
        compress({ messages: later }, anchorStore(), findings).body.toString()
      ).messages[0]
    ).toEqual(opening[0]);
  });
  it('compresses tool results while preserving provider fields, tools and reasoning', () => {
    const request = {
      model: 'test',
      stream: true,
      stream_options: { include_usage: true },
      tools: [
        {
          type: 'function',
          function: { name: 'list_records', parameters: { type: 'object' } },
        },
      ],
      messages: [
        { role: 'system', content: 'Rules' },
        { role: 'user', content: 'List records' },
        call('a'),
        tool('a'),
      ],
    };
    const result = compress(request);
    const sent = JSON.parse(result.body.toString());
    expect(result.summary.compressed).toBe(true);
    expect(sent.messages[3].content.length).toBeLessThan(rows.length);
    expect(sent.messages[3].tool_call_id).toBe('a');
    expect(sent.messages[3].custom_metadata).toEqual({ preserve: true });
    expect(sent.messages.slice(0, 3)).toEqual(request.messages.slice(0, 3));
    expect({ ...sent, messages: [] }).toEqual({ ...request, messages: [] });
    expect(sent).not.toHaveProperty('input');
    expect(sent).not.toHaveProperty('instructions');
    expect(sent).not.toHaveProperty('system');
  });
  it('keeps appended-turn prefixes stable and references real Chat message positions', () => {
    const messages = [
      { role: 'user', content: 'List records' },
      call('a'),
      tool('a'),
    ];
    const first = JSON.parse(compress({ messages }).body.toString());
    const next = JSON.parse(
      compress({
        messages: [...messages, call('b'), tool('b')],
      }).body.toString()
    );
    expect(next.messages.slice(0, 3)).toEqual(first.messages);
    expect(next.messages[4].content).toContain('messages[2].content');
    expect(next.messages[4].content).not.toContain('input[');
  });
  it('leaves multimodal results and ambiguous duplicate call IDs untouched', () => {
    const messages = [
      call('a'),
      tool('a', [
        { type: 'text', text: rows },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
      ]),
      call('b'),
      tool('b'),
      tool('b'),
    ];
    expect(compress({ messages }).body).toEqual(encode({ messages }));
  });
  it('does not compress code read for exact editing', () => {
    const source = Array.from(
      { length: 100 },
      (_, i) => `export const variable_${i} = ${i};`
    ).join('\n');
    const request = {
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'read',
              type: 'function',
              function: {
                name: 'read_file',
                arguments: '{"path":"source.ts"}',
              },
            },
          ],
        },
        tool('read', source),
      ],
    };
    expect(compress(request).body).toEqual(encode(request));
  });
});
