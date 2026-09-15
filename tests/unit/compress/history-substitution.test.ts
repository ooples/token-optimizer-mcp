/**
 * Substituting history for a digest of what it did.
 *
 * THE PROPERTY THAT DECIDES WHETHER THIS PAYS is not the size of the saving.
 * It is that the transform is a pure function of each message alone, so a
 * message looks identical on the turn it arrives and on every later turn. A
 * prefix that changes is a full 1.25x cache write on everything kept, against
 * 0.1x to re-read it untouched -- and the probe this replaces broke exactly
 * that rule. It exempted the newest assistant turn, so every message was sent
 * whole once and rewritten once, which rewrote the prefix on EVERY request:
 * code-debug-pipeline-py took 71% fewer turns and still cost 10% more.
 *
 * So the first describe below is the load-bearing one. The rest guard the
 * shapes that turn a saving into a 400.
 */

import { substituteHistory } from '../../../src/compress/history.js';
import { STRATEGIES, v4Substitute } from '../../../src/compress/strategy.js';
import type { Message } from '../../../src/compress/frontier.js';

const thinking = (text: string, signature = 'sig-abc') => ({
  type: 'thinking',
  thinking: text,
  signature,
});

const toolUse = (name: string, input: Record<string, unknown>) => ({
  type: 'tool_use',
  id: `tu_${name}`,
  name,
  input,
});

/** One assistant turn that reasoned and then acted, as the wire carries it. */
const assistantTurn = (n: number): Message => ({
  role: 'assistant',
  content: [
    thinking(`Long private reasoning for turn ${n}. `.repeat(40)),
    toolUse('Edit', { file_path: `src/module${n}.ts` }),
  ],
});

const userTurn = (n: number): Message => ({
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: `tu_Edit`, content: `ok ${n}` }],
});

/** A conversation of `turns` assistant/user pairs. */
const conversation = (turns: number): Message[] => {
  const out: Message[] = [];
  for (let n = 1; n <= turns; n += 1) {
    out.push(assistantTurn(n), userTurn(n));
  }
  return out;
};

describe('the transform is a pure function of each message, so the prefix never moves', () => {
  test('a message renders identically however long the conversation gets', () => {
    // THE CACHE ARGUMENT, ASSERTED. Turn 3's copy of message 0 must be byte for
    // byte turn 9's copy of message 0. If it is not, the provider's cached
    // prefix stops matching and every later turn pays a full write for content
    // it already had.
    const short = substituteHistory(conversation(3)).messages;
    const long = substituteHistory(conversation(9)).messages;

    for (let i = 0; i < short.length; i += 1) {
      expect(JSON.stringify(long[i])).toBe(JSON.stringify(short[i]));
    }
  });

  test('the newest assistant turn is substituted like any other', () => {
    // The specific defect being ruled out. Exempting the newest turn is what
    // put a moving boundary in the prefix; an exemption would show up here as
    // the last assistant message still carrying its thinking.
    const out = substituteHistory(conversation(4)).messages;
    const assistants = out.filter((m) => m.role === 'assistant');
    const last = assistants[assistants.length - 1];

    expect(Array.isArray(last.content)).toBe(true);
    expect(
      (last.content as { type?: string }[]).some((b) => b.type === 'thinking')
    ).toBe(false);
  });

  test('a longer conversation extends the result, never rewrites it', () => {
    // Stated as the growth property directly: the shorter result is a strict
    // prefix of the longer one. This is what "append-only" means on the wire.
    const short = substituteHistory(conversation(5)).messages;
    const long = substituteHistory(conversation(8)).messages;

    expect(long.length).toBeGreaterThan(short.length);
    expect(JSON.stringify(long.slice(0, short.length))).toBe(
      JSON.stringify(short)
    );
  });
});

