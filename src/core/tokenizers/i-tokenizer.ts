/**
 * Pluggable tokenizer interface — addresses issue #124.
 *
 * Implementations:
 * - TiktokenTokenizer: uses the local tiktoken library (GPT-4 / GPT-3.5-turbo).
 * - HeuristicTokenizer: content-aware local fallback for unknown models.
 *
 * The factory picks an implementation based on model name. All implementations
 * memoize counts via an injected LruCache so repeated inputs don't re-tokenize.
 */

export interface ITokenizer {
  readonly modelName: string;

  countTokens(text: string): Promise<number>;

  /** Free any native resources. */
  free(): void;
}
