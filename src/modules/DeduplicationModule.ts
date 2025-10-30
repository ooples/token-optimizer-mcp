import {
  IOptimizationModule,
  OptimizationResult,
} from './IOptimizationModule.js';
import { ITokenCounter } from '../interfaces/ITokenCounter.js';

/**
 * Production-ready deduplication optimization module.
 *
 * This module removes duplicate sentences and paragraphs from text while
 * preserving the original order and context. It uses robust algorithms
 * suitable for production use:
 * - Proper sentence boundary detection (Intl.Segmenter with fallback)
 * - Fuzzy matching for near-duplicates (Levenshtein distance)
 * - Semantic-aware code block preservation
 * - Formatting preservation for non-duplicate content
 *
 * Ideal for:
 * - Removing repeated boilerplate text
 * - Cleaning up copy-paste artifacts
 * - Removing redundant explanations
 * - Consolidating repeated information
 *
 * @example
 * ```typescript
 * const tokenCounter = new TokenCounter();
 * const deduplicationModule = new DeduplicationModule(tokenCounter, {
 *   caseSensitive: false,        // Ignore case when comparing
 *   minSentenceLength: 10,       // Only dedupe sentences with 10+ chars
 *   preserveFirst: true,         // Keep first occurrence
 *   similarityThreshold: 0.9,    // 90% similarity for fuzzy matching
 *   deduplicateParagraphs: true  // Also dedupe at paragraph level
 * });
 *
 * const result = await deduplicationModule.apply(textWithDuplicates);
 * console.log(`Removed ${result.metadata?.duplicatesRemoved} duplicates`);
 * console.log(`Saved ${result.savings} tokens`);
 * ```
 */
export class DeduplicationModule implements IOptimizationModule {
  readonly name = 'deduplication';

  /**
   * Create a deduplication module.
   *
   * @param tokenCounter - Token counter for measuring savings
   * @param options - Configuration options
   */
  constructor(
    private readonly tokenCounter: ITokenCounter,
    private readonly options?: {
      /**
       * Case-sensitive comparison
       * @default true
       */
      caseSensitive?: boolean;

      /**
       * Minimum sentence length to consider for deduplication
       * @default 5
       */
      minSentenceLength?: number;

      /**
       * Preserve first occurrence (true) or last occurrence (false)
       * @default true
       */
      preserveFirst?: boolean;

      /**
       * Similarity threshold for fuzzy matching (0-1)
       * - 1.0 = exact matching only
       * - 0.9 = 90% similarity required
       * - 0.8 = 80% similarity required
       * Lower values catch more near-duplicates but may have false positives
       * @default 1.0
       */
      similarityThreshold?: number;

      /**
       * Also deduplicate at paragraph level
       * @default false
       */
      deduplicateParagraphs?: boolean;

      /**
       * Preserve code blocks (don't deduplicate content between ``` markers)
       * @default true
       */
      preserveCodeBlocks?: boolean;
    }
  ) {}

