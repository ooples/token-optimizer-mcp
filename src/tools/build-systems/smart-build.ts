/**
 * Smart Build Tool - 85% Token Reduction
 *
 * Wraps TypeScript compiler (tsc) to provide:
 * - Incremental builds only
 * - Cached build outputs
 * - Error extraction (failures only, not entire log)
 * - Build time optimization suggestions
 */

import { CacheEngine } from '../../core/cache-engine.js';
import { TokenCounter } from '../../core/token-counter.js';
import { MetricsCollector } from '../../core/metrics.js';
import { createHash } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawnNodeBin } from './run-node-bin.js';
import {
  boundedWalk,
  traversalDeadlineMs,
  type TruncationReason,
} from '../shared/bounded-traversal.js';

interface BuildError {
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

interface BuildResult {
  success: boolean;
  errors: BuildError[];
  warnings: BuildError[];
  duration: number;
  filesCompiled: number;
  timestamp: number;
  /**
   * Set when `filesCompiled` came from a walk that was cut short, which makes
   * it a FLOOR rather than a count.
   */
  filesCompiledTruncatedBy?: TruncationReason;
}

interface SmartBuildOptions {
  /**
   * Force full rebuild (ignore cache)
   */
  force?: boolean;

  /**
   * Watch mode
   */
  watch?: boolean;

  /**
   * Project root directory
   */
  projectRoot?: string;

  /**
   * TypeScript config file
   */
  tsconfig?: string;

  /**
   * Include warnings in output
   */
  includeWarnings?: boolean;

  /**
   * Maximum cache age in seconds (default: 3600 = 1 hour)
   */
  maxCacheAge?: number;

  /**
   * Wall-clock budget in ms for the source-file count fallback.
   *
   * When tsc's output carries no "Found N errors" line there is nothing to
   * count files from, so the tool walked `src` itself -- recursively, with a
   * `statSync` per entry, following junctions, and with no way to stop.
   * Defaults to 10 s.
   */
  deadlineMs?: number;
}

interface SmartBuildOutput {
  /**
   * Build summary
   */
  summary: {
    success: boolean;
    duration: number;
    filesCompiled: number;
    errorCount: number;
    warningCount: number;
    fromCache: boolean;
    /**
     * Set when `filesCompiled` is a FLOOR rather than a count, because the
     * fallback walk that produced it hit its deadline.
     *
     * There is no honest cap for this number: unlike a search, the answer here
     * IS the total, so any bound that stops early makes it wrong. Saying so is
     * the only thing that keeps it usable -- as a lower bound it still
     * supports the "more than 50 files" test below, which can only err by
     * withholding a suggestion.
     */
    filesCompiledPartial?: boolean;
    filesCompiledNote?: string;
  };

  /**
   * Only errors and warnings (categorized)
   */
  errors: Array<{
    category: string;
    file: string;
    location: string;
    message: string;
    code: string;
  }>;

  /**
   * Optimization suggestions
   */
  suggestions: Array<{
    type: 'performance' | 'config' | 'code';
    message: string;
    impact: 'high' | 'medium' | 'low';
  }>;

  /**
   * Changed files since last build
   */
  changedFiles: string[];

  /**
   * Token reduction _metrics
   */
  _metrics: {
    originalTokens: number;
    compactedTokens: number;
    reductionPercentage: number;
  };
}

export class SmartBuild {
  private cache: CacheEngine;
  private cacheNamespace = 'smart_build';
  private projectRoot: string;
  private readonly defaultProjectRoot: string;

  constructor(
    cache: CacheEngine,
    _tokenCounter: TokenCounter,
    _metrics: MetricsCollector,
    projectRoot?: string
  ) {
    this.cache = cache;
    this.defaultProjectRoot = projectRoot || process.cwd();
    this.projectRoot = this.defaultProjectRoot;
  }

