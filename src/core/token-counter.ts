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

    // ALWAYS TOKENIZE. This used to null the encoder for any model tiktoken
    // does not name, and `count()` then fell back to Math.ceil(length / 4) --
    // silently, in the same field, with no marker separating a guess from a
    // measurement. Measured against real tokenization, that estimate is:
    //
    //   whitespace-heavy source   +130.4%   (indented code, the common case)
    //   typescript source          +14.7%
    //   english prose              +11.9%
    //   minified json              -27.0%
    //   emoji                      -62.5%
    //   japanese                   -74.2%
    //   base64                     -75.0%
    //
    // The +130% case OVERSTATES, and it flows straight into every reported
    // `tokensSaved`. Reachable today with GOOGLE_AI_MODEL or a non-tiktoken
    // OPENAI_MODEL set -- and this package ships a Gemini integration.
    //
    // mapToTiktokenModel already falls back to gpt-4 for unknown models, so an
    // encoder is always available; there was never a reason to divide by four.
    // A neighbouring model's tokenizer is wrong by a few percent. Length over
    // four is wrong by more than double.
    this.encoder = encoding_for_model(
      TiktokenTokenizer.mapToTiktokenModel(this.model)
    );
  }

  /**
   * Longest slice handed to the tokenizer in one call.
   *
   * BPE COST IS SUPERLINEAR IN THE LENGTH OF A SINGLE RUN, and pathologically
   * so on highly repetitive text, because every merge pass has more to merge.
   * Measured on 100,000 characters:
   *
   *   repeated single character   23,004 ms
   *   a 26-character cycle         6,856 ms
   *   minified json                   28 ms
   *   base64                          28 ms
   *   minified javascript             18 ms
   *
   * Ordinary content is fine; repetitive content is not. This is not a
   * hypothetical input either -- `count_tokens` is the most-called tool in the
   * product (2,738 of 4,735 recorded captures), and a padding run, an ASCII
   * separator or a repetitive blob would stall the server for twenty seconds.
   * It surfaced as a 38-second test suite, of which one case was 23 seconds.
   *
   * SLICING MAKES THE COST LINEAR, and slicing at a LINE START makes it very
   * nearly free of accuracy cost. Measured across all 342 files in this
   * repository over 8 KB, against an exact unsliced encode:
   *
   *   cut at the byte limit        aggregate +0.06437%
   *   cut at the last space        aggregate +0.00952%,  64.3% of files exact
   *   cut after the last newline   aggregate +0.00097%,  98.0% of files exact
   *
   * A cl100k token can carry its leading whitespace, which is why cutting at a
   * space still splits one and cutting after a newline does not. 19 tokens
   * differ across 1,963,504. Text shorter than one slice is encoded in a single
   * call and is bit-identical to before.
   */
  private static readonly ENCODE_SLICE = 8192;

  /**
   * Encodes in bounded slices, so one pathological input cannot stall a call.
   */
  private encodeBounded(text: string): number {
    if (!this.encoder) return 0;
    const slice = TokenCounter.ENCODE_SLICE;
    if (text.length <= slice) return this.encoder.encode(text).length;

    let total = 0;
    let from = 0;
    while (from < text.length) {
      let end = Math.min(from + slice, text.length);
      if (end < text.length) {
        // BACK UP TO A LINE START. A cl100k token can carry its leading
        // whitespace, so cutting AT a space still splits one -- measured across
        // 342 real files over 8 KB, cutting at spaces matched an exact encode on
        // 64.3% of them. Cutting immediately after a newline matched on 98.0%,
        // because a line start is a boundary the pre-tokenizer already respects.
        //
        // The search stops halfway back so a file with very long lines cannot
        // degenerate into tiny slices; when no newline is found in range the cut
        // is taken as-is, which is the minified-single-line case.
        const floor = from + (slice >> 1);
        let cut = end;
        while (cut > floor && text[cut - 1] !== '\n') cut--;
        if (cut > floor) end = cut;
      }
      total += this.encoder.encode(text.slice(from, end)).length;
      from = end;
    }
    return total;
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
        tokens: this.encodeBounded(text),
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
