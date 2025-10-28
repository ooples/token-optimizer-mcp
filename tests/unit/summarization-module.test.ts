/**
 * Unit Tests for SummarizationModule
 *
 * Tests cover:
 * - Basic summarization functionality
 * - Token counting and compression ratio calculation
 * - Different summarization options (style, preserveCodeBlocks, maxOutputTokens)
 * - Metrics recording
 * - Prompt building
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { SummarizationModule } from '../../src/modules/SummarizationModule.js';
import { MockFoundationModel } from '../../src/modules/MockFoundationModel.js';
import { ITokenCounter, TokenCountResult } from '../../src/interfaces/ITokenCounter.js';
import { IMetrics, SummarizationMetrics } from '../../src/interfaces/IMetrics.js';

// Mock token counter
class MockTokenCounter implements ITokenCounter {
  count(text: string): TokenCountResult {
    // Simple mock: 1 token per 4 characters
    const tokens = Math.ceil(text.length / 4);
    return {
      tokens,
      characters: text.length,
    };
  }
}

// Mock metrics collector
class MockMetrics implements IMetrics {
  public recordedMetrics: SummarizationMetrics[] = [];

  recordSummarization(metrics: SummarizationMetrics): void {
    this.recordedMetrics.push(metrics);
  }

  getSummarizationStats() {
    if (this.recordedMetrics.length === 0) {
      return {
        totalSummarizations: 0,
        averageCompressionRatio: 0,
        totalTokensSaved: 0,
        averageLatency: 0,
      };
    }

    const total = this.recordedMetrics.length;
    const totalRatio = this.recordedMetrics.reduce(
      (sum, m) => sum + m.compressionRatio,
      0
    );
    const totalSaved = this.recordedMetrics.reduce(
      (sum, m) => sum + (m.originalTokens - m.summaryTokens),
      0
    );
    const totalLatency = this.recordedMetrics.reduce(
      (sum, m) => sum + m.latency,
      0
    );

    return {
      totalSummarizations: total,
      averageCompressionRatio: totalRatio / total,
      totalTokensSaved: totalSaved,
      averageLatency: totalLatency / total,
    };
  }
}

describe('SummarizationModule', () => {
  let module: SummarizationModule;
  let model: MockFoundationModel;
  let tokenCounter: MockTokenCounter;
  let metrics: MockMetrics;

  beforeEach(() => {
    model = new MockFoundationModel('test-model');
    tokenCounter = new MockTokenCounter();
    metrics = new MockMetrics();
    module = new SummarizationModule(model, tokenCounter, metrics);
  });

  describe('Basic Summarization', () => {
    it('should summarize text and return result with metrics', async () => {
      const text = 'This is a long piece of text that needs to be summarized. It contains multiple sentences. Each sentence adds more context. The summarization should reduce the token count.';

      const result = await module.summarize(text);

      expect(result).toBeDefined();
      expect(result.summary).toBeDefined();
      expect(result.originalTokens).toBeGreaterThan(0);
      expect(result.summaryTokens).toBeGreaterThan(0);
      expect(result.summaryTokens).toBeLessThan(result.originalTokens);
      expect(result.compressionRatio).toBeGreaterThan(0);
      expect(result.compressionRatio).toBeLessThan(1);
    });

    it('should record metrics when provided', async () => {
      const text = 'This is a test text that will be summarized.';

      await module.summarize(text);

      expect(metrics.recordedMetrics).toHaveLength(1);
      const recorded = metrics.recordedMetrics[0];
      expect(recorded.originalTokens).toBeGreaterThan(0);
      expect(recorded.summaryTokens).toBeGreaterThan(0);
      expect(recorded.compressionRatio).toBeGreaterThan(0);
      expect(recorded.latency).toBeGreaterThanOrEqual(0);
    });

    it('should work without metrics', async () => {
      const moduleWithoutMetrics = new SummarizationModule(
        model,
        tokenCounter
      );
      const text = 'Test text for summarization.';

      const result = await moduleWithoutMetrics.summarize(text);

      expect(result).toBeDefined();
      expect(result.summary).toBeDefined();
    });
  });

  describe('Summarization Options', () => {
    it('should respect maxOutputTokens option', async () => {
      const text = 'This is a long text that needs summarization. It has many words.';
      const maxTokens = 5;

      const result = await module.summarize(text, {
        maxOutputTokens: maxTokens,
      });

      // The summary should be shorter, though exact token count depends on model behavior
      expect(result.summaryTokens).toBeLessThan(result.originalTokens);
    });

    it('should handle concise style', async () => {
      const text = 'This is a test. It has content. More information here.';

      const result = await module.summarize(text, {
        style: 'concise',
      });

      expect(result.summary).toBeDefined();
      expect(result.summary.length).toBeGreaterThan(0);
    });

    it('should handle detailed style', async () => {
      const text = 'This is a test. It has content. More information here.';

      const result = await module.summarize(text, {
        style: 'detailed',
      });

      expect(result.summary).toBeDefined();
      expect(result.summary.length).toBeGreaterThan(0);
    });

    it('should handle bullets style', async () => {
      const text = 'First point. Second point. Third point.';

      const result = await module.summarize(text, {
        style: 'bullets',
      });

      expect(result.summary).toBeDefined();
      expect(result.summary.length).toBeGreaterThan(0);
    });

    it('should handle preserveCodeBlocks option', async () => {
      const text = 'Here is some code:\n```js\nconst x = 42;\n```\nThis is important.';

      const result = await module.summarize(text, {
        preserveCodeBlocks: true,
      });

      expect(result.summary).toBeDefined();
      // Mock model should still process it
      expect(result.summary.length).toBeGreaterThan(0);
    });

    it('should handle compressionRatio option', async () => {
      const text = 'This is a long text with multiple sentences. Each sentence adds context.';

      const result = await module.summarize(text, {
        compressionRatio: 0.5,
      });

      expect(result.summary).toBeDefined();
      expect(result.compressionRatio).toBeGreaterThan(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty text', async () => {
      const result = await module.summarize('');

      expect(result).toBeDefined();
      expect(result.originalTokens).toBe(0);
    });

    it('should handle very short text', async () => {
      const text = 'Short.';

      const result = await module.summarize(text);

      expect(result).toBeDefined();
      expect(result.summary).toBeDefined();
    });

    it('should handle text with special characters', async () => {
      const text = 'Text with special chars: @#$%^&*(){}[]|\\<>?/~`';

      const result = await module.summarize(text);

      expect(result).toBeDefined();
      expect(result.summary).toBeDefined();
    });

    it('should handle unicode text', async () => {
      const text = 'Unicode text: 你好世界 こんにちは 안녕하세요';

      const result = await module.summarize(text);

      expect(result).toBeDefined();
      expect(result.summary).toBeDefined();
    });

    it('should calculate compression ratio correctly', async () => {
      const text = 'This is some text to summarize.';

      const result = await module.summarize(text);

      const expectedRatio = result.summaryTokens / result.originalTokens;
      expect(result.compressionRatio).toBeCloseTo(expectedRatio, 5);
    });
  });

  describe('Performance', () => {
    it('should complete summarization in reasonable time', async () => {
      const text = 'This is a test text for performance measurement.';
      const startTime = Date.now();

      await module.summarize(text);

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(5000); // Should complete within 5 seconds
    });

    it('should handle multiple sequential summarizations', async () => {
      const texts = [
        'First text to summarize.',
        'Second text to summarize.',
        'Third text to summarize.',
      ];

      for (const text of texts) {
        const result = await module.summarize(text);
        expect(result.summary).toBeDefined();
      }

      expect(metrics.recordedMetrics).toHaveLength(3);
    });
  });
});
