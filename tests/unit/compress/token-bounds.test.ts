import { describe, it, expect } from '@jest/globals';
import { get_encoding } from 'tiktoken';
import {
  O200K_MAX_TOKEN_BYTES,
  O200K_UNIFORM_ASCII_MAX_BYTES,
  provesTokenBenefit,
} from '../../../src/proxy/token-bounds.js';

describe('token bounds, not byte-only savings', () => {
  it('bounds every ordinary token in the actual installed vocabulary', () => {
    const encoder = get_encoding('o200k_base');
    try {
      const maxima = new Map<number, number>();
      let maximum = 0;
      let minimum = Infinity;
      for (const bytes of encoder.token_byte_values()) {
        maximum = Math.max(maximum, bytes.length);
        minimum = Math.min(minimum, bytes.length);
        if (
          O200K_UNIFORM_ASCII_MAX_BYTES.has(bytes[0]) &&
          bytes.every((byte) => byte === bytes[0])
        ) {
          maxima.set(
            bytes[0],
            Math.max(maxima.get(bytes[0]) ?? 0, bytes.length)
          );
        }
      }
      expect(maximum).toBeLessThanOrEqual(O200K_MAX_TOKEN_BYTES);
      expect(minimum).toBeGreaterThan(0);
      for (const [byte, maximum] of O200K_UNIFORM_ASCII_MAX_BYTES)
        expect(maxima.get(byte)).toBeLessThanOrEqual(maximum);
    } finally {
      encoder.free();
    }
  });

  it('proves strong reductions but refuses a shorter token-inflating candidate', () => {
    const encoder = get_encoding('o200k_base');
    try {
      const after = 'Summary';
      for (const byte of O200K_UNIFORM_ASCII_MAX_BYTES.keys()) {
        const before = String.fromCharCode(byte).repeat(8192);
        expect(
          provesTokenBenefit(
            before,
            Buffer.byteLength(before),
            Buffer.byteLength(after)
          )
        ).toBe(true);
        const a = encoder.encode(before, [], []).length;
        const b = encoder.encode(after, [], []).length;
        expect(b).toBeLessThanOrEqual(a * 0.9);
        expect(a - b).toBeGreaterThanOrEqual(8);
      }
      expect(provesTokenBenefit('a'.repeat(8192), 8192, 2999)).toBe(false);
    } finally {
      encoder.free();
    }
  });
});
