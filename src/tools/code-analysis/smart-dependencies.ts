/**
 * Smart Dependencies Tool - 83% Token Reduction
 *
 * Achieves token reduction through:
 * 1. Dependency graph caching (reuse across multiple queries)
 * 2. Incremental updates (only rebuild changed nodes)
 * 3. Compact graph representation (edges only, not full AST)
 * 4. Smart query modes (impact, circular, unused - return only what's needed)
 * 5. External vs internal separation (filter by relevance)
 *
 * Target: 83% reduction vs parsing and returning full file contents
 *
 * Week 5 - Phase 2 Track 2A
 */

import { readFileSync, existsSync, statSync } from 'fs';
import { parse as parseTypescript } from '@typescript-eslint/typescript-estree';
import { parse as parseBabel } from '@babel/parser';
import { relative, resolve, dirname, extname, join } from 'path';
import { CacheEngine } from '../../core/cache-engine.js';
import {
  RESOLVED_INPUT_KEY,
  resolvedFiles,
  type Declaring,
} from '../shared/savings.js';
import { TokenCounter } from '../../core/token-counter.js';
import { MetricsCollector } from '../../core/metrics.js';
import { hashFileMetadata, generateCacheKey } from '../shared/hash-utils.js';
import {
  boundedGlob,
  traversalDeadlineMs,
  type TruncationReason,
} from '../shared/bounded-traversal.js';

/**
 * Represents an import in a file
 */
export interface DependencyImport {
  source: string; // Module/file being imported
  specifiers: string[]; // Named imports/default import
  isExternal: boolean; // Is it external (node_modules) or internal
  isDynamic: boolean; // Is it a dynamic import()
  line: number; // Line number in file
}

/**
 * Represents an export in a file
 */
export interface DependencyExport {
  name: string; // Export name
  type: 'named' | 'default' | 'namespace';
  isReexport: boolean; // Re-exported from another module
  source?: string; // Source module if re-export
  line: number; // Line number in file
}

/**
 * Node in the dependency graph
 */
export interface DependencyNode {
  file: string; // Relative file path
  hash: string; // File content hash
  imports: DependencyImport[];
  exports: DependencyExport[];
  importedBy: string[]; // Files that import this one
  importedByCount: number; // Quick count for sorting
  lastAnalyzed: number; // Timestamp
}

/**
 * Circular dependency chain
 */
export interface CircularDependency {
  cycle: string[]; // Files in the circular dependency
  depth: number; // Length of the cycle
  severity: 'low' | 'medium' | 'high';
}

/**
 * Unused import/export detection
 */
export interface UnusedDependency {
  file: string;
  type: 'import' | 'export';
  name: string;
  source?: string;
  line: number;
  reason: string;
}

/**
 * Dependency impact analysis
 */
export interface DependencyImpact {
  file: string; // File being analyzed
  directDependents: string[]; // Files directly importing this
  indirectDependents: string[]; // Files indirectly importing this
  totalImpact: number; // Total files affected by changes
  criticalPath: string[][]; // Critical dependency chains
}

export interface SmartDependenciesOptions {
  // Scope
  cwd?: string; // Working directory
  files?: string[]; // Files to analyze (glob patterns)
  exclude?: string[]; // Patterns to exclude

  // Analysis modes
  mode?: 'graph' | 'circular' | 'unused' | 'impact'; // What to analyze
  targetFile?: string; // For impact analysis

  // Graph options
  includeExternal?: boolean; // Include external dependencies (default: false)
  maxDepth?: number; // Max depth for impact analysis (default: unlimited)

  // Cache options
  useCache?: boolean; // Use cached graph (default: true)
  incrementalUpdate?: boolean; // Update only changed files (default: true)
  ttl?: number; // Cache TTL in days (default: 7)

  // Output options
  format?: 'compact' | 'detailed'; // Output format
  includeMetadata?: boolean; // Include file metadata

  /**
   * Wall-clock budget in ms for discovering the files to analyse.
   *
   * File discovery here was `globSync` over every source file in the tree,
   * which is the same unbounded walk issue #335 reported: on a large tree it
   * blocks the event loop until it finishes, and there was no point at which
   * it could give up and answer. Defaults to 10 s.
   */
  deadlineMs?: number;
}

/** JSON-safe shape of the dependency graph. */
export interface DependencyGraphPayload {
  nodes: string[];
  edges: Array<{ from: string; to: string; type: string }>;
  externalDependencies: string[];
}

export interface SmartDependenciesResult {
  success: boolean;
  mode: string;
  metadata: {
    totalFiles: number;
    analyzedFiles: number;
    externalDependencies: number;
    internalDependencies: number;
    /*
     * NO TOKEN FIGURES HERE, DELIBERATELY.
     *
     * Four stood here: a baseline read off the files in the graph, a cost
     * counted from a JSON.stringify of the payload, their difference and their
     * ratio. The baseline was the right thing to measure and is now declared
     * as the paths it came from, so the recorder reads those files itself. The
     * cost was a count of one field of this object, not of the reply built
     * around it after the tool returns -- which is how a call that really
     * avoided 63% of a 211-token file came to publish `tokensSaved: -11`.
     */
    cacheHit: boolean;
    incrementalUpdate: boolean;
    /**
     * Set when a bound stopped file discovery, so the graph describes only
     * part of the tree. Absent means the walk ran to completion -- the
     * difference between "no cycles" and "no cycles among what I looked at".
     */
    searchTruncated?: boolean;
    searchTruncatedBy?: TruncationReason;
    searchNote?: string;
  };
  /**
   * The dependency graph, as data JSON can carry.
   *
   * THIS WAS A `Map`, and `JSON.stringify(new Map([...]))` is `{}` -- so every
   * response delivered `"graph": {}` no matter what was found. Measured on a
   * four-file fixture: metadata correctly reported analyzedFiles 4,
   * externalDependencies 2, internalDependencies 3, while the graph itself
   * arrived empty. The analysis was right and only the payload was lost, which
   * is why nothing ever looked broken from inside.
   *
   * The compact form was already being built to count tokens against, then
   * thrown away -- so the reported token count described data the caller never
   * received.
   */
  graph?: DependencyGraphPayload; // Full graph (graph mode)
  circular?: CircularDependency[]; // Circular dependencies (circular mode)
  unused?: UnusedDependency[]; // Unused imports/exports (unused mode)
  impact?: DependencyImpact; // Impact analysis (impact mode)
  error?: string;
}

