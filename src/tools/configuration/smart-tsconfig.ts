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
import { displayPath } from '../shared/report-shape.js';
import {
  RESOLVED_INPUT_KEY,
  resolvedFiles,
  type Declaring,
} from '../shared/savings.js';

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

// The merge, as the caller receives it, and ONLY when there was a merge --
// see ConfigResolution. It differs from ResolvedTsConfig by dropping
// `configPath`, which sits at the top of the response already; repeating that
// absolute path was about a tenth of the payload on a small config.
interface EmittedTsConfig {
  compilerOptions: TsConfigCompilerOptions;
  include?: string[];
  exclude?: string[];
  files?: string[];
  references?: Array<{ path: string }>;
  /** Every file the merge drew on, base first. Never fewer than two. */
  extendsChain: string[];
}

/**
 * What resolving the config actually did.
 *
 * `merged` means the config extended another and the answer is the merge of
 * the chain -- genuinely new, and sent.
 *
 * `as-written` means it extended nothing, so the resolved config IS the file
 * the caller named, which they have. Then this word is the finding and the
 * merge is not sent: 94 tokens of restated config against a 76-token file,
 * for the news that there was no news.
 */
type ConfigResolution = 'as-written' | 'merged';

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
  resolution: ConfigResolution;
  /**
   * The merge -- PRESENT ONLY when `resolution` is `merged`.
   *
   * There is nothing to send when nothing was merged. The analysis still
   * travels: `issues` and `suggestions` are computed from the resolved
   * config either way, and they are what the caller could not have worked
   * out from the file in front of them.
   */
  resolved?: EmittedTsConfig;
  issues?: ConfigIssue[];
  suggestions?: string[];
  cacheHit: boolean;
  // NO tokenMetrics FIELD, DELIBERATELY. Four figures stood here: a baseline
  // taken from the extends chain, a cost, their difference and their ratio. The
  // baseline was the right thing to measure and is now declared as the paths it
  // came from, so the recorder reads those files itself. The cost was this
  // response serialised with the metrics block spliced out -- a careful count
  // of an artifact nobody is sent, since the reply a caller pays for is built
  // around this object after the tool returns. That is how +8.21% came to be
  // printed where the wire said -2.9%.
  diff?: {
    added: string[];
    removed: string[];
    modified: string[];
  };
}

// ==================== Main Class ====================

class SmartTsConfig {
  private cache: CacheEngine;
  private metrics: MetricsCollector;
  private projectRoot: string;

  constructor(
    cache: CacheEngine,
    // ACCEPTED AND NOT USED. This counter was held so the tool could count both
    // halves of its own saving -- the extends chain, and this object standing in
    // for a reply it cannot see. It declares the chain's paths instead, and both
    // halves are counted by the party that holds the reply. The parameter stays
    // so every caller's construction call is unchanged.
    _tokenCounter: TokenCounter,
    metrics: MetricsCollector,
    projectRoot?: string
  ) {
    this.cache = cache;
    this.metrics = metrics;
    this.projectRoot = projectRoot || process.cwd();
  }

  /**
   * Main entry point - parse and resolve tsconfig
   */
  async run(
    options: SmartTsConfigOptions = {}
  ): Promise<Declaring<SmartTsConfigOutput>> {
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
          chainHash: string;
        };

        // Validate cache is still valid. The key covers the leaf config only,
        // so the whole chain is re-read and hashed here: a base config edited
        // since would otherwise be answered from a merge that no longer holds.
        const chainContent = await this.readChain(
          cachedData.resolved.extendsChain
        );
        if (
          chainContent !== undefined &&
          hashContent(chainContent) === cachedData.chainHash
        ) {
          const executionTime = Date.now() - startTime;

          const output = this.transformOutput(
            cachedData.resolved,
            cachedData.issues,
            cachedData.suggestions,
            options.includeIssues ?? true,
            options.includeSuggestions ?? true,
            true,
            cachedData.resolved.extendsChain
          );

          // NO TOKEN FIGURE ON THIS RECORD. It carried savedTokens from the
          // tool's own tokenMetrics, which measured this object and not the
          // reply built around it. The before is the chain, declared as paths
          // and read by the recorder; the after is counted once, at the wire.
          this.metrics.record({
            operation: 'smart-tsconfig',
            duration: executionTime,
            cacheHit: true,
            success: true,
          });

          return output;
        }

