/**
 * Interface for optimization modules
 */

export interface OptimizationResult {
  text: string;
  tokensSaved?: number;
  metadata?: Record<string, unknown>;
}

export interface IOptimizationModule {
  /**
   * Name of the optimization module
   */
  readonly name: string;

  /**
   * Apply optimization to the input text
   */
  apply(text: string): Promise<OptimizationResult>;
}