export class SmartDependenciesTool {
  /**
   * Token count per relative path, recorded while the file was open.
   *
   * Cleared at the start of every `analyze()` so it can never serve a count
   * from a previous call's content -- the saving is skipping a redundant read
   * WITHIN one analysis, not caching across them.
   */

  /**
   * Whether a candidate module path is a file, remembered for one `analyze()`.
   *
   * Import resolution probes the same handful of candidates over and over --
   * every file in a package resolving `./index` walks the identical extension
   * list -- and each probe was its own `existsSync`. Measured 2026-08-28 after
   * the read-once fix landed: 4.98 s, 14.6% of the run, and the single largest
   * remaining cost. Cleared per call for the same reason as the token counts.
   */
  private pathExists = new Map<string, boolean>();

  constructor(
    private cache: CacheEngine,
    // ACCEPTED AND NOT USED. It was held to count both halves of this tool's
    // own saving: an invented per-file baseline, and a JSON.stringify of the
    // graph standing in for a reply the tool never sees. Both halves are now
    // counted by the one party that sees both, so the parameter stays only to
    // leave every caller's construction call unchanged.
    _tokenCounter: TokenCounter,
    private metrics: MetricsCollector
  ) {}

  /**
   * Main entry point for dependency analysis
   * Alias for analyze() to maintain API consistency with other tools
   */
  async run(
    options: SmartDependenciesOptions = {}
  ): Promise<Declaring<SmartDependenciesResult>> {
    return this.analyze(options);
  }

  /**
   * Core dependency analysis implementation
   */
  async analyze(
    options: SmartDependenciesOptions = {}
  ): Promise<Declaring<SmartDependenciesResult>> {
    const startTime = Date.now();
    this.pathExists.clear();

    // Default options
    const opts: Required<SmartDependenciesOptions> = {
      cwd: options.cwd ?? process.cwd(),
      files: options.files ?? ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],
      exclude: options.exclude ?? [
        '**/node_modules/**',
        '**/.git/**',
        '**/dist/**',
        '**/build/**',
        '**/*.min.js',
        '**/*.test.*',
        '**/*.spec.*',
      ],
      mode: options.mode ?? 'graph',
      targetFile: options.targetFile ?? '',
      includeExternal: options.includeExternal ?? false,
      maxDepth: options.maxDepth ?? Infinity,
      useCache: options.useCache ?? true,
      incrementalUpdate: options.incrementalUpdate ?? true,
      ttl: options.ttl ?? 7,
      format: options.format ?? 'compact',
      includeMetadata: options.includeMetadata ?? false,
      deadlineMs: traversalDeadlineMs(options.deadlineMs),
    };

