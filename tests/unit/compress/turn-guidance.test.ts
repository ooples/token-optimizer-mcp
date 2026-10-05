/**
 * The guidance is off unless asked, and it is the same bytes every time.
 */
import { describe, expect, it } from '@jest/globals';
import {
  TURN_GUIDANCE_ENV,
  turnGuidance,
} from '../../../src/compress/turn-guidance.js';

describe('turn guidance', () => {
  it('is absent unless the operator asks', () => {
    // OFF BY DEFAULT: it is an instruction to the model, not a transformation
    // of bytes, and a prompt that changes how work is sequenced can change what
    // is concluded. No offline instrument can tell you whether it did.
    expect(turnGuidance({})).toBeNull();
    expect(turnGuidance({ [TURN_GUIDANCE_ENV]: '' })).toBeNull();
    expect(turnGuidance({ [TURN_GUIDANCE_ENV]: '0' })).toBeNull();
    expect(turnGuidance({ [TURN_GUIDANCE_ENV]: 'off' })).toBeNull();
    expect(turnGuidance({ [TURN_GUIDANCE_ENV]: 'false' })).toBeNull();
  });

  it('is present when it is', () => {
    const block = turnGuidance({ [TURN_GUIDANCE_ENV]: '1' });
    expect(block).not.toBeNull();
    expect(block).toContain('same turn');
  });

  it('is null and not an empty string when off', () => {
    // injectKnowledge treats a falsy block as "leave the request alone", and an
    // empty string would be injected as nothing and recorded as an injection.
    expect(turnGuidance({})).toBe(null);
  });

  it('is byte-identical across calls', () => {
    // It sits in the cached prefix for the life of the session. A block that
    // varied would invalidate that prefix on every turn and cost far more than
    // it could ever save.
    const a = turnGuidance({ [TURN_GUIDANCE_ENV]: 'on' });
    const b = turnGuidance({ [TURN_GUIDANCE_ENV]: 'yes' });
    expect(a).toBe(b);
  });

  it('stays short enough to be worth trying', () => {
    // Every character is charged W + R*N once and R on every turn after, so a
    // paragraph that does not change behaviour is a permanent tax.
    const block = turnGuidance({ [TURN_GUIDANCE_ENV]: '1' }) ?? '';
    expect(block.length).toBeLessThan(400);
  });
});
