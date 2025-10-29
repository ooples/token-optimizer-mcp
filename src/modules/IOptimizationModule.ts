/**
 * Interface for optimization modules in the plugin architecture.
 *
 * This interface defines the contract for all optimization plugins.
 * Modules can be chained together in a pipeline to apply multiple
 * optimizations sequentially.
 *
 * @example
 * ```typescript
 * // Creating a custom optimization module
 * class MyCustomModule implements IOptimizationModule {
 *   readonly name = 'my-custom-optimizer';
 *
 *   async apply(text: string): Promise<OptimizationResult> {
 *     // Count original tokens
 *     const originalTokens = await tokenCounter.count(text);
 *
 *     // Apply your optimization logic
 *     const optimizedText = myOptimizationLogic(text);
 *
 *     // Count optimized tokens
 *     const optimizedTokens = await tokenCounter.count(optimizedText);
 *
 *     return {
 *       text: optimizedText,
 *       originalTokens: originalTokens.tokens,
 *       optimizedTokens: optimizedTokens.tokens,
 *       savings: originalTokens.tokens - optimizedTokens.tokens,
 *       moduleName: this.name
 *     };
 *   }
 * }
 * ```
 */

/**
 * Result from applying an optimization module to text.
 *
 * Contains detailed metrics about the optimization including
 * token counts, savings, and module identification.
 */
export interface OptimizationResult {
  /**
   * The optimized text after applying this module
   */
  text: string;

  /**
   * Number of tokens in the original text before this module
   */
  originalTokens: number;

  /**
   * Number of tokens in the optimized text after this module
   */
  optimizedTokens: number;

  /**
   * Number of tokens saved by this module (can be negative if module expands text)
   */
  savings: number;

  /**
   * Name of the module that produced this result
   */
  moduleName: string;

  /**
   * Optional additional metadata about the optimization
   */
  metadata?: Record<string, unknown>;
}

/**
 * Interface for optimization modules in the plugin architecture.
 *
 * Modules are composable, reorderable plugins that apply specific
 * optimizations to text. They can be chained together in a pipeline
 * using the TokenOptimizer class.
 *
 * Key design principles:
 * - Each module should do one thing well
 * - Modules should be independent and not rely on specific ordering
 * - Modules should track their own token savings
 * - Modules should be thoroughly documented
 *
 * @see TokenOptimizer for pipeline orchestration
 */
export interface IOptimizationModule {
  /**
   * Unique name identifying this optimization module.
   * Used in logging, metrics, and result tracking.
   */
  readonly name: string;

  /**
   * Apply the optimization to input text.
   *
   * This method should:
   * 1. Count tokens in the input text
   * 2. Apply the optimization logic
   * 3. Count tokens in the output text
   * 4. Return a complete OptimizationResult
   *
   * @param text - The text to optimize
   * @returns Promise resolving to optimization result with metrics
   */
  apply(text: string): Promise<OptimizationResult>;
}
