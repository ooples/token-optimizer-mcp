/**
 * Smart Grep Tool - 80% Token Reduction
 *
 * Achieves token reduction through:
 * 1. Match-only output (line numbers + matched text, not full files)
 * 2. Context line control (configurable before/after lines)
 * 3. Pattern caching (reuse search results)
 * 4. Result pagination (limit matches returned)
 * 5. Smart file filtering (skip binary, node_modules, etc.)
 *
 * Target: 80% reduction vs returning full file contents
 */

import { readFileSync, statSync } from 'fs';
import { globSync } from 'glob';
import { relative, join, resolve } from 'path';
import { homedir } from 'os';
import { CacheEngine } from '../../core/cache-engine.js';
import { TokenCounter } from '../../core/token-counter.js';
import { MetricsCollector } from '../../core/metrics.js';
import { generateCacheKey } from '../shared/hash-utils.js';
import { fsGeneration } from '../../utils/fs-generation.js';
import { detectFileType } from '../shared/syntax-utils.js';
import { appendAll } from '../shared/append-all.js';
import { resolveSearchScope } from '../../utils/search-scope.js';

/**
 * The most this tool will ever return in one response.
 *
 * Roughly 4% of a 200k context window: large enough that ordinary searches are
 * never trimmed, small enough that a pathological one cannot evict the
 * conversation it was meant to serve. Callers who genuinely want more page
 * through it with `offset`.
 */
const MAX_RESPONSE_TOKENS = 8_000;

export interface GrepMatch {
  file: string; // File path
  lineNumber: number; // 1-based line number
  column?: number; // 0-based column number (optional)
  line: string; // The matched line
  match: string; // The actual matched text
  before?: string[]; // Context lines before match
  after?: string[]; // Context lines after match
}

export interface SmartGrepOptions {
  // Search scope
  /**
   * Directory to search. The natural name for it, and the one the hook's
   * refusal message leads callers to pass; takes precedence over `cwd`.
   */
  path?: string;
  cwd?: string; // Working directory (default: process.cwd())
  files?: string[]; // Specific files to search (glob patterns)

  // Pattern options
  caseSensitive?: boolean; // Case-sensitive search (default: false)
  wholeWord?: boolean; // Match whole words only (default: false)
  regex?: boolean; // Treat pattern as regex (default: false)

  // File filtering
  extensions?: string[]; // Search only these extensions
  excludeExtensions?: string[]; // Exclude these extensions
  skipBinary?: boolean; // Skip binary files (default: true)
  ignore?: string[]; // Patterns to ignore (default: node_modules, .git)

  // Output options
  includeContext?: boolean; // Include before/after context (default: false)
  contextBefore?: number; // Lines before match (default: 0)
  contextAfter?: number; // Lines after match (default: 0)
  includeColumn?: boolean; // Include column number (default: false)
  maxMatchesPerFile?: number; // Max matches per file (default: unlimited)

  // Result options
  limit?: number; // Maximum total matches to return
  offset?: number; // Skip first N matches (default: 0)
  filesWithMatches?: boolean; // Only return filenames, not matches (default: false)
  count?: boolean; // Only return match counts (default: false)

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

  // Performance options
  maxFileSize?: number; // Skip files larger than this (bytes)
  encoding?: BufferEncoding; // File encoding (default: utf-8)
}

export interface SmartGrepResult {
  success: boolean;
  pattern: string;
  metadata: {
    totalMatches: number;
    filesSearched: number;
    filesWithMatches: number;
    returnedMatches: number;
    truncated: boolean;
    tokensSaved: number;
    tokenCount: number;
    originalTokenCount: number;
    compressionRatio: number;
    duration: number;
    cacheHit: boolean;
  };
  matches?: GrepMatch[]; // Matches (if not filesWithMatches or count mode)
  files?: string[]; // Files with matches (if filesWithMatches mode)
  /**
   * Match counts per file, when `count` is set.
   *
   * A Record rather than a Map on purpose: this crosses a JSON boundary, and a
   * Map serialises to `{}`. The type used to say Map, which was accurate about
   * the value and wrong about what the caller received.
   */
  counts?: Record<string, number>;
  /**
   * Set only when a literal search found nothing that a regex search would
   * have found.
   *
   * `pattern` is matched literally unless `regex: true`, so an alternation or a
   * character class silently means nothing and the caller gets
   * `{ success: true, totalMatches: 0, filesSearched: 7 }` -- indistinguishable
   * from a thorough search of a tree that does not contain the term. That zero
   * reads as evidence of absence and gets acted on as such.
   *
   * Deliberately narrow. It requires all three of: literal mode, zero matches,
   * and a pattern that WOULD have matched as a regex. A hint on every empty
   * result would be noise, and a caller who learns to ignore it is no better
   * off than one who never saw it.
   */
  hint?: string;
  error?: string;
}

