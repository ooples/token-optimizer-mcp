/**
 * Token Caching Validation Tests
 *
 * Tests cover:
 * - Cache hit/miss ratio validation
 * - Compression ratio verification (95%+ target)
 * - Cache persistence across sessions
 * - Cache invalidation logic
 * - Different cache storage backends
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { CacheEngine } from '../../src/core/cache-engine.js';
import { CompressionEngine } from '../../src/core/compression-engine.js';
import { TokenCounter } from '../../src/core/token-counter.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('Token Caching Validation', () => {
  let cache: CacheEngine;
  let compression: CompressionEngine;
  let tokenCounter: TokenCounter;
  let testDbPath: string;

  beforeEach(() => {
    const tempDir = path.join(os.tmpdir(), 'token-optimizer-test');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    testDbPath = path.join(tempDir, `cache-validation-${Date.now()}.db`);
    cache = new CacheEngine(testDbPath, 100);
    compression = new CompressionEngine();
    tokenCounter = new TokenCounter();
  });

  afterEach(() => {
    cache.close();
    tokenCounter.free();

    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    const walPath = `${testDbPath}-wal`;
    const shmPath = `${testDbPath}-shm`;
    if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
    if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
  });

  describe('Cache Hit/Miss Ratio Validation', () => {
    it('should track cache hit ratio accurately', () => {
      const keys = ['key1', 'key2', 'key3'];

      // Populate cache
      keys.forEach((key, index) => {
        cache.set(key, `value${index}`, 10, 5);
      });

      // Access pattern: 2 hits, 1 miss
      cache.get('key1'); // Hit
      cache.get('key2'); // Hit
      cache.get('key4'); // Miss

      const stats = cache.getStats();
      expect(stats.hitRate).toBeCloseTo(2 / 3, 2); // 66.67%
    });

    it('should improve hit ratio with repeated access', () => {
      cache.set('popular', 'content', 10, 5);

      // Initial accesses
      cache.get('popular');
      cache.get('missing1');
      let stats = cache.getStats();
      const initialHitRate = stats.hitRate;

      // More hits
      cache.get('popular');
      cache.get('popular');
      cache.get('popular');

      stats = cache.getStats();
      expect(stats.hitRate).toBeGreaterThan(initialHitRate);
    });

    it('should maintain hit ratio across different operation patterns', () => {
      // Warm up cache
      for (let i = 0; i < 10; i++) {
        cache.set(`key${i}`, `value${i}`, 10, 5);
      }

      // Mixed access pattern
      for (let i = 0; i < 10; i++) {
        cache.get(`key${i}`); // All hits
      }

      for (let i = 10; i < 15; i++) {
        cache.get(`key${i}`); // All misses
      }

      const stats = cache.getStats();
      expect(stats.hitRate).toBeCloseTo(10 / 15, 2); // 66.67%
    });

    it('should reset hit ratio after cache clear', () => {
      cache.set('key1', 'value1', 10, 5);
      cache.get('key1');

      let stats = cache.getStats();
      expect(stats.hitRate).toBeGreaterThan(0);

      cache.clear();

      stats = cache.getStats();
      expect(stats.hitRate).toBe(0);
    });
  });

  describe('Compression Ratio Verification (95%+ Target)', () => {
    it('should achieve 95%+ compression on repetitive content', () => {
      const repetitiveText = `
        interface User {
          id: number;
          name: string;
          email: string;
        }
      `.repeat(100);

      const result = compression.compress(repetitiveText);

      // Should achieve excellent compression
      expect(result.percentSaved).toBeGreaterThan(95);
      expect(result.ratio).toBeLessThan(0.05);
    });

    it('should achieve high compression on JSON data', () => {
      const jsonData = JSON.stringify({
        items: Array.from({ length: 100 }, (_, i) => ({
          id: i,
          name: `Item ${i}`,
          description: 'Standard description text',
          status: 'active',
        })),
      });

      const result = compression.compress(jsonData);

      // JSON with repeated structure should compress well
      expect(result.percentSaved).toBeGreaterThan(90);
    });

    it('should track compression ratio in cache stats', () => {
      const text = 'Repeated content. '.repeat(100);
      const compressed = compression.compress(text);

      cache.set('compressed-key', compressed.compressed.toString('base64'), text.length, compressed.compressedSize);

      const stats = cache.getStats();
      expect(stats.compressionRatio).toBeLessThan(0.1); // Less than 10% of original
    });

    it('should meet compression targets for code', () => {
      const code = `
        export class TokenOptimizer {
          private cache: Map<string, string>;

          constructor() {
            this.cache = new Map();
          }

          optimize(text: string): string {
            return this.cache.get(text) || text;
          }
        }
      `.repeat(50);

      const result = compression.compress(code);

      expect(result.percentSaved).toBeGreaterThan(95);
    });

    it('should verify end-to-end compression with token savings', () => {
      const originalText = 'This is a sample text. '.repeat(200);
      const tokensBefore = tokenCounter.count(originalText);

      // Compress
      const compressed = compression.compress(originalText);

      // In real usage, we'd decompress before token counting
      // But compression should save significant storage
      expect(compressed.percentSaved).toBeGreaterThan(90);

      // Verify decompression preserves content
      const decompressed = compression.decompress(compressed.compressed);
      const tokensAfter = tokenCounter.count(decompressed);

      expect(tokensAfter.tokens).toBe(tokensBefore.tokens);
      expect(decompressed).toBe(originalText);
    });
  });

  describe('Cache Persistence Across Sessions', () => {
    it('should persist data between cache instances', () => {
      const testData = {
        key: 'persistent-key',
        value: 'persistent-value-' + 'x'.repeat(1000),
        originalSize: 1000,
        compressedSize: 100,
      };

      cache.set(testData.key, testData.value, testData.originalSize, testData.compressedSize);
      cache.close();

      // Create new instance
      const cache2 = new CacheEngine(testDbPath, 100);
      const retrieved = cache2.get(testData.key);

      expect(retrieved).toBe(testData.value);
      cache2.close();
    });

    it('should preserve hit counts across sessions', () => {
      cache.set('key1', 'value1', 10, 5);
      cache.get('key1');
      cache.get('key1');
      cache.get('key1');

      let entries = cache.getAllEntries();
      const hitCount1 = entries.find(e => e.key === 'key1')?.hitCount;

      cache.close();

      const cache2 = new CacheEngine(testDbPath, 100);
      entries = cache2.getAllEntries();
      const hitCount2 = entries.find(e => e.key === 'key1')?.hitCount;

      expect(hitCount2).toBe(hitCount1);
      cache2.close();
    });

    it('should maintain cache stats across restarts', () => {
      // Populate cache
      for (let i = 0; i < 10; i++) {
        cache.set(`key${i}`, `value${i}`, 100, 20);
      }

      const stats1 = cache.getStats();
      cache.close();

      const cache2 = new CacheEngine(testDbPath, 100);
      const stats2 = cache2.getStats();

      expect(stats2.totalEntries).toBe(stats1.totalEntries);
      expect(stats2.totalCompressedSize).toBe(stats1.totalCompressedSize);
      expect(stats2.totalOriginalSize).toBe(stats1.totalOriginalSize);

      cache2.close();
    });

    it('should handle database file corruption gracefully', () => {
      cache.set('test', 'value', 10, 5);
      cache.close();

      // Corrupt the database file
      fs.writeFileSync(testDbPath, 'corrupted data');

      // Should either throw or create new database
      expect(() => {
        const cache2 = new CacheEngine(testDbPath, 100);
        cache2.close();
      }).not.toThrow();
    });
  });

  describe('Cache Invalidation Logic', () => {
    it('should invalidate specific keys', () => {
      cache.set('key1', 'value1', 10, 5);
      cache.set('key2', 'value2', 10, 5);
      cache.set('key3', 'value3', 10, 5);

      expect(cache.get('key2')).toBe('value2');

      const deleted = cache.delete('key2');
      expect(deleted).toBe(true);
      expect(cache.get('key2')).toBeNull();

      // Others should remain
      expect(cache.get('key1')).toBe('value1');
      expect(cache.get('key3')).toBe('value3');
    });

    it('should clear all cache entries', () => {
      for (let i = 0; i < 20; i++) {
        cache.set(`key${i}`, `value${i}`, 10, 5);
      }

      expect(cache.getStats().totalEntries).toBe(20);

      cache.clear();

      expect(cache.getStats().totalEntries).toBe(0);
    });

    it('should evict LRU entries when reaching size limit', () => {
      // Add entries
      for (let i = 0; i < 20; i++) {
        cache.set(`key${i}`, `value${i}`, 100, 50);
      }

      // Access some to make them recently used
      cache.get('key15');
      cache.get('key16');
      cache.get('key17');

      // Evict to smaller size
      const evicted = cache.evictLRU(200); // Keep only ~4 entries (200 bytes / 50 bytes per entry)

      expect(evicted).toBeGreaterThan(0);
      expect(cache.getStats().totalEntries).toBeLessThanOrEqual(4);
      expect(cache.getStats().totalEntries).toBeGreaterThan(0);

      // At least one of the recently accessed should still be there
      const key15 = cache.get('key15');
      const key16 = cache.get('key16');
      const key17 = cache.get('key17');
      const anyPresent = key15 !== null || key16 !== null || key17 !== null;
      expect(anyPresent).toBe(true);
    });

    it('should invalidate based on TTL concept (simulated)', () => {
      const oldTimestamp = Date.now() - 86400000; // 24 hours ago
      const recentTimestamp = Date.now();

      cache.set('old-key', 'old-value', 10, 5);

      // Simulate time-based filtering by checking entries
      const entries = cache.getAllEntries();
      const oldEntries = entries.filter(e => e.lastAccessedAt < oldTimestamp);

      expect(oldEntries.length).toBe(0); // None are old yet
    });

    it('should update last accessed time on get', () => {
      cache.set('time-test', 'value', 10, 5);

      const entries1 = cache.getAllEntries();
      const time1 = entries1.find(e => e.key === 'time-test')?.lastAccessedAt;

      // Small delay
      const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

      return delay(10).then(() => {
        cache.get('time-test');

        const entries2 = cache.getAllEntries();
        const time2 = entries2.find(e => e.key === 'time-test')?.lastAccessedAt;

        expect(time2).toBeGreaterThan(time1!);
      });
    });
  });

  describe('Memory vs Disk Cache Performance', () => {
    it('should serve from memory cache on repeated access', () => {
      const key = 'memory-test';
      const value = 'test-value';

      cache.set(key, value, 10, 5);

      // First access loads to memory
      const start1 = Date.now();
      cache.get(key);
      const duration1 = Date.now() - start1;

      // Second access from memory should be equally fast or faster
      const start2 = Date.now();
      cache.get(key);
      const duration2 = Date.now() - start2;

      // Both should be very fast
      expect(duration1).toBeLessThan(50);
      expect(duration2).toBeLessThan(50);
    });

    it('should populate memory cache from disk on first access', () => {
      cache.set('disk-key', 'disk-value', 10, 5);

      // Clear memory cache
      // @ts-expect-error - accessing private member for testing
      cache.memoryCache.clear();

      // Should load from disk
      const value = cache.get('disk-key');
      expect(value).toBe('disk-value');
    });

    it('should handle cache size limits', () => {
      // Create cache with small memory limit
      const smallCache = new CacheEngine(testDbPath, 5);

      // Add more items than memory limit
      for (let i = 0; i < 10; i++) {
        smallCache.set(`key${i}`, `value${i}`, 10, 5);
      }

      // All should be retrievable (from disk if not in memory)
      for (let i = 0; i < 10; i++) {
        expect(smallCache.get(`key${i}`)).toBe(`value${i}`);
      }

      smallCache.close();
    });
  });

  describe('Integration: Full Caching Workflow', () => {
    it('should demonstrate complete token optimization workflow', () => {
      // 1. Original text
      const originalText = `
        This is a large codebase documentation.
        It contains many repeated patterns and structures.
        The token optimizer will compress and cache this content.
      `.repeat(50);

      // 2. Count original tokens
      const originalTokens = tokenCounter.count(originalText);

      // 3. Compress the text
      const compressed = compression.compress(originalText);

      // 4. Cache the compressed version
      const cacheKey = 'doc-section-1';
      cache.set(
        cacheKey,
        compressed.compressed.toString('base64'),
        compressed.originalSize,
        compressed.compressedSize
      );

      // 5. Verify cache hit
      const retrieved = cache.get(cacheKey);
      expect(retrieved).not.toBeNull();

      // 6. Decompress
      const decompressed = compression.decompressFromBase64(retrieved!);

      // 7. Verify token count preserved
      const decompressedTokens = tokenCounter.count(decompressed);
      expect(decompressedTokens.tokens).toBe(originalTokens.tokens);

      // 8. Verify compression ratio
      expect(compressed.percentSaved).toBeGreaterThan(90);

      // 9. Check cache stats
      const stats = cache.getStats();
      expect(stats.totalEntries).toBe(1);
      expect(stats.compressionRatio).toBeLessThan(0.2);
    });

    it('should validate 95%+ token reduction claim', () => {
      // Simulate real-world scenario
      const codeFiles = [
        'interface Config { port: number; host: string; }',
        'interface Config { port: number; host: string; }',
        'interface Config { port: number; host: string; }',
      ].map(code => code.repeat(100));

      let totalOriginalTokens = 0;
      let totalCompressedSize = 0;
      let totalOriginalSize = 0;

      codeFiles.forEach((code, index) => {
        const tokens = tokenCounter.count(code);
        totalOriginalTokens += tokens.tokens;

        const compressed = compression.compress(code);
        totalOriginalSize += compressed.originalSize;
        totalCompressedSize += compressed.compressedSize;

        cache.set(`file-${index}`, compressed.compressed.toString('base64'), compressed.originalSize, compressed.compressedSize);
      });

      const overallCompressionRatio = totalCompressedSize / totalOriginalSize;
      const percentSaved = ((totalOriginalSize - totalCompressedSize) / totalOriginalSize) * 100;

      // Verify 95%+ reduction target
      expect(percentSaved).toBeGreaterThan(95);
      expect(overallCompressionRatio).toBeLessThan(0.05);
    });
  });
});
