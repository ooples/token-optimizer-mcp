import { describe, it, expect } from '@jest/globals';
import { v1Frontier } from '../../../src/compress/strategy.js';
import type { ProviderRequest } from '../../../src/compress/frontier.js';

/**
 * #495: prose elision ran over the model's own earlier replies and over a
 * background agent's completion report. The model then misquoted what it had
 * told the user, and acted on agent reports with their evidence removed.
 * Tool output is still compressed -- that is the positive control, without
 * which this file would pass with the engine switched off.
 */

const SENTENCES = [
  'The release waiter polls the registry until the published version resolves or the budget runs out.',
  'Npm accepts a publish and then processes it asynchronously, which can take well over an hour.',
  'Raising the budget therefore cannot fix the failure, because no runner-held budget outlasts the queue.',
  'The waiter instead reports a pending publish separately from a broken one.',
  'A scheduled job verifies the window afterwards and opens an issue when the version never appears.',
  'Uniform outputs are tested bit for bit against the host generator, which skips when the library is missing.',
  'Normals are compared to within the last few bits, since the device maths differs there.',
  'Every backend now builds its generator through the same factory, so none of them throws any more.',
  'Whether the device path is worth building is a question nobody has measured yet.',
  'It would change where the numbers are computed, not what they are.',
];

// A DIFFERENT ORDER PER BLOCK, so no block is a repeat of another: identical
// text is folded by dedup before prose elision ever runs, which made an
// earlier draft of this test pass on the unfixed code. One sentence per line,
// because a single line is never claimed as prose at all.
const rotated = (by: number): string =>
  [...SENTENCES.slice(by), ...SENTENCES.slice(0, by)].join('\n');
const REPLY = rotated(0);
const REPORT = rotated(3);
const OUTPUT = rotated(6);

function request(): ProviderRequest {
  return {
    system: 'You are a coding agent.',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'start here' }] },
      { role: 'assistant', content: [{ type: 'text', text: REPLY }] },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `<task-notification>\n<status>completed</status>\n<result>${REPORT}</result>\n</task-notification>`,
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'Read', input: { path: 'x' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: OUTPUT }],
      },
    ],
  } as unknown as ProviderRequest;
}

const spill = (): string => '/spill/prose.txt';

type Msg = { content: { text?: string; content?: string }[] };

describe('the conversation record stays whole (#495)', () => {
  const out = v1Frontier(request(), { spill }).request as unknown as {
    messages: Msg[];
  };

  it("leaves the model's own earlier reply whole", () => {
    expect(out.messages[1].content[0].text).toBe(REPLY);
  });

  it("leaves a background agent's completion report whole", () => {
    expect(out.messages[2].content[0].text).toContain(REPORT);
  });

  it('still compresses tool output, the positive control', () => {
    expect(out.messages[4].content[0].content).toContain('lower-signal');
  });
});

describe('a harness report split across text blocks (#497 review)', () => {
  it('keeps the body block whole when the tag is in a sibling block', () => {
    const request = {
      system: 'You are a coding agent.',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'start here' }] },
        {
          role: 'user',
          content: [
            { type: 'text', text: '<task-notification>' },
            { type: 'text', text: REPORT },
            { type: 'text', text: '</task-notification>' },
          ],
        },
      ],
    } as unknown as ProviderRequest;
    const out = v1Frontier(request, { spill }).request as unknown as {
      messages: Msg[];
    };
    expect(out.messages[1].content[1].text).toBe(REPORT);
  });
});

describe('harness record tools and spill re-reads (#495)', () => {
  const RECEIPT = rotated(1);
  const RECOVERED = rotated(2);
  const CONTROL = rotated(4);
  const SPILL_PATH =
    'C:\\Temp\\token-optimizer-spill\\532db20f\\c0a8e9f1-prose.txt';
  const call = (id: string, name: string, input: Record<string, unknown>) => ({
    role: 'assistant',
    content: [{ type: 'tool_use', id, name, input }],
  });
  const result = (id: string, content: string) => ({
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content }],
  });
  const out = v1Frontier(
    {
      system: 'You are a coding agent.',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'start here' }] },
        call('a1', 'Agent', { prompt: 'implement the issue' }),
        result('a1', RECEIPT),
        call('s1', 'PowerShell', { command: `Get-Content ${SPILL_PATH}` }),
        result('s1', RECOVERED),
        call('c1', 'PowerShell', { command: 'Get-Content notes.txt' }),
        result('c1', CONTROL),
      ],
    } as unknown as ProviderRequest,
    { spill }
  ).request as unknown as { messages: Msg[] };

  it("leaves an agent tool's result whole: it carries the harness's instructions", () => {
    expect(out.messages[2].content[0].content).toBe(RECEIPT);
  });

  it('leaves a re-read of a spill whole, so an elision can be recovered', () => {
    expect(out.messages[4].content[0].content).toBe(RECOVERED);
  });

  it('still compresses the same read of any other file, the positive control', () => {
    expect(out.messages[6].content[0].content).toContain('lower-signal');
  });
});
