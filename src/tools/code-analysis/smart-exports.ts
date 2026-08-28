/**
 * Smart Exports Tool
 *
 * Analyzes TypeScript/JavaScript export statements with intelligent caching.
 * Provides export tracking, unused export detection, and optimization suggestions.
 *
 * Token Reduction: 75-85% through summarization of export analysis
 */

import * as ts from 'typescript';
import { createHash } from 'crypto';
import { join, relative, dirname } from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync } from 'fs';
import { CacheEngine } from '../../core/cache-engine.js';
import { MetricsCollector } from '../../core/metrics.js';
import { TokenCounter } from '../../core/token-counter.js';
import {
  boundedWalk,
  traversalDeadlineMs,
  type TruncationReason,
} from '../shared/bounded-traversal.js';

/**
 * Export statement information
 */
export interface ExportInfo {
  /** Type of export: named, default, namespace, reexport */
  type: 'named' | 'default' | 'namespace' | 'reexport';
  /** Name of the exported symbol */
  name: string;
  /** Original name if aliased */
  originalName?: string;
  /** Module being re-exported from (for re-exports) */
  fromModule?: string;
  /** Location in source file */
  location: {
    line: number;
    column: number;
  };
  /** Symbol kind (variable, function, class, etc.) */
  kind?: string;
  /** Whether export is used (imported elsewhere) */
  used?: boolean;
  /** TypeScript type information */
  typeInfo?: string;
}

/**
 * Export optimization suggestion
 */
export interface ExportOptimization {
  /** Type of optimization */
  type:
    | 'remove-unused'
    | 'consolidate-exports'
    | 'barrel-file'
    | 'export-organization';
  /** Severity level */
  severity: 'info' | 'warning' | 'error';
  /** Human-readable message */
  message: string;
  /** Specific suggestion */
  suggestion: string;
  /** Location in source file */
  location?: {
    line: number;
    column: number;
  };
  /** Code example */
  codeExample?: {
    before: string;
    after: string;
  };
  /** Impact analysis */
  impact?: {
    readability?: 'low' | 'medium' | 'high';
    maintainability?: 'low' | 'medium' | 'high';
    treeShaking?: 'low' | 'medium' | 'high';
  };
}

/**
 * Export dependency information
 */
export interface ExportDependency {
  /** File that imports this export */
  importingFile: string;
  /** Exported symbol being imported */
  symbol: string;
  /** How it's imported (named, default, namespace) */
  importType: 'named' | 'default' | 'namespace';
}

/**
 * Smart exports analysis result
 */
export interface SmartExportsResult {
  /** All exports found */
  exports: ExportInfo[];
  /** Unused exports detected */
  unusedExports: ExportInfo[];
  /** Export dependencies (what imports these exports) */
  dependencies: ExportDependency[];
  /** Optimization suggestions */
  optimizations: ExportOptimization[];
  /** Summary statistics */
  summary: {
    totalExports: number;
    namedExports: number;
    defaultExports: number;
    reexports: number;
    unusedCount: number;
    dependencyCount: number;
    /**
     * Set when a bound stopped the usage scan, so `unusedExports` is a list of
     * exports whose importers were not FOUND, which is not the same as exports
     * that have none. Acting on the first as if it were the second deletes
     * live code. Absent means the scan completed.
     */
    searchTruncated?: boolean;
    searchTruncatedBy?: TruncationReason;
    searchNote?: string;
  };
  /** Cache metadata */
  cached: boolean;
  cacheAge?: number;
}

/**
 * Options for smart exports analysis
 */
export interface SmartExportsOptions {
  /** File path to analyze */
  filePath?: string;
  /** File content (if not reading from disk) */
  fileContent?: string;
  /** Project root directory */
  projectRoot?: string;
  /** Force analysis even if cached */
  force?: boolean;
  /** Maximum cache age in seconds */
  maxCacheAge?: number;
  /** Check usage across project */
  checkUsage?: boolean;
  /** Scan depth for checking usage (number of directories) */
  scanDepth?: number;

