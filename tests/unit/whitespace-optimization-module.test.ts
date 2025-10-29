/**
 * Unit Tests for WhitespaceOptimizationModule
 *
 * Tests cover:
 * - Multiple space removal
 * - Trailing whitespace removal
 * - Newline collapsing
 * - Code block preservation
 * - Indentation preservation
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { WhitespaceOptimizationModule } from '../../src/modules/WhitespaceOptimizationModule.js';
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

describe('WhitespaceOptimizationModule', () => {
  let tokenCounter: MockTokenCounter;
  let module: WhitespaceOptimizationModule;

  beforeEach(() => {
    tokenCounter = new MockTokenCounter();
    module = new WhitespaceOptimizationModule(tokenCounter);
  });

  describe('Space Optimization', () => {
    it('should collapse multiple spaces to single space', async () => {
      const text = 'This  is   a    test';
      const result = await module.apply(text);

      expect(result.text).toBe('This is a test');
      expect(result.savings).toBeGreaterThan(0);
    });

    it('should remove trailing spaces', async () => {
      const text = 'Line 1   \nLine 2  \nLine 3 ';
      const result = await module.apply(text);

      expect(result.text).not.toContain('   \n');
      expect(result.text).not.toContain('  \n');
    });

    it('should trim leading and trailing whitespace', async () => {
      const text = '   Content   ';
      const result = await module.apply(text);

      expect(result.text).toBe('Content');
    });

    it('should count spaces removed', async () => {
      const text = 'A  B   C    D';
      const result = await module.apply(text);

      expect(result.metadata?.spacesRemoved).toBeGreaterThan(0);
    });
  });

  describe('Newline Optimization', () => {
    it('should collapse multiple newlines', async () => {
      const text = 'Paragraph 1\n\n\n\nParagraph 2';
      const result = await module.apply(text);

      expect(result.text).toBe('Paragraph 1\n\nParagraph 2');
    });

    it('should respect maxConsecutiveNewlines option', async () => {
      const module1 = new WhitespaceOptimizationModule(tokenCounter, {
        maxConsecutiveNewlines: 1,
      });
      const module2 = new WhitespaceOptimizationModule(tokenCounter, {
        maxConsecutiveNewlines: 3,
      });

      const text = 'A\n\n\n\nB';

      const result1 = await module1.apply(text);
      const result2 = await module2.apply(text);

      expect(result1.text).toBe('A\nB');
      expect(result2.text).toBe('A\n\n\nB');
    });

    it('should count newlines removed', async () => {
      const text = 'Line 1\n\n\n\nLine 2\n\n\nLine 3';
      const result = await module.apply(text);

      expect(result.metadata?.newlinesRemoved).toBeGreaterThan(0);
    });
  });

  describe('Indentation Handling', () => {
    it('should remove leading spaces by default', async () => {
      const text = '  function test() {\n    return true;\n  }';
      const result = await module.apply(text);

      expect(result.text).not.toContain('  function');
      expect(result.text).toContain('function test()');
    });

    it('should preserve indentation when configured', async () => {
      const moduleWithIndent = new WhitespaceOptimizationModule(tokenCounter, {
        preserveIndentation: true,
      });

      const text = '  function test() {\n    return true;\n  }';
      const result = await moduleWithIndent.apply(text);

      expect(result.text).toContain('  function');
      expect(result.text).toContain('    return');
    });

    it('should track indentation preservation in metadata', async () => {
      const module1 = new WhitespaceOptimizationModule(tokenCounter, {
        preserveIndentation: false,
      });
      const module2 = new WhitespaceOptimizationModule(tokenCounter, {
        preserveIndentation: true,
      });

      const text = '  Code';

      const result1 = await module1.apply(text);
      const result2 = await module2.apply(text);

      expect(result1.metadata?.preservedIndentation).toBe(false);
      expect(result2.metadata?.preservedIndentation).toBe(true);
    });
  });

  describe('Code Block Preservation', () => {
    it('should preserve code blocks by default', async () => {
      const text = `
Text with  extra   spaces

\`\`\`javascript
function  test()  {
  return   true;
}
\`\`\`

More  text
      `.trim();

      const result = await module.apply(text);

      // Code block should be preserved exactly
      expect(result.text).toContain('function  test()  {');
      expect(result.text).toContain('return   true;');

      // Outside text should be optimized
      expect(result.text).toContain('Text with extra spaces');
      expect(result.text).toContain('More text');
    });

    it('should not preserve code blocks when disabled', async () => {
      const moduleNoPreserve = new WhitespaceOptimizationModule(tokenCounter, {
        preserveCodeBlocks: false,
      });

      const text = `\`\`\`\nfunction  test()  {\n}\n\`\`\``;
      const result = await moduleNoPreserve.apply(text);

      // Spaces inside code blocks should be optimized
      expect(result.text).not.toContain('function  test()  {');
    });

    it('should count preserved code blocks', async () => {
      const text = `
\`\`\`javascript
code here
\`\`\`

\`\`\`python
more code
\`\`\`
      `;

      const result = await module.apply(text);

      expect(result.metadata?.preservedCodeBlocks).toBe(2);
    });
  });

  describe('Token Counting', () => {
    it('should calculate token savings correctly', async () => {
      const text = 'A  B   C    D     E';
      const originalCount = tokenCounter.count(text);
      const result = await module.apply(text);
      const optimizedCount = tokenCounter.count(result.text);

      expect(result.originalTokens).toBe(originalCount.tokens);
      expect(result.optimizedTokens).toBe(optimizedCount.tokens);
      expect(result.savings).toBe(originalCount.tokens - optimizedCount.tokens);
    });

    it('should track character savings', async () => {
      const text = 'Test  with   extra    spaces';
      const result = await module.apply(text);

      expect(result.metadata?.charactersSaved).toBeGreaterThan(0);
      expect(result.metadata?.originalLength).toBe(text.length);
      expect(result.metadata?.optimizedLength).toBe(result.text.length);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty text', async () => {
      const result = await module.apply('');

      expect(result.text).toBe('');
      expect(result.savings).toBe(0);
    });

    it('should handle text with only whitespace', async () => {
      const text = '   \n\n\n   ';
      const result = await module.apply(text);

      expect(result.text).toBe('');
    });

    it('should handle text without extra whitespace', async () => {
      const text = 'Perfect text with no extra spaces';
      const result = await module.apply(text);

      expect(result.text).toBe(text);
      expect(result.savings).toBe(0);
    });

    it('should handle unicode whitespace', async () => {
      const text = 'Text\u00A0with\u00A0non-breaking\u00A0spaces';
      const result = await module.apply(text);

      expect(result.text).toBeTruthy();
    });

    it('should handle very long text', async () => {
      const text = 'Word  '.repeat(10000);
      const result = await module.apply(text);

      expect(result.text.length).toBeLessThan(text.length);
      expect(result.savings).toBeGreaterThan(0);
    });
  });

  describe('Complex Scenarios', () => {
    it('should handle mixed content', async () => {
      const text = `
# Title  with   spaces

Paragraph  with   extra    spaces.

\`\`\`code
preserved  spaces
\`\`\`

Another   paragraph.
      `.trim();

      const result = await module.apply(text);

      expect(result.text).toContain('preserved  spaces'); // Code preserved
      expect(result.text).toContain('Title with spaces'); // Text optimized
      expect(result.text).toContain('Paragraph with extra spaces'); // Text optimized
    });

    it('should handle nested code blocks', async () => {
      const text = `
\`\`\`markdown
# Nested   Content

\`\`\`code
inner  code
\`\`\`
\`\`\`
      `;

      const result = await module.apply(text);

      // Should preserve the entire outer code block
      expect(result.text).toContain('Nested   Content');
    });
  });
});
