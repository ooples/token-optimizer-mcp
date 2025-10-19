import { encoding_for_model, Tiktoken } from 'tiktoken';

export interface TokenCountResult {
  tokens: number;
  characters: number;
  estimatedCost?: number;
}

export class TokenCounter {
  private encoder: Tiktoken;
  private readonly MODEL = 'gpt-4';

  constructor() {
    // Initialize tiktoken encoder for Claude (uses GPT-4 tokenizer as approximation)
    this.encoder = encoding_for_model(this.MODEL);
  }

  /**
   * Count tokens in text
   */
  count(text: string): TokenCountResult {
    const tokens = this.encoder.encode(text);

    return {
      tokens: tokens.length,
      characters: text.length,
    };
  }

  /**
   * Count tokens in multiple texts
   */
  countBatch(texts: string[]): TokenCountResult {
    let totalTokens = 0;
    let totalCharacters = 0;

    for (const text of texts) {
      const result = this.count(text);
      totalTokens += result.tokens;
      totalCharacters += result.characters;
    }

    return {
      tokens: totalTokens,
      characters: totalCharacters,
    };
  }

  /**
   * Estimate token count without encoding (faster, less accurate)
   */
  estimate(text: string): number {
    // Rough estimate: ~4 characters per token on average
    return Math.ceil(text.length / 4);
  }

  /**
   * Calculate token savings from compression
   */
  calculateSavings(
    originalText: string,
    compressedText: string
  ): {
    originalTokens: number;
    compressedTokens: number;
    tokensSaved: number;
    percentSaved: number;
  } {
    const original = this.count(originalText);
    const compressed = this.count(compressedText);
    const saved = original.tokens - compressed.tokens;
    const percentSaved =
      original.tokens > 0 ? (saved / original.tokens) * 100 : 0;

    return {
      originalTokens: original.tokens,
      compressedTokens: compressed.tokens,
      tokensSaved: saved,
      percentSaved,
    };
  }

  /**
   * Check if text exceeds token limit
   */
  exceedsLimit(text: string, limit: number): boolean {
    const result = this.count(text);
    return result.tokens > limit;
  }

  /**
   * Truncate text to fit within token limit
   */
  truncate(text: string, maxTokens: number): string {
    const tokens = this.encoder.encode(text);

    if (tokens.length <= maxTokens) {
      return text;
    }

    const truncatedTokens = tokens.slice(0, maxTokens);
    const decoded = this.encoder.decode(truncatedTokens);

    // Handle potential type issues with decode return value
    return typeof decoded === 'string'
      ? decoded
      : new TextDecoder().decode(decoded);
  }

  /**
   * Get token-to-character ratio for text
   */
  getTokenCharRatio(text: string): number {
    const result = this.count(text);
    return result.tokens > 0 ? result.characters / result.tokens : 0;
  }

  /**
   * Free the encoder resources
   */
  free(): void {
    this.encoder.free();
  }
}