        // Cache invalid, delete it
        this.cache.delete(cacheKey);
      }

      // Resolve the config with extends chain
      const { config: resolved, chainContent } =
        await this.resolveConfig(configPath);

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
        // The chain, not the leaf, because the chain is what the answer was
        // merged from. `fileHash` is still in the cache KEY, so a changed leaf
        // misses outright; this is what catches a changed base on a hit.
        chainHash: hashContent(chainContent),
      };

      const maxAge = options.maxCacheAge ?? 7 * 24 * 60 * 60; // 7 days default
      const stored = JSON.stringify(toCache);
      this.cache.set(cacheKey, stored, stored.length, stored.length, {
        ttlSeconds: maxAge,
      });

      const executionTime = Date.now() - startTime;

      const output = this.transformOutput(
        resolved,
        issues,
        suggestions,
        options.includeIssues ?? true,
        options.includeSuggestions ?? true,
        false,
        resolved.extendsChain
      );

      // No token figure, as on the cache-hit path above.
      this.metrics.record({
        operation: 'smart-tsconfig',
        duration: executionTime,
        cacheHit: false,
        success: true,
      });

      return output;
    } catch (error) {
      const executionTime = Date.now() - startTime;

      this.metrics.record({
        operation: 'smart-tsconfig',
        duration: executionTime,
        cacheHit: false,
        success: false,
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
  private async resolveConfig(
    configPath: string
  ): Promise<{ config: ResolvedTsConfig; chainContent: string }> {
    const extendsChain: string[] = [];
    // THE BASELINE IS EVERY FILE IN THE CHAIN, NOT JUST THE LEAF.
    //
    // A caller doing this by hand has to read the config, see what it extends,
    // read that, and merge them. Counting only the leaf therefore compared this
    // response against a fraction of the work it replaces, and it under-counted
    // by exactly as much as the tool does for you -- so the one case the tool
    // exists for was the case its own figures flattered least.
    const chainTexts: string[] = [];
    let currentPath = configPath;
    let mergedConfig: TsConfigJson = {};

    // Walk the extends chain
    while (true) {
      const { config, content } = await this.parseConfigFile(currentPath);
      extendsChain.push(currentPath);
      chainTexts.push(content);

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
      config: {
        compilerOptions: mergedConfig.compilerOptions ?? {},
        include: mergedConfig.include,
        exclude: mergedConfig.exclude,
        files: mergedConfig.files,
        references: mergedConfig.references,
        extendsChain: extendsChain.reverse(), // Base first
        configPath,
      },
      chainContent: chainTexts.join('\n'),
    };
  }

  /**
   * Re-reads every file a cached resolution was merged from.
   *
   * The cache key covers the leaf config's hash only, so a base config that
   * changed since would otherwise be served from a stale merge -- the answer
   * would be wrong in precisely the fields the caller came here for. Returns
   * undefined when any file in the chain has gone, which invalidates the entry.
   */
  private async readChain(chain: string[]): Promise<string | undefined> {
    const texts: string[] = [];
    for (const entry of chain) {
      try {
        texts.push(await readFile(entry, 'utf-8'));
      } catch (error) {
        console.warn(
          `[SmartTsConfig] cached extends chain entry unreadable, treating the cache entry as stale: ${entry}`,
          error
        );
        return undefined;
      }
    }
    // Base first, matching the order resolveConfig merged them in, so the hash
    // is over the same bytes in the same order on both paths.
    return texts.slice().reverse().join('\n');
  }

  /**
   * Parse a single tsconfig file
   */
  private async parseConfigFile(
    configPath: string
  ): Promise<{ config: TsConfigJson; content: string }> {
    const content = await readFile(configPath, 'utf-8');

    const stripped = this.stripJsonComments(content);

    try {
      return { config: JSON.parse(stripped) as TsConfigJson, content };
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
    /**
     * Every file in the extends chain, which is what reading this by hand
     * costs. DECLARED AS PATHS, NOT AS A COUNT OF THEM: the recorder cannot
     * walk an `extends` chain from the one config the caller named, so this is
     * the half only the tool knows -- but knowing which files is not the same
     * as being the right party to count them, and the counting stays with the
     * party that also counts the reply.
     */
    chainPaths: readonly string[] = []
  ): Declaring<SmartTsConfigOutput> {
    const emitted: EmittedTsConfig = {
      compilerOptions: resolved.compilerOptions,
      include: resolved.include,
      exclude: resolved.exclude,
      files: resolved.files,
      references: resolved.references,
      // The files this was merged from, base first. Always more than one:
      // this object is only sent when the chain is real, and a chain of one
      // entry is the config naming itself.
      extendsChain: resolved.extendsChain.map(displayPath),
    };

    // A chain of one entry is the config naming itself: it extended nothing,
    // so there was no merge to perform and none to report.
    const resolution: ConfigResolution =
      resolved.extendsChain.length > 1 ? 'merged' : 'as-written';

    const output: SmartTsConfigOutput = {
      success: true,
      // Relative to the working directory where that is shorter. JSON escapes
      // every Windows separator to a doubled backslash and each escape is its
      // own token, so an absolute path cost 11 of the 142 tokens this response
      // spends on a 76-token config -- to name the file the caller asked about.
      configPath: displayPath(resolved.configPath),
      resolution,
      // SENT ONLY WHEN THERE WAS A MERGE. Handing back a parse of the file
      // the caller just named is not an answer about it, and on a small
      // config it was five sixths of the reply. What they asked -- whether
      // this config resolves to something other than what it says -- is
      // answered by `resolution` in one word.
      ...(resolution === 'merged' ? { resolved: emitted } : {}),
      issues: includeIssues && issues && issues.length > 0 ? issues : undefined,
      suggestions:
        includeSuggestions && suggestions && suggestions.length > 0
          ? suggestions
          : undefined,
      cacheHit: fromCache,
    };

    // THE CHAIN, NAMED RATHER THAN COUNTED.
    //
    // A caller doing this by hand reads the config, sees what it extends, reads
    // that, and merges them -- so the before is every file in the chain, not
    // the leaf the arguments name. That is the one thing the recorder cannot
    // work out for itself, and the only thing this tool still says about its
    // own saving. The leaf appears in both lists and is counted once.
    return {
      ...output,
      [RESOLVED_INPUT_KEY]: resolvedFiles(chainPaths, 'resolved-config-chain'),
    };
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
): Promise<Declaring<SmartTsConfigOutput>> {
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
    'Parse and analyze TypeScript configuration. Resolves extends chains, detects issues, and caches results for 7 days. Measured token reduction vs reading the file: 40-92% first read, 40-92% repeated (bench/tools, 3 fixtures) -- it answers what the resolved config is and what is wrong with it, and sends the merge only where there was one: a config that extends nothing is answered with that fact and its suggestions, because the caller already holds the file.',
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