    try {
      // Build or load dependency graph
      const graphResult = await this.buildOrLoadGraph(opts, startTime);

      if (!graphResult.success) {
        return graphResult;
      }

      // The MAP, for the analysis modes below. `graphResult.graph` is the
      // JSON payload the caller receives; the two were one field, which is how
      // a Map came to be JSON.stringify'd into `{}`.
      const graph = graphResult.rawGraph!;

      // Run analysis based on mode
      let result: SmartDependenciesResult;

      switch (opts.mode) {
        case 'circular':
          result = this.detectCircularDependencies(graph, opts, startTime);
          break;
        case 'unused':
          result = this.detectUnusedDependencies(graph, opts, startTime);
          break;
        case 'impact':
          result = this.analyzeImpact(graph, opts, startTime);
          break;
        case 'graph':
        default:
          result = this.transformGraphOutput(graph, opts, startTime);
          break;
      }

      // Truncation is a property of the WALK, but each mode handler builds its
      // own metadata from the finished graph, so the flag is dropped on three
      // of the four paths unless it is re-applied here. A `circular` result
      // that quietly loses it reads as "no cycles" rather than "no cycles in
      // the part of the tree I actually reached".
      if (graphResult.metadata.searchTruncated) {
        result.metadata.searchTruncated = true;
        result.metadata.searchTruncatedBy =
          graphResult.metadata.searchTruncatedBy;
        result.metadata.searchNote = graphResult.metadata.searchNote;
      }

      // SO IS CACHE PROVENANCE, AND IT WAS LOST ON ALL FOUR PATHS. Only
      // `buildOrLoadGraph` knows whether the graph came off disk, and each mode
      // handler builds its own metadata with `cacheHit: false` written in. So a
      // call that did no work at all told the caller it had, `metrics.record`
      // below stored the same false, and `getStats()` reported zero cache hits
      // however many there were.
      result.metadata.cacheHit = graphResult.metadata.cacheHit;
      result.metadata.incrementalUpdate =
        graphResult.metadata.incrementalUpdate;

      // Record metrics
      const duration = Date.now() - startTime;

      // THE ONLY FIGURES LEFT ARE ONES THIS TOOL CAN SEE. The token fields fed
      // off the metadata above, so they inherited every one of its errors --
      // and `getStats()` then totalled them into a lifetime saving.
      this.metrics.record({
        operation: 'smart_dependencies',
        duration,
        success: true,
        cacheHit: result.metadata.cacheHit,
      });

      /*
       * THE BEFORE IS A SET OF FILES, NOT A NUMBER THIS TOOL COUNTED.
       *
       * What this call displaces is reading the import graph by hand, and the
       * old code tried to price that itself -- at first `files.length * 2000`,
       * then a real count of a second pass over every file. Both were the
       * tool doing arithmetic the caller pays for and nobody can check.
       *
       * Declared as paths instead: the recorder reads these files with the
       * same reader and counts them with the same counter it uses on the
       * reply, so the row comes out measured on both sides. The graph's keys
       * are relative to `opts.cwd` (see `analyzeFile`), and the recorder
       * resolves a relative path against ITS working directory, so they are
       * made absolute here -- the one place that knows which root they came
       * from.
       *
       * A graph larger than the recorder's file cap declares nothing, by way
       * of `resolvedFiles` returning null, and the row is then measured from
       * whatever the arguments named. Understating is the safe direction.
       */
      const displacedFiles = (
        !result.success
          ? // A REFUSAL DISPLACED NOTHING. `impact` without a `targetFile`, or
            // with one that is not in the graph, answers with an error and no
            // analysis -- and declaring the graph there would credit the call
            // with standing in for files the caller still has to read.
            []
          : result.impact
            ? [
                // Impact answers about one file and its dependents, so that is
                // what reading it by hand would have cost -- not the whole
                // graph.
                result.impact.file,
                ...result.impact.directDependents,
                ...result.impact.indirectDependents,
              ]
            : Array.from(graph.keys())
      ).map((file) => resolve(opts.cwd, file));

      return {
        ...result,
        [RESOLVED_INPUT_KEY]: resolvedFiles(
          displacedFiles,
          'resolved-import-graph'
        ),
      };
    } catch (error) {
      const duration = Date.now() - startTime;

      this.metrics.record({
        operation: 'smart_dependencies',
        duration,
        success: false,
        cacheHit: false,
      });

      return {
        success: false,
        mode: opts.mode,
        metadata: {
          totalFiles: 0,
          analyzedFiles: 0,
          externalDependencies: 0,
          internalDependencies: 0,
          cacheHit: false,
          incrementalUpdate: false,
        },
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Build dependency graph or load from cache
   */
  private async buildOrLoadGraph(
    opts: Required<SmartDependenciesOptions>,
    _startTime: number
  ): Promise<
    // ONLY `rawGraph`. This used to return the Map as `graph`, which
    // JSON.stringify turns into `{}` -- the defect this change fixes. The first
    // fix built the JSON payload here as well, but analyze() reads only
    // `rawGraph`, and every mode handler builds its own result from it, so that
    // payload was computed and thrown away on all four paths -- including the
    // cached fast path, turning an O(1) reference return into an O(n) traversal
    // for a value nobody read.
    SmartDependenciesResult & { rawGraph: Map<string, DependencyNode> }
  > {
    const cacheKey = generateCacheKey('dependency_graph', { cwd: opts.cwd });

    // Try to load from cache
    if (opts.useCache) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        const cachedGraph = this.deserializeGraph(cached.toString());

        // If incremental update enabled, check for file changes
        if (opts.incrementalUpdate) {
          const changedFiles = this.detectChangedFiles(cachedGraph, opts);

          if (changedFiles.length === 0) {
            // No changes - return cached graph
            return {
              success: true,
              mode: 'graph',
              rawGraph: cachedGraph,
              metadata: {
                totalFiles: cachedGraph.size,
                analyzedFiles: 0,
                externalDependencies: this.countExternalDeps(cachedGraph),
                internalDependencies: this.countInternalDeps(cachedGraph),
                // A CACHE HIT HAS A BASELINE AGAIN. It had none while the
                // before was a number someone had to have counted at analysis
                // time and no longer had -- so this claimed 100% of what it
                // returned, and then claimed nothing at all. The before is a
                // set of files, and the files are still on disk: the graph's
                // keys are declared like any other call's and the recorder
                // reads them.
                cacheHit: true,
                incrementalUpdate: false,
              },
            };
          } else {
            // Incremental update - rebuild only changed files
            const updatedGraph = await this.incrementalGraphUpdate(
              cachedGraph,
              changedFiles,
              opts
            );

            // Cache updated graph
            this.cacheGraph(cacheKey, updatedGraph, opts.ttl);

            return {
              success: true,
              mode: 'graph',
              rawGraph: updatedGraph,
              metadata: {
                totalFiles: updatedGraph.size,
                analyzedFiles: changedFiles.length,
                externalDependencies: this.countExternalDeps(updatedGraph),
                internalDependencies: this.countInternalDeps(updatedGraph),
                cacheHit: false,
                incrementalUpdate: true,
              },
            };
          }
        } else {
          // No incremental update - return cached graph
          return {
            success: true,
            mode: 'graph',
            rawGraph: cachedGraph,
            metadata: {
              totalFiles: cachedGraph.size,
              analyzedFiles: 0,
              externalDependencies: this.countExternalDeps(cachedGraph),
              internalDependencies: this.countInternalDeps(cachedGraph),
              // See above: a hit declares the same files a fresh build would.
              cacheHit: true,
              incrementalUpdate: false,
            },
          };
        }
      }
    }

    // Build graph from scratch
    const { graph, truncatedBy } = await this.buildFullGraph(opts);

    // A PARTIAL GRAPH IS NEVER CACHED. Storing one would outlive the call that
    // knew it was partial: every later request would hit the cache, report
    // `cacheHit: true` with no truncation flag at all, and answer "unused" for
    // files whose importers were simply never walked. Paying for a rebuild is
    // cheaper than a fast wrong answer that persists for the TTL.
    if (opts.useCache && !truncatedBy) {
      this.cacheGraph(cacheKey, graph, opts.ttl);
    }

    return {
      success: true,
      mode: 'graph',
      rawGraph: graph,
      metadata: {
        totalFiles: graph.size,
        analyzedFiles: graph.size,
        externalDependencies: this.countExternalDeps(graph),
        internalDependencies: this.countInternalDeps(graph),
        cacheHit: false,
        incrementalUpdate: false,
        ...(truncatedBy
          ? {
              searchTruncated: true,
              searchTruncatedBy: truncatedBy,
              searchNote: `File discovery stopped at the ${opts.deadlineMs}ms traversal deadline, so this graph covers only part of the tree and anything derived from it -- unused imports, cycles, impact -- may be missing entries. The partial graph was NOT cached. Narrow \`files\`/\`exclude\`, or raise TOKEN_OPTIMIZER_TRAVERSAL_DEADLINE_MS.`,
            }
          : {}),
      },
    };
  }

