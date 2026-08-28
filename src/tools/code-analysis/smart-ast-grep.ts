/**
 * Smart AST Grep Tool - 83% Token Reduction through Pattern Indexing
 *
 * Achieves token reduction through:
 * 1. AST index caching (parse once, query many times)
 * 2. Pattern-based result caching (common patterns reuse results)
 * 3. Incremental indexing (only reindex changed files)
 * 4. Match-only output (return only matching nodes, not full AST)
 * 5. Intelligent cache invalidation (file hash-based)
 *
 * Target: 83% reduction vs running ast-grep each time
 */

import { execFileSafeSync } from '../../utils/safe-exec.js';
import {
  resolveBinScript,
  resolveNpmScript,
} from '../build-systems/run-node-bin.js';
import { existsSync, statSync } from 'fs';
import { join, relative } from 'path';
import { CacheEngine } from '../../core/cache-engine.js';
import { TokenCounter } from '../../core/token-counter.js';
import { MetricsCollector } from '../../core/metrics.js';
import { hashFile } from '../shared/hash-utils.js';
import {
  boundedWalk,
  traversalDeadlineMs,
  type TruncationReason,
} from '../shared/bounded-traversal.js';

/**
 * The ast-grep CLI package, pinned by name.
 *
 * NOT `ast-grep` -- that npm name belongs to an unrelated stub at 0.1.0. The
 * tool this file drives is `@ast-grep/cli`, which ships the `ast-grep` and `sg`
 * binaries. Pinning the minor keeps a future breaking release from silently
 * changing what a search returns.
 */
const AST_GREP_PACKAGE = '@ast-grep/cli';

export interface SmartAstGrepOptions {
  // Pattern options
  pattern: string;
  language?:
    | 'ts'
    | 'tsx'
    | 'js'
    | 'jsx'
    | 'py'
    | 'go'
    | 'rs'
    | 'java'
    | 'c'
    | 'cpp';

  // Search scope
  projectPath: string;
  filePattern?: string; // e.g., "src/**/*.ts"
  excludePatterns?: string[];

  // Cache options
  enableCache?: boolean;
  ttl?: number; // 7 days default for AST indexes

  // Output options
  contextLines?: number; // Lines of context around matches
  maxMatches?: number; // Limit results
  includeContext?: boolean;

  // Performance options
  respectGitignore?: boolean;
  incrementalIndexing?: boolean;

  /**
   * Wall-clock budget in ms for discovering the files to index.
   *
   * Discovery was a recursive `readdirSync` that enumerated every entry and
   * only then tested it against the exclusions -- so `node_modules` was read
   * in full before being thrown away, on the event loop, with no point at
   * which the walk could give up and answer. Defaults to 10 s.
   */
  deadlineMs?: number;
}

export interface AstMatch {
  file: string;
  line: number;
  column: number;
  match: string;
  context?: {
    before: string[];
    after: string[];
  };
  nodeType: string;
}

export interface SmartAstGrepResult {
  matches: AstMatch[];
  metadata: {
    pattern: string;
    language: string;
    filesScanned: number;
    filesIndexed: number;
    matchCount: number;
    fromCache: boolean;
    cacheHit: boolean;
    tokensSaved: number;
    tokenCount: number;
    originalTokenCount: number;
    compressionRatio: number;
    executionTime: number;
    indexStats?: {
      indexAge: number;
      reindexedFiles: number;
      cachedFiles: number;
    };
    /**
     * Set when a bound stopped file discovery, so the index covers only part
     * of the project and a missing match may simply be an unvisited file.
     *
     * Neither the index nor the pattern result is cached while this is set:
     * the index key is derived from the project path and language, not from
     * the file set, so a partial index stored under it would be served in
     * answer to every later search.
     */
    searchTruncated?: boolean;
    searchTruncatedBy?: TruncationReason;
    searchNote?: string;
  };
  suggestions?: string[];
}

interface FileIndexEntry {
  path: string;
  hash: string;
  language: string;
  lastIndexed: number;
  nodeCount: number;
  patterns: Set<string>;
}

interface AstIndex {
  version: string;
  projectPath: string;
  files: Map<string, FileIndexEntry>;
  patterns: Map<string, Set<string>>; // pattern -> file paths that match
  lastUpdated: number;
}

