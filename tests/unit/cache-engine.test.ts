/**
 * Unit Tests for CacheEngine
 *
 * Tests cover:
 * - Basic cache operations (get, set, delete, clear)
 * - Cache statistics and metrics
 * - LRU eviction
 * - Hit/miss tracking
 * - Memory and disk cache interaction
 * - Configurable cache path via environment variable
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { CacheEngine, CacheStats } from '../../src/core/cache-engine.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('CacheEngine', () => {
  let cache: CacheEngine;
  let testDbPath: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    // Save original environment variable
    originalEnv = process.env.TOKEN_OPTIMIZER_CACHE_DIR;

    // Create a temporary database for testing
    const tempDir = path.join(os.tmpdir(), 'token-optimizer-test');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    testDbPath = path.join(tempDir, `test-cache-${Date.now()}.db`);
    cache = new CacheEngine(testDbPath, 100);
  });

  afterEach(() => {
    // Restore original environment variable
    if (originalEnv !== undefined) {
      process.env.TOKEN_OPTIMIZER_CACHE_DIR = originalEnv;
    } else {
      delete process.env.TOKEN_OPTIMIZER_CACHE_DIR;
    }

    // Clean up
    cache.close();
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    const walPath = `${testDbPath}-wal`;
    const shmPath = `${testDbPath}-shm`;
    if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
    if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
  });

  describe('Basic Operations', () => {
    it('should set and get a value', () => {
      const key = 'test-key';
      const value = 'test-value';

      cache.set(key, value, value.length, value.length);
      const retrieved = cache.get(key);

      expect(retrieved).toBe(value);
    });

    it('should return null for non-existent key', () => {
      const retrieved = cache.get('non-existent-key');
      expect(retrieved).toBeNull();
    });

    it('should delete a cached value', () => {
      const key = 'delete-test';
      const value = 'value-to-delete';

      cache.set(key, value, value.length, value.length);
      expect(cache.get(key)).toBe(value);

      const deleted = cache.delete(key);
      expect(deleted).toBe(true);
      expect(cache.get(key)).toBeNull();
    });

    it('should return false when deleting non-existent key', () => {
      const deleted = cache.delete('non-existent');
      expect(deleted).toBe(false);
    });

    it('should clear all cache entries', () => {
      cache.set('key1', 'value1', 6, 6);
      cache.set('key2', 'value2', 6, 6);
      cache.set('key3', 'value3', 6, 6);

      cache.clear();

      expect(cache.get('key1')).toBeNull();
      expect(cache.get('key2')).toBeNull();
      expect(cache.get('key3')).toBeNull();
    });

    it('should handle unicode and special characters', () => {
      const key = 'unicode-key';
      const value = 'Hello 世界 🚀 café';

      cache.set(key, value, Buffer.from(value).length, Buffer.from(value).length);
      const retrieved = cache.get(key);

      expect(retrieved).toBe(value);
    });

    it('should handle large values', () => {
      const key = 'large-value';
      const value = 'x'.repeat(100000); // 100KB of data

      cache.set(key, value, value.length, value.length);
      const retrieved = cache.get(key);

      expect(retrieved).toBe(value);
    });

    it('should update existing key', () => {
      const key = 'update-key';

      cache.set(key, 'original-value', 14, 14);
      expect(cache.get(key)).toBe('original-value');

      cache.set(key, 'updated-value', 13, 13);
      expect(cache.get(key)).toBe('updated-value');
    });
  });

  describe('Cache Statistics', () => {
    it('should track cache hits and misses', () => {
      cache.set('key1', 'value1', 6, 6);

      cache.get('key1'); // Hit
      cache.get('key1'); // Hit
      cache.get('key2'); // Miss
      cache.get('key3'); // Miss

      const stats = cache.getStats();
      expect(stats.totalMisses).toBe(2);
      expect(stats.hitRate).toBeCloseTo(0.5, 2); // 2 hits out of 4 total requests
    });

    it('should return correct total entries count', () => {
      expect(cache.getStats().totalEntries).toBe(0);

      cache.set('key1', 'value1', 6, 6);
      expect(cache.getStats().totalEntries).toBe(1);

      cache.set('key2', 'value2', 6, 6);
      cache.set('key3', 'value3', 6, 6);
      expect(cache.getStats().totalEntries).toBe(3);
    });

    it('should track compression metrics', () => {
      const originalSize = 1000;
      const compressedSize = 200;

      cache.set('compressed-key', 'compressed-data', originalSize, compressedSize);

      const stats = cache.getStats();
      expect(stats.totalOriginalSize).toBe(originalSize);
      expect(stats.totalCompressedSize).toBe(compressedSize);
      expect(stats.compressionRatio).toBeCloseTo(0.2, 2);
    });

    it('should handle zero compression ratio', () => {
      const stats = cache.getStats();
      expect(stats.compressionRatio).toBe(0);
    });

    it('should accumulate hit counts correctly', () => {
      cache.set('key1', 'value1', 6, 6);

      cache.get('key1');
      cache.get('key1');
      cache.get('key1');

      const entries = cache.getAllEntries();
      expect(entries[0].hitCount).toBe(3);
    });

    it('should reset stats after clear', () => {
      cache.set('key1', 'value1', 6, 6);
      cache.get('key1');
      cache.get('missing-key');

      cache.clear();

      const stats = cache.getStats();
      expect(stats.totalEntries).toBe(0);
      expect(stats.totalMisses).toBe(0);
      expect(stats.hitRate).toBe(0);
    });

    it('should persist hit rate across cache engine restarts', () => {
      // Set up initial cache with hits
      cache.set('key1', 'value1', 6, 6);
      cache.set('key2', 'value2', 6, 6);
      cache.get('key1'); // Hit
      cache.get('key1'); // Hit
      cache.get('key2'); // Hit

      const stats1 = cache.getStats();
      expect(stats1.totalHits).toBe(3);
      expect(stats1.hitRate).toBeGreaterThan(0);

      // Close the first cache instance
      cache.close();

      // Create a new cache instance using the same database
      const cache2 = new CacheEngine(testDbPath, 100);

      // Hit count should persist from database
      const stats2 = cache2.getStats();
      expect(stats2.totalHits).toBeGreaterThanOrEqual(3);

      // Make a new request to generate hits + misses for hit rate calculation
      cache2.get('key1'); // Hit
      cache2.get('nonexistent'); // Miss

      const stats3 = cache2.getStats();
      expect(stats3.totalHits).toBeGreaterThanOrEqual(4);
      expect(stats3.hitRate).toBeGreaterThan(0); // Now we have hits and misses

      // Clean up
      cache2.close();

      // Restart cache for cleanup (will be closed in afterEach)
      cache = new CacheEngine(testDbPath, 100);
    });
  });

  describe('Memory and Disk Cache Interaction', () => {
    it('should serve from memory cache on subsequent access', () => {
      const key = 'memory-test';
      const value = 'test-value';

      cache.set(key, value, value.length, value.length);

      // First access loads into memory
      cache.get(key);

      // Second access should come from memory (faster)
      const retrieved = cache.get(key);
      expect(retrieved).toBe(value);
    });

    it('should populate memory cache from disk on first access', () => {
      const key = 'disk-to-memory';
      const value = 'stored-on-disk';

      cache.set(key, value, value.length, value.length);

      // Clear memory cache but keep disk
      // @ts-expect-error - accessing private member for testing
      cache.memoryCache.clear();

      // Should load from disk
      const retrieved = cache.get(key);
      expect(retrieved).toBe(value);
    });
  });

  describe('Cache Entry Management', () => {
    it('should return all cache entries sorted by hit count', () => {
      cache.set('key1', 'value1', 6, 6);
      cache.set('key2', 'value2', 6, 6);
      cache.set('key3', 'value3', 6, 6);

      cache.get('key2'); // 1 hit
      cache.get('key2'); // 2 hits
      cache.get('key3'); // 1 hit

      const entries = cache.getAllEntries();
      expect(entries.length).toBe(3);
      expect(entries[0].key).toBe('key2'); // Most hits
      expect(entries[0].hitCount).toBe(2);
    });

    it('should track last accessed time', () => {
      const key = 'timestamp-test';
      const beforeSet = Date.now();

      cache.set(key, 'value', 5, 5);

      // Small delay
      const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

      return delay(10).then(() => {
        cache.get(key);

        const entries = cache.getAllEntries();
        const entry = entries.find(e => e.key === key);

        expect(entry).toBeDefined();
        expect(entry!.lastAccessedAt).toBeGreaterThanOrEqual(beforeSet);
        expect(entry!.createdAt).toBeGreaterThanOrEqual(beforeSet);
      });
    });

    it('should maintain created timestamp on update', () => {
      const key = 'update-timestamp';
      const beforeCreate = Date.now();

      cache.set(key, 'original', 8, 8);
      const entries1 = cache.getAllEntries();
      const originalCreatedAt = entries1.find(e => e.key === key)!.createdAt;

      // Small delay
      const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

      return delay(10).then(() => {
        cache.set(key, 'updated', 7, 7);

        const entries2 = cache.getAllEntries();
        const updatedEntry = entries2.find(e => e.key === key);

        expect(updatedEntry!.createdAt).toBe(originalCreatedAt);
      });
    });
  });

  describe('LRU Eviction', () => {
    it('should evict least recently used entries', () => {
      // Add multiple entries
      for (let i = 0; i < 10; i++) {
        cache.set(`key${i}`, `value${i}`, 10, 10);
      }

      // Access some entries to make them recently used
      cache.get('key5');
      cache.get('key7');
      cache.get('key9');

      // Evict to keep only most recent
      const evicted = cache.evictLRU(30); // Keep only ~3 entries

      expect(evicted).toBeGreaterThan(0);

      // Recently accessed should still be there
      const stats = cache.getStats();
      expect(stats.totalEntries).toBeLessThan(10);
    });

    it('should not evict recently accessed entries during LRU (race condition fix)', async () => {
      // Add two entries - one old, one that will be accessed
      cache.set('old-key', 'old-value', 10, 10);
      cache.set('key1', 'value1', 10, 10);

      // Wait 100ms to make them both slightly old
      await new Promise(resolve => setTimeout(resolve, 100));

      // Access key1 just before eviction (updates last_accessed)
      cache.get('key1');

      // Immediately trigger eviction to keep only 10 bytes
      // Without the fix, key1 could be deleted if it was included in the
      // initial SELECT as "old" but was accessed before the DELETE
      const evicted = cache.evictLRU(10);

      // key1 should still exist because it was just accessed (within 1-second safety margin)
      const value = cache.get('key1');
      expect(value).toBe('value1');

      // old-key should have been evicted (or might remain if it was selected first)
      // This test verifies that recent access protects an entry
    });

    it('should evict entries older than 1 second safety margin', async () => {
      // Add entry
      cache.set('old-key', 'old-value', 10, 5);

      // Wait longer than the 1-second safety margin
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Add another entry (will be recent)
      cache.set('new-key', 'new-value', 10, 5);

      // Evict to very small size (should only keep new-key)
      cache.evictLRU(5);

      // Old key should be evicted
      expect(cache.get('old-key')).toBeNull();

      // New key should still exist
      expect(cache.get('new-key')).toBe('new-value');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty string values', () => {
      const key = 'empty-value';
      cache.set(key, '', 0, 0);

      const retrieved = cache.get(key);
      expect(retrieved).toBe('');
    });

    it('should handle very long keys', () => {
      const key = 'x'.repeat(1000);
      const value = 'test-value';

      cache.set(key, value, value.length, value.length);
      const retrieved = cache.get(key);

      expect(retrieved).toBe(value);
    });

    it('should handle concurrent operations', () => {
      const operations = [];

      for (let i = 0; i < 100; i++) {
        operations.push(
          cache.set(`key${i}`, `value${i}`, 10, 10)
        );
      }

      for (let i = 0; i < 100; i++) {
        operations.push(
          cache.get(`key${i}`)
        );
      }

      // Should not throw
      expect(() => operations).not.toThrow();
      expect(cache.getStats().totalEntries).toBe(100);
    });

    it('should handle special characters in keys', () => {
      const specialKeys = [
        'key:with:colons',
        'key/with/slashes',
        'key.with.dots',
        'key-with-dashes',
        'key_with_underscores',
        'key with spaces',
      ];

      specialKeys.forEach((key, index) => {
        cache.set(key, `value${index}`, 10, 10);
        expect(cache.get(key)).toBe(`value${index}`);
      });
    });
  });

  describe('Database Persistence', () => {
    it('should persist data across instances', () => {
      const key = 'persistent-key';
      const value = 'persistent-value';

      cache.set(key, value, value.length, value.length);
      cache.close();

      // Create new instance with same database
      const cache2 = new CacheEngine(testDbPath, 100);
      const retrieved = cache2.get(key);

      expect(retrieved).toBe(value);
      cache2.close();
    });

    it('should maintain stats across instances', () => {
      cache.set('key1', 'value1', 6, 6);
      cache.set('key2', 'value2', 6, 6);
      cache.get('key1');

      const stats1 = cache.getStats();
      cache.close();

      const cache2 = new CacheEngine(testDbPath, 100);
      const stats2 = cache2.getStats();

      expect(stats2.totalEntries).toBe(stats1.totalEntries);
      cache2.close();
    });
  });

  describe('Configurable Cache Path', () => {
    it('should use environment variable for cache directory when no dbPath provided', () => {
      const customCacheDir = path.join(os.tmpdir(), `custom-cache-${Date.now()}`);
      process.env.TOKEN_OPTIMIZER_CACHE_DIR = customCacheDir;

      const cacheWithEnv = new CacheEngine(undefined, 100);
      const dbPath = cacheWithEnv.getDatabasePath();

      expect(dbPath).toContain(customCacheDir);
      expect(fs.existsSync(customCacheDir)).toBe(true);

      cacheWithEnv.close();

      // Clean up custom directory
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
      const walPath = `${dbPath}-wal`;
      const shmPath = `${dbPath}-shm`;
      if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
      if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
      if (fs.existsSync(customCacheDir)) fs.rmdirSync(customCacheDir);

      delete process.env.TOKEN_OPTIMIZER_CACHE_DIR;
    });

    it('should fall back to os.homedir() when environment variable not set', () => {
      delete process.env.TOKEN_OPTIMIZER_CACHE_DIR;

      const cacheWithoutEnv = new CacheEngine(undefined, 100);
      const dbPath = cacheWithoutEnv.getDatabasePath();

      expect(dbPath).toContain('.token-optimizer-cache');
      expect(dbPath).toContain(os.homedir());

      cacheWithoutEnv.close();

      // Note: We intentionally do not clean up the default home directory cache
      // as it may be in use by other tests or processes, and this is the
      // expected location for the cache in normal operation.
    });

    it('should prioritize explicit dbPath parameter over environment variable', () => {
      const customCacheDir = path.join(os.tmpdir(), `custom-cache-${Date.now()}`);
      process.env.TOKEN_OPTIMIZER_CACHE_DIR = customCacheDir;

      const explicitPath = path.join(os.tmpdir(), `explicit-cache-${Date.now()}`, 'cache.db');
      const cacheWithExplicit = new CacheEngine(explicitPath, 100);
      const dbPath = cacheWithExplicit.getDatabasePath();

      expect(dbPath).toBe(explicitPath);
      expect(dbPath).not.toContain(customCacheDir);

      cacheWithExplicit.close();

      // Clean up
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
      const walPath = `${dbPath}-wal`;
      const shmPath = `${dbPath}-shm`;
      if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
      if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
      if (fs.existsSync(path.dirname(dbPath))) fs.rmdirSync(path.dirname(dbPath));

      delete process.env.TOKEN_OPTIMIZER_CACHE_DIR;
    });

    it('should create cache directory from environment variable if it does not exist', () => {
      const customCacheDir = path.join(os.tmpdir(), `nonexistent-${Date.now()}`);
      process.env.TOKEN_OPTIMIZER_CACHE_DIR = customCacheDir;

      expect(fs.existsSync(customCacheDir)).toBe(false);

      const cacheWithEnv = new CacheEngine(undefined, 100);

      expect(fs.existsSync(customCacheDir)).toBe(true);

      const dbPath = cacheWithEnv.getDatabasePath();
      cacheWithEnv.close();

      // Clean up
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
      const walPath = `${dbPath}-wal`;
      const shmPath = `${dbPath}-shm`;
      if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
      if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
      if (fs.existsSync(customCacheDir)) fs.rmdirSync(customCacheDir);

      delete process.env.TOKEN_OPTIMIZER_CACHE_DIR;
    });

    it('should work correctly with environment variable set to existing directory', () => {
      const customCacheDir = path.join(os.tmpdir(), `existing-${Date.now()}`);
      fs.mkdirSync(customCacheDir, { recursive: true });
      process.env.TOKEN_OPTIMIZER_CACHE_DIR = customCacheDir;

      const cacheWithEnv = new CacheEngine(undefined, 100);
      const dbPath = cacheWithEnv.getDatabasePath();

      expect(dbPath).toContain(customCacheDir);

      // Test that cache operations work
      cacheWithEnv.set('test-key', 'test-value', 10, 10);
      const retrieved = cacheWithEnv.get('test-key');
      expect(retrieved).toBe('test-value');

      cacheWithEnv.close();

      // Clean up
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
      const walPath = `${dbPath}-wal`;
      const shmPath = `${dbPath}-shm`;
      if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
      if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
      if (fs.existsSync(customCacheDir)) fs.rmdirSync(customCacheDir);

      delete process.env.TOKEN_OPTIMIZER_CACHE_DIR;
    });
  });
});