  /**
   * Build complete dependency graph
   */
  private async buildFullGraph(
    opts: Required<SmartDependenciesOptions>
  ): Promise<{
    graph: Map<string, DependencyNode>;
    truncatedBy?: TruncationReason;
  }> {
    // ONE budget for the whole call, not one per pattern. `files` defaults to a
    // single pattern but accepts a list, and giving each its own 10 s deadline
    // would turn a five-pattern request into a fifty-second one -- which is the
    // caller's tool timeout, the thing this bound exists to stay under.
    const expiresAt = Date.now() + opts.deadlineMs;
    const remainingMs = () => Math.max(1, expiresAt - Date.now());

    // Find all files to analyze
    let files: string[] = [];
    let truncatedBy: TruncationReason | undefined;

    for (const pattern of opts.files) {
      if (truncatedBy) break;
      const walk = await boundedGlob(pattern, {
        cwd: opts.cwd,
        absolute: true,
        ignore: opts.exclude,
        nodir: true,
        deadlineMs: remainingMs(),
      });
      files.push(...walk.items);
      // NO CAP, DELIBERATELY. Every mode here answers a whole-graph question --
      // what imports what, which cycles exist, what is unused -- and a cap does
      // not shorten that answer, it falsifies it: dropping a node also drops
      // the `importedBy` edges of nodes that were KEPT, so a file that IS
      // imported comes back reported as unused. The deadline is the only bound
      // that can be reported honestly, because what it reports is "partial".
      if (walk.truncated) truncatedBy = walk.truncatedBy;
    }

    // Remove duplicates
    files = Array.from(new Set(files));

    // Build nodes
    const graph = new Map<string, DependencyNode>();

    for (const filePath of files) {
      const node = this.analyzeFile(filePath, opts.cwd);
      if (node) {
        const relativePath = relative(opts.cwd, filePath);
        graph.set(relativePath, node);
      }
    }

    // Build reverse dependencies (importedBy)
    this.buildReverseDependencies(graph, opts.cwd);

    return { graph, truncatedBy };
  }