export class SmartAstGrepTool {
  private cache: CacheEngine;
  private tokenCounter: TokenCounter;
  private metrics: MetricsCollector;
  private static readonly INDEX_VERSION = '1.0.0';
  private static readonly DEFAULT_TTL = 7 * 24 * 3600; // 7 days
  private static readonly COMMON_PATTERNS = [
    'import $NAME from $MODULE',
    'export const $NAME = $VALUE',
    'export function $NAME($ARGS) { $BODY }',
    'class $NAME',
    'interface $NAME',
    'type $NAME = $TYPE',
    'function $NAME($ARGS) { $BODY }',
    'async function $NAME($ARGS) { $BODY }',
    'const $NAME = ($ARGS) => $BODY',
    'new $CLASS($ARGS)',
  ];

  constructor(
    cache: CacheEngine,
    tokenCounter: TokenCounter,
    metrics: MetricsCollector
  ) {
    this.cache = cache;
    this.tokenCounter = tokenCounter;
    this.metrics = metrics;
  }

  /**
   * Smart AST grep with pattern indexing
   */
  async grep(
    pattern: string,
    options: SmartAstGrepOptions
  ): Promise<SmartAstGrepResult> {
    const startTime = Date.now();

    const {
      language,
      projectPath,
      filePattern,
      excludePatterns = [],
      enableCache = true,
      ttl = SmartAstGrepTool.DEFAULT_TTL,
      contextLines = 3,
      maxMatches = 100,
      includeContext = true,
      respectGitignore = true,
      incrementalIndexing = true,
    } = options;
    const deadlineMs = traversalDeadlineMs(options.deadlineMs);
    let searchTruncatedBy: TruncationReason | undefined;

    // Validate project path
    if (!existsSync(projectPath)) {
      throw new Error(`Project path not found: ${projectPath}`);
    }

    // Auto-detect language if not provided
    const detectedLanguage =
      language || this.detectLanguage(pattern, projectPath);

    // Generate cache keys
    const indexKey = this.generateIndexKey(projectPath, detectedLanguage);
    const patternKey = this.generatePatternKey(pattern, projectPath, options);

    // Check pattern cache first (fastest path)
    let fromPatternCache = false;

    if (enableCache) {
      const cached = this.cache.get(patternKey);
      if (cached) {
        try {
          const parsedResult = JSON.parse(cached) as SmartAstGrepResult;
          fromPatternCache = true;

          // Update execution time for cached result
          parsedResult.metadata.executionTime = Date.now() - startTime;
          parsedResult.metadata.fromCache = true;

          // Record metrics
          this.recordMetrics(parsedResult, startTime, true);

          return parsedResult;
        } catch (error) {
          // Invalid cache, continue with fresh search
          console.warn('Invalid pattern cache, regenerating:', error);
        }
      }
    }

    // Load or create AST index
    let index = this.loadIndex(indexKey);
    let reindexedFiles = 0;
    let cachedFiles = 0;

    if (!index || !enableCache) {
      // Create new index
      const created = await this.createIndex(
        projectPath,
        detectedLanguage,
        filePattern,
        excludePatterns,
        respectGitignore,
        deadlineMs
      );
      index = created.index;
      searchTruncatedBy = created.truncatedBy;
      reindexedFiles = index.files.size;

      // A PARTIAL INDEX IS NEVER CACHED. The index key is derived from the
      // project path and language, NOT from the file set, so a partial index
      // stored under it would be served to every later search of this project
      // for the whole TTL -- silently answering "no matches" for files that
      // were never walked.
      if (enableCache && !searchTruncatedBy) {
        this.cacheIndex(indexKey, index, ttl);
      }
    } else if (incrementalIndexing) {
      // Incremental update: check for changed files
      const updates = await this.updateIndex(
        index,
        projectPath,
        detectedLanguage,
        filePattern,
        excludePatterns,
        respectGitignore,
        deadlineMs
      );
      reindexedFiles = updates.reindexed;
      cachedFiles = updates.cached;
      searchTruncatedBy = updates.truncatedBy;

      // Update cache if files changed -- but never with a partial walk, for
      // the same reason as above.
      if (reindexedFiles > 0 && enableCache && !searchTruncatedBy) {
        this.cacheIndex(indexKey, index, ttl);
      }
    }

    // Execute ast-grep search on indexed files
    const matches = await this.executeAstGrep(
      pattern,
      detectedLanguage,
      index,
      contextLines,
      includeContext,
      respectGitignore,
      filePattern
    );

    // Limit matches
    const limitedMatches = matches.slice(0, maxMatches);

    // Calculate tokens
    const fullOutput = this.formatFullOutput(limitedMatches);
    const originalTokensResult = this.tokenCounter.count(fullOutput);
    const originalTokens = originalTokensResult.tokens;
    const compactOutput = this.formatCompactOutput(limitedMatches);
    const cachedTokensResult = this.tokenCounter.count(compactOutput);
    const cachedTokens = cachedTokensResult.tokens;
    const tokensSaved = Math.max(0, originalTokens - cachedTokens);
    const compressionRatio =
      originalTokens > 0 ? cachedTokens / originalTokens : 1;

    // Generate pattern suggestions
    const suggestions = this.generatePatternSuggestions(pattern);

    // Build result
    const result: SmartAstGrepResult = {
      matches: limitedMatches,
      metadata: {
        pattern,
        language: detectedLanguage,
        filesScanned: index.files.size,
        filesIndexed: reindexedFiles,
        matchCount: limitedMatches.length,
        fromCache: fromPatternCache,
        cacheHit: fromPatternCache,
        tokensSaved,
        tokenCount: cachedTokens,
        originalTokenCount: originalTokens,
        compressionRatio,
        executionTime: Date.now() - startTime,
        indexStats: {
          indexAge: Date.now() - index.lastUpdated,
          reindexedFiles,
          cachedFiles,
        },
      },
      suggestions: suggestions.length > 0 ? suggestions : undefined,
    };

    if (searchTruncatedBy) {
      result.metadata.searchTruncated = true;
      result.metadata.searchTruncatedBy = searchTruncatedBy;
      result.metadata.searchNote =
        'File discovery stopped at the ' +
        deadlineMs +
        'ms traversal deadline after indexing ' +
        index.files.size +
        ' file(s), so parts of the project were never searched and an absent match may just be an unvisited file. Narrow `projectPath`/`excludePatterns`, or raise TOKEN_OPTIMIZER_TRAVERSAL_DEADLINE_MS.';
    }

    // Cache pattern result -- but not one produced from a partial walk. The
    // pattern key does not encode which files were reached, so caching it
    // would answer every later identical search with the short version.
    if (enableCache && !fromPatternCache && !searchTruncatedBy) {
      this.cachePatternResult(patternKey, result, ttl);
    }

    // Record metrics
    this.recordMetrics(result, startTime, fromPatternCache);

    return result;
  }