/**
 * True when a group that already contains a quantifier is itself quantified.
 *
 * `(a+)+`, `(x*)*`, `(ab+){2,}` -- the classic catastrophic-backtracking shape,
 * where the engine has exponentially many ways to split the same input.
 *
 * DELIBERATELY CONSERVATIVE AND DELIBERATELY CRUDE. It is a gate on offering an
 * optional hint, not a security boundary: a false positive costs one hint, and
 * refusing to guess is the safe direction. A real answer needs a parser, and a
 * parser here would be a larger thing to get wrong than the problem it solves.
 *
 * Escaped parens and escaped quantifiers are stripped first, so `\(a\+\)` --
 * which is literal text, not a group -- does not read as one.
 */
function hasNestedQuantifier(pattern: string): boolean {
  const bare = pattern.replace(/\\./g, '');
  return /\([^()]*[*+]\)[*+{]|\([^()]*\{\d+,?\d*\}[^()]*\)[*+{]/.test(bare);
}

export class SmartGrepTool {
  constructor(
    private cache: CacheEngine,
    private tokenCounter: TokenCounter,
    private metrics: MetricsCollector
  ) {}

  /**
   * Smart grep with match-only output and context control
   */
  async grep(
    pattern: string,
    options: SmartGrepOptions = {}
  ): Promise<SmartGrepResult> {
    const startTime = Date.now();

    // `path` FIRST, and it is not a cosmetic alias.
    //
    // The hook refuses the built-in Grep and names this tool as the
    // replacement, so callers pass the one argument that describes a search:
    // where to look. `path` was undeclared, and an undeclared field that is
    // not a near miss of a declared one is discarded silently -- so `cwd` fell
    // back to process.cwd(), which for an MCP server is its own launch
    // directory. Measured: every "scoped" search actually walked 676,875 files
    // across the whole home directory, for 65 seconds, and answered about the
    // wrong tree.
    //
    // Assigning it straight to `cwd` then broke the OTHER reading of `path`: a
    // single FILE became the search root, and the default `['**/*']` cannot
    // match inside a file, so a file-scoped search reported success with zero
    // matches. `resolveSearchScope` handles both readings, and reports a path
    // that does not exist rather than answering zero for it.
    try {
      const scope = resolveSearchScope(
        options.path,
        options.cwd,
        process.cwd()
      );

      // Default options
      const opts: Required<SmartGrepOptions> = {
        cwd: scope.cwd,
        path: options.path ?? '',
        // A caller's explicit `files` wins over the one derived from `path`, so
        // `path` narrows the scope rather than overriding a stated filter.
        files: options.files ?? scope.files ?? ['**/*'],
        caseSensitive: options.caseSensitive ?? false,
        wholeWord: options.wholeWord ?? false,
        regex: options.regex ?? false,
        extensions: options.extensions ?? [],
        excludeExtensions: options.excludeExtensions ?? [
          '.min.js',
          '.map',
          '.lock',
        ],
        skipBinary: options.skipBinary ?? true,
        ignore: options.ignore ?? [
          '**/node_modules/**',
          '**/.git/**',
          '**/dist/**',
          '**/build/**',
        ],
        includeContext: options.includeContext ?? false,
        contextBefore: options.contextBefore ?? 0,
        contextAfter: options.contextAfter ?? 0,
        includeColumn: options.includeColumn ?? false,
        maxMatchesPerFile: options.maxMatchesPerFile ?? Infinity,
        limit: options.limit ?? Infinity,
        offset: options.offset ?? 0,
        filesWithMatches: options.filesWithMatches ?? false,
        count: options.count ?? false,
        useCache: options.useCache ?? false,
        ttl: options.ttl ?? 300,
        maxFileSize: options.maxFileSize ?? 10 * 1024 * 1024, // 10MB default
        encoding: options.encoding ?? 'utf-8',
      };

      // Check cache first
      const cacheKey = generateCacheKey('grep', {
        pattern,
        options: opts,
        // Any write through this server invalidates every cached search.
        fsGeneration: fsGeneration(),
      });

      if (opts.useCache) {
        const cached = this.cache.get(cacheKey);
        if (cached) {
          const result = JSON.parse(cached.toString()) as SmartGrepResult;
          result.metadata.cacheHit = true;

          const duration = Date.now() - startTime;
          this.metrics.record({
            operation: 'smart_grep',
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

      // Build search pattern
      const searchPattern = this.buildPattern(pattern, opts);

      // Find files to search
      let filesToSearch: string[] = [];
      for (const filePattern of opts.files) {
        const matches = globSync(filePattern, {
          cwd: opts.cwd,
          absolute: true,
          ignore: opts.ignore,
          nodir: true,
          // `.github/`, `.claude/`, `.husky/` and every dotfile are ordinary
          // project content, but glob skips anything dot-prefixed unless told
          // otherwise -- so every CI workflow in the repository was invisible.
          // Measured: searching a tree returned 0 matches over 654 files while
          // reporting success, and naming `.github` explicitly in `path` returned
          // 7 matches in 4 files. This is the third shape of the same defect in
          // this tool, and the worst: the other two reported `filesSearched: 0`,
          // whereas this one looks like a thorough search that found nothing.
          // What is excluded stays the ignore list's job.
          dot: true,
        });
        appendAll(filesToSearch, matches);
      }

      // Filter files by extension and size
      filesToSearch = filesToSearch.filter((file) => {
        try {
          // Extension filter
          if (opts.extensions.length > 0) {
            const hasAllowedExt = opts.extensions.some((ext) =>
              file.endsWith(ext)
            );
            if (!hasAllowedExt) return false;
          }

          const hasExcludedExt = opts.excludeExtensions.some((ext) =>
            file.endsWith(ext)
          );
          if (hasExcludedExt) return false;

          // Size filter
          const stats = statSync(file);
          if (stats.size > opts.maxFileSize) return false;

          // Binary file filter
          if (opts.skipBinary && this.isBinaryFile(file)) return false;

          return true;
        } catch {
          return false;
        }
      });

      const filesSearched = filesToSearch.length;

      // Search files
      const allMatches: GrepMatch[] = [];
      const filesWithMatches = new Set<string>();
      const matchCounts = new Map<string, number>();

      // Would this pattern have matched as a regex? One test per FILE, not per
      // line, and abandoned the moment it answers yes -- the question is
      // whether any match exists at all, so counting them would cost more and
      // say no more.
      const regexProbe = this.buildRegexProbe(pattern, opts);
      let regexWouldMatch = false;

      for (const file of filesToSearch) {
        try {
          const content = readFileSync(file, opts.encoding);
          const lines = content.split('\n');
          const fileMatches: GrepMatch[] = [];

          // PER LINE, because that is how the search itself matches.
          //
          // Testing whole file contents disagreed with the search in both
          // directions: `^TOKEN$` is false against a multi-line string -- `^`
          // and `$` anchor to the ends of the WHOLE string without the `m`
          // flag -- so the hint went missing for exactly the anchored patterns
          // someone reaching for regex is most likely to write; and a pattern
          // spanning a newline matched the file while matching no line, which
          // would have promised a `regex: true` result that does not exist.
          if (
            regexProbe &&
            !regexWouldMatch &&
            lines.some((l) => regexProbe.test(l))
          ) {
            regexWouldMatch = true;
          }

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const matches = [...line.matchAll(searchPattern)];

            for (const match of matches) {
              if (fileMatches.length >= opts.maxMatchesPerFile) break;

              const grepMatch: GrepMatch = {
                file: relative(opts.cwd, file),
                lineNumber: i + 1, // 1-based
                line: line,
                match: match[0],
              };

              // Add column if requested
              if (opts.includeColumn && match.index !== undefined) {
                grepMatch.column = match.index;
              }

              // Add context if requested
              if (opts.includeContext) {
                if (opts.contextBefore > 0) {
                  const start = Math.max(0, i - opts.contextBefore);
                  grepMatch.before = lines.slice(start, i);
                }
                if (opts.contextAfter > 0) {
                  const end = Math.min(lines.length, i + opts.contextAfter + 1);
                  grepMatch.after = lines.slice(i + 1, end);
                }
              }

              fileMatches.push(grepMatch);
            }
          }

          if (fileMatches.length > 0) {
            filesWithMatches.add(relative(opts.cwd, file));
            matchCounts.set(relative(opts.cwd, file), fileMatches.length);
            appendAll(allMatches, fileMatches);
          }
        } catch {
          // Skip files we can't read
          continue;
        }
      }

      // Apply pagination
      const totalMatches = allMatches.length;
      let paginatedMatches = allMatches.slice(
        opts.offset,
        opts.offset + opts.limit
      );

      // A HARD CEILING ON THE RESPONSE, because this tool's whole promise is
      // that it "caps and deduplicates results before they reach the context
      // window" -- the words the hook uses when it REFUSES the built-in Grep
      // and sends the caller here.
      //
      // It did not cap anything: `limit` defaults to Infinity, so a broad
      // search with context returned every match. Measured on this repository:
      // one `grep 'export function' src/**/*.ts` produced a 481,578-token
      // response -- more than twice a 200k context window, from the tool whose
      // entire purpose is preventing exactly that.
      //
      // The budget is enforced on the SERIALISED result, since that is what the
      // caller pays for, and whatever is dropped is reported rather than
      // silently discarded.
      let budgetTruncated = false;
      while (paginatedMatches.length > 1) {
        const size = this.tokenCounter.count(
          JSON.stringify({ matches: paginatedMatches })
        ).tokens;
        if (size <= MAX_RESPONSE_TOKENS) break;
        // Drop the tail proportionally rather than one at a time, so a huge
        // result set converges in a few passes instead of thousands.
        const keep = Math.max(
          1,
          Math.floor(
            paginatedMatches.length * Math.min(0.9, MAX_RESPONSE_TOKENS / size)
          )
        );
        paginatedMatches = paginatedMatches.slice(0, keep);
        budgetTruncated = true;
      }

      const truncated =
        budgetTruncated || totalMatches > paginatedMatches.length + opts.offset;

      // Build result based on mode
      let resultData: any;
      let resultTokens: number;

      if (opts.count) {
        // Count mode: return counts only
        resultData = { counts: Object.fromEntries(matchCounts) };
        resultTokens = this.tokenCounter.count(
          JSON.stringify(resultData)
        ).tokens;
      } else if (opts.filesWithMatches) {
        // Files-with-matches mode: return filenames only
        resultData = { files: Array.from(filesWithMatches) };
        resultTokens = this.tokenCounter.count(
          JSON.stringify(resultData)
        ).tokens;
      } else {
        // Normal mode: return matches
        resultData = { matches: paginatedMatches };
        resultTokens = this.tokenCounter.count(
          JSON.stringify(resultData)
        ).tokens;
      }

      // THE BASELINE IS MEASURED, NOT INVENTED.
      //
      // This used to multiply the result by 100, 20 or 5 depending on mode and
      // call the difference a saving. Those numbers came from nowhere: a search
      // returning 200 tokens claimed to have saved 19,800 without anything
      // having been read. An overstated saving is the one number this project
      // must never produce, and this was the largest one it produced.
      //
      // The honest comparison is the alternative the caller actually had: to
      // find these matches by hand they would have read the files that contain
      // them. That is a real quantity -- the files are known and their sizes
      // are on disk -- so it is summed rather than guessed. Files that could
      // not be stat'd are simply not counted, which understates the saving; of
      // the two directions to be wrong in, that is the safe one.
      let searchedBytes = 0;
      for (const file of filesWithMatches) {
        try {
          searchedBytes += statSync(resolve(opts.cwd, file)).size;
        } catch {
          // Not counted rather than estimated.
        }
      }
      // ~4 bytes per token is the same conversion used elsewhere in this
      // codebase for byte-denominated budgets.
      const originalTokens = Math.max(
        resultTokens,
        Math.round(searchedBytes / 4)
      );

      const tokensSaved = Math.max(0, originalTokens - resultTokens);
      // An honest baseline can now equal the result (nothing was withheld), so
      // the ratio must not divide by zero or report a nonsense figure.
      const compressionRatio =
        originalTokens > 0 ? resultTokens / originalTokens : 1;

      // Build result
      const result: SmartGrepResult = {
        success: true,
        pattern,
        metadata: {
          totalMatches,
          filesSearched,
          filesWithMatches: filesWithMatches.size,
          returnedMatches:
            opts.count || opts.filesWithMatches ? 0 : paginatedMatches.length,
          truncated,
          tokensSaved,
          tokenCount: resultTokens,
          originalTokenCount: originalTokens,
          compressionRatio,
          duration: 0, // Will be set below
          cacheHit: false,
        },
        // PLAIN OBJECT, not the Map. This result is JSON-serialised on its way
        // to every caller, and a Map stringifies to `{}` -- so count mode
        // returned an empty counts map beside a correct totalMatches, which is
        // the one thing the flag exists to provide. The cache path a few lines
        // up already used Object.fromEntries; only the returned object was
        // wrong, so the two disagreed about the same query.
        ...(opts.count ? { counts: Object.fromEntries(matchCounts) } : {}),
        ...(opts.filesWithMatches
          ? { files: Array.from(filesWithMatches) }
          : {}),
        ...(!opts.count && !opts.filesWithMatches
          ? { matches: paginatedMatches }
          : {}),
        // A zero that would not have been a zero. See SmartGrepResult.hint:
        // this fires only when the search was literal, found nothing, and the
        // pattern matches as a regex -- so it never contradicts a real result
        // and never fires on a genuinely absent term.
        ...(totalMatches === 0 && regexWouldMatch
          ? {
              hint:
                `No literal match for "${pattern}", but it matches as a regular ` +
                `expression. Patterns are literal unless you pass regex: true.`,
            }
          : {}),
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
        operation: 'smart_grep',
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
        operation: 'smart_grep',
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
          filesSearched: 0,
          filesWithMatches: 0,
          returnedMatches: 0,
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
   * Build search pattern from string
   */
  private buildPattern(
    pattern: string,
    opts: Required<SmartGrepOptions>
  ): RegExp {
    let regexPattern = pattern;

    // Escape regex special characters if not in regex mode
    if (!opts.regex) {
      regexPattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // Add word boundary if whole word mode
    if (opts.wholeWord) {
      regexPattern = `\\b${regexPattern}\\b`;
    }

    // Build flags
    const flags = opts.caseSensitive ? 'g' : 'gi';

    return new RegExp(regexPattern, flags);
  }

  /**
   * The regex the caller may have meant, or null when there is nothing to warn
   * about.
   *
   * Null in three cases, each of which would make a hint wrong rather than
   * merely unhelpful: the search is already a regex search; escaping changed
   * nothing, so literal and regex mean the same thing; or the pattern is not
   * valid regex syntax, so `regex: true` would not have helped either.
   *
   * NOT global. The caller tests whole file contents with it, and a `g` regex
   * carries `lastIndex` between calls -- reusing one across files would skip
   * matches and make the hint depend on file order.
   */
  private buildRegexProbe(
    pattern: string,
    opts: Required<SmartGrepOptions>
  ): RegExp | null {
    if (opts.regex) return null;

    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (escaped === pattern) return null;

    // A LITERAL SEARCH MUST NOT BE ABLE TO HANG THE PROCESS.
    //
    // Compiling and running the caller's pattern is exposure this probe
    // introduces: before it, `(a+)+$` was plain text and cost nothing. Measured
    // against a 26-character line, the unguarded probe spent 10.5 SECONDS
    // backtracking. The hint is a convenience, so declining to offer it on a
    // pathological pattern costs the caller nothing they had before.
    if (hasNestedQuantifier(pattern)) return null;

    try {
      const body = opts.wholeWord ? `\\b${pattern}\\b` : pattern;
      return new RegExp(body, opts.caseSensitive ? '' : 'i');
    } catch {
      return null;
    }
  }

  /**
   * Check if a file is binary
   */
  private isBinaryFile(filePath: string): boolean {
    try {
      // Read first 8KB to check for binary content
      const buffer = readFileSync(filePath, { encoding: null }).slice(0, 8192);

      // Check for null bytes (common in binary files)
      for (let i = 0; i < buffer.length; i++) {
        if (buffer[i] === 0) {
          return true;
        }
      }

      // Check file type
      const fileType = detectFileType(filePath);
      const binaryTypes = ['image', 'video', 'audio', 'binary', 'archive'];
      return binaryTypes.includes(fileType || '');
    } catch {
      return false;
    }
  }

  /**
   * Get grep statistics
   */
  getStats(): {
    totalSearches: number;
    cacheHits: number;
    totalTokensSaved: number;
    averageReduction: number;
  } {
    const grepMetrics = this.metrics.getOperations(0, 'smart_grep');

    const totalSearches = grepMetrics.length;
    const cacheHits = grepMetrics.filter((m) => m.cacheHit).length;
    const totalTokensSaved = grepMetrics.reduce(
      (sum, m) => sum + (m.savedTokens || 0),
      0
    );
    const totalInputTokens = grepMetrics.reduce(
      (sum, m) => sum + (m.inputTokens || 0),
      0
    );
    const totalOriginalTokens = totalInputTokens + totalTokensSaved;

    const averageReduction =
      totalOriginalTokens > 0
        ? (totalTokensSaved / totalOriginalTokens) * 100
        : 0;

    return {
      totalSearches,
      cacheHits,
      totalTokensSaved,
      averageReduction,
    };
  }
}

/**
 * Get smart grep tool instance
 */
export function getSmartGrepTool(
  cache: CacheEngine,
  tokenCounter: TokenCounter,
  metrics: MetricsCollector
): SmartGrepTool {
  return new SmartGrepTool(cache, tokenCounter, metrics);
}

/**
 * CLI function - Creates resources and uses factory
 */
export async function runSmartGrep(
  pattern: string,
  options: SmartGrepOptions = {}
): Promise<SmartGrepResult> {
  const cache = new CacheEngine(join(homedir(), '.hypercontext', 'cache'), 100);
  const tokenCounter = new TokenCounter();
  const metrics = new MetricsCollector();

  const tool = getSmartGrepTool(cache, tokenCounter, metrics);
  return tool.grep(pattern, options);
}

/**
 * MCP Tool Definition
 */
export const SMART_GREP_TOOL_DEFINITION = {
  name: 'smart_grep',
  description:
    'Search file contents with 80% token reduction through match-only output and smart filtering',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Search pattern (string or regex)',
      },
      path: {
        type: 'string',
        description:
          'Directory to search. Preferred over cwd; without it the search falls back to the server process directory rather than your project.',
      },
      cwd: {
        type: 'string',
        description: 'Working directory for search',
      },
      files: {
        type: 'array',
        items: { type: 'string' },
        description: 'File patterns to search (glob patterns)',
      },
      caseSensitive: {
        type: 'boolean',
        description: 'Case-sensitive search',
        default: false,
      },
      regex: {
        type: 'boolean',
        description: 'Treat pattern as regex',
        default: false,
      },
      extensions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Search only these file extensions',
      },
      includeContext: {
        type: 'boolean',
        description: 'Include context lines around matches',
        default: false,
      },
      contextBefore: {
        type: 'number',
        description: 'Lines of context before match',
        default: 0,
      },
      contextAfter: {
        type: 'number',
        description: 'Lines of context after match',
        default: 0,
      },
      limit: {
        type: 'number',
        description: 'Maximum matches to return',
      },
      filesWithMatches: {
        type: 'boolean',
        description: 'Only return filenames, not matches',
        default: false,
      },
      count: {
        type: 'boolean',
        description: 'Only return match counts per file',
        default: false,
      },
      // DECLARED BECAUSE THEY ARE ACCEPTED. The server spreads the caller's whole
      // argument object into options, so each of these already worked -- it simply
      // could not be discovered, and a caller guessing a neighbouring name got
      // silence rather than an error.
      wholeWord: {
        type: 'boolean',
        description: 'Match whole words only',
        default: false,
      },
      excludeExtensions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Skip files with these extensions',
        default: ['.min.js', '.map', '.lock'],
      },
      skipBinary: {
        type: 'boolean',
        description: 'Skip files that look binary',
        default: true,
      },
      ignore: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Glob patterns to skip. Defaults exclude node_modules, .git, dist and build; pass [] to search everything.',
        default: [
          '**/node_modules/**',
          '**/.git/**',
          '**/dist/**',
          '**/build/**',
        ],
      },
      includeColumn: {
        type: 'boolean',
        description: 'Include the 0-based column of each match',
        default: false,
      },
      maxMatchesPerFile: {
        type: 'number',
        description: 'Stop after this many matches in any one file',
      },
      offset: {
        type: 'number',
        description:
          'Skip this many matches before returning any; use with limit to page',
        default: 0,
      },
      useCache: {
        type: 'boolean',
        description:
          'Serve a previously cached result for the same query. Off by default: a cached search is keyed on the query, not on the tree it ran against, so a file created between two identical searches will not appear.',
        default: false,
      },
      ttl: {
        type: 'number',
        description: 'Cache lifetime in seconds, when useCache is on',
        default: 300,
      },
      maxFileSize: {
        type: 'number',
        description: 'Skip files larger than this many bytes',
        default: 10485760,
      },
      encoding: {
        type: 'string',
        description: 'File encoding used to read candidates',
        default: 'utf-8',
      },
    },
    required: ['pattern'],
  },
};
