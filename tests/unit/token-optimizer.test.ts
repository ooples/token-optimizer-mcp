/**
 * Unit Tests for TokenOptimizer
 *
 * Tests cover:
 * - Module pipeline execution
 * - Token counting and savings calculation
 * - Multiple module application
 * - Module ordering
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { TokenOptimizer } from '../../src/services/TokenOptimizer.js';
import {
  IOptimizationModule,
  OptimizationResult as ModuleResult,
} from '../../src/modules/IOptimizationModule.js';
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

// Mock optimization module
class MockOptimizationModule implements IOptimizationModule {
  constructor(
    public readonly name: string,
    private readonly transform: (text: string) => string
  ) {}

  async apply(text: string): Promise<ModuleResult> {
    const result = this.transform(text);
    return {
      text: result,
      tokensSaved: Math.floor((text.length - result.length) / 4),
    };
  }
}

describe('TokenOptimizer', () => {
  let tokenCounter: MockTokenCounter;

  beforeEach(() => {
    tokenCounter = new MockTokenCounter();
  });

  describe('Basic Optimization', () => {
    it('should optimize prompt with single module', async () => {
      const module = new MockOptimizationModule('trim', (text) => text.trim());
      const optimizer = new TokenOptimizer([module], tokenCounter);
      const prompt = '   Test prompt   ';

      const result = await optimizer.optimize(prompt);

      expect(result.optimizedPrompt).toBe('Test prompt');
      expect(result.originalTokens).toBeGreaterThan(result.optimizedTokens);
      expect(result.savings).toBeGreaterThan(0);
      expect(result.appliedModules).toEqual(['trim']);
    });

    it('should optimize prompt with multiple modules', async () => {
      const modules = [
        new MockOptimizationModule('trim', (text) => text.trim()),
        new MockOptimizationModule('lowercase', (text) => text.toLowerCase()),
      ];
      const optimizer = new TokenOptimizer(modules, tokenCounter);
      const prompt = '   TEST PROMPT   ';

      const result = await optimizer.optimize(prompt);

      expect(result.optimizedPrompt).toBe('test prompt');
      expect(result.appliedModules).toEqual(['trim', 'lowercase']);
    });

    it('should handle empty module list', async () => {
      const optimizer = new TokenOptimizer([], tokenCounter);
      const prompt = 'Test prompt';

      const result = await optimizer.optimize(prompt);

      expect(result.optimizedPrompt).toBe(prompt);
      expect(result.originalTokens).toBe(result.optimizedTokens);
      expect(result.savings).toBe(0);
      expect(result.appliedModules).toEqual([]);
    });

    it('should calculate token counts correctly', async () => {
      const module = new MockOptimizationModule(
        'remove-spaces',
        (text) => text.replace(/\s+/g, '')
      );
      const optimizer = new TokenOptimizer([module], tokenCounter);
      const prompt = 'This is a test';

      const result = await optimizer.optimize(prompt);

      const originalCount = tokenCounter.count(prompt);
      const optimizedCount = tokenCounter.count(result.optimizedPrompt);

      expect(result.originalTokens).toBe(originalCount.tokens);
      expect(result.optimizedTokens).toBe(optimizedCount.tokens);
      expect(result.savings).toBe(
        originalCount.tokens - optimizedCount.tokens
      );
    });
  });

  describe('Module Pipeline', () => {
    it('should apply modules in order', async () => {
      const modules = [
        new MockOptimizationModule('add-prefix', (text) => 'PREFIX: ' + text),
        new MockOptimizationModule('add-suffix', (text) => text + ' :SUFFIX'),
      ];
      const optimizer = new TokenOptimizer(modules, tokenCounter);
      const prompt = 'Test';

      const result = await optimizer.optimize(prompt);

      expect(result.optimizedPrompt).toBe('PREFIX: Test :SUFFIX');
    });

    it('should pass output of one module to next', async () => {
      const modules = [
        new MockOptimizationModule('double', (text) => text + text),
        new MockOptimizationModule('uppercase', (text) => text.toUpperCase()),
      ];
      const optimizer = new TokenOptimizer(modules, tokenCounter);
      const prompt = 'abc';

      const result = await optimizer.optimize(prompt);

      expect(result.optimizedPrompt).toBe('ABCABC');
    });

    it('should handle modules that increase token count', async () => {
      const module = new MockOptimizationModule(
        'expand',
        (text) => text + ' expanded content'
      );
      const optimizer = new TokenOptimizer([module], tokenCounter);
      const prompt = 'Short';

      const result = await optimizer.optimize(prompt);

      expect(result.optimizedTokens).toBeGreaterThan(result.originalTokens);
      expect(result.savings).toBeLessThan(0); // Negative savings
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty prompt', async () => {
      const module = new MockOptimizationModule('noop', (text) => text);
      const optimizer = new TokenOptimizer([module], tokenCounter);

      const result = await optimizer.optimize('');

      expect(result.optimizedPrompt).toBe('');
      expect(result.originalTokens).toBe(0);
      expect(result.optimizedTokens).toBe(0);
      expect(result.savings).toBe(0);
    });

    it('should handle module that returns empty string', async () => {
      const module = new MockOptimizationModule('clear', () => '');
      const optimizer = new TokenOptimizer([module], tokenCounter);
      const prompt = 'This will be cleared';

      const result = await optimizer.optimize(prompt);

      expect(result.optimizedPrompt).toBe('');
      expect(result.savings).toBe(result.originalTokens);
    });

    it('should handle special characters', async () => {
      const module = new MockOptimizationModule('noop', (text) => text);
      const optimizer = new TokenOptimizer([module], tokenCounter);
      const prompt = '@#$%^&*(){}[]|\\<>?/~`';

      const result = await optimizer.optimize(prompt);

      expect(result.optimizedPrompt).toBe(prompt);
    });

    it('should handle unicode characters', async () => {
      const module = new MockOptimizationModule('noop', (text) => text);
      const optimizer = new TokenOptimizer([module], tokenCounter);
      const prompt = '你好世界 こんにちは 안녕하세요';

      const result = await optimizer.optimize(prompt);

      expect(result.optimizedPrompt).toBe(prompt);
    });

    it('should handle very long prompts', async () => {
      const module = new MockOptimizationModule('noop', (text) => text);
      const optimizer = new TokenOptimizer([module], tokenCounter);
      const prompt = 'x'.repeat(10000);

      const result = await optimizer.optimize(prompt);

      expect(result.optimizedPrompt).toBe(prompt);
      expect(result.originalTokens).toBeGreaterThan(0);
    });
  });

  describe('Performance', () => {
    it('should complete optimization in reasonable time', async () => {
      const module = new MockOptimizationModule('trim', (text) => text.trim());
      const optimizer = new TokenOptimizer([module], tokenCounter);
      const prompt = '   Test prompt   ';
      const startTime = Date.now();

      await optimizer.optimize(prompt);

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(1000); // Should complete within 1 second
    });

    it('should handle multiple sequential optimizations', async () => {
      const module = new MockOptimizationModule('trim', (text) => text.trim());
      const optimizer = new TokenOptimizer([module], tokenCounter);
      const prompts = ['  First  ', '  Second  ', '  Third  '];

      for (const prompt of prompts) {
        const result = await optimizer.optimize(prompt);
        expect(result.optimizedPrompt).toBe(prompt.trim());
      }
    });
  });
});
