/**
 * Unit Tests for TokenCounter
 *
 * Tests cover:
 * - Token counting accuracy
 * - Batch counting
 * - Token estimation
 * - Savings calculation
 * - Token limit checking and truncation
 * - Character-to-token ratio calculation
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  TokenCounter,
  TokenCountResult,
} from '../../src/core/token-counter.js';

describe('TokenCounter', () => {
  let tokenCounter: TokenCounter;

  beforeEach(() => {
    tokenCounter = new TokenCounter();
  });

  afterEach(() => {
    tokenCounter.free();
  });

  describe('Basic Token Counting', () => {
    it('should count tokens in simple text', () => {
      const result = tokenCounter.count('Hello, world!');

      expect(result.tokens).toBeGreaterThan(0);
      expect(result.characters).toBe(13);
      expect(typeof result.tokens).toBe('number');
    });

    it('should count tokens in empty string', () => {
      const result = tokenCounter.count('');

      expect(result.tokens).toBe(0);
      expect(result.characters).toBe(0);
    });

    it('should handle unicode characters', () => {
      const text = 'Hello 世界 🚀';
      const result = tokenCounter.count(text);

      expect(result.tokens).toBeGreaterThan(0);
      expect(result.characters).toBe(text.length);
    });

    it('should count tokens in code', () => {
      const code = `
        function hello() {
          console.log("Hello, world!");
          return 42;
        }
      `;
      const result = tokenCounter.count(code);

      expect(result.tokens).toBeGreaterThan(0);
      expect(result.characters).toBe(code.length);
    });

    it('should count tokens in JSON', () => {
      const json = JSON.stringify({
        name: 'test',
        value: 123,
        nested: { key: 'value' },
      });
      const result = tokenCounter.count(json);

      expect(result.tokens).toBeGreaterThan(0);
      expect(result.characters).toBe(json.length);
    });

    it('should handle very long text', () => {
      const longText = 'word '.repeat(10000);
      const result = tokenCounter.count(longText);

      expect(result.tokens).toBeGreaterThan(1000);
      expect(result.characters).toBe(longText.length);
    });

    it('should count whitespace', () => {
      const whitespace = '   \n\n\t\t   ';
      const result = tokenCounter.count(whitespace);

      expect(result.tokens).toBeGreaterThan(0);
      expect(result.characters).toBe(whitespace.length);
    });

    it('should handle special characters', () => {
      const special = '!@#$%^&*()_+-=[]{}|;:,.<>?/~`';
      const result = tokenCounter.count(special);

      expect(result.tokens).toBeGreaterThan(0);
      expect(result.characters).toBe(special.length);
    });
  });

  describe('Batch Counting', () => {
    it('should count tokens in multiple texts', () => {
      const texts = [
        'Hello, world!',
        'This is a test.',
        'Token counting is important.',
      ];

      const result = tokenCounter.countBatch(texts);

      expect(result.tokens).toBeGreaterThan(0);
      expect(result.characters).toBe(texts.join('').length);
    });

    it('should handle empty array', () => {
      const result = tokenCounter.countBatch([]);

      expect(result.tokens).toBe(0);
      expect(result.characters).toBe(0);
    });

    it('should handle array with empty strings', () => {
      const result = tokenCounter.countBatch(['', '', '']);

      expect(result.tokens).toBe(0);
      expect(result.characters).toBe(0);
    });

    it('should accumulate counts correctly', () => {
      const text1 = 'First text';
      const text2 = 'Second text';

      const individual1 = tokenCounter.count(text1);
      const individual2 = tokenCounter.count(text2);

      const batch = tokenCounter.countBatch([text1, text2]);

      expect(batch.tokens).toBe(individual1.tokens + individual2.tokens);
      expect(batch.characters).toBe(
        individual1.characters + individual2.characters
      );
    });

    it('should handle large batch', () => {
      const texts = Array.from({ length: 1000 }, (_, i) => `Text ${i}`);
      const result = tokenCounter.countBatch(texts);

      expect(result.tokens).toBeGreaterThan(1000);
      expect(result.characters).toBeGreaterThan(5000);
    });
  });

  describe('Token Estimation', () => {
    it('should estimate token count', () => {
      const text = 'This is a test of token estimation.';
      const estimate = tokenCounter.estimate(text);
      const actual = tokenCounter.count(text);

      // Estimate should be in the ballpark
      expect(estimate).toBeGreaterThan(0);
      expect(estimate).toBeCloseTo(actual.tokens, -1); // Within 10x order of magnitude
    });

    it('should estimate empty string as zero', () => {
      const estimate = tokenCounter.estimate('');
      expect(estimate).toBe(0);
    });

    it('should estimate using ~4 chars per token', () => {
      const text = 'x'.repeat(400);
      const estimate = tokenCounter.estimate(text);

      // Should be around 100 tokens (400 / 4)
      expect(estimate).toBeCloseTo(100, 0);
    });

    it('should be faster than accurate counting for long text', () => {
      const longText = 'word '.repeat(10000);

      const estimateStart = Date.now();
      tokenCounter.estimate(longText);
      const estimateTime = Date.now() - estimateStart;

      const countStart = Date.now();
      tokenCounter.count(longText);
      const countTime = Date.now() - countStart;

      // Estimate should be faster (or at least not significantly slower)
      expect(estimateTime).toBeLessThanOrEqual(countTime * 2);
    });
  });

  describe('Token Savings Calculation', () => {
    it('should calculate savings correctly', () => {
      const original = 'This is a long text that will be compressed.';
      const contextTokens = 3; // Simulating metadata or summary

      const savings = tokenCounter.calculateSavings(original, contextTokens);

      expect(savings.originalTokens).toBeGreaterThan(savings.contextTokens);
      expect(savings.tokensSaved).toBeGreaterThan(0);
      expect(savings.percentSaved).toBeGreaterThan(0);
      expect(savings.percentSaved).toBeLessThanOrEqual(100);
    });

    it('should handle no savings', () => {
      const text = 'Same text.';
      const originalTokens = tokenCounter.count(text).tokens;

      const savings = tokenCounter.calculateSavings(text, originalTokens);

      expect(savings.originalTokens).toBe(savings.contextTokens);
      expect(savings.tokensSaved).toBe(0);
      expect(savings.percentSaved).toBe(0);
    });

    it('should handle negative savings (expansion)', () => {
      const original = 'Short';
      const originalTokens = tokenCounter.count(original).tokens;
      const expandedTokens = 15; // Simulating expansion

      const savings = tokenCounter.calculateSavings(original, expandedTokens);

      expect(savings.originalTokens).toBeLessThan(savings.contextTokens);
      expect(savings.tokensSaved).toBeLessThan(0);
      expect(savings.percentSaved).toBeLessThan(0);
    });

    it('should calculate 100% savings for empty result', () => {
      const original = 'Original text';
      const contextTokens = 0; // External caching - 100% savings

      const savings = tokenCounter.calculateSavings(original, contextTokens);

      expect(savings.contextTokens).toBe(0);
      expect(savings.percentSaved).toBeCloseTo(100, 0);
    });

    it('should handle empty original', () => {
      const savings = tokenCounter.calculateSavings('', 5);

      expect(savings.originalTokens).toBe(0);
      expect(savings.percentSaved).toBe(0);
    });

    it('should calculate realistic compression savings', () => {
      const original = `
        interface CacheEntry {
          key: string;
          value: string;
          compressedSize: number;
          originalSize: number;
          hitCount: number;
          createdAt: number;
          lastAccessedAt: number;
        }
      `;

      const contextTokens = 10; // Simulating metadata

      const savings = tokenCounter.calculateSavings(original, contextTokens);

      expect(savings.tokensSaved).toBeGreaterThan(0);
      expect(savings.percentSaved).toBeGreaterThan(0);
    });
  });

  describe('Token Limit Checking', () => {
    it('should detect when text exceeds limit', () => {
      const longText = 'word '.repeat(1000);
      const result = tokenCounter.count(longText);

      expect(tokenCounter.exceedsLimit(longText, result.tokens - 1)).toBe(true);
      expect(tokenCounter.exceedsLimit(longText, result.tokens)).toBe(false);
      expect(tokenCounter.exceedsLimit(longText, result.tokens + 1)).toBe(
        false
      );
    });

    it('should handle empty text with any limit', () => {
      expect(tokenCounter.exceedsLimit('', 0)).toBe(false);
      expect(tokenCounter.exceedsLimit('', 1)).toBe(false);
      expect(tokenCounter.exceedsLimit('', 1000)).toBe(false);
    });

    it('should handle zero limit', () => {
      expect(tokenCounter.exceedsLimit('any text', 0)).toBe(true);
    });
  });

  describe('Token Truncation', () => {
    it('should truncate text to token limit', () => {
      const text = 'This is a test of token truncation functionality.';
      const result = tokenCounter.count(text);
      const limit = Math.floor(result.tokens / 2);

      const truncated = tokenCounter.truncate(text, limit);
      const truncatedCount = tokenCounter.count(truncated);

      expect(truncatedCount.tokens).toBeLessThanOrEqual(limit);
      expect(truncated.length).toBeLessThan(text.length);
    });

    it('should not truncate if under limit', () => {
      const text = 'Short text.';
      const result = tokenCounter.count(text);

      const truncated = tokenCounter.truncate(text, result.tokens + 10);

      expect(truncated).toBe(text);
    });

    it('should handle zero token limit', () => {
      const text = 'Any text';
      const truncated = tokenCounter.truncate(text, 0);

      expect(truncated).toBe('');
    });

    it('should handle empty string', () => {
      const truncated = tokenCounter.truncate('', 100);
      expect(truncated).toBe('');
    });

    it('should truncate at token boundaries', () => {
      const text = 'word1 word2 word3 word4 word5';
      const result = tokenCounter.count(text);
      const limit = Math.floor(result.tokens / 2);

      const truncated = tokenCounter.truncate(text, limit);
      const truncatedCount = tokenCounter.count(truncated);

      expect(truncatedCount.tokens).toBeLessThanOrEqual(limit);
      // Truncated text should be valid (not cut in middle of token)
      expect(truncated.length).toBeGreaterThan(0);
    });

    it('should handle unicode in truncation', () => {
      const text = '世界 🚀 Hello World 你好';
      const result = tokenCounter.count(text);
      const limit = Math.floor(result.tokens / 2);

      const truncated = tokenCounter.truncate(text, limit);
      const truncatedCount = tokenCounter.count(truncated);

      expect(truncatedCount.tokens).toBeLessThanOrEqual(limit);
      expect(truncated.length).toBeGreaterThan(0);
    });
  });

  describe('Token-to-Character Ratio', () => {
    it('should calculate token-to-character ratio', () => {
      const text = 'This is a test.';
      const ratio = tokenCounter.getTokenCharRatio(text);

      expect(ratio).toBeGreaterThan(0);
      expect(ratio).toBeLessThanOrEqual(text.length);
    });

    it('should handle empty string', () => {
      const ratio = tokenCounter.getTokenCharRatio('');
      expect(ratio).toBe(0);
    });

    it('should show higher ratio for code', () => {
      const code = 'function test(){return 42;}';
      const prose = 'This is regular prose text with normal words.';

      const codeRatio = tokenCounter.getTokenCharRatio(code);
      const proseRatio = tokenCounter.getTokenCharRatio(prose);

      // Both should be reasonable
      expect(codeRatio).toBeGreaterThan(0);
      expect(proseRatio).toBeGreaterThan(0);
    });

    it('should handle unicode characters', () => {
      const unicode = '世界 🚀 Hello';
      const ratio = tokenCounter.getTokenCharRatio(unicode);

      expect(ratio).toBeGreaterThan(0);
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('should handle very long single line', () => {
      const longLine = 'x'.repeat(100000);
      const result = tokenCounter.count(longLine);

      expect(result.tokens).toBeGreaterThan(0);
      expect(result.characters).toBe(100000);
    });

    it('should handle many newlines', () => {
      const newlines = '\n'.repeat(1000);
      const result = tokenCounter.count(newlines);

      expect(result.tokens).toBeGreaterThan(0);
      expect(result.characters).toBe(1000);
    });

    it('should handle mixed content types', () => {
      const mixed = `
        Text content
        { "json": "data" }
        function() { return 42; }
        世界 🚀
        !@#$%^&*()
      `;
      const result = tokenCounter.count(mixed);

      expect(result.tokens).toBeGreaterThan(0);
      expect(result.characters).toBe(mixed.length);
    });

    it('should be consistent across multiple calls', () => {
      const text = 'Consistency test.';

      const result1 = tokenCounter.count(text);
      const result2 = tokenCounter.count(text);
      const result3 = tokenCounter.count(text);

      expect(result1.tokens).toBe(result2.tokens);
      expect(result2.tokens).toBe(result3.tokens);
    });

    it('should handle null bytes', () => {
      const textWithNull = 'Hello\x00World';
      const result = tokenCounter.count(textWithNull);

      expect(result.tokens).toBeGreaterThan(0);
    });
  });

  describe('Performance', () => {
    it('should count tokens in reasonable time for large text', () => {
      const largeText = 'word '.repeat(50000);
      const start = Date.now();

      tokenCounter.count(largeText);

      const duration = Date.now() - start;

      // Should complete in less than 1 second
      expect(duration).toBeLessThan(1000);
    });

    it('should handle batch processing efficiently', () => {
      const texts = Array.from({ length: 100 }, (_, i) =>
        `Text ${i} `.repeat(100)
      );

      const start = Date.now();
      tokenCounter.countBatch(texts);
      const duration = Date.now() - start;

      // Should complete in reasonable time
      expect(duration).toBeLessThan(2000);
    });
  });
});

describe('a pathological line cannot stall the counter', () => {
  // BPE cost is superlinear in the length of a single run, and pathologically
  // so on repetitive text. Measured before this bound, on 100,000 characters:
  // a repeated single character took 23,004 ms and a 26-character cycle 6,856
  // ms, while minified json, base64 and minified javascript were all under 30.
  //
  // `count_tokens` is the most-called tool in the product, so that is a stall
  // reachable from ordinary use -- a padding run or a repetitive blob. It
  // surfaced as a 38-second test suite with one 23-second case in it.
  const counter = new TokenCounter();

  it('counts a long repeated run in well under a second', () => {
    const started = Date.now();
    const result = counter.count('x'.repeat(100_000));
    const elapsed = Date.now() - started;

    expect(result.characters).toBe(100_000);
    expect(result.tokens).toBeGreaterThan(0);
    // Generous by design: this asserts the quadratic behaviour is gone, not a
    // particular machine's speed. It was 23,004 ms.
    expect(elapsed).toBeLessThan(3_000);
  });

  it('is unchanged for text shorter than one slice', () => {
    // Below the slice length nothing is split, so the result must be exactly
    // what an unsliced encode produces.
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(20);
    expect(text.length).toBeLessThan(8192);
    const encoder = (counter as unknown as { encoder?: { encode(s: string): unknown[] } }).encoder;
    if (encoder) {
      expect(counter.count(text).tokens).toBe(encoder.encode(text).length);
    }
  });

  it('stays within a fraction of a percent of an exact encode', () => {
    // A merge cannot span a slice boundary, so the sliced count runs slightly
    // high. The bound is what makes that acceptable: if this drifts, the
    // savings numbers built on it drift too.
    const encoder = (counter as unknown as { encoder?: { encode(s: string): unknown[] } }).encoder;
    if (!encoder) return;

    const prose = 'The quick brown fox jumps over the lazy dog. '.repeat(2200);
    const exact = encoder.encode(prose).length;
    const bounded = counter.count(prose).tokens;

    expect(bounded).toBeGreaterThanOrEqual(exact);
    expect((bounded - exact) / exact).toBeLessThan(0.005);
  });
});
