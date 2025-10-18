/**
 * Interface for token counting functionality
 */

export interface TokenCountResult {
  tokens: number;
  characters: number;
  estimatedCost?: number;
}

export interface ITokenCounter {
  /**
   * Count tokens in text
   */
  count(text: string): TokenCountResult | Promise<TokenCountResult>;

  /**
   * Count tokens in multiple texts
   */
  countBatch?(texts: string[]): TokenCountResult | Promise<TokenCountResult>;

  /**
   * Estimate token count without encoding (faster, less accurate)
   */
  estimate?(text: string): number;
}
