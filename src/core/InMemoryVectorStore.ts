import { IVectorStore } from '../interfaces/IVectorStore.js';

/**
 * An in-memory vector store implementation using cosine similarity
 * Stores vectors in memory for fast similarity search
 */
export class InMemoryVectorStore implements IVectorStore {
  private vectors: Map<string, number[]>;

  constructor() {
    this.vectors = new Map();
  }

  /**
   * Add a vector to the store
   */
  async add(id: string, vector: number[]): Promise<void> {
    this.vectors.set(id, vector);
  }

  /**
   * Search for similar vectors using cosine similarity
   * Returns results sorted by similarity (highest first)
   */
  async search(
    queryVector: number[],
    topK: number,
    threshold: number
  ): Promise<Array<{ id: string; similarity: number }>> {
    const results: Array<{ id: string; similarity: number }> = [];

    // Compute similarity for each stored vector
    for (const [id, vector] of this.vectors.entries()) {
      const similarity = this.cosineSimilarity(queryVector, vector);

      // Only include results above the threshold
      if (similarity >= threshold) {
        results.push({ id, similarity });
      }
    }

    // Sort by similarity (descending) and take top K
    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, topK);
  }

  /**
   * Delete a vector from the store
   */
  async delete(id: string): Promise<void> {
    this.vectors.delete(id);
  }

  /**
   * Get the total number of vectors in the store
   */
  async size(): Promise<number> {
    return this.vectors.size;
  }

  /**
   * Clear all vectors from the store
   */
  async clear(): Promise<void> {
    this.vectors.clear();
  }

  /**
   * Compute cosine similarity between two vectors
   * Returns a value between -1 and 1 (1 = identical, 0 = orthogonal, -1 = opposite)
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error(
        `Vector dimension mismatch: ${a.length} vs ${b.length}`
      );
    }

    let dotProduct = 0;
    let magnitudeA = 0;
    let magnitudeB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      magnitudeA += a[i] * a[i];
      magnitudeB += b[i] * b[i];
    }

    magnitudeA = Math.sqrt(magnitudeA);
    magnitudeB = Math.sqrt(magnitudeB);

    // Avoid division by zero
    if (magnitudeA === 0 || magnitudeB === 0) {
      return 0;
    }

    return dotProduct / (magnitudeA * magnitudeB);
  }
}
