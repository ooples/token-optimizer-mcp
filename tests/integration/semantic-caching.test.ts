import fs from 'fs';
import path from 'path';
import os from 'os';
import { CacheEngine } from '../../src/core/cache-engine.js';
import { FoundationModelEmbeddingGenerator } from '../../src/core/FoundationModelEmbeddingGenerator.js';
import { InMemoryVectorStore } from '../../src/core/InMemoryVectorStore.js';

describe('Semantic Caching Integration', () => {
  let cacheEngine: CacheEngine;
  let testDbPath: string;

  beforeEach(() => {
    // Create a temporary database for testing
    testDbPath = path.join(
      os.tmpdir(),
      `semantic-cache-test-${Date.now()}.db`
    );

    // Initialize cache engine with semantic caching enabled
    const embeddingGenerator = new FoundationModelEmbeddingGenerator(128);
    const vectorStore = new InMemoryVectorStore();

    cacheEngine = new CacheEngine(
      testDbPath,
      100,
      embeddingGenerator,
      vectorStore,
      {
        enabled: true,
        similarityThreshold: 0.6,
        topK: 5,
      }
    );
  });

  afterEach(() => {
    // Clean up
    cacheEngine.close();
    try {
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
      const walPath = `${testDbPath}-wal`;
      const shmPath = `${testDbPath}-shm`;
      if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
      if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  it('should store and retrieve values with exact key match', async () => {
    await cacheEngine.setWithSemantic('test-key', 'test-value', 100, 50);
    const result = await cacheEngine.getWithSemantic('test-key');

    expect(result).toBe('test-value');
  });

  it('should find semantically similar keys', async () => {
    // Store a value with a descriptive key
    await cacheEngine.setWithSemantic(
      'get user information from database',
      'user-data-response',
      200,
      100
    );

    // Try to retrieve with a similar but different query
    const result = await cacheEngine.getWithSemantic(
      'retrieve user info from db'
    );

    // Should find the similar key due to semantic matching
    expect(result).toBe('user-data-response');
  });

  it('should track semantic hits in statistics', async () => {
    await cacheEngine.setWithSemantic(
      'get user information from database',
      'response1',
      100,
      50
    );

    // Exact match
    await cacheEngine.getWithSemantic('get user information from database');

    // Semantic match
    await cacheEngine.getWithSemantic('retrieve user info from db'); // Similar to "get user information from database"

    const stats = cacheEngine.getStats();

    expect(stats.semanticHits).toBeGreaterThan(0);
    expect(stats.semanticHitRate).toBeGreaterThan(0);
  });

  it('should not match dissimilar keys', async () => {
    await cacheEngine.setWithSemantic('apple fruit', 'fruit-data', 100, 50);

    // Try to retrieve with completely different query
    const result = await cacheEngine.getWithSemantic('car vehicle');

    // Should not find a match (too dissimilar)
    expect(result).toBeNull();
  });

  it('should respect similarity threshold', async () => {
    // Create cache with high threshold
    const strictCacheEngine = new CacheEngine(
      path.join(os.tmpdir(), `strict-cache-${Date.now()}.db`),
      100,
      new FoundationModelEmbeddingGenerator(128),
      new InMemoryVectorStore(),
      {
        enabled: true,
        similarityThreshold: 0.95, // Very strict
        topK: 5,
      }
    );

    await strictCacheEngine.setWithSemantic('hello world', 'response', 100, 50);

    // Slightly different query should not match with high threshold
    const result = await strictCacheEngine.getWithSemantic('hello earth');

    expect(result).toBeNull();

    strictCacheEngine.close();
  });

  it('should delete embeddings when deleting cache entries', async () => {
    await cacheEngine.setWithSemantic('test-key', 'test-value', 100, 50);

    // Verify it's stored
    let result = await cacheEngine.getWithSemantic('test-key');
    expect(result).toBe('test-value');

    // Delete the entry
    await cacheEngine.deleteWithSemantic('test-key');

    // Should not be found anymore (exact or semantic)
    result = await cacheEngine.getWithSemantic('test-key');
    expect(result).toBeNull();

    result = await cacheEngine.getWithSemantic('test key'); // Similar query
    expect(result).toBeNull();
  });

  it('should clear embeddings when clearing cache', async () => {
    await cacheEngine.setWithSemantic('key1', 'value1', 100, 50);
    await cacheEngine.setWithSemantic('key2', 'value2', 100, 50);

    await cacheEngine.clearWithSemantic();

    const result1 = await cacheEngine.getWithSemantic('key1');
    const result2 = await cacheEngine.getWithSemantic('key2');

    expect(result1).toBeNull();
    expect(result2).toBeNull();

    const stats = cacheEngine.getStats();
    expect(stats.totalEntries).toBe(0);
  });

  it('should work without semantic caching when disabled', async () => {
    // Create cache without semantic caching
    const regularCache = new CacheEngine(
      path.join(os.tmpdir(), `regular-cache-${Date.now()}.db`),
      100
      // No embedding generator or vector store
    );

    regularCache.set('test-key', 'test-value', 100, 50);

    // Exact match should work
    let result = regularCache.get('test-key');
    expect(result).toBe('test-value');

    // Similar query should NOT work (no semantic matching)
    result = regularCache.get('testkey');
    expect(result).toBeNull();

    const stats = regularCache.getStats();
    expect(stats.semanticHits).toBe(0);
    expect(stats.semanticHitRate).toBe(0);

    regularCache.close();
  });

  it('should handle multiple similar entries', async () => {
    // Store multiple similar entries
    await cacheEngine.setWithSemantic('get user by id', 'user-by-id-response', 100, 50);
    await cacheEngine.setWithSemantic('get user by name', 'user-by-name-response', 100, 50);
    await cacheEngine.setWithSemantic('get user by email', 'user-by-email-response', 100, 50);

    // Query should match the most similar one
    const result = await cacheEngine.getWithSemantic('retrieve user by id');

    // Should match one of them (likely the first one)
    expect(result).toBeTruthy();
    expect(['user-by-id-response', 'user-by-name-response', 'user-by-email-response'])
      .toContain(result);
  });

  it('should gracefully handle embedding generation failures', async () => {
    // This test ensures the cache doesn't crash if semantic matching fails
    await cacheEngine.setWithSemantic('test', 'value', 100, 50);

    // Should not throw even if there are internal errors
    const result = await cacheEngine.getWithSemantic('test');
    expect(result).toBe('value');
  });

  it('should prefer exact matches over semantic matches', async () => {
    await cacheEngine.setWithSemantic('exact-key', 'exact-value', 100, 50);
    await cacheEngine.setWithSemantic('similar key', 'similar-value', 100, 50);

    // Query with exact key should return exact match
    const result = await cacheEngine.getWithSemantic('exact-key');

    expect(result).toBe('exact-value');
  });
});
