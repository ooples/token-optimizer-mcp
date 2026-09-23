/**
 * The shaper must be REACHABLE through the shipped entry point.
 *
 * A unit test on output-shaper.ts proves the module works; it proves nothing
 * about whether anything calls it. This package's recurring defect is exactly
 * that gap — a capability that is registered, tested and green while the
 * production call site never names it — so these tests go through
 * `compressBody`, which is what the proxy actually invokes, and assert on the
 * bytes it returns for forwarding.
 */
import { describe, it, expect, afterEach } from '@jest/globals';
import { compressBody } from '../../../src/proxy/server.js';

const PRIOR = {
  shaper: process.env.TOKEN_OPTIMIZER_OUTPUT_SHAPER,
  holdout: process.env.TOKEN_OPTIMIZER_OUTPUT_HOLDOUT,
};

afterEach(() => {
  // Process-wide, and jest shares a worker between files.
  if (PRIOR.shaper === undefined) delete process.env.TOKEN_OPTIMIZER_OUTPUT_SHAPER;
  else process.env.TOKEN_OPTIMIZER_OUTPUT_SHAPER = PRIOR.shaper;
  if (PRIOR.holdout === undefined) delete process.env.TOKEN_OPTIMIZER_OUTPUT_HOLDOUT;
  else process.env.TOKEN_OPTIMIZER_OUTPUT_HOLDOUT = PRIOR.holdout;
});

/** A request big enough to clear the proxy's size floor. */
function request(extra: Record<string, unknown> = {}) {
  const filler = 'x'.repeat(40_000);
  return {
    model: 'claude-sonnet-4',
    system: 'You are a coding agent.',
    messages: [
      { role: 'user', content: [{ type: 'tool_result', content: filler }] },
    ],
    ...extra,
  };
}

const forward = (payload: Record<string, unknown>) =>
  JSON.parse(compressBody(Buffer.from(JSON.stringify(payload), 'utf8')).body.toString('utf8')) as Record<
    string,
    unknown
  >;

describe('the shaper is reachable through compressBody', () => {
  it('does nothing when the switch is unset', () => {
    delete process.env.TOKEN_OPTIMIZER_OUTPUT_SHAPER;
    const out = forward(request());
    expect(out.system).toBe('You are a coding agent.');
  });

  it('appends the note at the END of the system prompt when enabled', () => {
    process.env.TOKEN_OPTIMIZER_OUTPUT_SHAPER = '1';
    const out = forward(request());
    const system = out.system as string;
    // THE CACHE-SAFETY PROPERTY, asserted on the forwarded bytes rather than on
    // the module's return value: the client's prefix must be untouched.
    expect(system.startsWith('You are a coding agent.')).toBe(true);
    expect(system.length).toBeGreaterThan('You are a coding agent.'.length);
  });

  it('clamps the thinking budget on a resumption turn', () => {
    process.env.TOKEN_OPTIMIZER_OUTPUT_SHAPER = '1';
    const out = forward(request({ thinking: { type: 'enabled', budget_tokens: 16_000 } }));
    expect((out.thinking as Record<string, unknown>).budget_tokens).toBe(1024);
  });

  it('leaves the budget alone on a turn that carries a real question', () => {
    process.env.TOKEN_OPTIMIZER_OUTPUT_SHAPER = '1';
    const payload = request({ thinking: { type: 'enabled', budget_tokens: 16_000 } });
    payload.messages = [{ role: 'user', content: 'why did that fail? '.repeat(3000) }];
    const out = forward(payload);
    expect((out.thinking as Record<string, unknown>).budget_tokens).toBe(16_000);
  });

  it('forwards unshaped for a held-out conversation', () => {
    process.env.TOKEN_OPTIMIZER_OUTPUT_SHAPER = '1';
    process.env.TOKEN_OPTIMIZER_OUTPUT_HOLDOUT = '1';
    const out = forward(request());
    expect(out.system).toBe('You are a coding agent.');
  });

  it('emits valid json that still carries the conversation', () => {
    // A re-serialisation bug would show up as a dropped field rather than as a
    // parse error, so the shape is asserted too.
    process.env.TOKEN_OPTIMIZER_OUTPUT_SHAPER = '1';
    const out = forward(request());
    expect(out.model).toBe('claude-sonnet-4');
    expect(Array.isArray(out.messages)).toBe(true);
    expect((out.messages as unknown[]).length).toBe(1);
  });
});
