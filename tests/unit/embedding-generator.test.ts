import { FoundationModelEmbeddingGenerator } from '../../src/core/FoundationModelEmbeddingGenerator.js';

describe('FoundationModelEmbeddingGenerator', () => {
  it('should generate embeddings with correct dimensions', async () => {
    const generator = new FoundationModelEmbeddingGenerator(128);
    const text = 'Hello, world!';
    const embedding = await generator.generateEmbedding(text);

    expect(embedding).toHaveLength(128);
    expect(generator.getDimensions()).toBe(128);
  });

  it('should generate different embeddings for different texts', async () => {
    const generator = new FoundationModelEmbeddingGenerator(128);
    const text1 = 'This is a test';
    const text2 = 'This is completely different';

    const embedding1 = await generator.generateEmbedding(text1);
    const embedding2 = await generator.generateEmbedding(text2);

    // Embeddings should be different
    const isSame = embedding1.every((val, idx) => val === embedding2[idx]);
    expect(isSame).toBe(false);
  });

  it('should generate similar embeddings for similar texts', async () => {
    const generator = new FoundationModelEmbeddingGenerator(128);
    const text1 = 'Hello world';
    const text2 = 'hello world'; // Same text, different case

    const embedding1 = await generator.generateEmbedding(text1);
    const embedding2 = await generator.generateEmbedding(text2);

    // Calculate cosine similarity
    const similarity = cosineSimilarity(embedding1, embedding2);

    // Similar texts should have high similarity (> 0.9)
    expect(similarity).toBeGreaterThan(0.9);
  });

  it('should generate normalized vectors', async () => {
    const generator = new FoundationModelEmbeddingGenerator(128);
    const text = 'This is a test';
    const embedding = await generator.generateEmbedding(text);

    // Calculate L2 norm (magnitude)
    const magnitude = Math.sqrt(
      embedding.reduce((sum, val) => sum + val * val, 0)
    );

    // Vector should be normalized (magnitude ≈ 1)
    expect(magnitude).toBeCloseTo(1.0, 5);
  });

  it('should handle empty strings', async () => {
    const generator = new FoundationModelEmbeddingGenerator(128);
    const embedding = await generator.generateEmbedding('');

    expect(embedding).toHaveLength(128);
    // All values should be finite numbers
    expect(embedding.every(v => Number.isFinite(v))).toBe(true);
  });

  it('should handle long texts', async () => {
    const generator = new FoundationModelEmbeddingGenerator(128);
    const longText = 'a'.repeat(10000);
    const embedding = await generator.generateEmbedding(longText);

    expect(embedding).toHaveLength(128);
    expect(embedding.every(v => Number.isFinite(v))).toBe(true);
  });

  it('should produce consistent embeddings for the same text', async () => {
    const generator = new FoundationModelEmbeddingGenerator(128);
    const text = 'Consistency test';

    const embedding1 = await generator.generateEmbedding(text);
    const embedding2 = await generator.generateEmbedding(text);

    // Same text should produce identical embeddings
    expect(embedding1).toEqual(embedding2);
  });

  it('should work with different dimensions', async () => {
    const dimensions = [64, 128, 256];

    for (const dim of dimensions) {
      const generator = new FoundationModelEmbeddingGenerator(dim);
      const embedding = await generator.generateEmbedding('Test');

      expect(embedding).toHaveLength(dim);
      expect(generator.getDimensions()).toBe(dim);
    }
  });
});

// Helper function to calculate cosine similarity
function cosineSimilarity(a: number[], b: number[]): number {
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

  if (magnitudeA === 0 || magnitudeB === 0) {
    return 0;
  }

  return dotProduct / (magnitudeA * magnitudeB);
}