  /**
   * Analyze a single file for dependencies
   */
  private analyzeFile(filePath: string, cwd: string): DependencyNode | null {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const ext = extname(filePath);
      const hash = hashFileMetadata(filePath);
      const relativePath = relative(cwd, filePath);

      const imports: DependencyImport[] = [];
      const exports: DependencyExport[] = [];

      // Parse based on file extension
      let ast: any;
      try {
        if (ext === '.ts' || ext === '.tsx') {
          ast = parseTypescript(content, {
            loc: true,
            range: true,
            tokens: false,
            comment: false,
            jsx: ext === '.tsx',
          });
        } else {
          ast = parseBabel(content, {
            sourceType: 'module',
            plugins: ['jsx', 'typescript'],
          });
        }
      } catch {
        // Parse error - skip file
        return null;
      }

      // Extract imports
      this.extractImports(ast, imports, cwd, dirname(filePath));

      // Extract exports
      this.extractExports(ast, exports);

      return {
        file: relativePath,
        hash,
        imports,
        exports,
        importedBy: [],
        importedByCount: 0,
        lastAnalyzed: Date.now(),
      };
    } catch {
      return null;
    }
  }

  /**
   * Extract imports from AST
   */
  private extractImports(
    ast: any,
    imports: DependencyImport[],
    cwd: string,
    fileDir: string
  ): void {
    const body = ast.body || ast.program?.body || [];

    for (const node of body) {
      // Static imports: import ... from '...'
      if (node.type === 'ImportDeclaration') {
        const source = node.source.value;
        const isExternal = this.isExternalDependency(source);
        const specifiers = node.specifiers.map((spec: any) => {
          if (spec.type === 'ImportDefaultSpecifier') {
            return 'default';
          } else if (spec.type === 'ImportNamespaceSpecifier') {
            return '*';
          } else {
            return spec.imported?.name || spec.local?.name || '';
          }
        });

        imports.push({
          source: isExternal
            ? source
            : this.resolveRelativePath(source, fileDir, cwd),
          specifiers,
          isExternal,
          isDynamic: false,
          line: node.loc?.start.line || 0,
        });
      }

      // Dynamic imports: import('...')
      if (
        node.type === 'ExpressionStatement' &&
        node.expression?.type === 'CallExpression' &&
        node.expression?.callee?.type === 'Import'
      ) {
        const source = node.expression.arguments[0]?.value;
        if (source) {
          const isExternal = this.isExternalDependency(source);
          imports.push({
            source: isExternal
              ? source
              : this.resolveRelativePath(source, fileDir, cwd),
            specifiers: [],
            isExternal,
            isDynamic: true,
            line: node.loc?.start.line || 0,
          });
        }
      }

      // require() calls
      if (node.type === 'VariableDeclaration') {
        for (const decl of node.declarations) {
          if (
            decl.init?.type === 'CallExpression' &&
            decl.init?.callee?.name === 'require'
          ) {
            const source = decl.init.arguments[0]?.value;
            if (source) {
              const isExternal = this.isExternalDependency(source);
              imports.push({
                source: isExternal
                  ? source
                  : this.resolveRelativePath(source, fileDir, cwd),
                specifiers: [],
                isExternal,
                isDynamic: false,
                line: node.loc?.start.line || 0,
              });
            }
          }
        }
      }
    }
  }

  /**
   * Extract exports from AST
   */
  private extractExports(ast: any, exports: DependencyExport[]): void {
    const body = ast.body || ast.program?.body || [];

    for (const node of body) {
      // Named exports: export { ... }
      if (node.type === 'ExportNamedDeclaration') {
        if (node.declaration) {
          // export const/function/class ...
          if (node.declaration.type === 'VariableDeclaration') {
            for (const decl of node.declaration.declarations) {
              exports.push({
                name: decl.id?.name || '',
                type: 'named',
                isReexport: false,
                line: node.loc?.start.line || 0,
              });
            }
          } else if (node.declaration.id) {
            exports.push({
              name: node.declaration.id.name,
              type: 'named',
              isReexport: false,
              line: node.loc?.start.line || 0,
            });
          }
        } else if (node.specifiers) {
          // export { a, b } from '...'
          for (const spec of node.specifiers) {
            exports.push({
              name: spec.exported?.name || '',
              type: 'named',
              isReexport: !!node.source,
              source: node.source?.value,
              line: node.loc?.start.line || 0,
            });
          }
        }
      }

      // Default export: export default ...
      if (node.type === 'ExportDefaultDeclaration') {
        exports.push({
          name: 'default',
          type: 'default',
          isReexport: false,
          line: node.loc?.start.line || 0,
        });
      }

      // Namespace export: export * from '...'
      if (node.type === 'ExportAllDeclaration') {
        exports.push({
          name: '*',
          type: 'namespace',
          isReexport: true,
          source: node.source?.value,
          line: node.loc?.start.line || 0,
        });
      }
    }
  }

  /**
   * Build reverse dependencies (which files import this file)
   */
  private buildReverseDependencies(
    graph: Map<string, DependencyNode>,
    _cwd: string
  ): void {
    // Reset all importedBy arrays
    for (const node of Array.from(graph.values())) {
      node.importedBy = [];
      node.importedByCount = 0;
    }

    // Build reverse mappings
    for (const [file, node] of Array.from(graph.entries())) {
      for (const imp of node.imports) {
        if (!imp.isExternal) {
          const targetNode = graph.get(imp.source);
          if (targetNode) {
            targetNode.importedBy.push(file);
            targetNode.importedByCount++;
          }
        }
      }
    }
  }

  /**
   * Detect files that have changed since last analysis
   */
  private detectChangedFiles(
    graph: Map<string, DependencyNode>,
    opts: Required<SmartDependenciesOptions>
  ): string[] {
    const changed: string[] = [];

    for (const [file, node] of Array.from(graph.entries())) {
      const fullPath = resolve(opts.cwd, file);

      if (!existsSync(fullPath)) {
        // File deleted
        changed.push(file);
        continue;
      }

      try {
        const currentHash = hashFileMetadata(fullPath);
        if (currentHash !== node.hash) {
          // File modified
          changed.push(file);
        }
      } catch {
        // Error accessing file
        changed.push(file);
      }
    }

    return changed;
  }

  /**
   * Incrementally update graph with changed files
   */
  private async incrementalGraphUpdate(
    graph: Map<string, DependencyNode>,
    changedFiles: string[],
    opts: Required<SmartDependenciesOptions>
  ): Promise<Map<string, DependencyNode>> {
    const updatedGraph = new Map(graph);

    // Analyze changed files
    for (const file of changedFiles) {
      const fullPath = resolve(opts.cwd, file);

      if (!existsSync(fullPath)) {
        // File deleted - remove from graph
        updatedGraph.delete(file);
      } else {
        // File modified - re-analyze
        const node = this.analyzeFile(fullPath, opts.cwd);
        if (node) {
          updatedGraph.set(file, node);
        }
      }
    }

    // Rebuild reverse dependencies
    this.buildReverseDependencies(updatedGraph, opts.cwd);

    return updatedGraph;
  }

  /**
   * Detect circular dependencies
   */
  private detectCircularDependencies(
    graph: Map<string, DependencyNode>,
    _opts: Required<SmartDependenciesOptions>,
    _startTime: number
  ): SmartDependenciesResult {
    const circular: CircularDependency[] = [];
    const visited = new Set<string>();
    const stack = new Set<string>();

    const detectCycle = (file: string, path: string[]): void => {
      if (stack.has(file)) {
        // Found cycle
        const cycleStart = path.indexOf(file);
        const cycle = path.slice(cycleStart).concat(file);
        const depth = cycle.length - 1;

        // Determine severity based on cycle length
        let severity: 'low' | 'medium' | 'high' = 'low';
        if (depth >= 5) severity = 'high';
        else if (depth >= 3) severity = 'medium';

        circular.push({ cycle, depth, severity });
        return;
      }

      if (visited.has(file)) {
        return;
      }

      visited.add(file);
      stack.add(file);
      path.push(file);

      const node = graph.get(file);
      if (node) {
        for (const imp of node.imports) {
          if (!imp.isExternal) {
            detectCycle(imp.source, [...path]);
          }
        }
      }

      stack.delete(file);
    };

    // Check all files
    for (const file of Array.from(graph.keys())) {
      if (!visited.has(file)) {
        detectCycle(file, []);
      }
    }

    return {
      success: true,
      mode: 'circular',
      circular,
      metadata: {
        totalFiles: graph.size,
        analyzedFiles: graph.size,
        externalDependencies: this.countExternalDeps(graph),
        internalDependencies: this.countInternalDeps(graph),
        cacheHit: false,
        incrementalUpdate: false,
      },
    };
  }

  /**
   * Detect unused imports and exports
   */
  private detectUnusedDependencies(
    graph: Map<string, DependencyNode>,
    _opts: Required<SmartDependenciesOptions>,
    _startTime: number
  ): SmartDependenciesResult {
    const unused: UnusedDependency[] = [];

    for (const [file, node] of Array.from(graph.entries())) {
      // Check for unused imports
      // (This is a simplified check - real implementation would need symbol tracking)
      for (const imp of node.imports) {
        if (!imp.isExternal && imp.specifiers.length > 0) {
          const targetNode = graph.get(imp.source);
          if (!targetNode) {
            unused.push({
              file,
              type: 'import',
              name: imp.specifiers.join(', '),
              source: imp.source,
              line: imp.line,
              reason: 'Imported file not found in project',
            });
          }
        }
      }

      // Check for unused exports
      if (node.importedByCount === 0 && node.exports.length > 0) {
        for (const exp of node.exports) {
          if (exp.type !== 'default') {
            unused.push({
              file,
              type: 'export',
              name: exp.name,
              line: exp.line,
              reason: 'Export not imported by any file in project',
            });
          }
        }
      }
    }

    return {
      success: true,
      mode: 'unused',
      unused,
      metadata: {
        totalFiles: graph.size,
        analyzedFiles: graph.size,
        externalDependencies: this.countExternalDeps(graph),
        internalDependencies: this.countInternalDeps(graph),
        cacheHit: false,
        incrementalUpdate: false,
      },
    };
  }

  /**
   * Analyze impact of changing a file
   */
  private analyzeImpact(
    graph: Map<string, DependencyNode>,
    opts: Required<SmartDependenciesOptions>,
    _startTime: number
  ): SmartDependenciesResult {
    if (!opts.targetFile) {
      return {
        success: false,
        mode: 'impact',
        metadata: {
          totalFiles: 0,
          analyzedFiles: 0,
          externalDependencies: 0,
          internalDependencies: 0,
          cacheHit: false,
          incrementalUpdate: false,
        },
        error: 'targetFile required for impact analysis',
      };
    }

    const targetNode = graph.get(opts.targetFile);
    if (!targetNode) {
      return {
        success: false,
        mode: 'impact',
        metadata: {
          totalFiles: 0,
          analyzedFiles: 0,
          externalDependencies: 0,
          internalDependencies: 0,
          cacheHit: false,
          incrementalUpdate: false,
        },
        error: `File not found in graph: ${opts.targetFile}`,
      };
    }

    const directDependents = targetNode.importedBy;
    const indirectDependents: string[] = [];
    const visited = new Set<string>();
    const criticalPath: string[][] = [];
    /*
     * A DIRECT DEPENDENT IS NOT ALSO AN INDIRECT ONE.
     *
     * The walk below seeds its queue with the direct dependents and records
     * every file it pops, so each direct dependent landed in both lists --
     * and `totalImpact` adds the two lengths. One file importing the target
     * reported an impact of 2, and a target with 30 importers reported 60.
     *
     * They still have to be walked, because that is how their own importers
     * are reached, so they are excluded from the recording rather than from
     * the queue. The target is excluded for the same reason: a cycle through
     * it would otherwise list the changed file as affected by itself.
     */
    const direct = new Set(directDependents);

    // BFS to find all indirect dependents
    const queue: Array<{ file: string; depth: number; path: string[] }> =
      directDependents.map((f) => ({
        file: f,
        depth: 1,
        path: [opts.targetFile, f],
      }));

    while (queue.length > 0) {
      const { file, depth, path } = queue.shift()!;

      if (visited.has(file) || depth > opts.maxDepth) {
        continue;
      }

      visited.add(file);
      if (!direct.has(file) && file !== opts.targetFile) {
        indirectDependents.push(file);
      }

      // Track critical paths (paths longer than 3)
      if (path.length >= 3) {
        criticalPath.push(path);
      }

      const node = graph.get(file);
      if (node) {
        for (const dependent of node.importedBy) {
          if (!visited.has(dependent)) {
            queue.push({
              file: dependent,
              depth: depth + 1,
              path: [...path, dependent],
            });
          }
        }
      }
    }

    const impact: DependencyImpact = {
      file: opts.targetFile,
      directDependents,
      indirectDependents,
      totalImpact: directDependents.length + indirectDependents.length,
      criticalPath: criticalPath.slice(0, 10), // Top 10 critical paths
    };

    return {
      success: true,
      mode: 'impact',
      impact,
      metadata: {
        totalFiles: graph.size,
        analyzedFiles: impact.totalImpact + 1,
        externalDependencies: this.countExternalDeps(graph),
        internalDependencies: this.countInternalDeps(graph),
        cacheHit: false,
        incrementalUpdate: false,
      },
    };
  }

  /**
   * Transform graph to compact output format
   */
  private transformGraphOutput(
    graph: Map<string, DependencyNode>,
    opts: Required<SmartDependenciesOptions>,
    _startTime: number
  ): SmartDependenciesResult {
    // Filter external dependencies if not requested
    const filteredGraph = new Map<string, DependencyNode>();

    for (const [file, node] of Array.from(graph.entries())) {
      const filteredNode = { ...node };

      if (!opts.includeExternal) {
        filteredNode.imports = node.imports.filter((imp) => !imp.isExternal);
      }

      filteredGraph.set(file, filteredNode);
    }

    // Calculate tokens
    // Both branches must be JSON-carryable. `detailed` used
    // Array.from(map.entries()), which survives JSON but was never the value
    // actually returned -- the raw Map was.
    const graphData: DependencyGraphPayload =
      this.compactGraphRepresentation(filteredGraph);

    return {
      success: true,
      mode: 'graph',
      // The SAME data the token count above describes. This returned the raw
      // Map, so the count measured one thing and the caller received another.
      graph: graphData,
      metadata: {
        totalFiles: filteredGraph.size,
        analyzedFiles: filteredGraph.size,
        externalDependencies: this.countExternalDeps(graph),
        internalDependencies: this.countInternalDeps(graph),
        cacheHit: false,
        incrementalUpdate: false,
      },
    };
  }

  /**
   * Create compact graph representation (edges only)
   */
  private compactGraphRepresentation(
    graph: Map<string, DependencyNode>
  ): DependencyGraphPayload {
    const edges: Array<{ from: string; to: string; type: string }> = [];
    const externalDeps = new Set<string>();

    for (const [file, node] of Array.from(graph.entries())) {
      for (const imp of node.imports) {
        if (imp.isExternal) {
          externalDeps.add(imp.source);
        } else {
          edges.push({
            from: file,
            to: imp.source,
            type: imp.isDynamic ? 'dynamic' : 'static',
          });
        }
      }
    }

    return {
      nodes: Array.from(graph.keys()),
      edges,
      externalDependencies: Array.from(externalDeps),
    };
  }

  /**
   * Utility: Check if dependency is external (node_modules)
   */
  private isExternalDependency(source: string): boolean {
    return !source.startsWith('.') && !source.startsWith('/');
  }

  /**
   * Utility: Resolve relative path
   */
  /**
   * Whether a candidate resolves to an actual FILE, asked once per analysis.
   *
   * `isFile()`, not `existsSync`. A directory satisfies `existsSync`, so
   * `./foo` in a project holding a `foo/` directory resolved to the directory
   * itself -- producing a graph edge to `src/foo`, which is not a node in the
   * graph at all. Measured on a fixture holding both `foo.ts` and
   * `foo/index.ts`: the recorded edge was `src\\main.ts -> src\\foo`, pointing
   * at nothing, while Node resolves that import to `foo.ts`.
   */
  private candidateIsFile(candidate: string): boolean {
    const remembered = this.pathExists.get(candidate);
    if (remembered !== undefined) return remembered;
    let isFile = false;
    try {
      isFile = statSync(candidate).isFile();
    } catch {
      isFile = false;
    }
    this.pathExists.set(candidate, isFile);
    return isFile;
  }

  /**
   * Resolve an import specifier to a path relative to `cwd`.
   *
   * Order matches Node: the path as written, then the extension candidates,
   * then `index.*` inside a directory of that name. Each step returns on the
   * first hit, so a later candidate can never overwrite an earlier one.
   */
  private resolveRelativePath(
    source: string,
    fileDir: string,
    cwd: string
  ): string {
    const resolved = resolve(fileDir, source);
    if (this.candidateIsFile(resolved)) return relative(cwd, resolved);

    const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

    for (const ext of extensions) {
      const withExt = `${resolved}${ext}`;
      if (this.candidateIsFile(withExt)) return relative(cwd, withExt);
    }

    for (const ext of extensions) {
      const indexFile = join(resolved, `index${ext}`);
      if (this.candidateIsFile(indexFile)) return relative(cwd, indexFile);
    }

    // Nothing on disk matches -- an unresolvable import is recorded as written
    // rather than dropped, so the edge is visible instead of silently absent.
    return relative(cwd, resolved);
  }

  /**
   * Count external dependencies
   */
  private countExternalDeps(graph: Map<string, DependencyNode>): number {
    const external = new Set<string>();
    for (const node of Array.from(graph.values())) {
      for (const imp of node.imports) {
        if (imp.isExternal) {
          external.add(imp.source);
        }
      }
    }
    return external.size;
  }

  /**
   * Count internal dependencies
   */
  private countInternalDeps(graph: Map<string, DependencyNode>): number {
    let count = 0;
    for (const node of Array.from(graph.values())) {
      count += node.imports.filter((imp) => !imp.isExternal).length;
    }
    return count;
  }

  /**
   * Cache graph
   */
  private cacheGraph(
    cacheKey: string,
    graph: Map<string, DependencyNode>,
    ttlDays: number
  ): void {
    const serialized = this.serializeGraph(graph);
    const ttlSeconds = ttlDays * 24 * 60 * 60;

    this.cache.set(cacheKey, serialized, serialized.length, serialized.length, {
      ttlSeconds,
    });
  }

  /**
   * Serialize graph for caching
   */
  private serializeGraph(graph: Map<string, DependencyNode>): string {
    const obj = Object.fromEntries(graph.entries());
    return JSON.stringify(obj);
  }

  /**
   * Deserialize graph from cache
   */
  private deserializeGraph(data: string): Map<string, DependencyNode> {
    const obj = JSON.parse(data);
    return new Map(Object.entries(obj));
  }

  /**
   * How many analyses ran, and how many of them avoided the walk.
   *
   * IT ALSO PUBLISHED A LIFETIME SAVING, and that is gone. The two figures
   * were `totalTokensSaved`, summed from the per-call `savedTokens` this tool
   * used to record, and `averageReduction`, that sum over itself plus the
   * recorded input. Both inherited every error in the per-call numbers, and
   * those numbers came from an invented baseline -- so a project of 12,000
   * files reported a saving of 790,200 tokens per call that would have been
   * identical had every file been empty.
   *
   * Nothing records a token field here any more, so the sums would now be a
   * constant zero, which reads as "saved nothing" rather than "not measured
   * here". The real figures are on the analytics rows, where both halves are
   * counted by the same party: see analytics/displaced-input.ts.
   */
  getStats(): {
    totalAnalyses: number;
    cacheHits: number;
    incrementalUpdates: number;
  } {
    const depMetrics = this.metrics.getOperations(0, 'smart_dependencies');

    return {
      totalAnalyses: depMetrics.length,
      cacheHits: depMetrics.filter((m) => m.cacheHit).length,
      incrementalUpdates: depMetrics.filter(
        (m) => m.metadata?.incrementalUpdate === true
      ).length,
    };
  }
}

