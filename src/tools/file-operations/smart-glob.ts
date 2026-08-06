/**
 * Smart Glob Tool - 75% Token Reduction
 *
 * Achieves token reduction through:
 * 1. Path-only results (no file content unless requested)
 * 2. Smart pagination (limit results, return counts)
 * 3. Cached pattern results (reuse glob results)
 * 4. Metadata filtering (filter before returning)
 * 5. Intelligent sorting (most relevant first)
 *
 * Target: 75% reduction vs listing all files with content
 */

import { globSync } from 'glob';
import { statSync, readFileSync } from 'fs';
import { relative, basename, extname, join, isAbsolute } from 'path';
import { homedir } from 'os';
import { CacheEngine } from '../../core/cache-engine.js';
import { TokenCounter } from '../../core/token-counter.js';
import { MetricsCollector } from '../../core/metrics.js';
import { generateCacheKey } from '../shared/hash-utils.js';
import { fsGeneration } from '../../utils/fs-generation.js';
import { detectFileType } from '../shared/syntax-utils.js';
import {
  resolveSearchScope,
  limitToScopedFile,
} from '../../utils/search-scope.js';

export interface FileMetadata {
  path: string;
  relativePath: string;
  name: string;
  extension: string;
  size: number;
  modified: Date;
  type: 'file' | 'directory';
  fileType?: string; // typescript, javascript, json, etc.
}

export interface SmartGlobOptions {
  // Pattern options
  /**
   * Directory to search. The natural name for it, and the one the hook's
   * refusal message leads callers to pass; takes precedence over `cwd`.
   */
  path?: string;
  cwd?: string; // Working directory (default: process.cwd())
  absolute?: boolean; // Return absolute paths (default: false)

  // Filtering options
  // Defaults are node_modules, .git, dist AND build -- the last two are real
  // source directories in plenty of projects, so `metadata.ignoredMatches`
  // reports whatever they withheld. Pass `[]` to search everything.
  ignore?: string[];
  onlyFiles?: boolean; // Only return files, not directories (default: true)
  onlyDirectories?: boolean; // Only return directories (default: false)

  // Extension filtering
  extensions?: string[]; // Filter by extensions (e.g., ['.ts', '.js'])
  excludeExtensions?: string[]; // Exclude extensions

  // Size filtering
  minSize?: number; // Minimum file size in bytes
  maxSize?: number; // Maximum file size in bytes

  // Date filtering
  modifiedAfter?: Date; // Files modified after date
  modifiedBefore?: Date; // Files modified before date

  // Output options
  includeMetadata?: boolean; // Include file metadata (default: false)
  includeContent?: boolean; // Include file content (default: false)
  maxContentSize?: number; // Max size for content inclusion (default: 10KB)

  // Pagination
  limit?: number; // Maximum results to return
  offset?: number; // Skip first N results (default: 0)

  // Sorting
  sortBy?: 'name' | 'size' | 'modified' | 'path'; // Sort field
  sortOrder?: 'asc' | 'desc'; // Sort direction (default: asc)

  // Cache options
  /**
   * Serve a previously cached result for the same query.
   *
   * DEFAULT FALSE, and the default is the point. A cached search is keyed on
   * the query, and a query does not describe the tree it ran against: create,
   * edit or delete a matching file and the cached answer is simply wrong.
   * Measured live -- a file created between two identical searches did not
   * appear in the second.
   *
   * Enabling it says "nothing outside this server is changing these files",
   * which only the caller can know. Writes made THROUGH this server are
   * handled either way: they bump a generation counter that forms part of the
   * key, so our own edits always invalidate.
   */
  useCache?: boolean;
  ttl?: number; // Cache TTL in seconds (default: 300)
}

export interface SmartGlobResult {
  success: boolean;
  pattern: string;
  metadata: {
    totalMatches: number;
    returnedCount: number;
    truncated: boolean;
    tokensSaved: number;
    tokenCount: number;
    originalTokenCount: number;
    compressionRatio: number;
    duration: number;
    cacheHit: boolean;
    /** Real matches withheld by the ignore patterns; absent when none were. */
    ignoredMatches?: number;
    /** Plain-language explanation of what was withheld and how to see it. */
    ignoreNote?: string;
  };
  files?: Array<string | FileMetadata>;
  error?: string;
}

export class SmartGlobTool {
  constructor(
    private cache: CacheEngine,
    private tokenCounter: TokenCounter,
    private metrics: MetricsCollector
  ) {}

