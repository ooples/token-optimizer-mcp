import { encoding_for_model, Tiktoken } from 'tiktoken';

export interface TokenCountResult {
  tokens: number;
  characters: number;
  estimatedCost?: number;
}

export class TokenCounter {
  private encoder: Tiktoken;
  private readonly model: string;

  constructor(model?: string) {
    // Auto-detect model from environment or use provided model
    // Claude Code sets CLAUDE_MODEL env var with the active model
    // Falls back to GPT-4 as universal approximation
    this.model = model || process.env.CLAUDE_MODEL || process.env.ANTHROPIC_MODEL || 'gpt-4';

    // Map Claude models to closest tiktoken equivalent
    // Claude uses similar tokenization to GPT-4, so it's a good approximation
    const tokenModel = this.mapToTiktokenModel(this.model);

    // Initialize tiktoken encoder
    this.encoder = encoding_for_model(tokenModel);
  }

  /**
   * Map Claude/Anthropic models to tiktoken model names
   */
  private mapToTiktokenModel(model: string): 'gpt-4' | 'gpt-3.5-turbo' {
    const lowerModel = model.toLowerCase();

    // Claude models use GPT-4 tokenizer as closest approximation
    if (lowerModel.includes('claude') || lowerModel.includes('sonnet') ||
        lowerModel.includes('opus') || lowerModel.includes('haiku')) {
      return 'gpt-4';
    }

    // GPT-4 variants
    if (lowerModel.includes('gpt-4')) {
      return 'gpt-4';
    }

    // GPT-3.5 variants
    if (lowerModel.includes('gpt-3.5') || lowerModel.includes('gpt3.5')) {
      return 'gpt-3.5-turbo';
    }

    // Default to GPT-4 for unknown models
    return 'gpt-4';
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
   * Calculate token savings based on context window management
   *
   * @param originalText - The original text content
   * @param contextTokens - Number of tokens remaining in LLM context (default: 0 for full caching)
   * @returns Token savings calculation
   *
   * @remarks
   * This method measures context window optimization, NOT compression ratio.
   * When content is cached externally (SQLite, Redis, etc.), it's completely
   * removed from the LLM's context window, resulting in 100% token savings.
   *
   * Use cases:
   * - External caching: contextTokens = 0 (100% savings)
   * - Metadata-only: contextTokens = tokens in metadata (e.g., 8)
   * - Summarization: contextTokens = tokens in summary (e.g., 50)
   */
  calculateSavings(
    originalText: string,
    contextTokens: number = 0
  ): {
    originalTokens: number;
    contextTokens: number;
    tokensSaved: number;
    percentSaved: number;
  } {
    const original = this.count(originalText);
    const saved = original.tokens - contextTokens;
    const percentSaved =
      original.tokens > 0 ? (saved / original.tokens) * 100 : 0;

    return {
      originalTokens: original.tokens,
      contextTokens,
      tokensSaved: saved,
      percentSaved,
    };
  }

  /**
   * Calculate context window savings for externally cached content
   *
   * @param originalText - The original text content being cached
   * @returns Token savings calculation with 100% savings
   *
   * @remarks
   * When content is compressed and stored in an external cache (SQLite, Redis, etc.),
   * it's completely removed from the LLM's context window. The compressed/encoded
   * data is NEVER sent to the LLM, so we measure 100% token savings.
   *
   * Key insight: We're measuring CONTEXT WINDOW CLEARANCE, not compression ratio.
   * - ✅ Content removed from LLM context (saves tokens)
   * - ✅ Storage compressed (saves disk space)
   * - ❌ Don't count tokens in compressed data (it's not sent to LLM!)
   *
   * @example
   * ```typescript
   * const tokenCounter = new TokenCounter();
   * const content = "Large file content...";
   * const compressed = compress(content);
   *
   * // Store in external cache
   * await cache.set(key, compressed);
   *
   * // Calculate context window savings
   * const savings = tokenCounter.calculateCacheSavings(content);
   * // Returns: { originalTokens: 250, contextTokens: 0, tokensSaved: 250, percentSaved: 100 }
   * ```
   */
  calculateCacheSavings(originalText: string): {
    originalTokens: number;
    contextTokens: number;
    tokensSaved: number;
    percentSaved: number;
  } {
    const original = this.count(originalText);

    return {
      originalTokens: original.tokens,
      contextTokens: 0, // External cache - nothing in context
      tokensSaved: original.tokens, // 100% of original tokens saved
      percentSaved: 100, // Always 100% for external caching
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
