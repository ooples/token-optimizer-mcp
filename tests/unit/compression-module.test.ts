/**
 * Unit Tests for CompressionModule
 *
 * Tests cover:
 * - Basic compression functionality
 * - Token counting and savings calculation
 * - Compression quality settings
 * - Small text handling
 * - Decompression functionality
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { CompressionModule } from '../../src/modules/CompressionModule.js';
import { CompressionEngine } from '../../src/core/compression-engine.js';
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

describe('CompressionModule', () => {
  let compressionEngine: CompressionEngine;
  let tokenCounter: MockTokenCounter;
  let module: CompressionModule;

  beforeEach(() => {
    compressionEngine = new CompressionEngine();
    tokenCounter = new MockTokenCounter();
    module = new CompressionModule(compressionEngine, tokenCounter);
  });

  describe('Basic Compression', () => {
    it('should compress text and return base64', async () => {
      const text = 'This is a test text that should be compressed. '.repeat(50);
      const result = await module.apply(text);

      expect(result.moduleName).toBe('compression');
      expect(result.text).toBeTruthy();
      expect(result.text).not.toBe(text);
      expect(result.metadata?.compressed).toBe(true);
      expect(result.metadata?.encoding).toBe('base64');
      expect(result.metadata?.algorithm).toBe('brotli');
    });

    it('should calculate token savings correctly', async () => {
      const text = 'Lorem ipsum dolor sit amet. '.repeat(100);
      const result = await module.apply(text);

      expect(result.originalTokens).toBeGreaterThan(0);
      expect(result.optimizedTokens).toBe(0); // Compressed = external cache
      expect(result.savings).toBe(result.originalTokens);
    });

    it('should skip compression for small texts', async () => {
      const text = 'Short text';
      const result = await module.apply(text);

      expect(result.text).toBe(text);
      expect(result.savings).toBe(0);
      expect(result.metadata?.compressed).toBe(false);
      expect(result.metadata?.reason).toContain('too small');
    });

    it('should respect quality settings', async () => {
      const text = 'Test text for compression quality. '.repeat(50);
      const module1 = new CompressionModule(compressionEngine, tokenCounter, {
        quality: 1,
      });
      const module2 = new CompressionModule(compressionEngine, tokenCounter, {
        quality: 11,
      });

      const result1 = await module1.apply(text);
      const result2 = await module2.apply(text);

      expect(result1.metadata?.quality).toBe(1);
      expect(result2.metadata?.quality).toBe(11);
    });

    it('should handle empty text', async () => {
      const result = await module.apply('');

      expect(result.text).toBe('');
      expect(result.originalTokens).toBe(0);
      expect(result.optimizedTokens).toBe(0);
      expect(result.savings).toBe(0);
    });
  });

  describe('Compression Metadata', () => {
    it('should include compression statistics', async () => {
      const text = 'This is a longer text that will be compressed. '.repeat(30);
      const result = await module.apply(text);

      expect(result.metadata).toBeDefined();
      expect(result.metadata?.compressionRatio).toBeDefined();
      expect(result.metadata?.percentSaved).toBeDefined();
      expect(result.metadata?.originalSize).toBeDefined();
      expect(result.metadata?.compressedSize).toBeDefined();
    });

    it('should report compression ratio', async () => {
      const text = 'Repeated text. '.repeat(100);
      const result = await module.apply(text);

      const ratio = result.metadata?.compressionRatio as number;
      expect(ratio).toBeGreaterThan(0);
      expect(ratio).toBeLessThan(1); // Should compress
    });
  });

  describe('Decompression', () => {
    it('should decompress compressed text correctly', async () => {
      const originalText = 'This is a test text for compression. '.repeat(50);
      const result = await module.apply(originalText);

      if (result.metadata?.compressed) {
        const decompressed = module.decompress(result.text);
        expect(decompressed).toBe(originalText);
      }
    });

    it('should handle round-trip compression', async () => {
      const texts = [
        'Simple text',
        'Text with numbers: 123456789',
        'Text with special chars: @#$%^&*()',
        'Unicode text: 你好世界 こんにちは',
      ];

      for (const text of texts) {
        const longText = text.repeat(30); // Make it long enough to compress
        const result = await module.apply(longText);

        if (result.metadata?.compressed) {
          const decompressed = module.decompress(result.text);
          expect(decompressed).toBe(longText);
        }
      }
    });
  });

  describe('Configuration Options', () => {
    it('should respect minSize option', async () => {
      const module1 = new CompressionModule(compressionEngine, tokenCounter, {
        minSize: 100,
      });
      const module2 = new CompressionModule(compressionEngine, tokenCounter, {
        minSize: 5000,
      });

      const text = 'Test text. '.repeat(50); // ~550 chars

      const result1 = await module1.apply(text);
      const result2 = await module2.apply(text);

      expect(result1.metadata?.compressed).toBe(true);
      expect(result2.metadata?.compressed).toBe(false);
    });

    it('should handle different compression modes', async () => {
      const text = 'Test text for mode testing. '.repeat(50);

      const modes: Array<'text' | 'font' | 'generic'> = ['text', 'font', 'generic'];

      for (const mode of modes) {
        const moduleWithMode = new CompressionModule(
          compressionEngine,
          tokenCounter,
          { mode }
        );
        const result = await moduleWithMode.apply(text);

        if (result.metadata?.compressed) {
          expect(result.text).toBeTruthy();
          const decompressed = moduleWithMode.decompress(result.text);
          expect(decompressed).toBe(text);
        }
      }
    });
  });

  describe('Edge Cases', () => {
    it('should handle very long text', async () => {
      const longText = 'x'.repeat(100000);
      const result = await module.apply(longText);

      expect(result.metadata?.compressed).toBe(true);
      expect(result.originalTokens).toBeGreaterThan(0);
    });

    it('should handle text with lots of repetition', async () => {
      const text = 'aaaaaaaaaa'.repeat(1000);
      const result = await module.apply(text);

      if (result.metadata?.compressed) {
        const ratio = result.metadata.compressionRatio as number;
        expect(ratio).toBeLessThan(0.1); // Should compress very well
      }
    });

    it('should handle already compressed text', async () => {
      const randomText = Array.from({ length: 1000 }, () =>
        String.fromCharCode(Math.random() * 256)
      ).join('');

      const result = await module.apply(randomText);

      // Random text doesn't compress well, but should still work
      expect(result.text).toBeTruthy();
    });
  });
});
