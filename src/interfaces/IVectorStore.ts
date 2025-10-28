/**
 * Interface for storing and searching vector embeddings
 * Enables semantic similarity search for cache entries
 */
export interface IVectorStore {
  /**
   * Add a vector to the store with an associated ID
   * @param id - Unique identifier (typically the cache key)
   * @param vector - The embedding vector to store
   * @returns A promise that resolves when the vector is stored
   */
  add(id: string, vector: number[]): Promise<void>;

  /**
   * Search for similar vectors in the store
   * @param vector - The query vector to search for
   * @param topK - Maximum number of results to return
   * @param threshold - Minimum similarity score (0-1) to include in results
   * @returns A promise that resolves to an array of matching entries with similarity scores
   */
  search(
    vector: number[],
    topK: number,
    threshold: number
  ): Promise<Array<{ id: string; similarity: number }>>;

  /**
   * Delete a vector from the store
   * @param id - The ID of the vector to delete
   * @returns A promise that resolves when the vector is deleted
   */
  delete(id: string): Promise<void>;

  /**
   * Get the total number of vectors in the store
   * @returns A promise that resolves to the count of stored vectors
   */
  size(): Promise<number>;

  /**
   * Clear all vectors from the store
   * @returns A promise that resolves when all vectors are cleared
   */
  clear(): Promise<void>;
}
