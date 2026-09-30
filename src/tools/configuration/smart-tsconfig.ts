/**
 * Smart TSConfig Tool - 83% Token Reduction
 *
 * Parses and analyzes tsconfig.json with:
 * - Extends chain resolution
 * - Compiler options inheritance
 * - 7-day TTL caching
 * - Config issue detection
 * - Optimization suggestions
 */

import { readFile } from 'fs/promises';
import { resolve, dirname, join } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { CacheEngine, resolveCacheLocation } from '../../core/cache-engine.js';
import { TokenCounter } from '../../core/token-counter.js';
import { MetricsCollector } from '../../core/metrics.js';
import { hashContent, generateCacheKey } from '../shared/hash-utils.js';

// ==================== Type Definitions ====================

interface TsConfigCompilerOptions {
  target?: string;
  module?: string;
  strict?: boolean;
  esModuleInterop?: boolean;
  skipLibCheck?: boolean;
  forceConsistentCasingInFileNames?: boolean;
  moduleResolution?: string;
  resolveJsonModule?: boolean;
  isolatedModules?: boolean;
  jsx?: string;
  lib?: string[];
  outDir?: string;
  rootDir?: string;
  baseUrl?: string;
  paths?: Record<string, string[]>;
  [key: string]: unknown;
}

interface TsConfigJson {
  extends?: string | string[];
  compilerOptions?: TsConfigCompilerOptions;
  include?: string[];
  exclude?: string[];
  files?: string[];
  references?: Array<{ path: string }>;
  [key: string]: unknown;
}

interface ResolvedTsConfig {
  compilerOptions: TsConfigCompilerOptions;
  include?: string[];
  exclude?: string[];
  files?: string[];
  references?: Array<{ path: string }>;
  extendsChain: string[];
  configPath: string;
}

// What the caller actually receives. It differs from ResolvedTsConfig in two
// places, both of them things the caller already has: `configPath` sits at the
// top of the response, and an `extendsChain` holding one entry is the config
// naming itself rather than a chain. On a small tsconfig those two absolute
// paths were about a fifth of the payload.
interface EmittedTsConfig {
  compilerOptions: TsConfigCompilerOptions;
  include?: string[];
  exclude?: string[];
  files?: string[];
  references?: Array<{ path: string }>;
  /** Present only when the config really does extend another. */
  extendsChain?: string[];
}

interface ConfigIssue {
  severity: 'error' | 'warning' | 'info';
  category:
    | 'strict-mode'
    | 'target-version'
    | 'module-system'
    | 'paths'
    | 'performance'
    | 'compatibility';
  message: string;
  suggestion?: string;
}

interface SmartTsConfigOptions {
  configPath?: string;
  projectRoot?: string;
  includeIssues?: boolean;
  includeSuggestions?: boolean;
  maxCacheAge?: number; // seconds
}

interface SmartTsConfigOutput {
  success: boolean;
  configPath: string;
  resolved: EmittedTsConfig;
  issues?: ConfigIssue[];
  suggestions?: string[];
  cacheHit: boolean;
  tokenMetrics: {
    original: number;
    compact: number;
    saved: number;
    savingsPercent: number;
  };
  executionTime: number;
  diff?: {
    added: string[];
    removed: string[];
    modified: string[];
  };
}

// ==================== Main Class ====================

class SmartTsConfig {
  private cache: CacheEngine;
  private tokenCounter: TokenCounter;
  private metrics: MetricsCollector;
  private projectRoot: string;

  constructor(
    cache: CacheEngine,
    tokenCounter: TokenCounter,
    metrics: MetricsCollector,
    projectRoot?: string
  ) {
    this.cache = cache;
    this.tokenCounter = tokenCounter;
    this.metrics = metrics;
    this.projectRoot = projectRoot || process.cwd();
  }

