import {
  IOptimizationModule,
  OptimizationResult as ModuleOptimizationResult,
} from '../modules/IOptimizationModule.js';
import { ITokenCounter } from '../interfaces/ITokenCounter.js';

/**
 * Result from a single module in the optimization pipeline.
 */
export interface ModuleResult {
  /**
   * Name of the module that produced this result
   */
  moduleName: string;

  /**
   * Tokens before this module was applied
   */
  tokensIn: number;

  /**
   * Tokens after this module was applied
   */
  tokensOut: number;

  /**
   * Tokens saved by this module (can be negative)
   */
  savings: number;

  /**
   * Optional metadata from the module
   */
  metadata?: Record<string, unknown>;
}

/**
 * Complete result from the optimization pipeline.
 */
export interface OptimizationPipelineResult {
  /**
   * Final optimized text after all modules
   */
  optimizedPrompt: string;

  /**
   * Original token count before any optimization
   */
  originalTokens: number;

  /**
   * Final token count after all optimizations
   */
  optimizedTokens: number;

  /**
   * Total tokens saved across all modules
   */
  savings: number;

  /**
   * Percentage of tokens saved
   */
  percentSaved: number;

  /**
   * Names of modules that were applied
   */
  appliedModules: string[];

  /**
   * Detailed per-module breakdown of the pipeline
   */
  moduleResults: ModuleResult[];

  /**
   * Execution time in milliseconds
   */
  executionTimeMs: number;
}

/**
 * Orchestrates a pipeline of optimization modules.
 *
 * The TokenOptimizer chains multiple IOptimizationModule instances together,
 * applying them sequentially to input text. It tracks detailed metrics for
 * each module and provides comprehensive statistics about the optimization.
 *
 * Key features:
 * - Sequential module execution
 * - Per-module token tracking
 * - Cumulative savings calculation
 * - Detailed performance metrics
 * - Support for any number of modules
 * - Module reordering support
 *
 * @example
 * ```typescript
 * // Create modules
 * const whitespace = new WhitespaceOptimizationModule(tokenCounter);
 * const dedup = new DeduplicationModule(tokenCounter);
 * const compression = new CompressionModule(engine, tokenCounter);
 *
 * // Create optimizer with module pipeline
 * const optimizer = new TokenOptimizer(
 *   [whitespace, dedup, compression],
 *   tokenCounter
 * );
 *
 * // Optimize text
 * const result = await optimizer.optimize(largeText);
 *
 * // Examine results
 * console.log(`Total savings: ${result.savings} tokens (${result.percentSaved}%)`);
 * console.log('Per-module breakdown:');
 * result.moduleResults.forEach(m => {
 *   console.log(`  ${m.moduleName}: ${m.savings} tokens saved`);
 * });
 * ```
 */
export class TokenOptimizer {
  /**
   * Create a token optimizer with a pipeline of modules.
   *
   * @param modules - Ordered array of optimization modules to apply
   * @param tokenCounter - Token counter for measuring savings
   */
  constructor(
    private modules: IOptimizationModule[],
    private tokenCounter: ITokenCounter
  ) {}

  /**
   * Optimize text by applying all modules in the pipeline.
   *
   * Modules are applied sequentially, with the output of each module
   * becoming the input to the next. Detailed metrics are collected
   * for each module and returned in the result.
   *
   * @param prompt - The text to optimize
   * @returns Detailed optimization result with per-module breakdown
   */
  async optimize(prompt: string): Promise<OptimizationPipelineResult> {
    const startTime = Date.now();

    let current = prompt;
    const originalTokenResult = await Promise.resolve(
      this.tokenCounter.count(prompt)
    );
    const originalTokens = originalTokenResult.tokens;
    const appliedModules: string[] = [];
    const moduleResults: ModuleResult[] = [];

    // Apply each optimization module in order
    for (const module of this.modules) {
      // Count tokens before this module
      const tokensInResult = await Promise.resolve(
        this.tokenCounter.count(current)
      );
      const tokensIn = tokensInResult.tokens;

      // Apply the module
      const result: ModuleOptimizationResult = await module.apply(current);
      current = result.text;
      appliedModules.push(module.name);

      // Count tokens after this module
      const tokensOutResult = await Promise.resolve(
        this.tokenCounter.count(current)
      );
      const tokensOut = tokensOutResult.tokens;

      // Record module result
      moduleResults.push({
        moduleName: module.name,
        tokensIn,
        tokensOut,
        savings: tokensIn - tokensOut,
        metadata: result.metadata,
      });
    }

    const optimizedTokenResult = await Promise.resolve(
      this.tokenCounter.count(current)
    );
    const optimizedTokens = optimizedTokenResult.tokens;
    const savings = originalTokens - optimizedTokens;
    const percentSaved =
      originalTokens > 0 ? (savings / originalTokens) * 100 : 0;
    const executionTimeMs = Date.now() - startTime;

    return {
      optimizedPrompt: current,
      originalTokens,
      optimizedTokens,
      savings,
      percentSaved,
      appliedModules,
      moduleResults,
      executionTimeMs,
    };
  }

  /**
   * Get the ordered list of modules in this optimizer's pipeline.
   *
   * @returns Array of module names in execution order
   */
  getModuleNames(): string[] {
    return this.modules.map((m) => m.name);
  }

  /**
   * Get the number of modules in this optimizer's pipeline.
   *
   * @returns Number of modules
   */
  getModuleCount(): number {
    return this.modules.length;
  }
}