  /**
   * Wall-clock budget in ms for the usage scan.
   *
   * `scanDepth` bounds how DEEP the walk goes but not how WIDE, so a shallow
   * scan of a broad monorepo was still unbounded -- and it ran `statSync` per
   * entry on the event loop. Defaults to 10 s.
   */
  deadlineMs?: number;
}

/**
 * Smart Exports Tool
 * Analyzes export statements with caching
 */
export class SmartExportsTool {
  private cache: CacheEngine;
  private metrics: MetricsCollector;
  private tokenCounter: TokenCounter;
  private cacheNamespace = 'smart_exports';
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
   * Run smart exports analysis
   */
  async run(options: SmartExportsOptions = {}): Promise<SmartExportsResult> {
    const startTime = Date.now();
    const {
      filePath,
      fileContent,
      projectRoot = this.projectRoot,
      force = false,
      maxCacheAge = 300,
      checkUsage = false,
      scanDepth = 3,
    } = options;
    const deadlineMs = traversalDeadlineMs(options.deadlineMs);

    // Get file content
    let content: string;
    let fileName: string;

    if (fileContent) {
      content = fileContent;
      fileName = 'inline.ts';
    } else if (filePath) {
      if (!existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
      }
      content = readFileSync(filePath, 'utf-8');
      fileName = filePath;
    } else {
      throw new Error('Either filePath or fileContent must be provided');
    }

    // Generate cache key
    const cacheKey = await this.generateCacheKey(content, {
      checkUsage,
      scanDepth,
      projectRoot,
    });

    // Check cache
    if (!force) {
      const cached = this.getCachedResult(cacheKey, maxCacheAge);
      if (cached) {
        const duration = Date.now() - startTime;
        this.metrics.record({
          operation: 'smart_exports',
          duration,
          cacheHit: true,
          savedTokens: cached.originalTokens || 0,
          success: true,
        });
        return {
          ...cached.result,
          cached: true,
          cacheAge: Date.now() - cached.timestamp,
        };
      }
    }

    // Parse file
    const sourceFile = ts.createSourceFile(
      fileName,
      content,
      ts.ScriptTarget.Latest,
      true
    );

    // Analyze exports
    const exports = this.extractExports(sourceFile);
    const usage =
      checkUsage && filePath
        ? await this.findExportDependencies(
            filePath,
            exports,
            projectRoot,
            scanDepth,
            deadlineMs
          )
        : { dependencies: [], truncatedBy: undefined };
    const dependencies = usage.dependencies;
    const unusedExports = checkUsage
      ? this.detectUnusedExports(exports, dependencies)
      : [];
    const optimizations = this.generateOptimizations(exports);

    // Build result
    const result: SmartExportsResult = {
      exports,
      unusedExports,
      dependencies,
      optimizations,
      summary: {
        totalExports: exports.length,
        namedExports: exports.filter((e) => e.type === 'named').length,
        defaultExports: exports.filter((e) => e.type === 'default').length,
        reexports: exports.filter((e) => e.type === 'reexport').length,
        unusedCount: unusedExports.length,
        dependencyCount: dependencies.length,
        ...(usage.truncatedBy
          ? {
              searchTruncated: true,
              searchTruncatedBy: usage.truncatedBy,
              searchNote:
                'The usage scan stopped at the ' +
                deadlineMs +
                'ms traversal deadline, so `unusedExports` lists exports whose importers were NOT FOUND rather than exports that have none -- do not delete on this result. Lower `scanDepth`, or raise TOKEN_OPTIMIZER_TRAVERSAL_DEADLINE_MS.',
            }
          : {}),
      },
      cached: false,
    };

    // Calculate token metrics
    const fullOutput = JSON.stringify(result, null, 2);
    const compactOutput = this.compactResult(result);
    const originalTokens = this.tokenCounter.count(fullOutput).tokens;
    const compactedTokens = this.tokenCounter.count(compactOutput).tokens;

    // A PARTIAL USAGE SCAN IS NEVER CACHED. The key is derived from the file's
    // content and the scan settings, NOT from which files were reached, so a
    // truncated "nothing imports this" would be replayed for the whole cache
    // window -- and it is the exact answer someone acts on by deleting code.
    if (!usage.truncatedBy) {
      this.cacheResult(cacheKey, result, originalTokens, compactedTokens);
    }

    // Record metrics
    const duration = Date.now() - startTime;
    this.metrics.record({
      operation: 'smart_exports',
      duration,
      cacheHit: false,
      inputTokens: originalTokens,
      cachedTokens: compactedTokens,
      savedTokens: originalTokens - compactedTokens,
      success: true,
    });

    return result;
  }

