import { InMemoryVectorStore } from '../../src/core/InMemoryVectorStore.js';

describe('InMemoryVectorStore', () => {
  let store: InMemoryVectorStore;

  beforeEach(() => {
    store = new InMemoryVectorStore();
  });

  it('should add and retrieve vectors', async () => {
    const vector = [0.1, 0.2, 0.3, 0.4];
    await store.add('key1', vector);

    const size = await store.size();
    expect(size).toBe(1);
  });

  it('should search for similar vectors', async () => {
    // Add some test vectors
    await store.add('key1', [1, 0, 0, 0]);
    await store.add('key2', [0, 1, 0, 0]);
    await store.add('key3', [0.9, 0.1, 0, 0]); // Similar to key1

    // Search for similar to key1
    const results = await store.search([1, 0, 0, 0], 5, 0.7);

    expect(results.length).toBeGreaterThan(0);
    // First result should be exact match (key1)
    expect(results[0].id).toBe('key1');
    expect(results[0].similarity).toBeCloseTo(1.0, 5);

    // Second result should be key3 (similar)
    const key3Result = results.find(r => r.id === 'key3');
    expect(key3Result).toBeDefined();
    expect(key3Result!.similarity).toBeGreaterThan(0.7);
  });

  it('should respect similarity threshold', async () => {
    await store.add('key1', [1, 0, 0, 0]);
    await store.add('key2', [0, 1, 0, 0]); // Orthogonal vector (similarity = 0)

    // Search with high threshold
    const results = await store.search([1, 0, 0, 0], 5, 0.8);

    // Only key1 should match (similarity = 1.0)
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('key1');
  });

  it('should respect topK parameter', async () => {
    // Add 5 similar vectors
    await store.add('key1', [1, 0, 0, 0]);
    await store.add('key2', [0.9, 0.1, 0, 0]);
    await store.add('key3', [0.8, 0.2, 0, 0]);
    await store.add('key4', [0.7, 0.3, 0, 0]);
    await store.add('key5', [0.6, 0.4, 0, 0]);

    // Search with topK = 3
    const results = await store.search([1, 0, 0, 0], 3, 0.5);

    // Should return at most 3 results
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('should return results sorted by similarity', async () => {
    await store.add('key1', [1, 0, 0, 0]);
    await store.add('key2', [0.5, 0.5, 0, 0]);
    await store.add('key3', [0.9, 0.1, 0, 0]);

    const results = await store.search([1, 0, 0, 0], 5, 0.4);

    // Results should be sorted by similarity (descending)
    for (let i = 0; i < results.length - 1; i++) {
      expect(results[i].similarity).toBeGreaterThanOrEqual(results[i + 1].similarity);
    }
  });

  it('should delete vectors', async () => {
    await store.add('key1', [1, 0, 0, 0]);
    await store.add('key2', [0, 1, 0, 0]);

    let size = await store.size();
    expect(size).toBe(2);

    await store.delete('key1');

    size = await store.size();
    expect(size).toBe(1);

    // Deleted vector should not appear in search
    const results = await store.search([1, 0, 0, 0], 5, 0.0);
    expect(results.find(r => r.id === 'key1')).toBeUndefined();
  });

  it('should clear all vectors', async () => {
    await store.add('key1', [1, 0, 0, 0]);
    await store.add('key2', [0, 1, 0, 0]);
    await store.add('key3', [0, 0, 1, 0]);

    let size = await store.size();
    expect(size).toBe(3);

    await store.clear();

    size = await store.size();
    expect(size).toBe(0);
  });

  it('should handle empty store searches', async () => {
    const results = await store.search([1, 0, 0, 0], 5, 0.5);
    expect(results).toEqual([]);
  });

  it('should update vectors when adding with same ID', async () => {
    await store.add('key1', [1, 0, 0, 0]);
    await store.add('key1', [0, 1, 0, 0]); // Update with different vector

    const size = await store.size();
    expect(size).toBe(1); // Should still be 1 entry

    // Search should find the updated vector
    const results = await store.search([0, 1, 0, 0], 5, 0.9);
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('key1');
  });

  it('should throw error on dimension mismatch', async () => {
    await store.add('key1', [1, 0, 0, 0]);

    // Try to search with different dimensions
    await expect(
      store.search([1, 0, 0], 5, 0.5) // 3D vector instead of 4D
    ).rejects.toThrow(/dimension mismatch/i);
  });

  it('should calculate cosine similarity correctly', async () => {
    // Test with known vectors
    await store.add('same', [1, 0, 0]);
    await store.add('opposite', [-1, 0, 0]);
    await store.add('orthogonal', [0, 1, 0]);

    const results = await store.search([1, 0, 0], 3, -1.0); // Include all

    const same = results.find(r => r.id === 'same');
    const opposite = results.find(r => r.id === 'opposite');
    const orthogonal = results.find(r => r.id === 'orthogonal');

    expect(same!.similarity).toBeCloseTo(1.0, 5);
    expect(opposite!.similarity).toBeCloseTo(-1.0, 5);
    expect(orthogonal!.similarity).toBeCloseTo(0.0, 5);
  });

  it('should handle zero vectors gracefully', async () => {
    await store.add('zero', [0, 0, 0, 0]);
    await store.add('nonzero', [1, 0, 0, 0]);

    // Search with zero vector
    const results = await store.search([0, 0, 0, 0], 5, -1.0);

    // Should not crash, but zero vector has 0 similarity with everything
    expect(results.every(r => r.similarity === 0)).toBe(true);
  });
});