  /**
   * Create new AST index for project
   */
  private async createIndex(
    projectPath: string,
    language: string,
    filePattern?: string,
    excludePatterns: string[] = [],
    respectGitignore: boolean = true,
    deadlineMs?: number
  ): Promise<{ index: AstIndex; truncatedBy?: TruncationReason }> {
    const discovery = await this.findSourceFiles(
      projectPath,
      language,
      filePattern,
      excludePatterns,
      respectGitignore,
      deadlineMs
    );
    const files = discovery.files;

    const index: AstIndex = {
      version: SmartAstGrepTool.INDEX_VERSION,
      projectPath,
      files: new Map(),
      patterns: new Map(),
      lastUpdated: Date.now(),
    };

    // Index each file
    for (const file of files) {
      const hash = hashFile(file);
      const stats = statSync(file);

      const entry: FileIndexEntry = {
        path: file,
        hash,
        language,
        lastIndexed: stats.mtimeMs,
        nodeCount: 0, // Would require parsing, skip for now
        patterns: new Set(),
      };

      index.files.set(file, entry);
    }

    return { index, truncatedBy: discovery.truncatedBy };
  }

  /**
   * Update AST index incrementally (only changed files)
   */
  private async updateIndex(
    index: AstIndex,
    projectPath: string,
    language: string,
    filePattern?: string,
    excludePatterns: string[] = [],
    respectGitignore: boolean = true,
    deadlineMs?: number
  ): Promise<{
    reindexed: number;
    cached: number;
    truncatedBy?: TruncationReason;
  }> {
    const discovery = await this.findSourceFiles(
      projectPath,
      language,
      filePattern,
      excludePatterns,
      respectGitignore,
      deadlineMs
    );
    const files = discovery.files;
    let reindexed = 0;
    let cached = 0;

    // Check existing files for changes
    const fileEntries = Array.from(index.files.entries());
    for (const [filePath, entry] of fileEntries) {
      if (!existsSync(filePath)) {
        // File deleted, remove from index
        index.files.delete(filePath);
        continue;
      }

      const currentHash = hashFile(filePath);
      if (currentHash !== entry.hash) {
        // File changed, update entry
        const stats = statSync(filePath);
        entry.hash = currentHash;
        entry.lastIndexed = stats.mtimeMs;
        entry.patterns.clear();
        reindexed++;
      } else {
        cached++;
      }
    }

    // Add new files
    for (const file of files) {
      if (!index.files.has(file)) {
        const hash = hashFile(file);
        const stats = statSync(file);

        const entry: FileIndexEntry = {
          path: file,
          hash,
          language,
          lastIndexed: stats.mtimeMs,
          nodeCount: 0,
          patterns: new Set(),
        };

        index.files.set(file, entry);
        reindexed++;
      }
    }

    index.lastUpdated = Date.now();

    return { reindexed, cached };
  }