  /**
   * Apply deduplication to the input text.
   *
   * This method:
   * 1. Counts tokens in the original text
   * 2. Extracts and preserves code blocks
   * 3. Splits text into sentences/paragraphs using proper tokenization
   * 4. Identifies duplicates using exact or fuzzy matching
   * 5. Removes duplicates while preserving formatting
   * 6. Restores code blocks
   * 7. Counts tokens in the deduplicated text
   * 8. Returns detailed results with statistics
   *
   * @param text - The text to deduplicate
   * @returns Optimization result with deduplication statistics
   */
  async apply(text: string): Promise<OptimizationResult> {
    // Count original tokens
    const originalTokenResult = await Promise.resolve(
      this.tokenCounter.count(text)
    );
    const originalTokens = originalTokenResult.tokens;

    // Track statistics
    const stats = {
      originalSentences: 0,
      duplicateSentences: 0,
      originalParagraphs: 0,
      duplicateParagraphs: 0,
    };

    let optimized = text;

    // Preserve code blocks if requested
    const codeBlocks: string[] = [];
    const preserveCodeBlocks = this.options?.preserveCodeBlocks ?? true;

    if (preserveCodeBlocks) {
      // Extract code blocks with proper multiline anchoring
      // This prevents matching inline backticks
      optimized = optimized.replace(/^```[\s\S]*?^```$/gm, (match) => {
        const index = codeBlocks.length;
        codeBlocks.push(match);
        return `___CODE_BLOCK_${index}___`;
      });
    }

    // Deduplicate at paragraph level if requested
    if (this.options?.deduplicateParagraphs) {
      const paragraphResult = this.deduplicateParagraphs(optimized);
      optimized = paragraphResult.text;
      stats.originalParagraphs = paragraphResult.originalCount;
      stats.duplicateParagraphs = paragraphResult.duplicateCount;
    }

    // Deduplicate at sentence level
    const sentenceResult = this.deduplicateSentences(optimized);
    optimized = sentenceResult.text;
    stats.originalSentences = sentenceResult.originalCount;
    stats.duplicateSentences = sentenceResult.duplicateCount;

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
        originalSentences: stats.originalSentences,
        duplicateSentences: stats.duplicateSentences,
        originalParagraphs: stats.originalParagraphs,
        duplicateParagraphs: stats.duplicateParagraphs,
        totalDuplicatesRemoved:
          stats.duplicateSentences + stats.duplicateParagraphs,
        caseSensitive: this.options?.caseSensitive ?? true,
        similarityThreshold: this.options?.similarityThreshold ?? 1.0,
        preservedCodeBlocks: codeBlocks.length,
      },
    };
  }

  /**
   * Deduplicate sentences in text using proper sentence boundary detection.
   *
   * Uses Intl.Segmenter (Node 16+) for accurate sentence splitting that handles
   * abbreviations correctly. Falls back to regex-based splitting on older Node versions.
   *
   * @param text - Text to process
   * @returns Deduplicated text and statistics
   */
  private deduplicateSentences(text: string): {
    text: string;
    originalCount: number;
    duplicateCount: number;
  } {
    const minLength = this.options?.minSentenceLength ?? 5;
    const caseSensitive = this.options?.caseSensitive ?? true;
    const preserveFirst = this.options?.preserveFirst ?? true;
    const similarityThreshold = this.options?.similarityThreshold ?? 1.0;

    // Split into sentences using proper tokenization
    const sentences = this.splitSentences(text);

    // Track seen sentences and their indices for preserveLast
    const seenMap = new Map<string, number>(); // normalized -> result array index
    const result: string[] = [];
    let originalCount = 0;
    let duplicateCount = 0;

    for (const sentence of sentences) {
      const trimmed = sentence.trim();

      // Skip empty sentences
      if (trimmed.length === 0) {
        result.push(sentence);
        continue;
      }

      originalCount++;

      // Normalize for comparison (remove trailing punctuation)
      const normalized = caseSensitive
        ? trimmed.replace(/[.!?]+\s*$/, '')
        : trimmed.replace(/[.!?]+\s*$/, '').toLowerCase();

      // Skip short sentences
      if (normalized.length < minLength) {
        result.push(sentence);
        continue;
      }

      // Check for duplicates (exact or fuzzy)
      let isDuplicate = false;
      let matchedKey: string | null = null;

      if (similarityThreshold >= 1.0) {
        // Exact matching
        isDuplicate = seenMap.has(normalized);
        matchedKey = normalized;
      } else {
        // Fuzzy matching - check similarity with all seen sentences
        for (const [seenNormalized] of seenMap.entries()) {
          const similarity = this.calculateSimilarity(
            normalized,
            seenNormalized
          );
          if (similarity >= similarityThreshold) {
            isDuplicate = true;
            matchedKey = seenNormalized;
            break;
          }
        }
      }

      if (isDuplicate && matchedKey !== null) {
        duplicateCount++;

        if (preserveFirst) {
          // Skip the duplicate, keep first occurrence
          continue;
        } else {
          // Replace first occurrence with current (preserve last)
          const firstIndex = seenMap.get(matchedKey);
          if (firstIndex !== undefined) {
            result[firstIndex] = sentence;
          }
          // Update the index to point to current position
          seenMap.set(matchedKey, result.length - 1);
          continue;
        }
      }

      // Not a duplicate - add to result
      seenMap.set(normalized, result.length);
      result.push(sentence);
    }

    return {
      text: result.join(''),
      originalCount,
      duplicateCount,
    };
  }

  /**
   * Deduplicate paragraphs in text while preserving original formatting.
   *
   * Uses capturing groups to preserve the exact separators between paragraphs,
   * so non-duplicate content retains its original spacing.
   *
   * @param text - Text to process
   * @returns Deduplicated text and statistics
   */
  private deduplicateParagraphs(text: string): {
    text: string;
    originalCount: number;
    duplicateCount: number;
  } {
    const caseSensitive = this.options?.caseSensitive ?? true;
    const preserveFirst = this.options?.preserveFirst ?? true;
    const similarityThreshold = this.options?.similarityThreshold ?? 1.0;

    // Split paragraphs while preserving separators
    // Matches one or more blank lines (with optional whitespace)
    const parts = text.split(/(\r?\n\s*\r?\n)/);

    // Track seen paragraphs and their indices
    const seenMap = new Map<string, number>();
    const result: string[] = [];
    let originalCount = 0;
    let duplicateCount = 0;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];

      // Check if this is a separator (blank line)
      if (/^\r?\n\s*\r?\n$/.test(part)) {
        result.push(part);
        continue;
      }

      const trimmed = part.trim();

      // Skip empty parts
      if (trimmed.length === 0) {
        result.push(part);
        continue;
      }

      originalCount++;

      // Normalize for comparison (remove trailing punctuation)
      const normalized = caseSensitive
        ? trimmed.replace(/[.!?]+\s*$/, '')
        : trimmed.replace(/[.!?]+\s*$/, '').toLowerCase();

      // Check for duplicates (exact or fuzzy)
      let isDuplicate = false;
      let matchedKey: string | null = null;

      if (similarityThreshold >= 1.0) {
        // Exact matching
        isDuplicate = seenMap.has(normalized);
        matchedKey = normalized;
      } else {
        // Fuzzy matching
        for (const [seenNormalized] of seenMap.entries()) {
          const similarity = this.calculateSimilarity(
            normalized,
            seenNormalized
          );
          if (similarity >= similarityThreshold) {
            isDuplicate = true;
            matchedKey = seenNormalized;
            break;
          }
        }
      }

      if (isDuplicate && matchedKey !== null) {
        duplicateCount++;

        if (preserveFirst) {
          // Skip duplicate and its following separator
          if (i + 1 < parts.length && /^\r?\n\s*\r?\n$/.test(parts[i + 1])) {
            i++; // Skip the separator too
          }
          continue;
        } else {
          // Replace first occurrence with current (preserve last)
          const firstIndex = seenMap.get(matchedKey);
          if (firstIndex !== undefined) {
            result[firstIndex] = part;
          }
          seenMap.set(matchedKey, result.length);
          result.push(part);
          continue;
        }
      }

      // Not a duplicate - add to result
      seenMap.set(normalized, result.length);
      result.push(part);
    }

    return {
      text: result.join(''),
      originalCount,
      duplicateCount,
    };
  }

  /**
   * Split text into sentences using proper sentence boundary detection.
   *
   * Uses Intl.Segmenter on Node 16+ for accurate splitting that handles:
   * - Abbreviations (Dr., U.S., etc.)
   * - Decimal numbers (1.5, $10.99)
   * - Ellipses (...)
   * - Quotations and punctuation
   *
   * Falls back to regex-based splitting on older Node versions.
   *
   * @param text - Text to split
   * @returns Array of sentence strings
   */
  private splitSentences(text: string): string[] {
    // Check if Intl.Segmenter is available (Node 16+)
    if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
      try {
        const segmenter = new (Intl as any).Segmenter('en', {
          granularity: 'sentence'
        });
        const segments = segmenter.segment(text);
        const sentences: string[] = [];

        for (const segment of segments) {
          sentences.push(segment.segment);
        }

        return sentences;
      } catch (e) {
        // Fall through to regex fallback
      }
    }

    // Fallback: Use improved regex that handles more cases
    // This still has limitations but is better than the original
    return text.split(/(?<=[.!?])\s+(?=[A-Z])/);
  }

  /**
   * Calculate normalized Levenshtein distance between two strings.
   *
   * Returns similarity score from 0 (completely different) to 1 (identical).
   * Uses character-level edit distance normalized by max string length.
   *
   * @param s1 - First string
   * @param s2 - Second string
   * @returns Similarity score between 0 and 1
   */
  private calculateSimilarity(s1: string, s2: string): number {
    // Quick exact match check
    if (s1 === s2) return 1.0;

    const len1 = s1.length;
    const len2 = s2.length;

    // Empty string handling
    if (len1 === 0 || len2 === 0) return 0;

    // Levenshtein distance matrix
    const matrix: number[][] = Array(len1 + 1)
      .fill(null)
      .map(() => Array(len2 + 1).fill(0));

    // Initialize first row and column
    for (let i = 0; i <= len1; i++) matrix[i][0] = i;
    for (let j = 0; j <= len2; j++) matrix[0][j] = j;

    // Calculate edit distance
    for (let i = 1; i <= len1; i++) {
      for (let j = 1; j <= len2; j++) {
        const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1, // deletion
          matrix[i][j - 1] + 1, // insertion
          matrix[i - 1][j - 1] + cost // substitution
        );
      }
    }

    const distance = matrix[len1][len2];
    const maxLength = Math.max(len1, len2);

    // Convert distance to similarity score
    return 1 - distance / maxLength;
  }
}
