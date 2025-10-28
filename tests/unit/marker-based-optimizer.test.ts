/**
 * Unit Tests for MarkerBasedOptimizer
 *
 * Tests cover:
 * - Marker detection and processing
 * - Multiple markers in single prompt
 * - Edge cases (nested markers, malformed markers, special characters)
 * - Content preservation outside markers
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { MarkerBasedOptimizer } from '../../src/services/MarkerBasedOptimizer.js';
import { SummarizationModule } from '../../src/modules/SummarizationModule.js';
import { MockFoundationModel } from '../../src/modules/MockFoundationModel.js';
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

describe('MarkerBasedOptimizer', () => {
  let optimizer: MarkerBasedOptimizer;
  let summarizationModule: SummarizationModule;
  let model: MockFoundationModel;
  let tokenCounter: MockTokenCounter;

  beforeEach(() => {
    model = new MockFoundationModel('test-model');
    tokenCounter = new MockTokenCounter();
    summarizationModule = new SummarizationModule(model, tokenCounter);
    optimizer = new MarkerBasedOptimizer(summarizationModule);
  });

  describe('Basic Marker Processing', () => {
    it('should detect and process single marker', async () => {
      const prompt = 'Before <summarize>This is a long text that needs to be summarized. It has multiple sentences. More content here.</summarize> After';

      const result = await optimizer.processMarkers(prompt);

      expect(result).toBeDefined();
      expect(result.startsWith('Before ')).toBe(true);
      expect(result.endsWith(' After')).toBe(true);
      expect(result).not.toContain('<summarize>');
      expect(result).not.toContain('</summarize>');
      expect(result.length).toBeLessThan(prompt.length);
    });

    it('should process multiple markers', async () => {
      const prompt = '<summarize>First section to summarize.</summarize> Middle content. <summarize>Second section to summarize.</summarize>';

      const result = await optimizer.processMarkers(prompt);

      expect(result).toBeDefined();
      expect(result).toContain('Middle content.');
      expect(result).not.toContain('<summarize>');
      expect(result).not.toContain('</summarize>');
    });

    it('should preserve content outside markers', async () => {
      const prompt = 'Keep this. <summarize>Summarize this part.</summarize> Keep this too.';

      const result = await optimizer.processMarkers(prompt);

      expect(result).toContain('Keep this.');
      expect(result).toContain('Keep this too.');
    });

    it('should handle prompt with no markers', async () => {
      const prompt = 'This prompt has no markers to process.';

      const result = await optimizer.processMarkers(prompt);

      expect(result).toBe(prompt);
    });

    it('should handle empty prompt', async () => {
      const result = await optimizer.processMarkers('');

      expect(result).toBe('');
    });
  });

  describe('Marker Edge Cases', () => {
    it('should handle marker at start of prompt', async () => {
      const prompt = '<summarize>Start content.</summarize> End content.';

      const result = await optimizer.processMarkers(prompt);

      expect(result).toBeDefined();
      expect(result).toContain('End content.');
      expect(result).not.toContain('<summarize>');
    });

    it('should handle marker at end of prompt', async () => {
      const prompt = 'Start content. <summarize>End content.</summarize>';

      const result = await optimizer.processMarkers(prompt);

      expect(result).toBeDefined();
      expect(result).toContain('Start content.');
      expect(result).not.toContain('</summarize>');
    });

    it('should handle only marker content', async () => {
      const prompt = '<summarize>Only this content.</summarize>';

      const result = await optimizer.processMarkers(prompt);

      expect(result).toBeDefined();
      expect(result).not.toContain('<summarize>');
      expect(result).not.toContain('</summarize>');
      expect(result.length).toBeGreaterThan(0);
    });

    it('should handle empty marker', async () => {
      const prompt = 'Before <summarize></summarize> After';

      const result = await optimizer.processMarkers(prompt);

      expect(result).toContain('Before');
      expect(result).toContain('After');
    });

    it('should handle marker with whitespace', async () => {
      const prompt = '<summarize>  \n\n  Content with whitespace.  \n\n  </summarize>';

      const result = await optimizer.processMarkers(prompt);

      expect(result).toBeDefined();
      expect(result).not.toContain('<summarize>');
    });

    it('should handle marker with special characters', async () => {
      const prompt = '<summarize>Content with @#$%^&*() special chars.</summarize>';

      const result = await optimizer.processMarkers(prompt);

      expect(result).toBeDefined();
      expect(result).not.toContain('<summarize>');
    });

    it('should handle marker with unicode', async () => {
      const prompt = '<summarize>Unicode: 你好世界 こんにちは 안녕하세요</summarize>';

      const result = await optimizer.processMarkers(prompt);

      expect(result).toBeDefined();
      expect(result).not.toContain('<summarize>');
    });

    it('should handle consecutive markers', async () => {
      const prompt = '<summarize>First.</summarize><summarize>Second.</summarize>';

      const result = await optimizer.processMarkers(prompt);

      expect(result).toBeDefined();
      expect(result).not.toContain('<summarize>');
      expect(result).not.toContain('</summarize>');
    });

    it('should handle malformed opening tag', async () => {
      const prompt = 'Before <summarize Content without closing.';

      const result = await optimizer.processMarkers(prompt);

      // Should leave malformed tags unchanged
      expect(result).toBe(prompt);
    });

    it('should handle malformed closing tag', async () => {
      const prompt = 'Before summarize> Content without opening.';

      const result = await optimizer.processMarkers(prompt);

      // Should leave malformed tags unchanged
      expect(result).toBe(prompt);
    });

    it('should not process nested markers', async () => {
      // The regex doesn't handle nesting, so outer marker will consume inner one
      const prompt = '<summarize>Outer <summarize>Inner</summarize> still outer</summarize>';

      const result = await optimizer.processMarkers(prompt);

      expect(result).toBeDefined();
      // Result depends on regex behavior - it will match first closing tag
    });
  });

  describe('Multiline Markers', () => {
    it('should handle multiline content in markers', async () => {
      const prompt = `<summarize>
Line 1 of content.
Line 2 of content.
Line 3 of content.
</summarize>`;

      const result = await optimizer.processMarkers(prompt);

      expect(result).toBeDefined();
      expect(result).not.toContain('<summarize>');
      expect(result).not.toContain('</summarize>');
    });

    it('should handle code blocks in markers', async () => {
      const prompt = `<summarize>
Here is some code:
\`\`\`javascript
function test() {
  return 42;
}
\`\`\`
This is important.
</summarize>`;

      const result = await optimizer.processMarkers(prompt);

      expect(result).toBeDefined();
      expect(result).not.toContain('<summarize>');
    });

    it('should handle mixed content with newlines', async () => {
      const prompt = 'Before\n<summarize>\nContent\nwith\nnewlines\n</summarize>\nAfter';

      const result = await optimizer.processMarkers(prompt);

      expect(result).toContain('Before');
      expect(result).toContain('After');
      expect(result).not.toContain('<summarize>');
    });
  });

  describe('Performance', () => {
    it('should process markers in reasonable time', async () => {
      const prompt = '<summarize>Test content for timing.</summarize>';
      const startTime = Date.now();

      await optimizer.processMarkers(prompt);

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(5000); // Should complete within 5 seconds
    });

    it('should handle many markers efficiently', async () => {
      let prompt = '';
      for (let i = 0; i < 10; i++) {
        prompt += `<summarize>Section ${i} content.</summarize> `;
      }

      const startTime = Date.now();
      const result = await optimizer.processMarkers(prompt);

      const duration = Date.now() - startTime;
      expect(result).toBeDefined();
      expect(result).not.toContain('<summarize>');
      expect(duration).toBeLessThan(10000); // Should complete within 10 seconds
    });

    it('should handle large content in markers', async () => {
      const largeContent = 'Lorem ipsum '.repeat(1000);
      const prompt = `<summarize>${largeContent}</summarize>`;

      const result = await optimizer.processMarkers(prompt);

      expect(result).toBeDefined();
      expect(result.length).toBeLessThan(prompt.length);
    });
  });
});