  /**
   * Main entry point - parse and resolve tsconfig
   */
  async run(options: SmartTsConfigOptions = {}): Promise<SmartTsConfigOutput> {
    const startTime = Date.now();
    const configPath = this.resolveConfigPath(options.configPath);

    try {
      // Generate cache key based on file content and path
      const configContent = await readFile(configPath, 'utf-8');
      const fileHash = hashContent(configContent);
      const cacheKey = generateCacheKey('tsconfig', {
        path: configPath,
        hash: fileHash,
      });

      // Check cache first
      const cached = this.cache.get(cacheKey);
      if (cached) {
        const cachedData = JSON.parse(cached) as {
          resolved: ResolvedTsConfig;
          issues?: ConfigIssue[];
          suggestions?: string[];
          fileHash: string;
        };

        // Validate cache is still valid
        if (cachedData.fileHash === fileHash) {
          const executionTime = Date.now() - startTime;

          // Record metrics
          this.metrics.record({
            operation: 'smart-tsconfig',
            duration: executionTime,
            cacheHit: true,
            success: true,
            savedTokens: 0, // Will be calculated in transformOutput
          });

          const output = this.transformOutput(
            cachedData.resolved,
            cachedData.issues,
            cachedData.suggestions,
            options.includeIssues ?? true,
            options.includeSuggestions ?? true,
            true,
            executionTime,
            configContent
          );

          return output;
        }

        // Cache invalid, delete it
        this.cache.delete(cacheKey);
      }

      // Resolve the config with extends chain
      const resolved = await this.resolveConfig(configPath);

      // Detect issues if requested
      const issues =
        options.includeIssues !== false
          ? this.detectIssues(resolved)
          : undefined;

      // Generate suggestions if requested
      const suggestions =
        options.includeSuggestions !== false
          ? this.generateSuggestions(resolved, issues)
          : undefined;

      // Cache the result
      const toCache = {
        resolved,
        issues,
        suggestions,
        fileHash,
      };

      const maxAge = options.maxCacheAge ?? 7 * 24 * 60 * 60; // 7 days default
      this.cache.set(
        cacheKey,
        Buffer.from(JSON.stringify(toCache)).toString('utf-8'),
        0,
        maxAge
      );

      const executionTime = Date.now() - startTime;

      // Record metrics
      this.metrics.record({
        operation: 'smart-tsconfig',
        duration: executionTime,
        cacheHit: false,
        success: true,
        savedTokens: 0,
      });

      return this.transformOutput(
        resolved,
        issues,
        suggestions,
        options.includeIssues ?? true,
        options.includeSuggestions ?? true,
        false,
        executionTime,
        configContent
      );
    } catch (error) {
      const executionTime = Date.now() - startTime;

      this.metrics.record({
        operation: 'smart-tsconfig',
        duration: executionTime,
        cacheHit: false,
        success: false,
        savedTokens: 0,
      });

      throw error;
    }
  }

  /**
   * Resolve config path from options or find default
   */
  private resolveConfigPath(configPath?: string): string {
    if (configPath) {
      return resolve(this.projectRoot, configPath);
    }

    // Look for tsconfig.json in project root
    const defaultPath = join(this.projectRoot, 'tsconfig.json');
    if (existsSync(defaultPath)) {
      return defaultPath;
    }

    throw new Error('tsconfig.json not found. Specify configPath option.');
  }

  /**
   * Resolve tsconfig with extends chain
   */
  private async resolveConfig(configPath: string): Promise<ResolvedTsConfig> {
    const extendsChain: string[] = [];
    let currentPath = configPath;
    let mergedConfig: TsConfigJson = {};

    // Walk the extends chain
    while (true) {
      const config = await this.parseConfigFile(currentPath);
      extendsChain.push(currentPath);

      // Merge compiler options (later configs override earlier)
      mergedConfig = this.mergeConfigs(mergedConfig, config);

      // Check for extends
      if (!config.extends) {
        break;
      }

      // Resolve extends path
      const extendsPath = this.resolveExtendsPath(currentPath, config.extends);
      currentPath = extendsPath;

      // Prevent infinite loops
      if (extendsChain.includes(currentPath)) {
        throw new Error(`Circular extends detected: ${currentPath}`);
      }

      if (extendsChain.length > 20) {
        throw new Error('Extends chain too deep (max 20)');
      }
    }

    return {
      compilerOptions: mergedConfig.compilerOptions ?? {},
      include: mergedConfig.include,
      exclude: mergedConfig.exclude,
      files: mergedConfig.files,
      references: mergedConfig.references,
      extendsChain: extendsChain.reverse(), // Base first
      configPath,
    };
  }

