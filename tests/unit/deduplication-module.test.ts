/**
 * Unit Tests for DeduplicationModule
 *
 * Tests cover:
 * - Sentence deduplication
 * - Paragraph deduplication
 * - Case sensitivity
 * - Code block preservation
 * - Token savings calculation
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { DeduplicationModule } from '../../src/modules/DeduplicationModule.js';
import { ITokenCounter, TokenCountResult } from '../../src/interfaces/ITokenCounter.js';

// Mock token counter
class MockTokenCounter implements ITokenCounter {
  count(text: string): TokenCountResult {
    const tokens = Math.ceil(text.length / 4);
    return {
      tokens,
      characters: text.length,
    };
  }
}

describe('DeduplicationModule', () => {
  let tokenCounter: MockTokenCounter;
  let module: DeduplicationModule;

  beforeEach(() => {
    tokenCounter = new MockTokenCounter();
    module = new DeduplicationModule(tokenCounter);
  });

  describe('Sentence Deduplication', () => {
    it('should remove duplicate sentences', async () => {
      const text = 'This is a test. This is a test. This is unique.';
      const result = await module.apply(text);

      expect(result.text).toBe('This is a test. This is unique.');
      expect(result.metadata?.duplicateSentences).toBe(1);
    });

    it('should preserve first occurrence by default', async () => {
      const text = 'First sentence. Second sentence. First sentence.';
      const result = await module.apply(text);

      expect(result.text).toContain('First sentence. Second sentence.');
      expect(result.text.split('First sentence').length - 1).toBe(1);
      expect(result.metadata?.duplicateSentences).toBe(1);
    });

    it('should be case-sensitive by default', async () => {
      const text = 'This is a test. this is a test. This Is A Test.';
      const result = await module.apply(text);

      // All three are different due to case
      expect(result.text).toBe(text);
      expect(result.metadata?.duplicateSentences).toBe(0);
    });

    it('should be case-insensitive when configured', async () => {
      const moduleIgnoreCase = new DeduplicationModule(tokenCounter, {
        caseSensitive: false,
      });

      const text = 'This is a test. this is a test. THIS IS A TEST.';
      const result = await moduleIgnoreCase.apply(text);

      expect(result.metadata?.duplicateSentences).toBe(2);
    });

    it('should respect minimum sentence length', async () => {
      const moduleMinLength = new DeduplicationModule(tokenCounter, {
        minSentenceLength: 20,
      });

      const text = 'Short. Short. This is a longer sentence. This is a longer sentence.';
      const result = await moduleMinLength.apply(text);

      // Short duplicates should be kept, long ones removed
      expect(result.text).toContain('Short. Short.');
      expect(result.metadata?.duplicateSentences).toBe(1);
    });

    it('should count duplicate sentences', async () => {
      const text = 'Apple. Banana. Cherry. Apple. Banana. Durian.';
      const result = await module.apply(text);

      expect(result.metadata?.originalSentences).toBeGreaterThan(0);
      expect(result.metadata?.duplicateSentences).toBe(2);
    });
  });

  describe('Paragraph Deduplication', () => {
    it('should deduplicate paragraphs when enabled', async () => {
      const moduleParagraph = new DeduplicationModule(tokenCounter, {
        deduplicateParagraphs: true,
      });

      const text = `First paragraph text.

First paragraph text.

Second paragraph text.`;

      const result = await moduleParagraph.apply(text);

      expect(result.metadata?.duplicateParagraphs).toBe(1);
      expect(result.text).toContain('First paragraph text');
      expect(result.text).toContain('Second paragraph text');
    });

    it('should not deduplicate paragraphs by default', async () => {
      const text = `Same paragraph.

Same paragraph.`;

      const result = await module.apply(text);

      expect(result.metadata?.duplicateParagraphs).toBe(0);
    });

    it('should handle mixed paragraph and sentence deduplication', async () => {
      const moduleBoth = new DeduplicationModule(tokenCounter, {
        deduplicateParagraphs: true,
      });

      const text = `Para 1. Sentence A. Sentence A.

Para 1. Sentence A. Sentence A.

Para 2.`;

      const result = await moduleBoth.apply(text);

      expect(result.metadata?.duplicateParagraphs).toBeGreaterThan(0);
      expect(result.metadata?.duplicateSentences).toBeGreaterThan(0);
    });
  });

  describe('Code Block Preservation', () => {
    it('should preserve code blocks by default', async () => {
      const text = `
Duplicate sentence. Duplicate sentence.

\`\`\`javascript
duplicate code. duplicate code.
\`\`\`

More text.
      `.trim();

      const result = await module.apply(text);

      // Code block should be preserved with duplicates
      expect(result.text).toContain('duplicate code. duplicate code.');
      expect(result.metadata?.preservedCodeBlocks).toBe(1);
    });

    it('should not preserve code blocks when disabled', async () => {
      const moduleNoPreserve = new DeduplicationModule(tokenCounter, {
        preserveCodeBlocks: false,
      });

      // Test with code blocks and duplicates
      const text = 'Regular text. \`\`\`code block\`\`\` More text. Regular text.';
      const result = await moduleNoPreserve.apply(text);

      // When code blocks aren't preserved, deduplication should work on regular text
      expect(result.metadata?.duplicateSentences).toBe(1);
      expect(result.metadata?.preservedCodeBlocks).toBe(0);
    });

    it('should track preserved code blocks', async () => {
      const text = `
\`\`\`
block 1
\`\`\`

\`\`\`
block 2
\`\`\`
      `;

      const result = await module.apply(text);

      expect(result.metadata?.preservedCodeBlocks).toBe(2);
    });
  });

  describe('Token Counting', () => {
    it('should calculate token savings correctly', async () => {
      const text = 'Duplicate. Duplicate. Unique.';
      const originalCount = tokenCounter.count(text);
      const result = await module.apply(text);
      const optimizedCount = tokenCounter.count(result.text);

      expect(result.originalTokens).toBe(originalCount.tokens);
      expect(result.optimizedTokens).toBe(optimizedCount.tokens);
      expect(result.savings).toBe(originalCount.tokens - optimizedCount.tokens);
      expect(result.savings).toBeGreaterThan(0);
    });

    it('should track total duplicates removed', async () => {
      const moduleBoth = new DeduplicationModule(tokenCounter, {
        deduplicateParagraphs: true,
      });

      const text = `
Dup sentence. Dup sentence.

Same paragraph.

Same paragraph.
      `.trim();

      const result = await moduleBoth.apply(text);

      const total = result.metadata?.totalDuplicatesRemoved as number;
      expect(total).toBeGreaterThan(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty text', async () => {
      const result = await module.apply('');

      expect(result.text).toBe('');
      expect(result.savings).toBe(0);
    });

    it('should handle text without duplicates', async () => {
      const text = 'Every sentence is unique. No repetition here. All different.';
      const result = await module.apply(text);

      expect(result.text).toBe(text);
      expect(result.metadata?.duplicateSentences).toBe(0);
    });

    it('should handle text with only duplicates', async () => {
      const text = 'Hello. Hello. Hello. Hello.';
      const result = await module.apply(text);

      expect(result.text.trim()).toBe('Hello.');
      expect(result.metadata?.duplicateSentences).toBe(3);
    });

    it('should handle very long sentences', async () => {
      const longSentence = 'This is a very long sentence with lots of words';
      const text = `${longSentence}. ${longSentence}. Unique sentence.`;
      const result = await module.apply(text);

      expect(result.metadata?.duplicateSentences).toBe(1);
    });

    it('should handle special characters', async () => {
      const text = 'Special@#$%. Special@#$%. Different.';
      const result = await module.apply(text);

      expect(result.metadata?.duplicateSentences).toBe(1);
    });

    it('should handle unicode characters', async () => {
      const text = '你好世界朋友. 你好世界朋友. こんにちは世界.';
      const result = await module.apply(text);

      expect(result.metadata?.duplicateSentences).toBe(1);
    });
  });

  describe('Configuration Options', () => {
    it('should track case sensitivity in metadata', async () => {
      const module1 = new DeduplicationModule(tokenCounter, {
        caseSensitive: true,
      });
      const module2 = new DeduplicationModule(tokenCounter, {
        caseSensitive: false,
      });

      const text = 'Test.';

      const result1 = await module1.apply(text);
      const result2 = await module2.apply(text);

      expect(result1.metadata?.caseSensitive).toBe(true);
      expect(result2.metadata?.caseSensitive).toBe(false);
    });

    it('should handle preserve first vs last', async () => {
      const modulePreserveFirst = new DeduplicationModule(tokenCounter, {
        preserveFirst: true,
      });
      const modulePreserveLast = new DeduplicationModule(tokenCounter, {
        preserveFirst: false,
      });

      const text = 'First. Middle. First.';

      const result1 = await modulePreserveFirst.apply(text);
      const result2 = await modulePreserveLast.apply(text);

      // Both should remove one duplicate
      expect(result1.metadata?.duplicateSentences).toBe(1);
      expect(result2.metadata?.duplicateSentences).toBe(1);
    });
  });

  describe('Complex Scenarios', () => {
    it('should handle mixed content', async () => {
      const text = `
Introduction sentence. Introduction sentence.

\`\`\`code
code here. code here.
\`\`\`

Conclusion sentence. Conclusion sentence.
      `.trim();

      const result = await module.apply(text);

      // Duplicates outside code blocks should be removed
      expect(result.metadata?.duplicateSentences).toBeGreaterThan(0);
      // Code blocks should be preserved
      expect(result.text).toContain('code here. code here.');
    });

    it('should handle paragraph breaks', async () => {
      const modulePara = new DeduplicationModule(tokenCounter, {
        deduplicateParagraphs: true,
      });

      const text = `Paragraph one.

Paragraph two.

Paragraph one.`;

      const result = await modulePara.apply(text);

      expect(result.metadata?.duplicateParagraphs).toBe(1);
    });
  });
});