  /**
   * Smart glob with filtering, pagination, and minimal token output
   */
  async glob(
    pattern: string,
    options: SmartGlobOptions = {}
  ): Promise<SmartGlobResult> {
    const startTime = Date.now();

    // See smart-grep.ts: `path` was silently discarded, so a scoped search
    // actually ran from the server's own launch directory. This tool did not
    // crash on it -- it returned confident results from the wrong tree, which
    // is the worse of the two failures.
    //
    // Assigning it to `cwd` then broke `path` naming a single FILE: a glob
    // rooted at a file matches nothing, so the call returned success with an
    // empty list. The scope resolves a file to its parent plus the file itself,
    // and `limitToScopedFile` below keeps the result to that one file, since
    // this tool's only filter is the caller's pattern.
    try {
      const scope = resolveSearchScope(
        options.path,
        options.cwd,
        process.cwd()
      );

      // Default options
      const opts: Required<SmartGlobOptions> = {
        cwd: scope.cwd,
        path: options.path ?? '',
        absolute: options.absolute ?? false,
        // `dist` and `build` are conventions, not guarantees. Real projects keep
        // real source in both -- AiDotNet.Tensors has two .csproj files under
        // build/, and a search for '**/*.csproj' silently returned 16 of its 18.
        // The hook DENIES the built-in Glob and sends the caller here, so a
        // silent omission is not a smaller result set, it is the caller
        // concluding their file does not exist.
        //
        // The defaults are kept, because they are right far more often than not.
        // What is removed is the SILENCE: `ignoredMatches` below reports how many
        // real matches these patterns withheld, so the omission is visible and
        // the caller can pass their own `ignore` to see them.
        ignore: options.ignore ?? [
          '**/node_modules/**',
          '**/.git/**',
          '**/dist/**',
          '**/build/**',
        ],
        onlyFiles: options.onlyFiles ?? true,
        onlyDirectories: options.onlyDirectories ?? false,
        extensions: options.extensions ?? [],
        excludeExtensions: options.excludeExtensions ?? [],
        minSize: options.minSize ?? 0,
        maxSize: options.maxSize ?? Infinity,
        modifiedAfter: options.modifiedAfter ?? new Date(0),
        modifiedBefore: options.modifiedBefore ?? new Date(8640000000000000), // Max date
        includeMetadata: options.includeMetadata ?? false,
        includeContent: options.includeContent ?? false,
        maxContentSize: options.maxContentSize ?? 10240, // 10KB
        limit: options.limit ?? Infinity,
        offset: options.offset ?? 0,
        sortBy: options.sortBy ?? 'path',
        sortOrder: options.sortOrder ?? 'asc',
        useCache: options.useCache ?? false,
        ttl: options.ttl ?? 300,
      };

      // Check cache first
      const cacheKey = generateCacheKey('glob', {
        pattern,
        options: opts,
        // Any write through this server invalidates every cached search.
        fsGeneration: fsGeneration(),
      });

      if (opts.useCache) {
        const cached = this.cache.get(cacheKey);
        if (cached) {
          const result = JSON.parse(cached.toString()) as SmartGlobResult;
          result.metadata.cacheHit = true;

          const duration = Date.now() - startTime;
          this.metrics.record({
            operation: 'smart_glob',
            duration,
            inputTokens: result.metadata.tokenCount,
            outputTokens: 0,
            cachedTokens: result.metadata.originalTokenCount,
            savedTokens: result.metadata.tokensSaved,
            success: true,
            cacheHit: true,
          });

          return result;
        }
      }

      // Perform glob search
      //
      // Narrowed to the scoped file when `path` named one -- the glob ran from
      // that file's PARENT, so without this it would also return the parent's
      // other matches and quietly widen the scope the caller asked for.
      const matches = limitToScopedFile(
        globSync(pattern, {
          cwd: opts.cwd,
          absolute: opts.absolute,
          ignore: opts.ignore,
          nodir: opts.onlyFiles,
          // `.github/`, `.claude/`, `.husky/` and every dotfile are ordinary
          // project content, but glob skips anything dot-prefixed unless told
          // otherwise. Measured in a real checkout: ten .yml files existed, all
          // under .github/workflows, and a repo-wide search returned ZERO while
          // reporting success over 654 files searched. Exclusion is the ignore
          // list's job -- .git and node_modules are still excluded by it.
          dot: true,
        }),
        scope
      );

      // Whether the exclusions in force are OURS or the caller's -- the note
      // below names them, and naming them wrongly misdirects anyone hunting a
      // file that did not come back.
      const usingDefaultIgnore = options.ignore === undefined;

      // How many REAL matches the ignore patterns withheld. Turns a silent
      // omission into a number the caller can act on.
      //
      // With `ignore: []` there is nothing to withhold and `matches` is
      // already the unignored set, so the second walk would traverse the whole
      // tree synchronously to rediscover a list we are holding -- pure cost on
      // the exact call that opted out of filtering.
      //
      // BOTH WALKS ARE SCOPED THE SAME WAY. Narrowing only the first one made
      // the difference between them look like suppressed matches: a file-scoped
      // glob returned 1 while the comparison walk still covered the parent and
      // returned 2, so the response reported that 1 file "matched but were
      // excluded by the ignore patterns" when nothing had been excluded at all.
      // A number invented to explain an absence is worse than no number.
      const ignoredMatches =
        opts.ignore.length === 0
          ? 0
          : Math.max(
              0,
              limitToScopedFile(
                globSync(pattern, {
                  cwd: opts.cwd,
                  absolute: opts.absolute,
                  nodir: opts.onlyFiles,
                  // Same reason as above; both walks must agree.
                  dot: true,
                }),
                scope
              ).length - matches.length
            );

      // Filter and collect file info
      let files: Array<{ path: string; metadata?: FileMetadata }> = [];

      for (const filePath of matches) {
        try {
          // globSync returns paths relative to opts.cwd when absolute:false.
          // statSync resolves relative paths against process.cwd(), NOT
          // opts.cwd — so when a caller passes a cwd different from the MCP
          // server's process cwd, EVERY statSync throws and every file is
          // skipped, yielding 0 matches for a directory that actually has
          // files. Resolve against opts.cwd for all filesystem access while
          // keeping the caller-facing display path (filePath) unchanged.
          const absPath = isAbsolute(filePath)
            ? filePath
            : join(opts.cwd, filePath);
          const stats = statSync(absPath);
          const isFile = stats.isFile();
          const isDir = stats.isDirectory();

          // Apply filters
          if (opts.onlyFiles && !isFile) continue;
          if (opts.onlyDirectories && !isDir) continue;

          if (isFile) {
            // Extension filter
            const ext = extname(filePath);
            if (opts.extensions.length > 0 && !opts.extensions.includes(ext))
              continue;
            if (opts.excludeExtensions.includes(ext)) continue;

            // Size filter
            if (stats.size < opts.minSize || stats.size > opts.maxSize)
              continue;

            // Date filter
            if (
              stats.mtime < opts.modifiedAfter ||
              stats.mtime > opts.modifiedBefore
            )
              continue;
          }

          // Build metadata if requested
          let metadata: FileMetadata | undefined;
          if (opts.includeMetadata) {
            metadata = {
              path: absPath,
              relativePath: relative(opts.cwd, absPath),
              name: basename(absPath),
              extension: extname(absPath),
              size: stats.size,
              modified: stats.mtime,
              type: isFile ? 'file' : 'directory',
              fileType: isFile ? detectFileType(absPath) : undefined,
            };
          }

          // Keep the caller-facing display path (respects opts.absolute).
          files.push({ path: filePath, metadata });
        } catch {
          // Skip files we can't access
          continue;
        }
      }

      // Sort files
      this.sortFiles(files, opts.sortBy, opts.sortOrder);

      // Apply pagination
      const totalMatches = files.length;
      const paginatedFiles = files.slice(opts.offset, opts.offset + opts.limit);
      const truncated = totalMatches > paginatedFiles.length + opts.offset;

      // Build result array
      const results: Array<string | FileMetadata> = paginatedFiles.map((f) => {
        if (opts.includeMetadata && f.metadata) {
          return f.metadata;
        }
        return f.path;
      });

      // Add content if requested (and files are small enough)
      if (opts.includeContent) {
        for (let i = 0; i < results.length; i++) {
          const displayPath =
            typeof results[i] === 'string'
              ? (results[i] as string)
              : (results[i] as FileMetadata).path;
          // Resolve against opts.cwd so content reads work when the display
          // path is relative (same root cause as the statSync fix above).
          const filePath = isAbsolute(displayPath)
            ? displayPath
            : join(opts.cwd, displayPath);

          try {
            const stats = statSync(filePath);
            if (stats.isFile() && stats.size <= opts.maxContentSize) {
              const content = readFileSync(filePath, 'utf-8');
              if (typeof results[i] === 'object') {
                (results[i] as any).content = content;
              }
            }
          } catch {
            // Skip content for files we can't read
          }
        }
      }

      // Calculate tokens
      const resultTokens = this.tokenCounter.count(
        JSON.stringify(results)
      ).tokens;

      // WHAT WAS ACTUALLY WITHHELD, not a multiplier.
      //
      // This used to report `resultTokens * 50` as the baseline in path-only
      // mode -- so listing 2,400 files claimed to have saved 117,943 tokens
      // without having read a single one. Nothing was read, so nothing about
      // file CONTENT was saved; the 50x came from nowhere.
      //
      // A listing's real saving is what pagination and filtering kept out of
      // the response: the paths that matched and were not returned. That is
      // countable, so it is counted. When everything matched fits in the
      // response, the honest answer is that nothing was saved.
      const withheldPaths = files
        .slice(opts.offset + paginatedFiles.length)
        .map((f) => f.path);
      const withheldTokens = withheldPaths.length
        ? this.tokenCounter.count(JSON.stringify(withheldPaths)).tokens
        : 0;

      const originalTokens = resultTokens + withheldTokens;
      const tokensSaved = withheldTokens;
      // An honest baseline can now equal the result (nothing was withheld), so
      // the ratio must not divide by zero or report a nonsense figure.
      const compressionRatio =
        originalTokens > 0 ? resultTokens / originalTokens : 1;

      // Build result
      const result: SmartGlobResult = {
        success: true,
        pattern,
        metadata: {
          totalMatches,
          returnedCount: results.length,
          truncated,
          tokensSaved,
          tokenCount: resultTokens,
          originalTokenCount: originalTokens,
          compressionRatio,
          duration: 0, // Will be set below
          cacheHit: false,
          // Only present when something was actually withheld, so a normal
          // search stays as quiet as it was.
          ...(ignoredMatches > 0
            ? {
                ignoredMatches,
                // "default" only when they ARE the defaults. A caller who
                // passed their own ignore array was told their exclusions came
                // from patterns they had just overridden, which sends anybody
                // debugging a missing file to the wrong list.
                ignoreNote:
                  `${ignoredMatches} file(s) matched but were excluded by the ` +
                  `${usingDefaultIgnore ? 'default' : 'configured'} ignore patterns ` +
                  `(${opts.ignore.join(', ')}). Pass ignore: [] to include them.`,
              }
            : {}),
        },
        files: results,
      };

      // Cache result
      if (opts.useCache) {
        const resultString = JSON.stringify(result);
        const resultSize = Buffer.from(resultString, 'utf-8').length;
        this.cache.set(cacheKey, resultString, resultSize, resultSize);
      }

      // Record metrics
      const duration = Date.now() - startTime;
      result.metadata.duration = duration;

      this.metrics.record({
        operation: 'smart_glob',
        duration,
        inputTokens: resultTokens,
        outputTokens: 0,
        cachedTokens: 0,
        savedTokens: tokensSaved,
        success: true,
        cacheHit: false,
      });

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;

      this.metrics.record({
        operation: 'smart_glob',
        duration,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        savedTokens: 0,
        success: false,
        cacheHit: false,
      });

      return {
        success: false,
        pattern,
        metadata: {
          totalMatches: 0,
          returnedCount: 0,
          truncated: false,
          tokensSaved: 0,
          tokenCount: 0,
          originalTokenCount: 0,
          compressionRatio: 0,
          duration,
          cacheHit: false,
        },
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Sort files by specified field
   */
  private sortFiles(
    files: Array<{ path: string; metadata?: FileMetadata }>,
    sortBy: string,
    sortOrder: 'asc' | 'desc'
  ): void {
    files.sort((a, b) => {
      let comparison = 0;

      switch (sortBy) {
        case 'name':
          comparison = basename(a.path).localeCompare(basename(b.path));
          break;
        case 'size':
          if (a.metadata && b.metadata) {
            comparison = a.metadata.size - b.metadata.size;
          }
          break;
        case 'modified':
          if (a.metadata && b.metadata) {
            comparison =
              a.metadata.modified.getTime() - b.metadata.modified.getTime();
          }
          break;
        case 'path':
        default:
          comparison = a.path.localeCompare(b.path);
          break;
      }

      return sortOrder === 'desc' ? -comparison : comparison;
    });
  }

  /**
   * Get glob statistics
   */
  getStats(): {
    totalGlobs: number;
    cacheHits: number;
    totalTokensSaved: number;
    averageReduction: number;
  } {
    const globMetrics = this.metrics.getOperations(0, 'smart_glob');

    const totalGlobs = globMetrics.length;
    const cacheHits = globMetrics.filter((m) => m.cacheHit).length;
    const totalTokensSaved = globMetrics.reduce(
      (sum, m) => sum + (m.savedTokens || 0),
      0
    );
    const totalInputTokens = globMetrics.reduce(
      (sum, m) => sum + (m.inputTokens || 0),
      0
    );
    const totalOriginalTokens = totalInputTokens + totalTokensSaved;

    const averageReduction =
      totalOriginalTokens > 0
        ? (totalTokensSaved / totalOriginalTokens) * 100
        : 0;

    return {
      totalGlobs,
      cacheHits,
      totalTokensSaved,
      averageReduction,
    };
  }
}

/**
 * Get smart glob tool instance
 */
export function getSmartGlobTool(
  cache: CacheEngine,
  tokenCounter: TokenCounter,
  metrics: MetricsCollector
): SmartGlobTool {
  return new SmartGlobTool(cache, tokenCounter, metrics);
}

/**
 * CLI function - Creates resources and uses factory
 */
export async function runSmartGlob(
  pattern: string,
  options: SmartGlobOptions = {}
): Promise<SmartGlobResult> {
  const cache = new CacheEngine(join(homedir(), '.hypercontext', 'cache'), 100);
  const tokenCounter = new TokenCounter();
  const metrics = new MetricsCollector();

  const tool = getSmartGlobTool(cache, tokenCounter, metrics);
  return tool.glob(pattern, options);
}

/**
 * MCP Tool Definition
 */
export const SMART_GLOB_TOOL_DEFINITION = {
  name: 'smart_glob',
  description:
    'Search files with glob patterns and 75% token reduction through path-only results and smart filtering',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description:
          'Glob pattern to match files (e.g., "src/**/*.ts", "*.json")',
      },
      path: {
        type: 'string',
        description:
          'Directory to search. Preferred over cwd; without it the search falls back to the server process directory rather than your project.',
      },
      cwd: {
        type: 'string',
        description: 'Working directory for glob search',
      },
      includeMetadata: {
        type: 'boolean',
        description: 'Include file metadata (size, modified date, etc.)',
        default: false,
      },
      includeContent: {
        type: 'boolean',
        description: 'Include file content for small files',
        default: false,
      },
      extensions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Filter by file extensions (e.g., [".ts", ".js"])',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results to return',
      },
      sortBy: {
        type: 'string',
        enum: ['name', 'size', 'modified', 'path'],
        description: 'Field to sort results by',
        default: 'path',
      },
      // DECLARED BECAUSE THEY ARE ACCEPTED. The server spreads the caller's whole
      // argument object into options, so these already worked and were simply
      // undiscoverable -- the same gap that let `path` be dropped silently and every
      // "scoped" search run from the wrong directory.
      absolute: {
        type: 'boolean',
        description:
          'Return absolute paths instead of paths relative to the search root',
        default: false,
      },
      ignore: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Glob patterns to skip. Defaults exclude node_modules, .git, dist and build -- the last two hold real source in some projects, so metadata.ignoredMatches reports what they withheld. Pass [] to search everything.',
        default: [
          '**/node_modules/**',
          '**/.git/**',
          '**/dist/**',
          '**/build/**',
        ],
      },
      onlyFiles: {
        type: 'boolean',
        description: 'Return files only, excluding directories',
        default: true,
      },
      onlyDirectories: {
        type: 'boolean',
        description: 'Return directories only',
        default: false,
      },
      excludeExtensions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Skip files with these extensions',
      },
      minSize: {
        type: 'number',
        description: 'Skip files smaller than this many bytes',
      },
      maxSize: {
        type: 'number',
        description: 'Skip files larger than this many bytes',
      },
      modifiedAfter: {
        type: 'string',
        format: 'date-time',
        description: 'Only files modified after this ISO-8601 timestamp',
      },
      modifiedBefore: {
        type: 'string',
        format: 'date-time',
        description: 'Only files modified before this ISO-8601 timestamp',
      },
      maxContentSize: {
        type: 'number',
        description:
          'Largest file, in bytes, for which includeContent returns content',
        default: 10240,
      },
      offset: {
        type: 'number',
        description:
          'Skip this many results before returning any; use with limit to page',
        default: 0,
      },
      sortOrder: {
        type: 'string',
        enum: ['asc', 'desc'],
        description: 'Sort direction for sortBy',
        default: 'asc',
      },
      useCache: {
        type: 'boolean',
        description:
          'Serve a previously cached result for the same query. Off by default: the key describes the query, not the tree, so a file created between two identical searches will not appear.',
        default: false,
      },
      ttl: {
        type: 'number',
        description: 'Cache lifetime in seconds, when useCache is on',
        default: 300,
      },
    },
    required: ['pattern'],
  },
};