  /**
   * Extract export statements from source file
   */
  private extractExports(sourceFile: ts.SourceFile): ExportInfo[] {
    const exports: ExportInfo[] = [];

    const visit = (node: ts.Node) => {
      // Export declarations (export const, export function, etc.)
      if (ts.isExportAssignment(node)) {
        // export = something (CommonJS style)
        const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        exports.push({
          type: 'default',
          name: 'default',
          location: {
            line: pos.line + 1,
            column: pos.character,
          },
          kind: 'expression',
        });
      }

      // Export named declarations
      if (
        ts.isVariableStatement(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node)
      ) {
        const hasExport = node.modifiers?.some(
          (m) => m.kind === ts.SyntaxKind.ExportKeyword
        );

        if (hasExport) {
          const isDefault = node.modifiers?.some(
            (m) => m.kind === ts.SyntaxKind.DefaultKeyword
          );

          let name: string | undefined;
          let kind: string | undefined;

          if (ts.isVariableStatement(node)) {
            kind = 'variable';
            node.declarationList.declarations.forEach((decl) => {
              if (ts.isIdentifier(decl.name)) {
                name = decl.name.text;
                const pos = sourceFile.getLineAndCharacterOfPosition(
                  node.getStart()
                );
                exports.push({
                  type: isDefault ? 'default' : 'named',
                  name,
                  location: {
                    line: pos.line + 1,
                    column: pos.character,
                  },
                  kind,
                });
              }
            });
            return;
          } else if (ts.isFunctionDeclaration(node)) {
            kind = 'function';
            name = node.name?.text;
          } else if (ts.isClassDeclaration(node)) {
            kind = 'class';
            name = node.name?.text;
          } else if (ts.isInterfaceDeclaration(node)) {
            kind = 'interface';
            name = node.name?.text;
          } else if (ts.isTypeAliasDeclaration(node)) {
            kind = 'type';
            name = node.name?.text;
          } else if (ts.isEnumDeclaration(node)) {
            kind = 'enum';
            name = node.name?.text;
          }

          if (name) {
            const pos = sourceFile.getLineAndCharacterOfPosition(
              node.getStart()
            );
            exports.push({
              type: isDefault ? 'default' : 'named',
              name,
              location: {
                line: pos.line + 1,
                column: pos.character,
              },
              kind,
            });
          }
        }
      }

      // Export { ... } statements
      if (ts.isExportDeclaration(node)) {
        const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());

        // export * from 'module'
        if (!node.exportClause) {
          const moduleSpecifier = node.moduleSpecifier;
          if (moduleSpecifier && ts.isStringLiteral(moduleSpecifier)) {
            exports.push({
              type: 'namespace',
              name: '*',
              fromModule: moduleSpecifier.text,
              location: {
                line: pos.line + 1,
                column: pos.character,
              },
              kind: 'reexport',
            });
          }
          return;
        }

        // export { a, b as c } from 'module'
        if (ts.isNamedExports(node.exportClause)) {
          const moduleSpecifier = node.moduleSpecifier;
          const fromModule =
            moduleSpecifier && ts.isStringLiteral(moduleSpecifier)
              ? moduleSpecifier.text
              : undefined;

          node.exportClause.elements.forEach((element) => {
            const name = element.name.text;
            const originalName = element.propertyName?.text;

            exports.push({
              type: fromModule ? 'reexport' : 'named',
              name,
              originalName,
              fromModule,
              location: {
                line: pos.line + 1,
                column: pos.character,
              },
              kind: fromModule ? 'reexport' : 'named',
            });
          });
        }

        // export * as name from 'module'
        if (ts.isNamespaceExport(node.exportClause)) {
          const moduleSpecifier = node.moduleSpecifier;
          if (moduleSpecifier && ts.isStringLiteral(moduleSpecifier)) {
            exports.push({
              type: 'namespace',
              name: node.exportClause.name.text,
              fromModule: moduleSpecifier.text,
              location: {
                line: pos.line + 1,
                column: pos.character,
              },
              kind: 'reexport',
            });
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return exports;
  }

  /**
   * Find files that import these exports
   */
  private async findExportDependencies(
    filePath: string,
    exports: ExportInfo[],
    projectRoot: string,
    scanDepth: number,
    deadlineMs: number
  ): Promise<{
    dependencies: ExportDependency[];
    truncatedBy?: TruncationReason;
  }> {
    const dependencies: ExportDependency[] = [];

    // Scan project files
    const scan = await this.scanProjectFiles(
      projectRoot,
      scanDepth,
      deadlineMs
    );
    const filesToScan = scan.files;

    for (const file of filesToScan) {
      if (file === filePath) continue;

      try {
        const content = readFileSync(file, 'utf-8');
        const sourceFile = ts.createSourceFile(
          file,
          content,
          ts.ScriptTarget.Latest,
          true
        );

        // Find imports from our file
        const imports = this.extractImportsFromFile(sourceFile, filePath);

        for (const imp of imports) {
          // Check if imported symbol matches our exports
          for (const exportInfo of exports) {
            if (imp.symbols.includes(exportInfo.name)) {
              dependencies.push({
                importingFile: file,
                symbol: exportInfo.name,
                importType: imp.type,
              });
            }
          }
        }
      } catch {
        // Skip files that can't be parsed
      }
    }

    return { dependencies, truncatedBy: scan.truncatedBy };
  }

  /**
   * Scan project files up to specified depth
   */
  private async scanProjectFiles(
    dir: string,
    depth: number,
    deadlineMs: number
  ): Promise<{ files: string[]; truncatedBy?: TruncationReason }> {
    // The old walk called `statSync` on every entry to decide file-vs-directory
    // -- one blocking syscall per entry, on the event loop, on top of the
    // recursion. `withFileTypes` answers the same question from the directory
    // read that already happened, and also stops a Windows junction (which
    // stats as a directory but is not one) from turning the walk into a loop.
    const skipped = (name: string): boolean =>
      name === 'node_modules' || name === '.git' || name.startsWith('.');

    // DEPTH IS PRESERVED EXACTLY, not approximated. The recursive version
    // listed `dir` at currentDepth 0 and refused to recurse once currentDepth
    // reached `depth`, so a directory whose path is `depth` segments below the
    // root was never opened. `relative` counts those segments.
    const tooDeep = (fullPath: string): boolean =>
      relative(dir, fullPath).split(/[\\/]/).length >= depth;

    const walk = await boundedWalk(dir, {
      prune: (name, fullPath) => skipped(name) || tooDeep(fullPath),
      accept: (_fullPath, fileName) =>
        !skipped(fileName) && /\.(ts|tsx|js|jsx)$/.test(fileName),
      // NO CAP. Usage is proved by FINDING an importer, so a short walk turns
      // "I did not look everywhere" into "nothing uses this, delete it".
      deadlineMs,
    });

    return { files: walk.items, truncatedBy: walk.truncatedBy };
  }

  /**
   * Extract imports from a file that might import from our target file
   */
  private extractImportsFromFile(
    sourceFile: ts.SourceFile,
    targetFilePath: string
  ): Array<{ type: 'named' | 'default' | 'namespace'; symbols: string[] }> {
    const imports: Array<{
      type: 'named' | 'default' | 'namespace';
      symbols: string[];
    }> = [];

    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node)) {
        const moduleSpecifier = node.moduleSpecifier;
        if (!ts.isStringLiteral(moduleSpecifier)) {
          ts.forEachChild(node, visit);
          return;
        }

        const importPath = moduleSpecifier.text;

        // Check if this import is from our target file
        const resolved = this.resolveImportPath(
          sourceFile.fileName,
          importPath,
          targetFilePath
        );

        if (resolved) {
          const importClause = node.importClause;
          if (importClause) {
            const symbols: string[] = [];
            let type: 'named' | 'default' | 'namespace' = 'named';

            // Default import
            if (importClause.name) {
              symbols.push(importClause.name.text);
              type = 'default';
            }

            // Named imports
            if (importClause.namedBindings) {
              if (ts.isNamespaceImport(importClause.namedBindings)) {
                symbols.push(importClause.namedBindings.name.text);
                type = 'namespace';
              } else if (ts.isNamedImports(importClause.namedBindings)) {
                importClause.namedBindings.elements.forEach((element) => {
                  symbols.push(element.propertyName?.text || element.name.text);
                });
                type = 'named';
              }
            }

            if (symbols.length > 0) {
              imports.push({ type, symbols });
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return imports;
  }

  /**
   * Resolve import path to check if it matches target file
   */
  private resolveImportPath(
    importingFile: string,
    importPath: string,
    targetFilePath: string
  ): boolean {
    // Handle relative imports
    if (!importPath.startsWith('.')) return false;

    // `dirname`, not a hand-rolled `lastIndexOf`. The previous version read
    // `lastIndexOf('/') || lastIndexOf('\\')`, and `||` yields the FIRST
    // truthy operand -- which for a path containing no forward slash is the
    // -1 the failed search returned, and `substring(0, -1)` clamps to ''.
    //
    // MEASURED, NOT ASSUMED: that is LATENT here, not live. `importingFile` is
    // `sourceFile.fileName`, and TypeScript normalises it to forward slashes --
    // `C:/Users/.../src/uses.ts` even on Windows, while the target path passed
    // in alongside it keeps its backslashes. So the '/' search always finds a
    // real index and the fallback never runs. It would bite the moment this is
    // called with a path that did not come through TypeScript.
    //
    // Fixed anyway, because the expression is wrong on its own terms -- but no
    // test here can observe the difference, and a mutation reverting this line
    // survives. That is the honest result, recorded rather than papered over.
    const importingDir = dirname(importingFile);

    // A NodeNext specifier names the EMITTED file: `./helper.js` is how you
    // import `helper.ts`, and it is the style this repository itself uses
    // throughout. Candidate extensions were appended to the specifier AS
    // WRITTEN, so such an import was only ever tried as `helper.js`,
    // `helper.js.ts`, `helper.js.tsx` ... and never as `helper.ts`. Every one
    // of them failed to resolve, so every export reached only through one came
    // back in `unusedExports` -- which is the single output of this tool that
    // someone acts on by deleting live code.
    const specifiers = [importPath];
    const emitted = /\.(js|jsx|mjs|cjs)$/.exec(importPath);
    if (emitted) specifiers.push(importPath.slice(0, -emitted[0].length));

    const extensions = [
      '',
      '.ts',
      '.tsx',
      '.js',
      '.jsx',
      '/index.ts',
      '/index.tsx',
      '/index.js',
      '/index.jsx',
    ];

    // Compared with one separator spelling on both sides. `join` produces
    // backslashes on Windows while the `/index.*` candidates carry a forward
    // slash, so a raw string comparison misses on exactly the platform this
    // runs on.
    const normalised = (path: string): string => path.replace(/\\/g, '/');
    const target = normalised(targetFilePath);

    for (const specifier of specifiers) {
      const resolved = join(importingDir, specifier);
      for (const ext of extensions) {
        if (normalised(resolved + ext) === target) return true;
      }
    }

    return false;
  }

  /**
   * Detect unused exports
   */
  private detectUnusedExports(
    exports: ExportInfo[],
    dependencies: ExportDependency[]
  ): ExportInfo[] {
    const unused: ExportInfo[] = [];
    const usedSymbols = new Set(dependencies.map((d) => d.symbol));

    for (const exp of exports) {
      if (!usedSymbols.has(exp.name) && exp.name !== 'default') {
        exp.used = false;
        unused.push(exp);
      } else {
        exp.used = true;
      }
    }

    return unused;
  }

  /**
   * Generate optimization suggestions
   */
  private generateOptimizations(exports: ExportInfo[]): ExportOptimization[] {
    const optimizations: ExportOptimization[] = [];

    // Suggest barrel file for many exports
    if (exports.length > 10) {
      const namedExports = exports.filter((e) => e.type === 'named');
      if (namedExports.length > 7) {
        optimizations.push({
          type: 'barrel-file',
          severity: 'info',
          message: `File has ${namedExports.length} named exports. Consider using a barrel file (index.ts) to organize exports.`,
          suggestion:
            'Create an index.ts file that re-exports public API, keeping implementation details private.',
          codeExample: {
            before:
              'export const a = ...\nexport const b = ...\nexport const c = ...',
            after:
              "// In module.ts:\nconst a = ...\nconst b = ...\nexport { a, b };\n\n// In index.ts:\nexport { a, b } from './module.js';",
          },
          impact: {
            readability: 'high',
            maintainability: 'high',
            treeShaking: 'medium',
          },
        });
      }
    }

    // Check for mixed export styles
    const hasDefault = exports.some((e) => e.type === 'default');
    const hasNamed = exports.some((e) => e.type === 'named');

    if (hasDefault && hasNamed) {
      optimizations.push({
        type: 'export-organization',
        severity: 'info',
        message:
          'File uses both default and named exports. Consider using consistent export style.',
        suggestion:
          'Prefer named exports for better tree-shaking and explicit imports. Use default exports sparingly for main module exports.',
        impact: {
          readability: 'medium',
          treeShaking: 'medium',
        },
      });
    }

    // Consolidate scattered exports
    const exportLocations = exports.map((e) => e.location.line);
    const spread = Math.max(...exportLocations) - Math.min(...exportLocations);

    if (spread > 50 && exports.length > 5) {
      optimizations.push({
        type: 'consolidate-exports',
        severity: 'info',
        message:
          'Exports are scattered across file. Consider consolidating exports at the end.',
        suggestion:
          'Move all export statements to the bottom of the file for better visibility.',
        codeExample: {
          before:
            '// Scattered throughout file\nexport const a = ...\n// ... 50 lines ...\nexport const b = ...',
          after:
            '// At bottom of file\nconst a = ...;\nconst b = ...;\n\nexport { a, b };',
        },
        impact: {
          readability: 'high',
          maintainability: 'medium',
        },
      });
    }

    return optimizations;
  }

  /**
   * Generate cache key
   */
  private async generateCacheKey(
    content: string,
    options: {
      checkUsage?: boolean;
      scanDepth?: number;
      projectRoot?: string;
    }
  ): Promise<string> {
    const hash = createHash('sha256');
    hash.update(this.cacheNamespace);
    hash.update(content);
    hash.update(JSON.stringify(options));
    return `${this.cacheNamespace}:${hash.digest('hex')}`;
  }

  /**
   * Get cached result
   */
  private getCachedResult(
    cacheKey: string,
    maxAge: number
  ): {
    result: SmartExportsResult;
    timestamp: number;
    originalTokens?: number;
  } | null {
    const cached = this.cache.get(cacheKey);
    if (!cached) return null;

    const data = JSON.parse(cached) as {
      result: SmartExportsResult;
      timestamp: number;
      originalTokens?: number;
    };

    const age = (Date.now() - data.timestamp) / 1000;
    if (age <= maxAge) {
      return data;
    }

    return null;
  }

  /**
   * Cache result
   */
  private cacheResult(
    cacheKey: string,
    result: SmartExportsResult,
    originalTokens?: number,
    compactedTokens?: number
  ): void {
    const toCache = {
      result,
      timestamp: Date.now(),
      originalTokens,
      compactedTokens,
    };
    const buffer = JSON.stringify(toCache);
    const tokensSaved =
      originalTokens && compactedTokens ? originalTokens - compactedTokens : 0;
    this.cache.set(cacheKey, buffer, 300, tokensSaved);
  }

  /**
   * Compact result for token efficiency
   */
  private compactResult(result: SmartExportsResult): string {
    const compact = {
      exp: result.exports.map((e) => ({
        t: e.type[0], // First letter: n/d/r
        n: e.name,
        k: e.kind,
        l: e.location.line,
        u: e.used,
      })),
      unu: result.unusedExports.map((e) => ({
        n: e.name,
        k: e.kind,
      })),
      dep: result.dependencies.map((d) => ({
        f: d.importingFile.split('/').pop(), // Just filename
        s: d.symbol,
      })),
      opt: result.optimizations.map((o) => ({
        t: o.type,
        m: o.message,
      })),
      sum: result.summary,
    };

    return JSON.stringify(compact);
  }
}

/**
 * Factory function for dependency injection
 */
export function getSmartExportsTool(
  cache: CacheEngine,
  tokenCounter: TokenCounter,
  metrics: MetricsCollector,
  projectRoot?: string
): SmartExportsTool {
  return new SmartExportsTool(cache, tokenCounter, metrics, projectRoot);
}

/**
 * Standalone function for CLI usage
 */
export async function runSmartExports(
  options: SmartExportsOptions
): Promise<SmartExportsResult> {
  const cache = new CacheEngine(join(homedir(), '.hypercontext', 'cache'));
  const tokenCounter = new TokenCounter();
  const metrics = new MetricsCollector();
  const tool = getSmartExportsTool(
    cache,
    tokenCounter,
    metrics,
    options.projectRoot
  );
  return tool.run(options);
}

/**
 * MCP Tool Definition
 */
export const SMART_EXPORTS_TOOL_DEFINITION = {
  name: 'smart_exports',
  description:
    'Analyze TypeScript/JavaScript export statements with intelligent caching. Tracks exports, detects unused exports, and provides optimization suggestions. Achieves 75-85% token reduction through export analysis summarization.',
  inputSchema: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'Path to the TypeScript/JavaScript file to analyze',
      },
      fileContent: {
        type: 'string',
        description: 'File content (alternative to filePath)',
      },
      projectRoot: {
        type: 'string',
        description:
          'Project root directory (default: current working directory)',
      },
      force: {
        type: 'boolean',
        description:
          'Force analysis even if cached result exists (default: false)',
        default: false,
      },
      maxCacheAge: {
        type: 'number',
        description: 'Maximum cache age in seconds (default: 300)',
        default: 300,
      },
      checkUsage: {
        type: 'boolean',
        description:
          'Check if exports are used across project (default: false)',
        default: false,
      },
      scanDepth: {
        type: 'number',
        description: 'Directory depth to scan when checking usage (default: 3)',
        default: 3,
      },
      deadlineMs: {
        type: 'number',
        description:
          'Wall-clock budget in ms for the usage scan (default 10000). On expiry the result comes back with summary.searchTruncated set and is NOT cached, instead of walking until the calling tool times out.',
      },
    },
  },
};
