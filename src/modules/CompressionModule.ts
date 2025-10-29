import {
  IOptimizationModule,
  OptimizationResult,
} from './IOptimizationModule.js';
import { CompressionEngine } from '../core/compression-engine.js';
import { ITokenCounter } from '../interfaces/ITokenCounter.js';

/**
 * Compression-based optimization module.
 *
 * This module wraps the CompressionEngine to provide Brotli compression
 * as part of the optimization pipeline. It compresses text and stores it
 * in base64 format, which can be cached externally to reduce token usage
 * in the LLM context window.
 *
 * Key features:
 * - Brotli compression with configurable quality
 * - Base64 encoding for easy storage
 * - Token counting before and after compression
 * - Detailed compression statistics
 *
 * Note: This module is primarily useful for caching scenarios where the
 * compressed content is stored externally and not sent to the LLM. The
 * token savings represent the removal of content from the context window.
 *
 * @example
 * ```typescript
 * const compressionEngine = new CompressionEngine();
 * const tokenCounter = new TokenCounter();
 * const compressionModule = new CompressionModule(
 *   compressionEngine,
 *   tokenCounter,
 *   { quality: 11 } // Maximum compression
 * );
 *
 * const result = await compressionModule.apply(largeText);
 * console.log(`Compressed: ${result.savings} tokens saved`);
 * console.log(`Compression ratio: ${result.metadata?.compressionRatio}`);
 * ```
 */
export class CompressionModule implements IOptimizationModule {
  readonly name = 'compression';

  /**
   * Create a compression module.
   *
   * @param compressionEngine - The compression engine instance
   * @param tokenCounter - Token counter for measuring savings
   * @param options - Optional compression configuration
   */
  constructor(
    private readonly compressionEngine: CompressionEngine,
    private readonly tokenCounter: ITokenCounter,
    private readonly options?: {
      quality?: number; // 0-11, default 11 (max compression)
      mode?: 'text' | 'font' | 'generic';
      minSize?: number; // Minimum text size to compress, default 1000
    }
  ) {}

  /**
   * Apply Brotli compression to the input text.
   *
   * This method:
   * 1. Counts tokens in the original text
   * 2. Compresses the text using Brotli
   * 3. Encodes the compressed data as base64
   * 4. Returns the base64 string (for external caching)
   * 5. Calculates token savings based on context window clearance
   *
   * Note: The compressed base64 string is meant to be cached externally.
   * The token savings represent removing the original text from the
   * LLM context window, not the size of the compressed data.
   *
   * @param text - The text to compress
   * @returns Optimization result with compression metadata
   */
  async apply(text: string): Promise<OptimizationResult> {
    // Count original tokens
    const originalTokenResult = await Promise.resolve(
      this.tokenCounter.count(text)
    );
    const originalTokens = originalTokenResult.tokens;

    // Check if compression is worthwhile
    const minSize = this.options?.minSize ?? 1000;
    if (!this.compressionEngine.shouldCompress(text, minSize)) {
      // Text too small or compression not beneficial
      return {
        text,
        originalTokens,
        optimizedTokens: originalTokens,
        savings: 0,
        moduleName: this.name,
        metadata: {
          compressed: false,
          reason: 'Text too small or compression not beneficial',
        },
      };
    }

    // Compress text to base64
    const compressionResult = this.compressionEngine.compressToBase64(text, {
      quality: this.options?.quality,
      mode: this.options?.mode,
    });

    // For context window optimization, we count the compressed text as having
    // 0 tokens because it's stored externally and never sent to the LLM.
    // The base64 string is returned for caching purposes only.
    const optimizedTokens = 0;
    const savings = originalTokens - optimizedTokens;

    return {
      text: compressionResult.compressed, // Base64 compressed data
      originalTokens,
      optimizedTokens,
      savings,
      moduleName: this.name,
      metadata: {
        compressed: true,
        compressionRatio: compressionResult.ratio,
        percentSaved: compressionResult.percentSaved,
        originalSize: compressionResult.originalSize,
        compressedSize: compressionResult.compressedSize,
        encoding: 'base64',
        algorithm: 'brotli',
        quality: this.options?.quality ?? 11,
      },
    };
  }

  /**
   * Decompress previously compressed content.
   *
   * This is a utility method for retrieving cached compressed content.
   * Not part of the standard optimization pipeline.
   *
   * @param compressed - Base64 encoded compressed text
   * @returns Original decompressed text
   */
  decompress(compressed: string): string {
    return this.compressionEngine.decompressFromBase64(compressed);
  }
}
