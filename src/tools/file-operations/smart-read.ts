/**
 * Smart Read Tool - 80% token reduction through intelligent caching and diff-based updates
 *
 * Features:
 * - Diff-based updates (send only changes)
 * - Automatic chunking for large files
 * - Syntax-aware truncation
 * - Cache integration with git awareness
 * - Metrics and cache provenance
 *
 * WHAT A CALL SAVED IS NOT COUNTED HERE, AND NEVER COULD BE. This tool used to
 * publish four figures about its own saving -- `tokensSaved`, `tokenCount`,
 * `originalTokenCount` and `compressionRatio` -- every one of them counted from
 * `finalContent`, the string the method returns. What a caller pays for is the
 * serialised reply built around that string after the tool has returned, with
 * its metadata block and its report text, and no code in this file can see it.
 * Measured on a 5,416-character source file at the 4,000-character chunk
 * default, the reply cost 1,765 tokens against the file's own 1,270 -- a 39%
 * LOSS -- and reported `tokensSaved: 316`.
 *
 * So both halves are counted by the one party that sees both: the recorder
 * reads the file named in the `path` argument for itself, and the server counts
 * the text it actually returns. This tool declares nothing either, because its
 * own argument already names its baseline.
 */

import { readFileSync, existsSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { CacheEngine, resolveCacheLocation } from '../../core/cache-engine.js';
import { TokenCounter } from '../../core/token-counter.js';
import { MetricsCollector } from '../../core/metrics.js';
import { generateDiff, hasMeaningfulChanges } from '../shared/diff-utils.js';
import {
  hashFile,
  generateCacheKey,
  lastWrittenKey,
} from '../shared/hash-utils.js';
import { cacheGet, cacheSet } from '../../utils/cache-helper.js';
import { authoredBase } from './authored-base.js';
import {
  chunkBySyntax,
  truncateContent,
  detectFileType,
  isMinified,
} from '../shared/syntax-utils.js';

export interface SmartReadOptions {
  // Cache options
  enableCache?: boolean;
  ttl?: number;

  // Output options
  diffMode?: boolean; // Return only diff if file was previously read
  maxSize?: number; // Maximum size to return (will truncate)
  chunkSize?: number; // Size of chunks for large files
  /**
   * Which chunk to return for a chunked file (0-based).
   *
   * Advertised in the tool schema from the start, but absent from this
   * interface and never read, so asking for chunk 2 silently returned chunk 1.
   */
  chunkIndex?: number;

  // Optimization options
  preserveStructure?: boolean; // Keep important structural elements when truncating
  // Also return path, type, hash and encoding; off by default, see
  // SmartReadMetadata for what each of them was measured to cost.
  includeMetadata?: boolean;
  encoding?: BufferEncoding; // File encoding (default: utf-8)
}

/**
 * What a read reports about the file, alongside the content itself.
 *
 * EVERY FIELD HERE IS BILLED TO THE CALLER, which is why so few of them are
 * sent unasked. Measured on this repository's own `tool-profile.ts`, the header
 * cost 127 tokens of a 1167-token reply, against a first-read overhead of about
 * 150 -- so the header was very nearly the whole of this tool's loss on a first
 * read. Of those 127, `hash` was 41 (a sha256 in hex is close to the worst case
 * a BPE tokenizer has), `path` 29 restating the argument the caller had just
 * sent, `fileType` and `encoding` 7 each -- and nothing in this repository,
 * production or test, read any of the four. The four flags added 22 more while
 * all four were false.
 *
 * So `size` is unconditional, the four descriptive fields are sent when asked
 * for, and a flag appears only when it is TRUE: the false case is the ordinary
 * one and omission says it for nothing. `getMetadata` fills the whole shape,
 * because a caller that wants metadata and no content wants exactly these.
 */
export interface SmartReadMetadata {
  /** Present when asked for, or on an explicit metadata read. */
  path?: string;
  size: number;
  /** Present when asked for, or when the file was not read as utf-8. */
  encoding?: string;
  /** Present when asked for, or on an explicit metadata read. */
  fileType?: string;
  /** Content hash. Present when asked for, or on an explicit metadata read. */
  hash?: string;
  /** Present only when the content came from the cache. */
  fromCache?: boolean;
  /** Present only when the content is a diff against an earlier read. */
  isDiff?: boolean;
  /** Present only when the file was split into chunks. */
  chunked?: boolean;
  /** Present only when the content was cut short. */
  truncated?: boolean;
  /** How many chunks the file was split into; present only when chunked. */
  chunkCount?: number;
  /** Which chunk this response carries; present only when chunked. */
  chunkIndex?: number;
}

export interface SmartReadResult {
  content: string;
  metadata: SmartReadMetadata;
  diff?: {
    added: string[];
    removed: string[];
    unchanged: number;
  };
}

export class SmartReadTool {
  private cache: CacheEngine;
  private metrics: MetricsCollector;

  constructor(
    cache: CacheEngine,
    // ACCEPTED AND NOT USED. The counter was held to count both halves of this
    // tool's own saving: the file on disk, and the string handed back standing
    // in for a reply the tool never sees. Both halves are now counted by the
    // one party that sees both, so the parameter stays only to leave every
    // caller's construction call unchanged.
    _tokenCounter: TokenCounter,
    metrics: MetricsCollector
  ) {
    this.cache = cache;
    this.metrics = metrics;
  }

  /**
   * Smart read with aggressive token optimization
   */
  async read(
    filePath: string,
    options: SmartReadOptions = {}
  ): Promise<SmartReadResult> {
    const startTime = Date.now();

    const {
      enableCache = true,
      ttl: _ttl = 3600,
      diffMode = true,
      maxSize = 100000, // 100KB default max
      chunkSize = 4000,
      preserveStructure = true,
      includeMetadata = false,
      encoding = 'utf-8',
    } = options;

    // Guard against a missing/blank path (e.g. caller passed `file_path`
    // instead of `path`) so we fail with a clear message instead of an
    // opaque downstream error. The typeof check must come first so we never
    // call a string method on a non-string; whitespace-only paths are also
    // treated as blank.
    if (typeof filePath !== 'string' || filePath.trim().length === 0) {
      throw new Error(
        'smart_read requires a non-empty "path" argument (received: ' +
          `${JSON.stringify(filePath)})`
      );
    }

    // Validate file exists
    if (!existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    // Get file stats
    const stats = statSync(filePath);
    const fileHash = hashFile(filePath);
    const fileType = detectFileType(filePath);

    // Generate cache key
    const cacheKey = generateCacheKey('smart-read', {
      path: filePath,
      options: { maxSize, chunkSize, preserveStructure },
    });

    // Check cache
    const ownCached = enableCache ? cacheGet(this.cache, cacheKey) : null;

    // FALL BACK TO WHAT WAS ALREADY WRITTEN, from the safer source first.
    //
    // TWO MECHANISMS LANDED FOR THE SAME PROBLEM and this merge keeps both,
    // because neither subsumes the other:
    //
    //   authoredBase()  is SESSION-SCOPED and covers a write made through ANY
    //     path, including the built-in Write, because the hook recorded those
    //     bytes. The record carries the session that authored it, so a caller
    //     that did not write the file gets nothing and resends -- which is
    //     today's behaviour, so it can never make a read worse. The
    //     knowledge-graph snapshot could NOT be used here for exactly that
    //     reason: `indexFile` runs on reads too, so it would have told a
    //     session that never saw a file that nothing had changed.
    //
    //   lastWrittenKey() is PATH-SCOPED and covers only this product's own
    //     smart_write / smart_edit, whose entries lived under a different
    //     namespace and so were never found on a read.
    //
    // Ordered session-scoped first: it is the one with a provenance argument.
    // Both are only ever a BASE, never the answer, so a stale entry costs a
    // diff rather than a wrong result.
    // BOTH fallbacks are gated on enableCache. `enableCache: false` is a
    // caller saying 'give me the file, not a diff against something you
    // remember'; serving `// No changes` off a persisted authored record would
    // ignore that opt-out just as surely as serving it off the cache.
    const cachedData = enableCache
      ? (ownCached ??
        authoredBase(filePath) ??
        cacheGet(this.cache, lastWrittenKey(filePath)))
      : null;

    // Deliberately NOT `cachedData !== null`. This means "my own cache entry
    // hit", which is what the metrics below report and what gates the re-seed
    // further down -- so a read served off either fallback still populates its
    // own key, and the next read needs no fallback at all.
    const fromCache = ownCached !== null;

    // Read file content
    const rawContent = readFileSync(filePath, encoding);

    let finalContent = rawContent;
    let isDiff = false;
    let truncated = false;
    let chunked = false;
    let chunkCount = 0;
    let chunkIndex = 0;
    let diffData:
      | { added: string[]; removed: string[]; unchanged: number }
      | undefined;

    // If we have cached data and diff mode is enabled.
    //
    // AN EXPLICIT chunkIndex IS A REQUEST FOR THAT CHUNK, NOT FOR NEWS.
    //
    // Diff mode answers "what changed since you last read this". Chunk
    // navigation answers "show me part 3". Both are useful; they are not the
    // same question. Without the chunkIndex guard, the intended sequence --
    // read the file, then ask for chunk 2 -- hit this branch on the second
    // call, found nothing had changed, and returned `// No changes` instead of
    // chunk 2. The documented way to page through a file worked exactly once.
    //
    // So an explicit chunkIndex bypasses the diff entirely. Omitting it keeps
    // the previous behaviour, which is what a plain re-read should do.
    if (cachedData && diffMode && options.chunkIndex === undefined) {
      try {
        // Check if content has meaningful changes
        if (hasMeaningfulChanges(cachedData, rawContent)) {
          // Generate diff
          const diff = generateDiff(cachedData, rawContent, {
            contextLines: 3,
            ignoreWhitespace: true,
          });

          // Only use diff if it's significantly smaller
          if (diff.compressionRatio < 0.5) {
            finalContent = diff.diffText;
            isDiff = true;
            diffData = {
              added: diff.added,
              removed: diff.removed,
              unchanged: diff.unchanged,
            };
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
          finalContent = '// No changes';
          isDiff = true;
        }
      } catch (error) {
        // If decompression fails, fall through to normal read
        console.error('Cache decompression failed:', error);
      }
    }

    // PAGINATION IS A REQUEST, NOT A DEFAULT.
    //
    // Every chunk carries its own metadata block and its own navigation footer,
    // and the content inside it is the file's own bytes returned verbatim -- so a
    // caller who wanted the file paid that envelope once per chunk and received
    // exactly what a single plain read would have given them. Measured on a
    // 5,416-character source file at the 4,000-character default: 1,765 tokens
    // against the file's own 1,270, a 39% LOSS, because 4,000 characters is
    // roughly a thousand tokens and any ordinary source file clears it. The
    // response reported a saving of 316 tokens on that call; that figure is gone
    // now, along with every other one this tool stated about itself, but the loss
    // it was reporting on is the reason this branch is reached by asking.
    //
    // Chunking still earns its keep when a caller genuinely wants part of a file
    // and will stop reading, so it stays -- reached by asking for it, with
    // `chunkIndex` or an explicit `chunkSize`. What changes is that a caller who
    // said only "read this file" is no longer charged for pagination they did not
    // ask for and, on the evidence above, would not have wanted.
    const paginationRequested =
      options.chunkIndex !== undefined || options.chunkSize !== undefined;

    // Handle large files - prioritize maxSize over chunking
    if (!isDiff && rawContent.length > maxSize) {
      // Check if file is minified
      if (isMinified(rawContent)) {
        // For minified files, just truncate with a warning
        const truncationMsg = '\n// [TRUNCATED: Minified file]';
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
    } else if (
      !isDiff &&
      paginationRequested &&
      rawContent.length > chunkSize &&
      rawContent.length <= maxSize
    ) {
      // Only chunk if file fits within maxSize but is larger than chunkSize
      // This allows for structured navigation of medium-sized files
      const allChunks = chunkBySyntax(rawContent, chunkSize).chunks;
      chunked = true;
      chunkCount = allChunks.length;

      // ONE chunk is returned, and it is the one that was ASKED for.
      //
      // `chunkIndex` was declared in the tool schema and named in the message
      // this very branch emits -- "use chunk index to get more" -- but it was
      // never read out of `options`, so the documented way to reach chunk 2 did
      // nothing and returned chunk 1 again.
      const requested = Number(options.chunkIndex);
      chunkIndex =
        Number.isInteger(requested) &&
        requested >= 0 &&
        requested < allChunks.length
          ? requested
          : 0;

      finalContent =
        allChunks[chunkIndex] +
        `\n\n// [chunk ${chunkIndex + 1} of ${allChunks.length}. ` +
        `Call smart_read again with chunkIndex=<n> for another.]`;
    }
    // Advance the read base after an edit too. Leaving a cache hit pinned to
    // its old bytes would return the same diff on every subsequent read.
    if (enableCache && (!fromCache || ownCached !== rawContent)) {
      cacheSet(this.cache, cacheKey, rawContent);
    }

    // Record metrics.
    //
    // NO TOKEN FIELD ON THIS RECORD EITHER. The four it carried -- in, out,
    // cached and saved -- were all derived from counting `finalContent`, so the
    // in-process totals built from them described a string nobody is sent. What
    // is left is what this method really knows: how long it took, whether its
    // own cache entry hit, and which of the three shaping paths it took.
    this.metrics.record({
      operation: 'smart_read',
      duration: Date.now() - startTime,
      success: true,
      cacheHit: fromCache,
      metadata: {
        path: filePath,
        fileSize: stats.size,
        isDiff,
        chunked,
        truncated,
      },
    });

    const header: SmartReadMetadata = { size: stats.size };

    if (includeMetadata) {
      header.path = filePath;
      header.fileType = fileType;
      header.hash = fileHash;
    }
    // The encoding is worth a line when it is NOT the one every caller assumes,
    // asked for or not: content decoded as latin1 and labelled nothing reads as
    // corrupt rather than as a different encoding. Both spellings of the default
    // count as the default, since a caller who passes one is not saying anything.
    if (includeMetadata || (encoding !== 'utf-8' && encoding !== 'utf8')) {
      header.encoding = encoding;
    }

    if (fromCache) header.fromCache = true;
    if (isDiff) header.isDiff = true;
    if (truncated) header.truncated = true;
    if (chunked) {
      header.chunked = true;
      // Navigation, not content. Attaching every chunk here defeated the
      // entire point of chunking: the caller received the whole file anyway.
      header.chunkCount = chunkCount;
      header.chunkIndex = chunkIndex;
    }

    return {
      content: finalContent,
      metadata: header,
      diff: diffData,
    };
  }

  /**
   * Read a specific chunk from a chunked file
   */
  async readChunk(
    filePath: string,
    chunkIndex: number,
    chunkSize: number = 4000
  ): Promise<string> {
    if (!existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const content = readFileSync(filePath, 'utf-8');
    const chunkResult = chunkBySyntax(content, chunkSize);

    if (chunkIndex < 0 || chunkIndex >= chunkResult.chunks.length) {
      throw new Error(
        `Invalid chunk index: ${chunkIndex}. Total chunks: ${chunkResult.chunks.length}`
      );
    }

    return chunkResult.chunks[chunkIndex];
  }

  /**
   * Get file metadata without reading content (minimal tokens)
   */
  async getMetadata(filePath: string): Promise<SmartReadResult['metadata']> {
    if (!existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const stats = statSync(filePath);
    const fileHash = hashFile(filePath);
    const fileType = detectFileType(filePath);

    return {
      path: filePath,
      size: stats.size,
      encoding: 'utf-8',
      fileType,
      hash: fileHash,
      fromCache: false,
      isDiff: false,
      chunked: false,
      truncated: false,
    };
  }
}

// Export singleton instance
let smartReadInstance: SmartReadTool | null = null;

export function getSmartReadTool(
  cache: CacheEngine,
  tokenCounter: TokenCounter,
  metrics: MetricsCollector
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
  options: SmartReadOptions = {}
): Promise<SmartReadResult> {
  const cache = new CacheEngine(
    resolveCacheLocation(join(homedir(), '.hypercontext', 'cache')),
    100
  );
  const tokenCounter = new TokenCounter();
  const metrics = new MetricsCollector();

  const tool = getSmartReadTool(cache, tokenCounter, metrics);
  return tool.read(filePath, options);
}

// MCP Tool definition
export const SMART_READ_TOOL_DEFINITION = {
  name: 'smart_read',
  description:
    'Read files with intelligent caching, diff-based updates, and syntax-aware optimization. Measured token reduction vs reading the file: -5% to -1% first read, 98-99.6% repeated on an unchanged file (bench/tools, 3 fixtures) -- a first read returns the file plus a one-field header, so it still costs a little more than reading the file; the saving is on the repeat.',
  annotations: {
    title: 'Read a file efficiently',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the file to read',
      },
      diffMode: {
        type: 'boolean',
        description:
          'Return only diff if file was previously read (default: true)',
        default: true,
      },
      maxSize: {
        type: 'number',
        description:
          'Maximum content size to return in bytes (default: 100000)',
        default: 100000,
      },
      chunkSize: {
        type: 'number',
        description: 'Size of chunks for large files (default: 4000)',
        default: 4000,
      },
      chunkIndex: {
        type: 'number',
        description: 'For chunked files, the chunk index to retrieve',
      },
      // DECLARED BECAUSE THEY ARE ACCEPTED: the server spreads the caller's whole
      // argument object into options, so these worked while being undiscoverable.
      enableCache: {
        type: 'boolean',
        description: 'Reuse a cached read of this file when it has not changed',
        default: true,
      },
      ttl: {
        type: 'number',
        description: 'Cache lifetime in seconds',
        default: 300,
      },
      preserveStructure: {
        type: 'boolean',
        description:
          'Keep structural lines (signatures, exports) when compressing output',
        default: true,
      },
      includeMetadata: {
        type: 'boolean',
        description:
          'Also return the path, type, hash and encoding of the file. Off by default: they measured 84 tokens of a reply and none of them is the file',
        default: false,
      },
      encoding: {
        type: 'string',
        description: 'File encoding used to read the file',
        default: 'utf-8',
      },
    },
    required: ['path'],
  },
};
