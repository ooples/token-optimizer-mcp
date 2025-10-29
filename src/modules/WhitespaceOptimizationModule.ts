import {
  IOptimizationModule,
  OptimizationResult,
} from './IOptimizationModule.js';
import { ITokenCounter } from '../interfaces/ITokenCounter.js';

/**
 * Whitespace optimization module.
 *
 * This lightweight optimization module removes excessive whitespace from text
 * while preserving readability and structure. It's an excellent example of a
 * simple, composable optimization that can be combined with other modules.
 *
 * Optimizations applied:
 * - Collapses multiple spaces into single spaces
 * - Removes trailing whitespace from lines
 * - Removes leading whitespace from lines (configurable)
 * - Collapses multiple newlines into double newlines (preserves paragraph breaks)
 * - Trims leading and trailing whitespace
 *
 * This module is particularly effective for:
 * - Code snippets with inconsistent formatting
 * - Copy-pasted content with extra whitespace
 * - Generated text with formatting artifacts
 * - Long documents where whitespace adds up
 *
 * @example
 * ```typescript
 * const tokenCounter = new TokenCounter();
 * const whitespaceModule = new WhitespaceOptimizationModule(tokenCounter, {
 *   preserveIndentation: true, // Keep leading spaces
 *   maxConsecutiveNewlines: 2   // Allow up to 2 newlines
 * });
 *
 * const result = await whitespaceModule.apply(textWithExtraSpaces);
 * console.log(`Removed ${result.savings} tokens of whitespace`);
 * ```
 */
export class WhitespaceOptimizationModule implements IOptimizationModule {
  readonly name = 'whitespace-optimization';

  /**
   * Create a whitespace optimization module.
   *
   * @param tokenCounter - Token counter for measuring savings
   * @param options - Configuration options
   */
  constructor(
    private readonly tokenCounter: ITokenCounter,
    private readonly options?: {
      /**
       * Preserve leading whitespace (indentation) in lines
       * @default false
       */
      preserveIndentation?: boolean;

      /**
       * Maximum consecutive newlines to allow
       * @default 2
       */
      maxConsecutiveNewlines?: number;

      /**
       * Preserve code block formatting (content between ``` markers)
       * @default true
       */
      preserveCodeBlocks?: boolean;
    }
  ) {}

  /**
   * Apply whitespace optimization to the input text.
   *
   * This method:
   * 1. Counts tokens in the original text
   * 2. Removes excessive whitespace while preserving structure
   * 3. Optionally preserves code blocks and indentation
   * 4. Counts tokens in the optimized text
   * 5. Returns detailed results with statistics
   *
   * @param text - The text to optimize
   * @returns Optimization result with whitespace statistics
   */
  async apply(text: string): Promise<OptimizationResult> {
    // Count original tokens
    const originalTokenResult = await Promise.resolve(
      this.tokenCounter.count(text)
    );
    const originalTokens = originalTokenResult.tokens;

    // Track statistics
    const stats = {
      originalLength: text.length,
      originalLines: text.split('\n').length,
      spacesRemoved: 0,
      newlinesRemoved: 0,
    };

    let optimized = text;

    // Preserve code blocks if requested
    const codeBlocks: string[] = [];
    const preserveCodeBlocks = this.options?.preserveCodeBlocks ?? true;

    if (preserveCodeBlocks) {
      // Extract code blocks and replace with placeholders
      optimized = optimized.replace(/```[\s\S]*?```/g, (match) => {
        const index = codeBlocks.length;
        codeBlocks.push(match);
        return `___CODE_BLOCK_${index}___`;
      });
    }

    // Collapse multiple spaces into single spaces (but not at line start if preserving indentation)
    const spacesBefore = (optimized.match(/ /g) || []).length;
    if (this.options?.preserveIndentation) {
      // Only collapse spaces that are NOT at the beginning of lines
      // Match: (non-space character)(space)(2+ spaces) -> replace with $1$2
      optimized = optimized.replace(/([^ \n\t])( ) {2,}/g, '$1$2');
    } else {
      // Collapse all multiple spaces
      optimized = optimized.replace(/ {2,}/g, ' ');
    }
    const spacesAfter = (optimized.match(/ /g) || []).length;
    stats.spacesRemoved = spacesBefore - spacesAfter;

    // Remove trailing whitespace from each line
    optimized = optimized.replace(/[ \t]+$/gm, '');

    // Remove leading whitespace if not preserving indentation
    if (!this.options?.preserveIndentation) {
      optimized = optimized.replace(/^[ \t]+/gm, '');
    }

    // Collapse multiple newlines
    const maxNewlines = this.options?.maxConsecutiveNewlines ?? 2;
    const newlinesBefore = (optimized.match(/\n/g) || []).length;
    const newlinePattern = new RegExp(`\n{${maxNewlines + 1},}`, 'g');
    optimized = optimized.replace(newlinePattern, '\n'.repeat(maxNewlines));
    const newlinesAfter = (optimized.match(/\n/g) || []).length;
    stats.newlinesRemoved = newlinesBefore - newlinesAfter;

    // Trim leading and trailing whitespace (only if not preserving indentation)
    if (!this.options?.preserveIndentation) {
      optimized = optimized.trim();
    } else {
      // Just trim trailing whitespace to avoid unnecessary blank lines at end
      optimized = optimized.replace(/\s+$/, '');
    }

    // Restore code blocks
    if (preserveCodeBlocks && codeBlocks.length > 0) {
      codeBlocks.forEach((block, index) => {
        optimized = optimized.replace(`___CODE_BLOCK_${index}___`, block);
      });
    }

    // Count optimized tokens
    const optimizedTokenResult = await Promise.resolve(
      this.tokenCounter.count(optimized)
    );
    const optimizedTokens = optimizedTokenResult.tokens;
    const savings = originalTokens - optimizedTokens;

    return {
      text: optimized,
      originalTokens,
      optimizedTokens,
      savings,
      moduleName: this.name,
      metadata: {
        originalLength: stats.originalLength,
        optimizedLength: optimized.length,
        charactersSaved: stats.originalLength - optimized.length,
        originalLines: stats.originalLines,
        optimizedLines: optimized.split('\n').length,
        spacesRemoved: stats.spacesRemoved,
        newlinesRemoved: stats.newlinesRemoved,
        preservedCodeBlocks: codeBlocks.length,
        preservedIndentation: this.options?.preserveIndentation ?? false,
      },
    };
  }
}
