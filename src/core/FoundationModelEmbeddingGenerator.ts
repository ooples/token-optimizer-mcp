import crypto from 'crypto';
import { IEmbeddingGenerator } from '../interfaces/IEmbeddingGenerator.js';

/**
 * A simple embedding generator using hashing and statistical features
 * This is an MVP implementation that doesn't require external API calls.
 * Can be extended later to use OpenAI, HuggingFace, or other embedding APIs.
 */
export class FoundationModelEmbeddingGenerator implements IEmbeddingGenerator {
  private readonly dimensions: number;

  /**
   * @param dimensions - The dimensionality of the embedding vectors (default: 128)
   */
  constructor(dimensions: number = 128) {
    this.dimensions = dimensions;
  }

  /**
   * Generate an embedding vector for the given text
   * Uses a hybrid approach combining:
   * 1. Hashing-based features for content similarity
   * 2. Statistical features (length, character distribution)
   * 3. N-gram features for semantic similarity
   */
  async generateEmbedding(text: string): Promise<number[]> {
    const normalized = this.normalizeText(text);
    const embedding = new Array(this.dimensions).fill(0);

    // Part 1: Hash-based features (first 1/3 of dimensions)
    // Use multiple hash functions to create diverse features
    const hashSection = Math.floor(this.dimensions / 3);
    for (let i = 0; i < hashSection; i++) {
      const hash = crypto
        .createHash('sha256')
        .update(normalized + i.toString())
        .digest();
      // Convert hash bytes to normalized values [-1, 1]
      embedding[i] = (hash[i % hash.length] / 127.5) - 1;
    }

    // Part 2: Statistical features (middle 1/3)
    const statsSection = Math.floor(this.dimensions / 3);
    const statsStart = hashSection;
    const stats = this.computeStatistics(normalized);
    for (let i = 0; i < statsSection; i++) {
      embedding[statsStart + i] = stats[i % stats.length];
    }

    // Part 3: N-gram features (last 1/3)
    const ngramSection = this.dimensions - hashSection - statsSection;
    const ngramStart = hashSection + statsSection;
    const ngrams = this.computeNgramFeatures(normalized, ngramSection);
    for (let i = 0; i < ngramSection; i++) {
      embedding[ngramStart + i] = ngrams[i];
    }

    // Normalize the embedding vector to unit length
    return this.normalizeVector(embedding);
  }

  getDimensions(): number {
    return this.dimensions;
  }

  /**
   * Normalize text for consistent embedding generation
   */
  private normalizeText(text: string): string {
    return text
      .toLowerCase()
      .replace(/\s+/g, ' ') // Normalize whitespace
      .replace(/[^\w\s]/g, '') // Remove punctuation
      .trim();
  }

  /**
   * Compute statistical features from text
   */
  private computeStatistics(text: string): number[] {
    const stats: number[] = [];

    // Length-based features
    stats.push(Math.tanh(text.length / 1000)); // Normalized length

    // Character frequency features
    const charFreq = new Map<string, number>();
    for (const char of text) {
      charFreq.set(char, (charFreq.get(char) || 0) + 1);
    }

    // Entropy (measure of character diversity)
    let entropy = 0;
    for (const freq of charFreq.values()) {
      const p = freq / text.length;
      entropy -= p * Math.log2(p);
    }
    stats.push(Math.tanh(entropy / 5)); // Normalized entropy

    // Vowel ratio
    const vowels = (text.match(/[aeiou]/g) || []).length;
    stats.push(vowels / Math.max(text.length, 1));

    // Digit ratio
    const digits = (text.match(/\d/g) || []).length;
    stats.push(digits / Math.max(text.length, 1));

    // Average word length
    const words = text.split(' ').filter(w => w.length > 0);
    const avgWordLen = words.reduce((sum, w) => sum + w.length, 0) / Math.max(words.length, 1);
    stats.push(Math.tanh(avgWordLen / 10));

    // Repeat pattern to fill space if needed
    while (stats.length < 32) {
      stats.push(...stats.slice(0, Math.min(stats.length, 32 - stats.length)));
    }

    return stats.slice(0, 32);
  }

  /**
   * Compute n-gram features for semantic similarity
   */
  private computeNgramFeatures(text: string, numFeatures: number): number[] {
    const features = new Array(numFeatures).fill(0);

    // Compute 2-gram and 3-gram frequencies
    const ngrams = new Map<string, number>();

    // 2-grams (bigrams)
    for (let i = 0; i < text.length - 1; i++) {
      const bigram = text.substring(i, i + 2);
      ngrams.set(bigram, (ngrams.get(bigram) || 0) + 1);
    }

    // 3-grams (trigrams)
    for (let i = 0; i < text.length - 2; i++) {
      const trigram = text.substring(i, i + 3);
      ngrams.set(trigram, (ngrams.get(trigram) || 0) + 1);
    }

    // Hash n-grams to feature indices
    for (const [ngram, count] of ngrams.entries()) {
      const hash = crypto.createHash('md5').update(ngram).digest();
      const idx = hash[0] % numFeatures;
      features[idx] += count / text.length; // Normalized count
    }

    // Clip values to [-1, 1] range
    return features.map(v => Math.tanh(v * 10));
  }

  /**
   * Normalize a vector to unit length (L2 normalization)
   */
  private normalizeVector(vector: number[]): number[] {
    const magnitude = Math.sqrt(
      vector.reduce((sum, val) => sum + val * val, 0)
    );

    if (magnitude === 0) {
      return vector; // Avoid division by zero
    }

    return vector.map(val => val / magnitude);
  }
}
