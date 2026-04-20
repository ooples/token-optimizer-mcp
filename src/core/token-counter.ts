import { encoding_for_model, Tiktoken } from 'tiktoken';
import { TokenizerFactory } from './tokenizers/tokenizer-factory.js';
import { ITokenizer } from './tokenizers/i-tokenizer.js';
import { TiktokenTokenizer } from './tokenizers/tiktoken-tokenizer.js';

export interface TokenCountResult {
  tokens: number;
  characters: number;
  estimatedCost?: number;
}

/**
 * TokenCounter — delegates tokenization to the pluggable
 * TokenizerFactory from issue #124 while preserving the callable
 * surface (`count`, `countBatch`, `estimate`, `calculateSavings`,
 * `calculateCacheSavings`, `exceedsLimit`, `truncate`,
 * `getTokenCharRatio`, `free`) the rest of the codebase relies on.
 *
 * Truncation still uses a local tiktoken encoder because the
 * ITokenizer contract doesn't expose the raw token array — we
 * keep one for GPT-4-family models and otherwise degrade to
 * character-based truncation.
 */
export class TokenCounter {
  private readonly tokenizer: ITokenizer;
  private readonly encoder: Tiktoken | null;
  public readonly model: string;

  constructor(model?: string) {
    this.model =
      model ||
      process.env.CLAUDE_MODEL ||
      process.env.ANTHROPIC_MODEL ||
      process.env.OPENAI_MODEL ||
      process.env.GOOGLE_AI_MODEL ||
      'gpt-4';

    this.tokenizer = TokenizerFactory.create(this.model);

    // Keep a local encoder for tiktoken-compatible models — truncate()
    // needs to slice the raw token array, which the ITokenizer interface
    // intentionally does not expose.
    if (TiktokenTokenizer.supports(this.model)) {
      this.encoder = encoding_for_model(
        TiktokenTokenizer.mapToTiktokenModel(this.model)
      );
    } else {
      this.encoder = null;
    }
  }

  /**
   * Count tokens in text (synchronous).
   *
   * Synchronous on tiktoken-backed tokenizers, which is all we expose
   * externally via Anthropic/OpenAI. Remote tokenizers (Google AI) are
   * reachable via `countAsync`.
   */
  count(text: string): TokenCountResult {
    if (this.encoder) {
      return {
        tokens: this.encoder.encode(text).length,
        characters: text.length,
      };
    }
    // Fall back to the synchronous estimate so non-tiktoken paths keep
    // working. Callers that want exact remote counts should use
    // countAsync.
    return {
      tokens: this.estimate(text),
      characters: text.length,
    };
  }

  /**
   * Async token counting through the pluggable tokenizer — accurate for
   * both local tiktoken and remote Google AI paths.
   */
  async countAsync(text: string): Promise<TokenCountResult> {
    const tokens = await this.tokenizer.countTokens(text);
    return { tokens, characters: text.length };
  }

  countBatch(texts: string[]): TokenCountResult {
    let totalTokens = 0;
    let totalCharacters = 0;
    for (const text of texts) {
      const result = this.count(text);
      totalTokens += result.tokens;
      totalCharacters += result.characters;
    }
    return { tokens: totalTokens, characters: totalCharacters };
  }

  estimate(text: string): number {
    // Rough fallback: ~4 characters per token. Only used when no
    // tiktoken encoder is available for this model.
    return Math.ceil(text.length / 4);
  }

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

  calculateCacheSavings(originalText: string): {
    originalTokens: number;
    contextTokens: number;
    tokensSaved: number;
    percentSaved: number;
  } {
    const original = this.count(originalText);
    return {
      originalTokens: original.tokens,
      contextTokens: 0,
      tokensSaved: original.tokens,
      percentSaved: 100,
    };
  }

  exceedsLimit(text: string, limit: number): boolean {
    return this.count(text).tokens > limit;
  }

  truncate(text: string, maxTokens: number): string {
    if (!this.encoder) {
      // No raw-token access for this model — fall back to a
      // char-proportional slice using the estimate ratio.
      const approxChars = maxTokens * 4;
      return text.length <= approxChars ? text : text.slice(0, approxChars);
    }
    const tokens = this.encoder.encode(text);
    if (tokens.length <= maxTokens) {
      return text;
    }
    const truncatedTokens = tokens.slice(0, maxTokens);
    const decoded = this.encoder.decode(truncatedTokens);
    return typeof decoded === 'string'
      ? decoded
      : new TextDecoder().decode(decoded);
  }

  getTokenCharRatio(text: string): number {
    const result = this.count(text);
    return result.tokens > 0 ? result.characters / result.tokens : 0;
  }

  free(): void {
    if (this.encoder) {
      this.encoder.free();
    }
    // TokenizerFactory owns the tokenizer's lifecycle (instance cache).
  }
}
