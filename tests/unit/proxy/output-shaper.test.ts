/**
 * The output shaper may only ever reduce.
 *
 * A proxy that quietly increases spend while advertising a saving is worse than
 * one that does nothing, so most of these tests are about what the shaper
 * REFUSES to do: raise an effort level, invent a system prompt, rewrite a block
 * the client may have cached, or shape a turn that is a fresh instruction
 * rather than a resumption.
 */
import { describe, it, expect } from '@jest/globals';
import {
  shapeOutput,
  isResumption,
  inHoldout,
  shaperEnabled,
  holdoutFraction,
} from '../../../src/proxy/output-shaper.js';

const on = { wireFormat: 'messages' as const, enabled: true };

describe('the switch is off unless set', () => {
  it('reads only explicit on-values', () => {
    expect(shaperEnabled({})).toBe(false);
    expect(shaperEnabled({ TOKEN_OPTIMIZER_OUTPUT_SHAPER: '' })).toBe(false);
    expect(shaperEnabled({ TOKEN_OPTIMIZER_OUTPUT_SHAPER: 'maybe' })).toBe(false);
    expect(shaperEnabled({ TOKEN_OPTIMIZER_OUTPUT_SHAPER: '1' })).toBe(true);
    expect(shaperEnabled({ TOKEN_OPTIMIZER_OUTPUT_SHAPER: 'on' })).toBe(true);
  });

  it('forwards the body untouched when off', () => {
    const body = { system: 'You are a coding agent.', messages: [] };
    const out = shapeOutput(body, { wireFormat: 'messages', enabled: false });
    expect(out.body).toBe(body);
    expect(out.labels).toHaveLength(0);
  });
});

describe('verbosity steering goes at the END of the prompt', () => {
  it('appends to a string system prompt rather than prepending', () => {
    const body = { system: 'You are a coding agent.', messages: [] };
    const out = shapeOutput(body, on);
    const system = out.body.system as string;
    // THE WHOLE POINT: a provider cache keys on the prefix, so the original
    // text must still start the prompt byte for byte.
    expect(system.startsWith('You are a coding agent.')).toBe(true);
    expect(system.length).toBeGreaterThan('You are a coding agent.'.length);
    expect(out.labels).toContain('output_shaper:verbosity');
  });

  it('adds a new trailing block rather than editing an existing one', () => {
    const body = {
      system: [{ type: 'text', text: 'Cached preamble.', cache_control: { type: 'ephemeral' } }],
      messages: [],
    };
    const out = shapeOutput(body, on);
    const blocks = out.body.system as Record<string, unknown>[];
    expect(blocks).toHaveLength(2);
    // The client's cached block must be the same object content it sent.
    expect(blocks[0]).toEqual(body.system[0]);
  });

  it('does not invent a system prompt where there is none', () => {
    const body = { messages: [{ role: 'user', content: 'hi' }] };
    const out = shapeOutput(body, on);
    expect(out.body).toBe(body);
    expect(out.skipped).toBe('nothing to shape');
  });

  it('is idempotent, so a re-proxied request does not accumulate notes', () => {
    const once = shapeOutput({ system: 'Base.', messages: [] }, on);
    const twice = shapeOutput(once.body, on);
    expect(twice.body).toBe(once.body);
  });
});

describe('a resumption turn is distinguished from a fresh instruction', () => {
  const toolResult = { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] };

  it('recognises a turn carrying only tool results', () => {
    expect(isResumption({ messages: [toolResult] }, 'messages')).toBe(true);
  });

  it('does NOT treat a tool result plus a question as a resumption', () => {
    // The distinction that matters: the user said something, so this turn
    // deserves whatever effort the client asked for.
    const mixed = {
      role: 'user',
      content: [{ type: 'tool_result', content: 'ok' }, { type: 'text', text: 'now why?' }],
    };
    expect(isResumption({ messages: [mixed] }, 'messages')).toBe(false);
  });

  it('recognises the other two dialects', () => {
    expect(isResumption({ messages: [{ role: 'tool', content: 'ok' }] }, 'chat-completions')).toBe(true);
    expect(isResumption({ input: [{ type: 'function_call_output' }] }, 'responses')).toBe(true);
  });

  it('is false for an empty or absent conversation', () => {
    expect(isResumption({ messages: [] }, 'messages')).toBe(false);
    expect(isResumption({}, 'messages')).toBe(false);
  });
});

