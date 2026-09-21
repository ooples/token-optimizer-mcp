/**
 * The Responses dialect is not the Messages dialect, and conflating them made
 * shaping a no-op there.
 *
 * Review on #411 caught this, and the existing 27 tests all still passed after
 * the fix — which is the tell that the broken path was never covered. Responses
 * carries its system text in `instructions` as a plain string and nests effort
 * under `reasoning.effort`; the original branch reached for `system` and a flat
 * `reasoning_effort`, so it found neither and returned unchanged every time.
 *
 * The field names are taken from this repo's own handler rather than from the
 * review: `src/proxy/responses-knowledge.ts` both reads and appends to
 * `request.instructions`, and branches on `request.previous_response_id`.
 */
import { describe, it, expect } from '@jest/globals';
import { shapeOutput, inHoldout } from '../../../src/proxy/output-shaper.js';

const on = { wireFormat: 'responses' as const, enabled: true };
const resumption = { type: 'function_call_output', call_id: 'c1', output: 'ok' };

describe('verbosity steering uses instructions, not system', () => {
  it('appends to the end of instructions', () => {
    const body = { instructions: 'You are a coding agent.', input: [] };
    const out = shapeOutput(body, on);
    const text = out.body.instructions as string;
    expect(text.startsWith('You are a coding agent.')).toBe(true);
    expect(text.length).toBeGreaterThan('You are a coding agent.'.length);
    expect(out.labels).toContain('output_shaper:verbosity');
  });

  it('does not touch a system field on this dialect', () => {
    // A Responses request has no `system`; inventing one would be a field the
    // client never sent.
    const body = { instructions: 'Base.', input: [] };
    const out = shapeOutput(body, on);
    expect(out.body.system).toBeUndefined();
  });

  it('leaves a request with no instructions alone', () => {
    const body = { input: [{ type: 'message', role: 'user', content: 'hi' }] };
    expect(shapeOutput(body, on).body).toBe(body);
  });

  it('is idempotent', () => {
    const once = shapeOutput({ instructions: 'Base.', input: [] }, on);
    expect(shapeOutput(once.body, on).body).toBe(once.body);
  });
});

describe('effort routing uses the nested reasoning object', () => {
  it('clamps reasoning.effort on a resumption and keeps the rest of the object', () => {
    const body = {
      instructions: 'Base.',
      // `summary` must survive: the rest of the reasoning object can carry
      // settings, and on a continuation encrypted reasoning this proxy is
      // careful never to disturb.
      reasoning: { effort: 'high', summary: 'auto' },
      input: [resumption],
    };
    const out = shapeOutput(body, on);
    expect(out.body.reasoning).toEqual({ effort: 'low', summary: 'auto' });
    expect(out.labels).toContain('output_shaper:effort');
  });

  it('never raises an already-low effort', () => {
    const body = { instructions: 'Base.', reasoning: { effort: 'minimal' }, input: [resumption] };
    const out = shapeOutput(body, on);
    expect((out.body.reasoning as Record<string, unknown>).effort).toBe('minimal');
  });

  it('does not add a reasoning object the client omitted', () => {
    const body = { instructions: 'Base.', input: [resumption] };
    expect(shapeOutput(body, on).body.reasoning).toBeUndefined();
  });

  it('does not clamp when the turn is not a resumption', () => {
    const body = {
      instructions: 'Base.',
      reasoning: { effort: 'high' },
      input: [{ type: 'message', role: 'user', content: 'why?' }],
    };
    const out = shapeOutput(body, on);
    expect((out.body.reasoning as Record<string, unknown>).effort).toBe('high');
  });

  it('ignores a flat reasoning_effort on this dialect', () => {
    // Sending the Chat Completions field on a Responses request is a client
    // error; shaping it would be guessing at what the provider does with it.
    const body = { instructions: 'Base.', reasoning_effort: 'high', input: [resumption] };
    expect(shapeOutput(body, on).body.reasoning_effort).toBe('high');
  });
});

describe('a continuation still lands in a holdout arm', () => {
  it('keys on an identifier the client sent rather than on absent content', () => {
    // The bug: a continuation carrying only function_call_output has no system
    // text and no user item, so the content hash was undefined and every such
    // turn was treated as shaped — emptying the control arm of exactly the
    // resumption turns effort routing acts on.
    // At a PARTIAL fraction, which is the real configuration: a key the
    // client supplied is assigned deterministically, and an absent key
    // cannot be assigned at all so it never joins the control arm.
    const first = inHoldout('resp_abc123', 0.5);
    expect(inHoldout('resp_abc123', 0.5)).toBe(first);
    expect(inHoldout(undefined, 0.5)).toBe(false);
    // A fraction of 1 means hold everything out, and it says so before it
    // looks at the key -- asserting otherwise was my error, not the code's.
    expect(inHoldout(undefined, 1)).toBe(true);
  });
});