describe('structure is preserved, which is what removal could not promise', () => {
  test('message count is unchanged', () => {
    const input = conversation(6);
    expect(substituteHistory(input).messages).toHaveLength(input.length);
  });

  test('a message whose ONLY content was reasoning is never emptied', () => {
    // An empty content array is a 400, so the invariant is that SOMETHING
    // remains -- asserted on the count and on the absence of reasoning, not on
    // which block stands in, because that is the digest's business next door.
    const input: Message[] = [
      { role: 'assistant', content: [thinking('reasoned, did nothing')] },
    ];
    const out = substituteHistory(input).messages;

    expect(out).toHaveLength(1);
    expect((out[0].content as unknown[]).length).toBeGreaterThan(0);
    expect(
      (out[0].content as { type?: string }[]).some(
        (b) => b.type === 'thinking' || b.type === 'redacted_thinking'
      )
    ).toBe(false);
  });

  test('user messages and their tool results are untouched', () => {
    // Tool results are a separate concern with a separate risk profile. Mixing
    // them in would make any regression unattributable to either.
    const input = conversation(3);
    const out = substituteHistory(input).messages;

    for (let i = 0; i < input.length; i += 1) {
      if (input[i].role !== 'user') continue;
      expect(JSON.stringify(out[i])).toBe(JSON.stringify(input[i]));
    }
  });

  test('the input messages are not mutated', () => {
    const input = conversation(3);
    const before = JSON.stringify(input);
    substituteHistory(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe('the digest says nothing the message already says', () => {
  test('no digest at all when the tool calls survive', () => {
    // MEASURED, NOT ASSUMED. The first version wrote a digest naming the tools
    // this message called -- while the tool_use blocks naming them stayed put.
    // On two real sessions 312 of 312 and 99 of 100 reasoning-bearing messages
    // also carried tool_use, so the digest was pure duplicate cost, and it is
    // why the arm lost to plain removal at every conversation length.
    const out = substituteHistory([
      {
        role: 'assistant',
        content: [
          thinking('...'),
          toolUse('Edit', { file_path: 'src/cache.ts' }),
        ],
      },
    ]).messages;

    const blocks = out[0].content as { type?: string }[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('tool_use');
  });

  test('no digest when the model own text survives', () => {
    // The text block is the model's own conclusion, which is strictly better
    // evidence than anything this module could synthesise.
    const out = substituteHistory([
      {
        role: 'assistant',
        content: [thinking('...'), { type: 'text', text: 'The bug is in parse().' }],
      },
    ]).messages;

    const blocks = out[0].content as { type?: string; text?: string }[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe('The bug is in parse().');
  });

  test('a digest ONLY when the message would otherwise be empty', () => {
    // The one case it earns its bytes: an empty content array is a 400, so the
    // turn cannot simply vanish. Rare -- zero occurrences in 412 real messages
    // -- but it is a correctness guard, not an optimisation.
    const out = substituteHistory([
      { role: 'assistant', content: [thinking('reasoned, acted on nothing')] },
    ]).messages;

    const blocks = out[0].content as { type?: string; text?: string }[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('text');
    expect(blocks[0].text).toMatch(/elided/i);
  });

  test('the fallback digest is marked as elided, not passed off as the model words', () => {
    // A digest presented as original text would be a false memory the model
    // cannot distinguish from something it actually wrote.
    const out = substituteHistory([
      { role: 'assistant', content: [thinking('x')] },
    ]).messages;
    expect((out[0].content as { text?: string }[])[0].text).toBe('[reasoning elided]');
  });

  test('two reasoning blocks in one message still leave one block, not two', () => {
    const out = substituteHistory([
      { role: 'assistant', content: [thinking('first'), thinking('second')] },
    ]).messages;

    const blocks = out[0].content as { type?: string }[];
    expect(blocks).toHaveLength(1);
    expect(blocks.filter((b) => b.type === 'thinking')).toHaveLength(0);
  });
});

describe('the accounting says what it removed AND what it added', () => {
  test('removal is reported, and nothing is added when nothing needed adding', () => {
    // The common shape: every message keeps a tool_use, so no digest is written
    // and the substitute cost is genuinely zero. An accounting that reported a
    // cost here would be inventing one.
    const result = substituteHistory(conversation(4));
    expect(result.removedChars).toBeGreaterThan(0);
    expect(result.substituteChars).toBe(0);
    expect(result.substituted).toBe(4);
  });

  test('a digest that IS written is charged', () => {
    // The rare shape, where the guard fires. It costs bytes and must say so.
    const result = substituteHistory([
      { role: 'assistant', content: [thinking('no trace left')] },
    ]);
    expect(result.substituteChars).toBeGreaterThan(0);
  });

  test('the digest is far smaller than what it replaced', () => {
    // Not an assertion about a target ratio -- an assertion that the transform
    // is a reduction at all, which a digest naming many tools need not be.
    const result = substituteHistory(conversation(4));
    expect(result.substituteChars).toBeLessThan(result.removedChars / 10);
  });

  test('a conversation with no reasoning is left completely alone', () => {
    const plain: Message[] = [
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ];
    const result = substituteHistory(plain);
    expect(result.substituted).toBe(0);
    expect(result.removedChars).toBe(0);
    expect(JSON.stringify(result.messages)).toBe(JSON.stringify(plain));
  });

  test('undefined messages do not throw', () => {
    expect(substituteHistory(undefined).messages).toEqual([]);
  });
});

describe('the strategy composes with v1 rather than replacing it', () => {
  test('it is registered', () => {
    expect(STRATEGIES['v4-substitute']).toBe(v4Substitute);
  });

  test('it preserves message count on a request that actually has reasoning', () => {
    // The shared "every strategy" test uses a fixture with no thinking blocks,
    // so it passes vacuously for this arm. This is the same invariant asserted
    // against input the arm actually transforms.
    const req = { messages: conversation(5) };
    const out = v4Substitute(req, {});
    expect(out.request.messages).toHaveLength(10);
  });

  test('it leaves the caller original request untouched', () => {
    const req = { messages: conversation(3) };
    const before = JSON.stringify(req);
    v4Substitute(req, {});
    expect(JSON.stringify(req)).toBe(before);
  });

  test('a digest it added is counted in injectedChars', () => {
    // A strategy that reports only what it removed can show a saving while
    // having made the request larger. Exercised on the shape that actually
    // writes a digest -- on the common shape the honest answer is zero, which
    // an assertion of "greater than zero" would have forced the code to fake.
    const out = v4Substitute(
      { messages: [{ role: 'assistant', content: [thinking('no trace')] }] },
      {}
    );
    expect(out.injectedChars).toBeGreaterThan(0);
  });

  test('and nothing is claimed as injected when no digest was written', () => {
    const out = v4Substitute({ messages: conversation(4) }, {});
    expect(out.injectedChars).toBe(0);
  });

  test('a request with no reasoning still gets v1 compression', () => {
    // Substitution finding nothing must not short-circuit the arm into a no-op;
    // the fresh tail and tool definitions are still V1's job.
    const req = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      ] as Message[],
    };
    const out = v4Substitute(req, {});
    expect(Array.isArray(out.request.messages)).toBe(true);
    expect(out.request.messages).toHaveLength(1);
  });
});

describe('tool results are the other region, and only with a pure compressor', () => {
  const big = (n: number) => 'row data here\n'.repeat(n);

  test('untouched when no compressor is supplied', () => {
    // The default must stay conservative: this module cannot verify that a
    // compressor is pure, so it does nothing unless the caller provides one.
    const input: Message[] = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: big(50) }] },
    ];
    const result = substituteHistory(input);
    expect(result.toolResultChars).toBe(0);
    expect(JSON.stringify(result.messages)).toBe(JSON.stringify(input));
  });

  test('compressed in place when one is', () => {
    const input: Message[] = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: big(50) }] },
    ];
    const result = substituteHistory(input, {
      compressToolResult: (text) => text.slice(0, 20),
    });
    expect(result.toolResultChars).toBeGreaterThan(0);
    expect((result.messages[0].content as { content?: string }[])[0].content).toHaveLength(20);
  });

  test('message count and role are preserved', () => {
    const input: Message[] = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: big(50) }] },
    ];
    const out = substituteHistory(input, { compressToolResult: (t) => t.slice(0, 5) }).messages;
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('user');
  });

  test('a compressor that changes nothing leaves the message identical', () => {
    // Not merely "equal": the same object, so an unchanged message keeps its
    // identity for the replay's serialisation memo and for the cache.
    const input: Message[] = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'short' }] },
    ];
    const out = substituteHistory(input, { compressToolResult: (t) => t }).messages;
    expect(out[0]).toBe(input[0]);
  });

  test('non-string tool_result bodies are left alone', () => {
    // A tool_result may carry an array of blocks. Compressing that shape is a
    // different problem and guessing at it is how a 400 gets shipped.
    const input: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: big(20) }] },
        ],
      },
    ];
    const result = substituteHistory(input, { compressToolResult: (t) => t.slice(0, 3) });
    expect(result.toolResultChars).toBe(0);
    expect(result.messages[0]).toBe(input[0]);
  });

  test('the compressor still runs on every turn identically', () => {
    // The append-only property again, now for the tool-result half.
    const opts = { compressToolResult: (t: string) => t.slice(0, 30) };
    const short = substituteHistory(conversation(4), opts).messages;
    const long = substituteHistory(conversation(9), opts).messages;
    expect(JSON.stringify(long.slice(0, short.length))).toBe(JSON.stringify(short));
  });
});
