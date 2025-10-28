/**
 * Interface for generating vector embeddings from text
 * Used for semantic similarity matching in cache lookups
 */
export interface IEmbeddingGenerator {
  /**
   * Generate a vector embedding for the given text
   * @param text - The input text to generate an embedding for
   * @returns A promise that resolves to a numerical vector representation
   */
  generateEmbedding(text: string): Promise<number[]>;

  /**
   * Get the dimensionality of the embeddings produced by this generator
   * @returns The number of dimensions in the embedding vectors
   */
  getDimensions(): number;
}