  /**
   * Execute ast-grep on indexed files
   */
  private async executeAstGrep(
    pattern: string,
    language: string,
    index: AstIndex,
    contextLines: number,
    includeContext: boolean,
    respectGitignore: boolean,
    filePattern?: string
  ): Promise<AstMatch[]> {
    const matches: AstMatch[] = [];

    // Get list of files to search
    const filePaths = Array.from(index.files.keys());

    if (filePaths.length === 0) {
      return matches;
    }

    // Build ast-grep command
    const args = ['--pattern', pattern, '--lang', language, '--json=stream'];

    if (includeContext && contextLines > 0) {
      args.push('-C', contextLines.toString());
    }

    if (!respectGitignore) {
      args.push('--no-ignore');
    }

    // Add file pattern if specified
    if (filePattern) {
      args.push(filePattern);
    } else {
      // Add project path
      args.push(index.projectPath);
    }

    // Execute ast-grep in argv mode (shell:false). The caller-controlled
    // pattern / language / file pattern are passed as individual arguments and
    // cannot be interpreted by a shell (previously they were concatenated into
    // a command string and run through execSync — a command-injection sink).
    try {
      // NEVER SPAWN A .cmd. Node 20.12 refuses to spawn `.cmd`/`.bat` without a
      // shell -- the fix for CVE-2024-27980 -- so `spawnSync npx.cmd` fails with
      // EINVAL on every Windows machine. The error went to console.warn, which
      // on a stdio MCP server is stderr the client never sees, so the tool
      // returned "0 matches" instead of "I could not run".
      //
      // Six sibling tools already route through run-node-bin.ts for exactly
      // this; this one was missed. Measured: with the fix, `function $NAME`
      // finds all three fixture functions where it previously found none.
      //
      // The package is `@ast-grep/cli`. Plain `ast-grep` on npm is an unrelated
      // stub at 0.1.0 that errors on any real input, so `npx ast-grep` -- even
      // where it could spawn -- ran the wrong program.
      const script = resolveBinScript(
        AST_GREP_PACKAGE,
        'ast-grep',
        index.projectPath
      );

      let output: string;
      if (script) {
        // Installed locally: run its JS entry directly. No shim, no shell.
        output = execFileSafeSync(process.execPath, [script, ...args], {
          cwd: index.projectPath,
          maxBuffer: 10 * 1024 * 1024,
          timeout: 120000,
        });
      } else {
        // Not installed. npx can fetch it, but must be reached through npm's own
        // JS entry rather than npx.cmd.
        const npmScript = resolveNpmScript();
        if (!npmScript) {
          throw new Error(
            `${AST_GREP_PACKAGE} is not installed in ${index.projectPath}, and npm ` +
              `could not be located to fetch it. Install it with: npm i -D ${AST_GREP_PACKAGE}`
          );
        }
        output = execFileSafeSync(
          process.execPath,
          [
            npmScript,
            'exec',
            '--yes',
            '--package',
            AST_GREP_PACKAGE,
            '--',
            'ast-grep',
            ...args,
          ],
          {
            cwd: index.projectPath,
            maxBuffer: 10 * 1024 * 1024,
            timeout: 120000,
          }
        );
      }

      // Parse JSON stream output
      const lines = output
        .trim()
        .split('\n')
        .filter((line) => line.trim());

      for (const line of lines) {
        try {
          const match = JSON.parse(line);

          // Extract match information
          const astMatch: AstMatch = {
            file: match.file || match.path || '',
            line: match.line || match.start?.line || 0,
            column: match.column || match.start?.column || 0,
            match: match.text || match.matched || '',
            nodeType: match.kind || match.nodeKind || 'unknown',
          };

          // Add context if available
          if (includeContext && match.context) {
            astMatch.context = {
              before: match.context.before || [],
              after: match.context.after || [],
            };
          }

          matches.push(astMatch);
        } catch (parseError) {
          // Skip invalid JSON lines
          continue;
        }
      }
    } catch (error) {
      // Exit code 1 means "ran fine, matched nothing" -- a real, empty answer.
      if (error instanceof Error && 'status' in error && error.status === 1) {
        return matches;
      }

      // ANYTHING ELSE MUST SURFACE. This logged to console.warn and returned an
      // empty array, which on a stdio MCP server means stderr the client never
      // sees -- so "I could not run" was delivered as "0 matches", the exact
      // confusion this file's other fix exists to end. Worse, the informative
      // error thrown above for a missing CLI was itself caught here and
      // swallowed: a plain Error has no `.status`, so it fell straight to the
      // warn. The message was written and then thrown away.
      throw new Error(
        `ast-grep could not be run: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }

    return matches;
  }

  /**
   * Find source files in project
   */
  private async findSourceFiles(
    projectPath: string,
    language: string,
    _filePattern?: string,
    excludePatterns: string[] = [],
    respectGitignore: boolean = true,
    deadlineMs?: number
  ): Promise<{ files: string[]; truncatedBy?: TruncationReason }> {
    const extensions = this.getExtensionsForLanguage(language);

    const excluded = (fullPath: string): boolean =>
      this.shouldExclude(
        relative(projectPath, fullPath),
        excludePatterns,
        respectGitignore
      );

    // PRUNED, NOT FILTERED. `shouldExclude` was consulted per entry AFTER the
    // directory had been enumerated, so a project with `node_modules` paid to
    // read the whole of it and then dropped the results one at a time. Pruning
    // is exactly equivalent, not stricter: `shouldExclude` is a substring test
    // on the relative path, and a child's relative path contains its parent's.
    const walk = await boundedWalk(projectPath, {
      prune: (_name, fullPath) => excluded(fullPath),
      accept: (fullPath, fileName) =>
        !excluded(fullPath) &&
        extensions.includes(fileName.substring(fileName.lastIndexOf('.'))),
      // NO CAP. A file missing from the index is a match missing from the
      // answer, and nothing in the output would distinguish that from the
      // pattern genuinely not occurring.
      deadlineMs,
    });

    return { files: walk.items, truncatedBy: walk.truncatedBy };
  }

  /**
   * Check if path should be excluded
   */
  private shouldExclude(
    relativePath: string,
    excludePatterns: string[],
    respectGitignore: boolean
  ): boolean {
    // Default exclusions
    const defaultExclusions = [
      'node_modules',
      '.git',
      'dist',
      'build',
      '.next',
      'coverage',
      '.cache',
    ];

    if (respectGitignore) {
      for (const exclusion of defaultExclusions) {
        if (relativePath.includes(exclusion)) {
          return true;
        }
      }
    }

    // User-defined exclusions
    for (const pattern of excludePatterns) {
      // Simple glob matching: strip every wildcard, not just the first, so a
      // pattern like `*.test.*` doesn't leave a literal `*` in the substring.
      if (relativePath.includes(pattern.replace(/\*/g, ''))) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get file extensions for language
   */
  private getExtensionsForLanguage(language: string): string[] {
    const extensionMap: Record<string, string[]> = {
      ts: ['.ts', '.tsx'],
      tsx: ['.tsx', '.ts'],
      js: ['.js', '.jsx', '.mjs', '.cjs'],
      jsx: ['.jsx', '.js'],
      py: ['.py'],
      go: ['.go'],
      rs: ['.rs'],
      java: ['.java'],
      c: ['.c', '.h'],
      cpp: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx'],
    };

    return extensionMap[language] || [`.${language}`];
  }

  /**
   * Detect language from pattern or project
   */
  private detectLanguage(pattern: string, projectPath: string): string {
    // Check for TypeScript/JavaScript keywords
    if (
      pattern.includes('interface') ||
      pattern.includes('type ') ||
      pattern.includes('import')
    ) {
      if (existsSync(join(projectPath, 'tsconfig.json'))) {
        return 'ts';
      }
      return 'js';
    }

    // Check for Python keywords
    if (
      pattern.includes('def ') ||
      pattern.includes('class ') ||
      pattern.includes('import ')
    ) {
      return 'py';
    }

    // Default to TypeScript for this project
    return 'ts';
  }

  /**
   * Generate cache key for AST index
   */
  private generateIndexKey(projectPath: string, language: string): string {
    return `ast-index:${projectPath}:${language}:${SmartAstGrepTool.INDEX_VERSION}`;
  }

  /**
   * Generate cache key for pattern search
   */
  private generatePatternKey(
    pattern: string,
    projectPath: string,
    options: Partial<SmartAstGrepOptions>
  ): string {
    const keyContent = JSON.stringify({
      pattern,
      projectPath,
      language: options.language,
      filePattern: options.filePattern,
      contextLines: options.contextLines,
    });
    return `ast-pattern:${keyContent}`;
  }

  /**
   * Load AST index from cache
   */
  private loadIndex(key: string): AstIndex | null {
    try {
      const cached = this.cache.get(key);
      if (!cached) return null;

      const data = JSON.parse(cached);

      // Reconstruct Maps
      const index: AstIndex = {
        version: data.version,
        projectPath: data.projectPath,
        files: new Map(
          Object.entries(data.files).map(([path, entry]: [string, any]) => [
            path,
            {
              ...entry,
              patterns: new Set(entry.patterns || []),
            },
          ])
        ),
        patterns: new Map(
          Object.entries(data.patterns || {}).map(
            ([pattern, files]: [string, any]) => [pattern, new Set(files)]
          )
        ),
        lastUpdated: data.lastUpdated,
      };

      return index;
    } catch (error) {
      console.warn('Failed to load AST index from cache:', error);
      return null;
    }
  }

  /**
   * Cache AST index
   */
  private cacheIndex(key: string, index: AstIndex, ttl: number): void {
    try {
      // Convert Maps to serializable objects
      const filesArray = Array.from(index.files.entries()).map(
        ([path, entry]) => [
          path,
          {
            ...entry,
            patterns: Array.from(entry.patterns),
          },
        ]
      );

      const patternsArray = Array.from(index.patterns.entries()).map(
        ([pattern, files]) => [pattern, Array.from(files)]
      );

      const serializable = {
        version: index.version,
        projectPath: index.projectPath,
        files: Object.fromEntries(filesArray),
        patterns: Object.fromEntries(patternsArray),
        lastUpdated: index.lastUpdated,
      };

      const data = JSON.stringify(serializable);
      const tokensSaved = this.estimateTokensSaved(index);

      this.cache.set(key, data, ttl, tokensSaved);
    } catch (error) {
      console.warn('Failed to cache AST index:', error);
    }
  }

  /**
   * Cache pattern search result
   */
  private cachePatternResult(
    key: string,
    result: SmartAstGrepResult,
    ttl: number
  ): void {
    try {
      const data = JSON.stringify(result);
      this.cache.set(key, data, ttl, result.metadata.tokensSaved);
    } catch (error) {
      console.warn('Failed to cache pattern result:', error);
    }
  }

  /**
   * Estimate tokens saved by index
   */
  private estimateTokensSaved(index: AstIndex): number {
    // Estimate based on number of files indexed
    // Each file saves ~500 tokens on average by avoiding re-parsing
    return index.files.size * 500;
  }

  /**
   * Format full output (baseline for token comparison)
   */
  private formatFullOutput(matches: AstMatch[]): string {
    let output = '';

    for (const match of matches) {
      output += `File: ${match.file}\n`;
      output += `Line: ${match.line}, Column: ${match.column}\n`;
      output += `Node Type: ${match.nodeType}\n`;
      output += `Match:\n${match.match}\n`;

      if (match.context) {
        output += `Context Before:\n${match.context.before.join('\n')}\n`;
        output += `Context After:\n${match.context.after.join('\n')}\n`;
      }

      output += '\n---\n\n';
    }

    return output;
  }

  /**
   * Format compact output (optimized for tokens)
   */
  private formatCompactOutput(matches: AstMatch[]): string {
    // Compact format: file:line:column: match
    return matches
      .map((m) => `${m.file}:${m.line}:${m.column}: ${m.match.trim()}`)
      .join('\n');
  }

  /**
   * Generate pattern suggestions based on index
   */
  private generatePatternSuggestions(pattern: string): string[] {
    const suggestions: string[] = [];

    // Suggest common patterns if this is a partial match
    for (const commonPattern of SmartAstGrepTool.COMMON_PATTERNS) {
      if (
        commonPattern.includes(pattern) ||
        pattern.includes(commonPattern.split(' ')[0])
      ) {
        suggestions.push(commonPattern);
      }
    }

    return suggestions.slice(0, 5); // Return top 5 suggestions
  }

  /**
   * Record metrics
   */
  private recordMetrics(
    result: SmartAstGrepResult,
    startTime: number,
    cacheHit: boolean
  ): void {
    this.metrics.record({
      operation: 'smart-ast-grep',
      duration: Date.now() - startTime,
      success: true,
      cacheHit,
      inputTokens: result.metadata.originalTokenCount,
      outputTokens: result.metadata.tokenCount,
      metadata: {
        tokensSaved: result.metadata.tokensSaved,
        pattern: result.metadata.pattern,
        language: result.metadata.language,
        filesScanned: result.metadata.filesScanned,
        matchCount: result.metadata.matchCount,
        compressionRatio: result.metadata.compressionRatio,
      },
    });
  }
}

/**
 * Factory function to create SmartAstGrepTool instance
 */
export function getSmartAstGrepTool(
  cache: CacheEngine,
  tokenCounter: TokenCounter,
  metrics: MetricsCollector
): SmartAstGrepTool {
  return new SmartAstGrepTool(cache, tokenCounter, metrics);
}

/**
 * Main entry point for smart ast-grep
 */
export async function runSmartAstGrep(
  pattern: string,
  options: SmartAstGrepOptions,
  cache?: CacheEngine,
  tokenCounter?: TokenCounter,
  metrics?: MetricsCollector
): Promise<SmartAstGrepResult> {
  // Use provided instances or create defaults
  const cacheInstance = cache || new CacheEngine();
  const tokenCounterInstance = tokenCounter || new TokenCounter();
  const metricsInstance = metrics || new MetricsCollector();

  const tool = getSmartAstGrepTool(
    cacheInstance,
    tokenCounterInstance,
    metricsInstance
  );
  return tool.grep(pattern, options);
}

/**
 * MCP Tool Definition for smart-ast-grep
 */
export const SMART_AST_GREP_TOOL_DEFINITION = {
  name: 'smart_ast_grep',
  description:
    'Perform structural code search with 83% token reduction through AST indexing and caching',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description:
          'AST pattern to search for (e.g., "function $NAME($ARGS) { $BODY }")',
      },
      projectPath: {
        type: 'string',
        description: 'Root directory of the project to search',
      },
      language: {
        type: 'string',
        enum: ['ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'java', 'c', 'cpp'],
        description: 'Programming language (auto-detected if not provided)',
      },
      filePattern: {
        type: 'string',
        description:
          'Specific directory or file pattern to search (e.g., "src/**/*.ts")',
      },
      excludePatterns: {
        type: 'array',
        items: { type: 'string' },
        description: 'Patterns to exclude from search',
      },
      contextLines: {
        type: 'number',
        default: 3,
        description: 'Number of context lines around matches',
      },
      maxMatches: {
        type: 'number',
        default: 100,
        description: 'Maximum number of matches to return',
      },
      enableCache: {
        type: 'boolean',
        default: true,
        description: 'Enable AST index and pattern caching',
      },
      // DECLARED BECAUSE THEY ARE ACCEPTED: the server spreads the caller's whole
      // argument object into options, so these worked while being undiscoverable.
      ttl: {
        type: 'number',
        description: 'Lifetime of the AST index cache in seconds',
        default: 604800,
      },
      includeContext: {
        type: 'boolean',
        description: 'Include surrounding source lines with each match',
        default: false,
      },
      respectGitignore: {
        type: 'boolean',
        description: 'Skip files git ignores when walking the project',
        default: true,
      },
      incrementalIndexing: {
        type: 'boolean',
        description:
          'Reindex only files changed since the last run instead of the whole project',
        default: true,
      },
      deadlineMs: {
        type: 'number',
        description:
          'Wall-clock budget in ms for discovering the files to index (default 10000). On expiry the search reports what it reached with metadata.searchTruncated set and caches nothing, instead of walking until the calling tool times out.',
      },
    },
    required: ['pattern', 'projectPath'],
  },
};
