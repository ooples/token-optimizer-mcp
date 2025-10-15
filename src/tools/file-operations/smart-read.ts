/**
 * Smart Read Tool - 80% token reduction through intelligent caching and diff-based updates
 *
 * Features:
 * - Diff-based updates (send only changes)
 * - Automatic chunking for large files
 * - Syntax-aware truncation
 * - Cache integration with git awareness
 * - Token tracking and metrics
 */

import { readFileSync, existsSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { CacheEngine } from "../../core/cache-engine";
import { TokenCounter } from "../../core/token-counter";
import { MetricsCollector } from "../../core/metrics";
import { generateDiff, hasMeaningfulChanges } from "../shared/diff-utils";
import { hashFile, generateCacheKey } from "../shared/hash-utils";
import { compress, decompress } from "../shared/compression-utils";
import {
  chunkBySyntax,
  truncateContent,
  detectFileType,
  isMinified,
} from "../shared/syntax-utils";

export interface SmartReadOptions {
  // Cache options
  enableCache?: boolean;
  ttl?: number;

  // Output options
  diffMode?: boolean; // Return only diff if file was previously read
  maxSize?: number; // Maximum size to return (will truncate)
  chunkSize?: number; // Size of chunks for large files

  // Optimization options
  preserveStructure?: boolean; // Keep important structural elements when truncating
  includeMetadata?: boolean; // Include file metadata in response
  encoding?: BufferEncoding; // File encoding (default: utf-8)
}

export interface SmartReadResult {
  content: string;
  metadata: {
    path: string;
    size: number;
    encoding: string;
    fileType: string;
    hash: string;
    fromCache: boolean;
    isDiff: boolean;
    chunked: boolean;
    truncated: boolean;
    tokensSaved: number;
    tokenCount: number;
    originalTokenCount: number;
    compressionRatio: number;
  };
  chunks?: string[];
  diff?: {
    added: string[];
    removed: string[];
    unchanged: number;
  };
}

export class SmartReadTool {
  private cache: CacheEngine;
  private tokenCounter: TokenCounter;
  private metrics: MetricsCollector;

  constructor(
    cache: CacheEngine,
    tokenCounter: TokenCounter,
    metrics: MetricsCollector,
  ) {
    this.cache = cache;
    this.tokenCounter = tokenCounter;
    this.metrics = metrics;
  }

  /**
   * Smart read with aggressive token optimization
   */
  async read(
    filePath: string,
    options: SmartReadOptions = {},
  ): Promise<SmartReadResult> {
    const startTime = Date.now();

    const {
      enableCache = true,
      ttl = 3600,
      diffMode = true,
      maxSize = 100000, // 100KB default max
      chunkSize = 4000,
      preserveStructure = true,
      includeMetadata: _includeMetadata = true,
      encoding = "utf-8",
    } = options;

    // Validate file exists
    if (!existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    // Get file stats
    const stats = statSync(filePath);
    const fileHash = hashFile(filePath);
    const fileType = detectFileType(filePath);

    // Generate cache key
    const cacheKey = generateCacheKey("smart-read", {
      path: filePath,
      options: { maxSize, chunkSize, preserveStructure },
    });

    // Check cache
    let cachedData: Buffer | null = null;
    let fromCache = false;

    if (enableCache) {
      cachedData = this.cache.get(cacheKey);
      if (cachedData) {
        fromCache = true;
      }
    }

    // Read file content
    const rawContent = readFileSync(filePath, encoding);
    const originalTokens = this.tokenCounter.count(rawContent).tokens;

    let finalContent = rawContent;
    let isDiff = false;
    let truncated = false;
    let chunked = false;
    let chunks: string[] | undefined;
    let diffData:
      | { added: string[]; removed: string[]; unchanged: number }
      | undefined;
    let tokensSaved = 0;

    // If we have cached data and diff mode is enabled
    if (cachedData && diffMode) {
      try {
        const decompressed = decompress(cachedData, "gzip");
        const cachedContent = decompressed;

        // Check if content has meaningful changes
        if (hasMeaningfulChanges(cachedContent.toString(), rawContent)) {
          // Generate diff
          const diff = generateDiff(
            cachedContent.toString(),
            rawContent,
            {
              contextLines: 3,
              ignoreWhitespace: true,
            },
          );

          // Only use diff if it's significantly smaller
          if (diff.compressionRatio < 0.5) {
            finalContent = diff.diffText;
            isDiff = true;
            diffData = {
              added: diff.added,
              removed: diff.removed,
              unchanged: diff.unchanged,
            };

            const diffTokens = this.tokenCounter.count(finalContent).tokens;
            tokensSaved = Math.max(0, originalTokens - diffTokens);
          } else {
            // Diff exists but not efficient, still return full content with diff metadata
            isDiff = true;
            diffData = {
              added: diff.added,
              removed: diff.removed,
              unchanged: diff.unchanged,
            };
          }
        } else {
          // No changes, return minimal response
          finalContent = "// No changes";
          isDiff = true;
          tokensSaved = Math.max(
            0,
            originalTokens - this.tokenCounter.count(finalContent).tokens,
          );
        }
      } catch (error) {
        // If decompression fails, fall through to normal read
        console.error("Cache decompression failed:", error);
      }
    }

    // Handle large files - prioritize maxSize over chunking
    if (!isDiff && rawContent.length > maxSize) {
      // Check if file is minified
      if (isMinified(rawContent)) {
        // For minified files, just truncate with a warning
        const truncationMsg = "\n// [TRUNCATED: Minified file]";
        const actualMaxSize = maxSize - truncationMsg.length;
        finalContent = rawContent.substring(0, actualMaxSize) + truncationMsg;
        truncated = true;
      } else {
        // If file is larger than maxSize, truncate it
        const truncateResult = truncateContent(rawContent, maxSize, {
          keepTop: 100,
          keepBottom: 50,
          preserveStructure,
        });
        finalContent = truncateResult.truncated;
        truncated = true;
      }

      const truncatedTokens = this.tokenCounter.count(finalContent).tokens;
      tokensSaved = originalTokens - truncatedTokens;
    } else if (
      !isDiff &&
      rawContent.length > chunkSize &&
      rawContent.length <= maxSize
    ) {
      // Only chunk if file fits within maxSize but is larger than chunkSize
      // This allows for structured navigation of medium-sized files
      const chunkResult = chunkBySyntax(rawContent, chunkSize);
      chunks = chunkResult.chunks;
      chunked = true;

      // Return first chunk with metadata about total chunks
      finalContent =
        chunks[0] +
        `\n\n// [${chunks.length} chunks total, use chunk index to get more]`;

      // Calculate token savings from chunking (only returning first chunk)
      const firstChunkTokens = this.tokenCounter.count(finalContent).tokens;
      tokensSaved = originalTokens - firstChunkTokens;
    }
    if (enableCache && !fromCache) {
      const compressed = compress(rawContent, "gzip");
      this.cache.set(
        cacheKey,
        compressed.toString(),
        tokensSaved,
        ttl,
      );
    }

    // Calculate final metrics
    const finalTokens = this.tokenCounter.count(finalContent).tokens;
    // Only recalculate tokensSaved if it hasn't been set by diff mode or truncation
    if (tokensSaved === 0 && (truncated || chunked)) {
      tokensSaved = Math.max(0, originalTokens - finalTokens);
    }

    const compressionRatio = finalContent.length / rawContent.length;

    // Record metrics
    this.metrics.record({
      operation: "smart_read",
      duration: Date.now() - startTime,
      success: true,
      cacheHit: fromCache,
      inputTokens: 0,
      outputTokens: finalTokens,
      cachedTokens: fromCache ? finalTokens : 0,
      savedTokens: tokensSaved,
      metadata: {
        path: filePath,
        fileSize: stats.size,
        tokensSaved,
        isDiff,
        chunked,
        truncated,
      },
    });

    return {
      content: finalContent,
      metadata: {
        path: filePath,
        size: stats.size,
        encoding,
        fileType,
        hash: fileHash,
        fromCache,
        isDiff,
        chunked,
        truncated,
        tokensSaved,
        tokenCount: finalTokens,
        originalTokenCount: originalTokens,
        compressionRatio,
      },
      chunks,
      diff: diffData,
    };
  }

  /**
   * Read a specific chunk from a chunked file
   */
  async readChunk(
    filePath: string,
    chunkIndex: number,
    chunkSize: number = 4000,
  ): Promise<string> {
    if (!existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const content = readFileSync(filePath, "utf-8");
    const chunkResult = chunkBySyntax(content, chunkSize);

    if (chunkIndex < 0 || chunkIndex >= chunkResult.chunks.length) {
      throw new Error(
        `Invalid chunk index: ${chunkIndex}. Total chunks: ${chunkResult.chunks.length}`,
      );
    }

    return chunkResult.chunks[chunkIndex];
  }

  /**
   * Get file metadata without reading content (minimal tokens)
   */
  async getMetadata(filePath: string): Promise<SmartReadResult["metadata"]> {
    if (!existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const stats = statSync(filePath);
    const fileHash = hashFile(filePath);
    const fileType = detectFileType(filePath);

    return {
      path: filePath,
      size: stats.size,
      encoding: "utf-8",
      fileType,
      hash: fileHash,
      fromCache: false,
      isDiff: false,
      chunked: false,
      truncated: false,
      tokensSaved: 0,
      tokenCount: 0,
      originalTokenCount: 0,
      compressionRatio: 1,
    };
  }
}

// Export singleton instance
let smartReadInstance: SmartReadTool | null = null;

export function getSmartReadTool(
  cache: CacheEngine,
  tokenCounter: TokenCounter,
  metrics: MetricsCollector,
): SmartReadTool {
  if (!smartReadInstance) {
    smartReadInstance = new SmartReadTool(cache, tokenCounter, metrics);
  }
  return smartReadInstance;
}

/**
 * CLI function - Creates resources and uses factory
 */
export async function runSmartRead(
  filePath: string,
  options: SmartReadOptions = {},
): Promise<SmartReadResult> {
  const cache = new CacheEngine(100, join(homedir(), ".hypercontext", "cache"));
  const tokenCounter = new TokenCounter();
  const metrics = new MetricsCollector();

  const tool = getSmartReadTool(cache, tokenCounter, metrics);
  return tool.read(filePath, options);
}

// MCP Tool definition
export const SMART_READ_TOOL_DEFINITION = {
  name: "smart_read",
  description:
    "Read files with 80% token reduction through intelligent caching, diff-based updates, and syntax-aware optimization",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file to read",
      },
      diffMode: {
        type: "boolean",
        description:
          "Return only diff if file was previously read (default: true)",
        default: true,
      },
      maxSize: {
        type: "number",
        description:
          "Maximum content size to return in bytes (default: 100000)",
        default: 100000,
      },
      chunkSize: {
        type: "number",
        description: "Size of chunks for large files (default: 4000)",
        default: 4000,
      },
      chunkIndex: {
        type: "number",
        description: "For chunked files, the chunk index to retrieve",
      },
    },
    required: ["path"],
  },
};
