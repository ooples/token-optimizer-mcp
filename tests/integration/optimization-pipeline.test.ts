/**
 * Integration Tests for Optimization Pipeline
 *
 * Tests cover:
 * - Complete pipeline execution with multiple modules
 * - Module ordering and composition
 * - Per-module metrics tracking
 * - Real-world optimization scenarios
 * - Error handling and edge cases
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { TokenOptimizer } from '../../src/services/TokenOptimizer.js';
import { CompressionModule } from '../../src/modules/CompressionModule.js';
import { WhitespaceOptimizationModule } from '../../src/modules/WhitespaceOptimizationModule.js';
import { DeduplicationModule } from '../../src/modules/DeduplicationModule.js';
import { CompressionEngine } from '../../src/core/compression-engine.js';
import { TokenCounter } from '../../src/core/token-counter.js';

describe('Optimization Pipeline Integration', () => {
  let compressionEngine: CompressionEngine;
  let tokenCounter: TokenCounter;

  beforeEach(() => {
    compressionEngine = new CompressionEngine();
    tokenCounter = new TokenCounter();
  });

  describe('Complete Pipeline', () => {
    it('should apply multiple modules in sequence', async () => {
      const whitespace = new WhitespaceOptimizationModule(tokenCounter);
      const dedup = new DeduplicationModule(tokenCounter);

      const optimizer = new TokenOptimizer([whitespace, dedup], tokenCounter);

      const text = `
This is  a   test.   This is  a   test.
Another  line   here.
Another  line   here.
      `.trim();

      const result = await optimizer.optimize(text);

      expect(result.appliedModules).toEqual([
        'whitespace-optimization',
        'deduplication',
      ]);
      expect(result.moduleResults).toHaveLength(2);
      expect(result.savings).toBeGreaterThan(0);
    });

    it('should track per-module metrics', async () => {
      const whitespace = new WhitespaceOptimizationModule(tokenCounter);
      const dedup = new DeduplicationModule(tokenCounter);

      const optimizer = new TokenOptimizer([whitespace, dedup], tokenCounter);

      const text = 'Test  text. Test  text.';
      const result = await optimizer.optimize(text);

      // Check each module result
      for (const moduleResult of result.moduleResults) {
        expect(moduleResult.moduleName).toBeTruthy();
        expect(moduleResult.tokensIn).toBeGreaterThanOrEqual(0);
        expect(moduleResult.tokensOut).toBeGreaterThanOrEqual(0);
        expect(typeof moduleResult.savings).toBe('number');
      }
    });

    it('should calculate cumulative savings', async () => {
      const whitespace = new WhitespaceOptimizationModule(tokenCounter);
      const dedup = new DeduplicationModule(tokenCounter);

      const optimizer = new TokenOptimizer([whitespace, dedup], tokenCounter);

      const text = 'Duplicate  text.   Duplicate  text.   ';
      const result = await optimizer.optimize(text);

      const totalModuleSavings = result.moduleResults.reduce(
        (sum, m) => sum + m.savings,
        0
      );

      // Total savings should equal sum of module savings
      // (within rounding tolerance due to token counting at each step)
      expect(Math.abs(result.savings - totalModuleSavings)).toBeLessThan(5);
    });

    it('should track execution time', async () => {
      const whitespace = new WhitespaceOptimizationModule(tokenCounter);
      const optimizer = new TokenOptimizer([whitespace], tokenCounter);

      const text = 'Test  text';
      const result = await optimizer.optimize(text);

      expect(result.executionTimeMs).toBeGreaterThan(0);
      expect(result.executionTimeMs).toBeLessThan(10000); // Should be fast
    });

    it('should calculate percent saved', async () => {
      const dedup = new DeduplicationModule(tokenCounter);
      const optimizer = new TokenOptimizer([dedup], tokenCounter);

      const text = 'Same. Same. Same. Same.';
      const result = await optimizer.optimize(text);

      expect(result.percentSaved).toBeGreaterThan(0);
      expect(result.percentSaved).toBeLessThanOrEqual(100);
      expect(result.percentSaved).toBeCloseTo(
        (result.savings / result.originalTokens) * 100,
        2
      );
    });
  });

  describe('Module Ordering', () => {
    it('should apply modules in specified order', async () => {
      const whitespace = new WhitespaceOptimizationModule(tokenCounter);
      const dedup = new DeduplicationModule(tokenCounter);

      const optimizer1 = new TokenOptimizer([whitespace, dedup], tokenCounter);
      const optimizer2 = new TokenOptimizer([dedup, whitespace], tokenCounter);

      const text = 'Duplicate  text.   Duplicate  text.';

      const result1 = await optimizer1.optimize(text);
      const result2 = await optimizer2.optimize(text);

      // Different order might produce slightly different results
      expect(result1.appliedModules[0]).toBe('whitespace-optimization');
      expect(result2.appliedModules[0]).toBe('deduplication');

      // Both should save tokens
      expect(result1.savings).toBeGreaterThan(0);
      expect(result2.savings).toBeGreaterThan(0);
    });

    it('should pass output of each module to next', async () => {
      const whitespace = new WhitespaceOptimizationModule(tokenCounter);
      const dedup = new DeduplicationModule(tokenCounter);

      const optimizer = new TokenOptimizer([whitespace, dedup], tokenCounter);

      const text = 'Test  text.   Test  text.';
      const result = await optimizer.optimize(text);

      // First module should receive original text
      expect(result.moduleResults[0].tokensIn).toBe(result.originalTokens);

      // Second module should receive output of first
      expect(result.moduleResults[1].tokensIn).toBe(
        result.moduleResults[0].tokensOut
      );
    });

    it('should handle whitespace -> dedup -> compression pipeline', async () => {
      const whitespace = new WhitespaceOptimizationModule(tokenCounter);
      const dedup = new DeduplicationModule(tokenCounter);
      const compression = new CompressionModule(
        compressionEngine,
        tokenCounter,
        { minSize: 100 }
      );

      const optimizer = new TokenOptimizer(
        [whitespace, dedup, compression],
        tokenCounter
      );

      const text = 'Test  sentence.   Test  sentence.   '.repeat(50);
      const result = await optimizer.optimize(text);

      expect(result.appliedModules).toEqual([
        'whitespace-optimization',
        'deduplication',
        'compression',
      ]);
      expect(result.moduleResults).toHaveLength(3);
      expect(result.savings).toBeGreaterThan(0);
    });
  });

  describe('Real-World Scenarios', () => {
    it('should optimize code documentation', async () => {
      const whitespace = new WhitespaceOptimizationModule(tokenCounter, {
        preserveCodeBlocks: true,
      });
      const dedup = new DeduplicationModule(tokenCounter, {
        preserveCodeBlocks: true,
      });

      const optimizer = new TokenOptimizer([whitespace, dedup], tokenCounter);

      const text = `
# Documentation

This is  a   function.   This is  a   function.

\`\`\`javascript
function  example()  {
  return  true;
}
\`\`\`

Usage  example.   Usage  example.
      `;

      const result = await optimizer.optimize(text);

      // Code blocks should be preserved
      expect(result.optimizedPrompt).toContain('function  example()  {');
      expect(result.optimizedPrompt).toContain('return  true;');

      // Documentation should be optimized
      expect(result.savings).toBeGreaterThan(0);
    });

    it('should optimize repeated boilerplate', async () => {
      const dedup = new DeduplicationModule(tokenCounter);
      const optimizer = new TokenOptimizer([dedup], tokenCounter);

      const text = `
Copyright 2024. All rights reserved.

Content here.

Copyright 2024. All rights reserved.
      `.trim();

      const result = await optimizer.optimize(text);

      expect(result.savings).toBeGreaterThan(0);
      expect(result.moduleResults[0].metadata?.duplicateSentences).toBe(1);
    });

    it('should optimize copy-paste artifacts', async () => {
      const whitespace = new WhitespaceOptimizationModule(tokenCounter);
      const optimizer = new TokenOptimizer([whitespace], tokenCounter);

      const text = `Line 1   \n\n\n\nLine 2  \n\n\n\nLine 3`;
      const result = await optimizer.optimize(text);

      expect(result.savings).toBeGreaterThan(0);
      expect(result.optimizedPrompt.split('\n').length).toBeLessThan(
        text.split('\n').length
      );
    });

    it('should handle large documents', async () => {
      const whitespace = new WhitespaceOptimizationModule(tokenCounter);
      const dedup = new DeduplicationModule(tokenCounter);

      const optimizer = new TokenOptimizer([whitespace, dedup], tokenCounter);

      const paragraph = 'This is  a   paragraph.   ';
      const text = paragraph.repeat(100);

      const result = await optimizer.optimize(text);

      expect(result.savings).toBeGreaterThan(0);
      expect(result.executionTimeMs).toBeLessThan(5000); // Should be reasonably fast
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty pipeline', async () => {
      const optimizer = new TokenOptimizer([], tokenCounter);
      const text = 'Test text';
      const result = await optimizer.optimize(text);

      expect(result.optimizedPrompt).toBe(text);
      expect(result.savings).toBe(0);
      expect(result.appliedModules).toHaveLength(0);
      expect(result.moduleResults).toHaveLength(0);
    });

    it('should handle empty text', async () => {
      const whitespace = new WhitespaceOptimizationModule(tokenCounter);
      const optimizer = new TokenOptimizer([whitespace], tokenCounter);

      const result = await optimizer.optimize('');

      expect(result.optimizedPrompt).toBe('');
      expect(result.originalTokens).toBe(0);
      expect(result.optimizedTokens).toBe(0);
      expect(result.savings).toBe(0);
    });

    it('should handle modules that increase size', async () => {
      // Create a module that expands text
      class ExpanderModule {
        readonly name = 'expander';
        async apply(text: string) {
          const expanded = text + ' [expanded]';
          const originalCount = await tokenCounter.count(text);
          const expandedCount = await tokenCounter.count(expanded);
          return {
            text: expanded,
            originalTokens: originalCount.tokens,
            optimizedTokens: expandedCount.tokens,
            savings: originalCount.tokens - expandedCount.tokens,
            moduleName: this.name,
          };
        }
      }

      const expander = new ExpanderModule();
      const optimizer = new TokenOptimizer([expander], tokenCounter);

      const result = await optimizer.optimize('Test');

      expect(result.savings).toBeLessThan(0); // Negative savings
      expect(result.optimizedTokens).toBeGreaterThan(result.originalTokens);
    });

    it('should handle very long execution', async () => {
      const whitespace = new WhitespaceOptimizationModule(tokenCounter);
      const optimizer = new TokenOptimizer([whitespace], tokenCounter);

      const text = 'Word  '.repeat(50000);
      const result = await optimizer.optimize(text);

      expect(result.executionTimeMs).toBeLessThan(30000); // Within 30 seconds
      expect(result.savings).toBeGreaterThan(0);
    });
  });

  describe('Utility Methods', () => {
    it('should return module names', () => {
      const whitespace = new WhitespaceOptimizationModule(tokenCounter);
      const dedup = new DeduplicationModule(tokenCounter);

      const optimizer = new TokenOptimizer([whitespace, dedup], tokenCounter);

      const names = optimizer.getModuleNames();

      expect(names).toEqual(['whitespace-optimization', 'deduplication']);
    });

    it('should return module count', () => {
      const whitespace = new WhitespaceOptimizationModule(tokenCounter);
      const dedup = new DeduplicationModule(tokenCounter);

      const optimizer = new TokenOptimizer([whitespace, dedup], tokenCounter);

      expect(optimizer.getModuleCount()).toBe(2);
    });

    it('should handle empty pipeline utility methods', () => {
      const optimizer = new TokenOptimizer([], tokenCounter);

      expect(optimizer.getModuleNames()).toEqual([]);
      expect(optimizer.getModuleCount()).toBe(0);
    });
  });

  describe('Module Metadata', () => {
    it('should preserve module metadata', async () => {
      const whitespace = new WhitespaceOptimizationModule(tokenCounter);
      const optimizer = new TokenOptimizer([whitespace], tokenCounter);

      const text = 'Test  text';
      const result = await optimizer.optimize(text);

      const metadata = result.moduleResults[0].metadata;
      expect(metadata).toBeDefined();
      expect(metadata?.spacesRemoved).toBeDefined();
    });

    it('should track metadata across multiple modules', async () => {
      const whitespace = new WhitespaceOptimizationModule(tokenCounter);
      const dedup = new DeduplicationModule(tokenCounter);

      const optimizer = new TokenOptimizer([whitespace, dedup], tokenCounter);

      const text = 'Test  text.   Test  text.';
      const result = await optimizer.optimize(text);

      expect(result.moduleResults[0].metadata?.spacesRemoved).toBeDefined();
      expect(result.moduleResults[1].metadata?.duplicateSentences).toBeDefined();
    });
  });
});