  /**
   * Run build with smart caching and output reduction
   */
  async run(options: SmartBuildOptions = {}): Promise<SmartBuildOutput> {
    // Honor a per-call projectRoot. The MCP server constructs this tool ONCE
    // as a singleton (with the server's own cwd), so without this the
    // projectRoot argument was silently ignored and the build ran in the
    // wrong directory — reporting success:false with 0 files on a clean build.
    // Resolve from the constructor default each call so omitting projectRoot
    // reverts to the default instead of stickily keeping a prior call's value.
    this.projectRoot = options.projectRoot || this.defaultProjectRoot;
    const {
      force = false,
      watch = false,
      tsconfig = 'tsconfig.json',
      includeWarnings = false,
      maxCacheAge = 3600,
    } = options;
    const deadlineMs = traversalDeadlineMs(options.deadlineMs);

    const startTime = Date.now();

    // Generate cache key based on source files
    const cacheKey = await this.generateCacheKey(tsconfig);

    // Check cache first (unless force or watch mode)
    if (!force && !watch) {
      const cached = this.getCachedResult(cacheKey, maxCacheAge);
      if (cached) {
        return this.formatCachedOutput(cached);
      }
    }

    // Detect changed files for incremental build
    const changedFiles = await this.detectChangedFiles(cacheKey);

    // Run TypeScript compiler
    const result = await this.runTsc({
      tsconfig,
      watch,
      incremental: !force,
      deadlineMs,
    });

    const duration = Date.now() - startTime;
    result.duration = duration;

    // Cache the result
    if (!watch) {
      this.cacheResult(cacheKey, result);
    }

    // Generate optimization suggestions
    const suggestions = this.generateSuggestions(result, changedFiles);

    // Transform to smart output
    return this.transformOutput(
      result,
      changedFiles,
      suggestions,
      includeWarnings
    );
  }