describe('effort routing clamps and never raises', () => {
  const resumption = { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] };

  it('lowers a large thinking budget on a resumption', () => {
    const body = { system: 'Base.', thinking: { type: 'enabled', budget_tokens: 16000 }, messages: [resumption] };
    const out = shapeOutput(body, on);
    expect((out.body.thinking as Record<string, unknown>).budget_tokens).toBe(1024);
    expect(out.labels).toContain('output_shaper:effort');
  });

  it('leaves an already-small budget alone', () => {
    const body = { system: 'Base.', thinking: { type: 'enabled', budget_tokens: 512 }, messages: [resumption] };
    const out = shapeOutput(body, on);
    expect((out.body.thinking as Record<string, unknown>).budget_tokens).toBe(512);
    expect(out.labels).not.toContain('output_shaper:effort');
  });

  it('does not add a thinking block the client omitted', () => {
    const body = { system: 'Base.', messages: [resumption] };
    const out = shapeOutput(body, on);
    expect(out.body.thinking).toBeUndefined();
  });

  it('never raises an openai effort level', () => {
    const low = { messages: [{ role: 'system', content: 'Base.' }, { role: 'tool', content: 'ok' }], reasoning_effort: 'minimal' };
    const out = shapeOutput(low, { wireFormat: 'chat-completions', enabled: true });
    expect(out.body.reasoning_effort).toBe('minimal');
    expect(out.labels).not.toContain('output_shaper:effort');
  });

  it('lowers a high openai effort level', () => {
    const high = { messages: [{ role: 'system', content: 'Base.' }, { role: 'tool', content: 'ok' }], reasoning_effort: 'high' };
    const out = shapeOutput(high, { wireFormat: 'chat-completions', enabled: true });
    expect(out.body.reasoning_effort).toBe('low');
    expect(out.labels).toContain('output_shaper:effort');
  });

  it('does not touch effort on a non-resumption turn', () => {
    const body = { system: 'Base.', thinking: { type: 'enabled', budget_tokens: 16000 }, messages: [{ role: 'user', content: 'a new question' }] };
    const out = shapeOutput(body, on);
    expect((out.body.thinking as Record<string, unknown>).budget_tokens).toBe(16000);
  });
});

describe('the holdout arm makes the saving measurable', () => {
  it('is empty at zero and total at one', () => {
    expect(inHoldout('conv-1', 0)).toBe(false);
    expect(inHoldout('conv-1', 1)).toBe(true);
  });

  it('keeps a conversation in the same arm across turns', () => {
    // A conversation that flipped arms mid-flight would pollute both.
    const first = inHoldout('conv-abc', 0.5);
    for (let i = 0; i < 5; i += 1) expect(inHoldout('conv-abc', 0.5)).toBe(first);
  });

  it('splits distinct conversations at roughly the requested rate', () => {
    const keys = Array.from({ length: 400 }, (_, i) => `conv-${i}`);
    const held = keys.filter((k) => inHoldout(k, 0.25)).length;
    // Loose bounds: this asserts the hash is not degenerate, not that it is
    // perfectly uniform at n=400.
    expect(held).toBeGreaterThan(60);
    expect(held).toBeLessThan(140);
  });

  it('shapes nothing for a held-out conversation, and says so', () => {
    const body = { system: 'Base.', messages: [] };
    const out = shapeOutput(body, { ...on, holdout: 1, conversationKey: 'c' });
    expect(out.body).toBe(body);
    expect(out.labels).toContain('output_shaper:holdout');
  });

  it('reads an invalid holdout as none', () => {
    expect(holdoutFraction({})).toBe(0);
    expect(holdoutFraction({ TOKEN_OPTIMIZER_OUTPUT_HOLDOUT: 'half' })).toBe(0);
    expect(holdoutFraction({ TOKEN_OPTIMIZER_OUTPUT_HOLDOUT: '-1' })).toBe(0);
    expect(holdoutFraction({ TOKEN_OPTIMIZER_OUTPUT_HOLDOUT: '0.1' })).toBeCloseTo(0.1);
  });
});