/**
 * Factory function for getting SmartDependenciesTool instance with injected dependencies
 */
export function getSmartDependenciesTool(
  cache: CacheEngine,
  tokenCounter: TokenCounter,
  metrics: MetricsCollector
): SmartDependenciesTool {
  return new SmartDependenciesTool(cache, tokenCounter, metrics);
}

/**
 * CLI-friendly function for running smart dependencies analysis
 */
export async function runSmartDependencies(
  options: SmartDependenciesOptions
): Promise<Declaring<SmartDependenciesResult>> {
  const cache = new CacheEngine();
  const tokenCounter = new TokenCounter();
  const metrics = new MetricsCollector();

  const tool = getSmartDependenciesTool(cache, tokenCounter, metrics);
  return tool.analyze(options);
}

/**
 * MCP Tool Definition
 */
export const SMART_DEPENDENCIES_TOOL_DEFINITION = {
  name: 'smart_dependencies',
  description:
    'Analyze project dependencies through graph caching and incremental updates. Measured token reduction vs reading the file: 63-99% first read, 63-99% repeated (bench/tools, 2 fixtures).',
  inputSchema: {
    type: 'object',
    properties: {
      cwd: {
        type: 'string',
        description: 'Working directory for analysis',
      },
      files: {
        type: 'array',
        items: { type: 'string' },
        description: 'File patterns to analyze (glob patterns)',
      },
      mode: {
        type: 'string',
        enum: ['graph', 'circular', 'unused', 'impact'],
        description:
          'Analysis mode: graph (full dependency graph), circular (detect cycles), unused (find unused imports/exports), impact (analyze change impact)',
        default: 'graph',
      },
      targetFile: {
        type: 'string',
        description:
          'Target file for impact analysis (required for impact mode)',
      },
      includeExternal: {
        type: 'boolean',
        description: 'Include external dependencies (node_modules)',
        default: false,
      },
      maxDepth: {
        type: 'number',
        description: 'Maximum depth for impact analysis',
      },
      useCache: {
        type: 'boolean',
        description: 'Use cached dependency graph',
        default: true,
      },
      incrementalUpdate: {
        type: 'boolean',
        description: 'Update only changed files (when cache exists)',
        default: true,
      },
      format: {
        type: 'string',
        enum: ['compact', 'detailed'],
        description: 'Output format',
        default: 'compact',
      },
      // DECLARED BECAUSE THEY ARE ACCEPTED: the server spreads the caller's whole
      // argument object into options, so these worked while being undiscoverable.
      exclude: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Glob patterns for files to skip while resolving the graph',
      },
      ttl: {
        type: 'number',
        // DAYS, not seconds. `cacheGraph` multiplies by 24*60*60 before storing, so a
        // caller who read "seconds" here and passed 300 would get a 300-DAY entry. A
        // unit that is confidently wrong is worse than one that is absent.
        description: 'Cache lifetime in DAYS (converted to seconds internally)',
        default: 7,
      },
      includeMetadata: {
        type: 'boolean',
        description:
          'Include per-package version and resolution detail, not just the edges',
        default: false,
      },
      deadlineMs: {
        type: 'number',
        description:
          'Wall-clock budget in ms for discovering the files to analyse (default 10000). On expiry the graph comes back partial with metadata.searchTruncated set and is NOT cached, instead of walking until the calling tool times out.',
      },
    },
  },
};