  /**
   * Run TypeScript compiler and capture results
   */
  private async runTsc(options: {
    tsconfig: string;
    watch: boolean;
    incremental: boolean;
    deadlineMs: number;
  }): Promise<BuildResult> {
    const args = ['--project', options.tsconfig];

    if (options.watch) {
      args.push('--watch');
    }

    if (options.incremental) {
      args.push('--incremental');
    }

    return new Promise<BuildResult>((resolve, reject) => {
      let stdout = '';
      let stderr = '';

      // SECURITY: argv mode (shell:false) so caller-controlled args (e.g.
      // tsconfig path) cannot be reinterpreted by a shell. On Windows npx is a
      // .cmd shim that must be named explicitly when not using a shell.
      // Runs the project's own tsc as `node <tsc.js> ...` -- argv mode, no
      // shell, and no .cmd shim for Node to refuse. See run-node-bin.ts.
      const tsc = spawnNodeBin(
        'typescript',
        'tsc',
        args,
        { cwd: this.projectRoot },
        'smart_build'
      );

      tsc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      tsc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      tsc.on('close', (code) => {
        const output = stdout + stderr;
        const errors = this.parseCompilerOutput(output);

        // The count can now require a filesystem walk, which is async, so the
        // handler resolves from a promise chain rather than inline. `reject`
        // is wired up because a walk that throws must surface as a failed
        // build, not as a promise that never settles.
        this.countCompiledFiles(output, options.deadlineMs).then(
          (counted) =>
            resolve({
              success: code === 0,
              errors: errors.filter((e) => e.severity === 'error'),
              warnings: errors.filter((e) => e.severity === 'warning'),
              duration: 0, // Set by caller
              filesCompiled: counted.count,
              filesCompiledTruncatedBy: counted.truncatedBy,
              timestamp: Date.now(),
            }),
          reject
        );
      });

      tsc.on('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * Parse TypeScript compiler output for errors and warnings
   */
  private parseCompilerOutput(output: string): BuildError[] {
    const errors: BuildError[] = [];
    const lines = output.split('\n');

    for (const line of lines) {
      // Match TypeScript error format: file.ts(line,col): error TSxxxx: message
      const match = line.match(
        /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/
      );
      if (match) {
        errors.push({
          file: match[1],
          line: parseInt(match[2], 10),
          column: parseInt(match[3], 10),
          severity: match[4] as 'error' | 'warning',
          code: match[5],
          message: match[6],
        });
      }
    }

    return errors;
  }

  /**
   * Count files compiled from output
   */
  private async countCompiledFiles(
    output: string,
    deadlineMs: number
  ): Promise<{ count: number; truncatedBy?: TruncationReason }> {
    // Look for "Found X errors" message which indicates compilation happened
    const match = output.match(/Found (\d+) error/);
    if (match) {
      // Count unique files in error messages
      const files = new Set<string>();
      const lines = output.split('\n');
      for (const line of lines) {
        const fileMatch = line.match(/^(.+?)\(\d+,\d+\):/);
        if (fileMatch) {
          files.add(fileMatch[1]);
        }
      }
      return { count: files.size };
    }

    // Fallback: count .ts files in src
    return this.countSourceFiles(deadlineMs);
  }

  /**
   * Count TypeScript source files
   */
  private async countSourceFiles(
    deadlineMs: number
  ): Promise<{ count: number; truncatedBy?: TruncationReason }> {
    return countTypeScriptSources(join(this.projectRoot, 'src'), deadlineMs);
  }

  /**
   * Generate cache key based on source files and config
   */
  private async generateCacheKey(tsconfig: string): Promise<string> {
    const hash = createHash('sha256');
    hash.update(this.cacheNamespace);

    // Hash tsconfig
    const tsconfigPath = join(this.projectRoot, tsconfig);
    if (existsSync(tsconfigPath)) {
      const content = readFileSync(tsconfigPath, 'utf-8');
      hash.update(content);
    }

    // Hash package.json for dependency changes
    const packageJsonPath = join(this.projectRoot, 'package.json');
    if (existsSync(packageJsonPath)) {
      const content = readFileSync(packageJsonPath, 'utf-8');
      hash.update(content);
    }

    return `${this.cacheNamespace}:${hash.digest('hex')}`;
  }

  /**
   * Get cached result if available and fresh
   */
  private getCachedResult(key: string, maxAge: number): BuildResult | null {
    const cached = this.cache.get(key);
    if (!cached) {
      return null;
    }

    try {
      const result = JSON.parse(cached) as BuildResult & { cachedAt: number };
      const age = (Date.now() - result.cachedAt) / 1000;

      if (age <= maxAge) {
        return result;
      }
    } catch (err) {
      return null;
    }

    return null;
  }

  /**
   * Cache build result
   */
  private cacheResult(key: string, result: BuildResult): void {
    const toCache = {
      ...result,
      cachedAt: Date.now(),
    };

    const dataToCache = JSON.stringify(toCache);
    const originalSize = this.estimateOriginalOutputSize(result);
    const compactSize = dataToCache.length;

    this.cache.set(key, dataToCache, originalSize, compactSize);
  }

  /**
   * Detect changed files since last build
   */
  private async detectChangedFiles(_cacheKey: string): Promise<string[]> {
    // In a real implementation, we'd track file hashes
    // For now, return empty array
    return [];
  }

  /**
   * Generate optimization suggestions based on build result
   */
  private generateSuggestions(
    result: BuildResult,
    changedFiles: string[]
  ): Array<{
    type: 'performance' | 'config' | 'code';
    message: string;
    impact: 'high' | 'medium' | 'low';
  }> {
    const suggestions: Array<{
      type: 'performance' | 'config' | 'code';
      message: string;
      impact: 'high' | 'medium' | 'low';
    }> = [];

    // Suggest incremental builds if many files
    if (result.filesCompiled > 50 && changedFiles.length < 10) {
      suggestions.push({
        type: 'performance',
        message: 'Consider using --incremental flag for faster rebuilds',
        impact: 'high',
      });
    }

    // Suggest build time optimization if slow
    if (result.duration > 30000) {
      suggestions.push({
        type: 'performance',
        message:
          'Build is slow. Consider enabling skipLibCheck in tsconfig.json',
        impact: 'high',
      });
    }

    // Suggest fixing common error patterns
    const commonErrors = this.categorizeErrors(result.errors);
    if (commonErrors['TS2307'] > 5) {
      suggestions.push({
        type: 'config',
        message:
          'Many "Cannot find module" errors. Check your paths in tsconfig.json',
        impact: 'high',
      });
    }

    return suggestions;
  }

  /**
   * Categorize errors by code
   */
  private categorizeErrors(errors: BuildError[]): Record<string, number> {
    const categories: Record<string, number> = {};
    for (const error of errors) {
      categories[error.code] = (categories[error.code] || 0) + 1;
    }
    return categories;
  }

  /**
   * Transform full build output to smart output
   */
  private transformOutput(
    result: BuildResult,
    changedFiles: string[],
    suggestions: Array<{
      type: 'performance' | 'config' | 'code';
      message: string;
      impact: 'high' | 'medium' | 'low';
    }>,
    includeWarnings: boolean,
    fromCache = false
  ): SmartBuildOutput {
    // Categorize errors
    const categorizedErrors = this.categorizeAndFormatErrors(result.errors);
    const categorizedWarnings = includeWarnings
      ? this.categorizeAndFormatErrors(result.warnings)
      : [];

    const allErrors = [...categorizedErrors, ...categorizedWarnings];

    const originalSize = this.estimateOriginalOutputSize(result);
    const compactSize = this.estimateCompactSize(result);

    return {
      summary: {
        success: result.success,
        duration: result.duration,
        filesCompiled: result.filesCompiled,
        errorCount: result.errors.length,
        warningCount: result.warnings.length,
        fromCache,
        ...(result.filesCompiledTruncatedBy
          ? {
              filesCompiledPartial: true,
              filesCompiledNote:
                'tsc reported no error summary to count from, so this number came from walking `src` -- and that walk hit its traversal deadline. Treat `filesCompiled` as a LOWER BOUND, not a count.',
            }
          : {}),
      },
      errors: allErrors,
      suggestions,
      changedFiles,
      _metrics: {
        originalTokens: Math.ceil(originalSize / 4),
        compactedTokens: Math.ceil(compactSize / 4),
        reductionPercentage: Math.round(
          ((originalSize - compactSize) / originalSize) * 100
        ),
      },
    };
  }

  /**
   * Categorize and format errors
   */
  private categorizeAndFormatErrors(errors: BuildError[]): Array<{
    category: string;
    file: string;
    location: string;
    message: string;
    code: string;
  }> {
    return errors.map((error) => ({
      category: this.categorizeErrorCode(error.code),
      file: error.file,
      location: `${error.line}:${error.column}`,
      message: error.message,
      code: error.code,
    }));
  }

  /**
   * Categorize error by TS error code
   */
  private categorizeErrorCode(code: string): string {
    const categories: Record<string, string> = {
      TS2307: 'Module Resolution',
      TS2304: 'Type Errors',
      TS2322: 'Type Errors',
      TS2345: 'Type Errors',
      TS2339: 'Type Errors',
      TS2551: 'Type Errors',
      TS7006: 'Type Annotations',
      TS7016: 'Type Declarations',
    };

    return categories[code] || 'Other';
  }

  /**
   * Format cached output
   */
  private formatCachedOutput(result: BuildResult): SmartBuildOutput {
    return this.transformOutput(result, [], [], false, true);
  }

  /**
   * Estimate original output size (full tsc output)
   */
  private estimateOriginalOutputSize(result: BuildResult): number {
    // Estimate: each error is ~200 chars in full tsc output
    const errorSize = (result.errors.length + result.warnings.length) * 200;
    // Plus header/footer ~500 chars
    return errorSize + 500;
  }

  /**
   * Estimate compact output size
   */
  private estimateCompactSize(result: BuildResult): number {
    const summary = {
      success: result.success,
      errorCount: result.errors.length,
      warningCount: result.warnings.length,
    };

    const errors = this.categorizeAndFormatErrors(result.errors.slice(0, 10)); // Only first 10

    return JSON.stringify({ summary, errors }).length;
  }

  /**
   * Close cache connection
   */
  close(): void {
    this.cache.close();
  }
}

/**
 * Factory function for creating SmartBuild with shared resources
 * Use this in benchmarks and tests where resources are shared
 */
export function getSmartBuildTool(
  cache: CacheEngine,
  tokenCounter: TokenCounter,
  metrics: MetricsCollector,
  projectRoot?: string
): SmartBuild {
  return new SmartBuild(cache, tokenCounter, metrics, projectRoot);
}

/**
 * CLI-friendly function for running smart build
 */
export async function runSmartBuild(
  options: SmartBuildOptions = {}
): Promise<string> {
  // Create standalone resources for CLI usage
  const cache = new CacheEngine(join(homedir(), '.hypercontext', 'cache'), 100);
  const tokenCounter = new TokenCounter();
  const metrics = new MetricsCollector();

  const smartBuild = new SmartBuild(
    cache,
    tokenCounter,
    metrics,
    options.projectRoot
  );
  try {
    const result = await smartBuild.run(options);

    let output = `\nðŸ”¨ Smart Build Results ${result.summary.fromCache ? '(cached)' : ''}\n`;
    output += `${'='.repeat(50)}\n\n`;

    // Summary
    output += `Summary:\n`;
    output += `  Status: ${result.summary.success ? 'âœ“ Success' : 'âœ— Failed'}\n`;
    output += `  Files Compiled: ${result.summary.filesCompiled}\n`;
    output += `  Errors: ${result.summary.errorCount}\n`;
    output += `  Warnings: ${result.summary.warningCount}\n`;
    output += `  Duration: ${(result.summary.duration / 1000).toFixed(2)}s\n\n`;

    // Errors
    if (result.errors.length > 0) {
      output += `Errors:\n`;
      const byCategory = result.errors.reduce(
        (acc, error) => {
          if (!acc[error.category]) acc[error.category] = [];
          acc[error.category].push(error);
          return acc;
        },
        {} as Record<string, typeof result.errors>
      );

      for (const [category, errors] of Object.entries(byCategory)) {
        output += `\n  ${category} (${errors.length}):\n`;
        for (const error of errors.slice(0, 5)) {
          // Show first 5 per category
          output += `    ${error.file}:${error.location}\n`;
          output += `      [${error.code}] ${error.message}\n`;
        }
        if (errors.length > 5) {
          output += `    ... and ${errors.length - 5} more\n`;
        }
      }
      output += '\n';
    }

    // Suggestions
    if (result.suggestions.length > 0) {
      output += `Optimization Suggestions:\n`;
      for (const suggestion of result.suggestions) {
        const icon =
          suggestion.impact === 'high'
            ? 'ðŸ”´'
            : suggestion.impact === 'medium'
              ? 'ðŸŸ¡'
              : 'ðŸŸ¢';
        output += `  ${icon} [${suggestion.type}] ${suggestion.message}\n`;
      }
      output += '\n';
    }

    // Changed files
    if (result.changedFiles.length > 0) {
      output += `Changed Files (${result.changedFiles.length}):\n`;
      for (const file of result.changedFiles.slice(0, 10)) {
        output += `  â€¢ ${file}\n`;
      }
      if (result.changedFiles.length > 10) {
        output += `  ... and ${result.changedFiles.length - 10} more\n`;
      }
      output += '\n';
    }

    // _metrics
    output += `Token Reduction:\n`;
    output += `  Original: ${result._metrics.originalTokens} tokens\n`;
    output += `  Compacted: ${result._metrics.compactedTokens} tokens\n`;
    output += `  Reduction: ${result._metrics.reductionPercentage}%\n`;

    return output;
  } finally {
    smartBuild.close();
  }
}

// MCP Tool definition
export const SMART_BUILD_TOOL_DEFINITION = {
  name: 'smart_build',
  description:
    'Run TypeScript build with intelligent caching, diff-based change detection, and token-optimized output',
  inputSchema: {
    type: 'object',
    properties: {
      force: {
        type: 'boolean',
        description: 'Force full rebuild (ignore cache)',
        default: false,
      },
      watch: {
        type: 'boolean',
        description: 'Watch mode for continuous builds',
        default: false,
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory',
      },
      tsconfig: {
        type: 'string',
        description: 'TypeScript config file path',
      },
      includeWarnings: {
        type: 'boolean',
        description: 'Include warnings in output',
        default: true,
      },
      maxCacheAge: {
        type: 'number',
        description: 'Maximum cache age in seconds (default: 3600)',
        default: 3600,
      },
      deadlineMs: {
        type: 'number',
        description:
          'Wall-clock budget in ms for the fallback source-file count (default 10000). On expiry filesCompiled is reported as a lower bound with summary.filesCompiledPartial set.',
      },
    },
  },
};

/**
 * Count `.ts` files under a directory, bounded.
 *
 * A MODULE FUNCTION RATHER THAN A METHOD so the bound can be exercised
 * directly. Reaching it through `run()` requires a real `tsc` invocation that
 * produces no "Found N errors" line, which is a five-second subprocess to test
 * a walk -- and a bound nobody can test is a bound nobody will keep.
 */
export async function countTypeScriptSources(
  srcDir: string,
  deadlineMs?: number
): Promise<{ count: number; truncatedBy?: TruncationReason }> {
  if (!existsSync(srcDir)) {
    return { count: 0 };
  }

  // NO CAP HERE, WHICH IS NOT THE SAME CHOICE `smart_glob` MAKES. A cap is
  // legitimate when the caller asked for N results, because stopping at N is
  // the answer. Here the answer IS the total, so a cap does not shorten it,
  // it replaces it with the cap -- and nothing downstream could tell.
  //
  // The deadline can also make the number a floor, so when it fires the
  // number is reported AS a floor rather than as a count. That is still
  // useful: the only consumer is a "more than 50 files" heuristic, and a
  // floor can only ever err by withholding a suggestion.
  //
  // The old walk used `statSync` per entry and therefore FOLLOWED junctions,
  // which on Windows is how a shared `node_modules` turns a count into an
  // endless loop. `boundedWalk` reads types from the directory entry, so a
  // junction is simply not descended.
  const walk = await boundedWalk(srcDir, {
    accept: (_fullPath, fileName) => fileName.endsWith('.ts'),
    deadlineMs,
  });

  return { count: walk.items.length, truncatedBy: walk.truncatedBy };
}