  /**
   * Parse a single tsconfig file
   */
  private async parseConfigFile(configPath: string): Promise<TsConfigJson> {
    const content = await readFile(configPath, 'utf-8');

    const stripped = this.stripJsonComments(content);

    try {
      return JSON.parse(stripped) as TsConfigJson;
    } catch (error) {
      throw new Error(
        `Failed to parse ${configPath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // A COMMENT STRIPPER THAT CANNOT READ STRINGS WILL EAT GLOBS.
  //
  // tsconfig allows comments, so they have to go before JSON.parse. Doing that
  // with /\/\*[\s\S]*?\*\//g treats the file as though no string literal existed,
  // and the commonest line in any tsconfig is a glob: "include": ["src/**" + "/*"]
  // contains a slash-star followed by a star-slash, so the regex matched INSIDE
  // the string and the resolved config came back as ["src*"]. The exclude entry
  // for test files lost its separator the same way.
  //
  // That is not a formatting difference. This tool's whole output is "here is
  // the config that actually applies", and a pattern with its separators removed
  // matches a different set of files than the one on disk -- so the answer was
  // wrong in the one field a caller would act on.
  //
  // The scan below tracks whether it is inside a string, where a comment
  // delimiter is data rather than syntax.
  private stripJsonComments(content: string): string {
    let out = '';
    let inString = false;
    let inLineComment = false;
    let inBlockComment = false;

    for (let i = 0; i < content.length; i++) {
      const ch = content[i];
      const next = content[i + 1];

      if (inLineComment) {
        if (ch === '\n') {
          inLineComment = false;
          out += ch;
        }
        continue;
      }

      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          inBlockComment = false;
          i++;
        }
        continue;
      }

      if (inString) {
        out += ch;
        if (ch === '\\') {
          // An escape consumes whatever follows it, so a literal \" inside the
          // string is never mistaken for the quote that closes the string.
          if (next !== undefined) {
            out += next;
            i++;
          }
          continue;
        }
        if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        out += ch;
        continue;
      }

      if (ch === '/' && next === '/') {
        inLineComment = true;
        i++;
        continue;
      }

      if (ch === '/' && next === '*') {
        inBlockComment = true;
        i++;
        continue;
      }

      out += ch;
    }

    return out;
  }

  /**
   * Resolve extends path (can be relative or node_modules package)
   */
  private resolveExtendsPath(
    fromConfig: string,
    extendsValue: string | string[]
  ): string {
    // For now, only handle single extends (not array)
    const extendsPath = Array.isArray(extendsValue)
      ? extendsValue[0]
      : extendsValue;

    if (!extendsPath) {
      throw new Error('Empty extends value');
    }

    const configDir = dirname(fromConfig);

    // Relative path
    if (extendsPath.startsWith('./') || extendsPath.startsWith('../')) {
      const resolved = resolve(configDir, extendsPath);
      // Add .json if not present
      return resolved.endsWith('.json') ? resolved : `${resolved}.json`;
    }

    // Node module (e.g., @tsconfig/node16/tsconfig.json)
    try {
      // Try to resolve from node_modules
      const nodeModulePath = require.resolve(extendsPath, {
        paths: [configDir],
      });
      return nodeModulePath;
    } catch {
      // Fallback: assume it's in node_modules
      const nodeModulePath = join(configDir, 'node_modules', extendsPath);
      if (existsSync(nodeModulePath)) {
        return nodeModulePath;
      }

      throw new Error(`Cannot resolve extends: ${extendsPath}`);
    }
  }

  /**
   * Merge two configs (later overrides earlier)
   */
  private mergeConfigs(
    base: TsConfigJson,
    override: TsConfigJson
  ): TsConfigJson {
    return {
      ...base,
      ...override,
      compilerOptions: {
        ...base.compilerOptions,
        ...override.compilerOptions,
      },
    };
  }

  /**
   * Detect configuration issues
   */
  private detectIssues(resolved: ResolvedTsConfig): ConfigIssue[] {
    const issues: ConfigIssue[] = [];
    const opts = resolved.compilerOptions;

    // Check strict mode
    if (!opts.strict) {
      issues.push({
        severity: 'warning',
        category: 'strict-mode',
        message: 'Strict mode is disabled',
        suggestion: 'Enable "strict": true for better type safety',
      });
    }

    // Check target version
    const target = opts.target?.toLowerCase();
    if (target && ['es3', 'es5'].includes(target)) {
      issues.push({
        severity: 'warning',
        category: 'target-version',
        message: `Old target version: ${opts.target}`,
        suggestion:
          'Consider upgrading to ES2020 or later for better performance',
      });
    }

    // Check module system
    if (!opts.module) {
      issues.push({
        severity: 'info',
        category: 'module-system',
        message: 'No module system specified',
        suggestion: 'Specify "module" option (e.g., "esnext", "commonjs")',
      });
    }

    // Check esModuleInterop
    if (opts.module === 'commonjs' && !opts.esModuleInterop) {
      issues.push({
        severity: 'warning',
        category: 'compatibility',
        message: 'esModuleInterop disabled with CommonJS',
        suggestion:
          'Enable "esModuleInterop": true for better ES module compatibility',
      });
    }

    // Check skipLibCheck
    if (!opts.skipLibCheck) {
      issues.push({
        severity: 'info',
        category: 'performance',
        message: 'skipLibCheck is disabled',
        suggestion: 'Enable "skipLibCheck": true to speed up compilation',
      });
    }

    return issues;
  }

  /**
   * Generate optimization suggestions
   */
  private generateSuggestions(
    resolved: ResolvedTsConfig,
    issues?: ConfigIssue[]
  ): string[] {
    const suggestions: string[] = [];
    const opts = resolved.compilerOptions;

    // Extends chain suggestions
    if (resolved.extendsChain.length === 1) {
      suggestions.push(
        'Consider using @tsconfig/* base configs for better defaults'
      );
    }

    // Path mapping suggestions
    if (opts.paths && Object.keys(opts.paths).length > 10) {
      suggestions.push(
        'Consider simplifying path mappings - too many can slow compilation'
      );
    }

    // Output directory suggestions
    if (!opts.outDir) {
      suggestions.push(
        'Specify "outDir" to keep source and build files separate'
      );
    }

    // Add issue-based suggestions
    if (issues) {
      for (const issue of issues) {
        if (issue.severity === 'warning' && issue.suggestion) {
          suggestions.push(issue.suggestion);
        }
      }
    }

    return suggestions;
  }

  // THE SAME QUESTION MUST NOT GET A SMALLER ANSWER THE SECOND TIME IT IS ASKED.
  //
  // This used to return the whole resolved config on a cold read and, on a cache
  // hit, only compilerOptions plus the path -- dropping include, exclude, files
  // and references. Reading one tsconfig twice therefore produced two different
  // configs, and the second was missing precisely the fields that say which files
  // the config applies to. The metrics block then subtracted the two and
  // published the difference as a saving, which is how dropped content gets
  // reported as compression. One shape is built here and used on both paths.
  private transformOutput(
    resolved: ResolvedTsConfig,
    issues?: ConfigIssue[],
    suggestions?: string[],
    includeIssues: boolean = true,
    includeSuggestions: boolean = true,
    fromCache: boolean = false,
    executionTime: number = 0,
    sourceContent: string = ''
  ): SmartTsConfigOutput {
    const emitted: EmittedTsConfig = {
      compilerOptions: resolved.compilerOptions,
      include: resolved.include,
      exclude: resolved.exclude,
      files: resolved.files,
      references: resolved.references,
      // A chain of one entry is the config naming itself: nothing was extended,
      // and that path is already on the response. Two absolute paths restating
      // what the caller passed in cost about a fifth of the payload on a small
      // config, so they are only worth sending when there is a real chain.
      ...(resolved.extendsChain.length > 1
        ? { extendsChain: resolved.extendsChain }
        : {}),
    };

    const output: SmartTsConfigOutput = {
      success: true,
      configPath: resolved.configPath,
      resolved: emitted,
      issues: includeIssues && issues && issues.length > 0 ? issues : undefined,
      suggestions:
        includeSuggestions && suggestions && suggestions.length > 0
          ? suggestions
          : undefined,
      cacheHit: fromCache,
      tokenMetrics: {
        original: 0,
        compact: 0,
        saved: 0,
        savingsPercent: 0,
      },
      executionTime,
    };

    // MEASURED AGAINST THE FILE, NOT AGAINST A SHAPE WE NEVER SEND.
    //
    // The old figure compared this response to a hypothetical fuller response --
    // a baseline the caller never sees and cannot check, and one that was only
    // ever bigger because the cached branch was dropping fields. The single
    // saving a reader of this tool can verify is against the config file they
    // would otherwise have read, so that is the baseline reported. When the
    // report costs more than the file, saved is 0 and the caller can see it.
    const originalTokens = sourceContent
      ? this.tokenCounter.count(sourceContent).tokens
      : 0;
    // Counted without the metrics block, so the number is not trying to account
    // for its own digits.
    const { tokenMetrics: _placeholder, ...counted } = output;
    const compactTokens = this.tokenCounter.count(
      JSON.stringify(counted)
    ).tokens;
    const savedTokens = Math.max(0, originalTokens - compactTokens);
    const savingsPercent =
      originalTokens > 0 ? (savedTokens / originalTokens) * 100 : 0;

    output.tokenMetrics = {
      original: originalTokens,
      compact: compactTokens,
      saved: savedTokens,
      savingsPercent: parseFloat(savingsPercent.toFixed(2)),
    };

    return output;
  }

  /**
   * Close resources
   */
  close(): void {
    this.cache.close();
  }
}

// ==================== Exported Function ====================

/**
 * Factory function for shared resources (benchmarks)
 */
export function getSmartTsConfig(
  cache: CacheEngine,
  tokenCounter: TokenCounter,
  metrics: MetricsCollector,
  projectRoot?: string
): SmartTsConfig {
  return new SmartTsConfig(cache, tokenCounter, metrics, projectRoot);
}

/**
 * Smart TSConfig - Parse and analyze tsconfig.json with caching
 *
 * @param options - Configuration options
 * @returns Parsed and resolved tsconfig with metrics
 */
export async function runSmartTsconfig(
  options: SmartTsConfigOptions = {}
): Promise<SmartTsConfigOutput> {
  const cache = new CacheEngine(
    resolveCacheLocation(join(homedir(), '.hypercontext', 'cache'))
  );
  const tokenCounter = new TokenCounter();
  const metrics = new MetricsCollector();
  const projectRoot = options.projectRoot ?? process.cwd();
  const tool = getSmartTsConfig(cache, tokenCounter, metrics, projectRoot);

  try {
    return await tool.run(options);
  } finally {
    tool.close();
  }
}

// ==================== MCP Tool Definition ====================

export const SMART_TSCONFIG_TOOL_DEFINITION = {
  name: 'smart_tsconfig',
  description:
    'Parse and analyze TypeScript configuration. Resolves extends chains, detects issues, and caches results for 7 days. Measured token reduction vs reading the file: -108% to -13% first read, -108% to -13% repeated (bench/tools, 2 fixtures) -- this answers what the resolved config is and what is wrong with it, and a tsconfig is small enough that the answer costs more than the file at both sizes measured.',
  inputSchema: {
    type: 'object',
    properties: {
      configPath: {
        type: 'string',
        description: 'Path to tsconfig.json (relative to projectRoot)',
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory (defaults to cwd)',
      },
      includeIssues: {
        type: 'boolean',
        description: 'Include configuration issues detection (default: true)',
      },
      includeSuggestions: {
        type: 'boolean',
        description: 'Include optimization suggestions (default: true)',
      },
      maxCacheAge: {
        type: 'number',
        description: 'Maximum cache age in seconds (default: 604800 = 7 days)',
      },
    },
  },
} as const;
