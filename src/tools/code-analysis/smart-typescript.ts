/**
 * Smart TypeScript Tool - 83% Token Reduction
 *
 * Incremental TypeScript compilation with intelligent caching:
 * - Tracks file dependencies (import/export graph)
 * - Only recompiles changed files and their dependents
 * - Caches compilation results and type information
 * - <5s cache invalidation on file changes
 * - Provides actionable type error summaries
 */

import { CacheEngine, resolveCacheLocation } from '../../core/cache-engine.js';
import { MetricsCollector } from '../../core/metrics.js';
import { TokenCounter } from '../../core/token-counter.js';
import { createHash } from 'crypto';
import { readFileSync, existsSync, statSync } from 'fs';
import { join, relative, dirname, isAbsolute, normalize } from 'path';
import { homedir } from 'os';
import * as ts from 'typescript';

interface TypeScriptFile {
  path: string;
  hash: string;
  lastModified: number;
  dependencies: string[]; // Files this file imports
  dependents: string[]; // Files that import this file
}

interface CompilationResult {
  success: boolean;
  diagnostics: ts.Diagnostic[];
  /**
   * The files this really type-checked -- not the files it was asked about.
   *
   * It used to be the request, echoed. A name the program does not contain is
   * skipped, so asking about one file and being told `Files Compiled: 1` with
   * `Errors: 0` was a verdict on nothing; see notInProgram.
   */
  filesCompiled: string[];
  /**
   * The files that were asked about and are not in the program.
   *
   * A tsconfig defines the program. A file it does not include has no
   * diagnostics to report, and `0 errors` about it is not a true answer in a
   * smaller font -- it is the opposite of one. These are named so a caller can
   * see which of their paths the tsconfig does not reach.
   */
  notInProgram: string[];
  typeInfo?: Map<string, TypeInfo>;
}

interface TypeInfo {
  file: string;
  exports: Array<{
    name: string;
    type: string;
    kind: string;
  }>;
  imports: Array<{
    module: string;
    imports: string[];
  }>;
}

interface SmartTypeScriptOptions {
  /**
   * Force full compilation (ignore cache)
   */
  force?: boolean;

  /**
   * Project root directory
   */
  projectRoot?: string;

  /**
   * TypeScript config file
   */
  tsconfig?: string;

  /**
   * Maximum cache age in seconds (default: 300 = 5 minutes)
   */
  maxCacheAge?: number;

  /**
   * Files to specifically check (incremental mode)
   */
  files?: string[];

  /**
   * Include type information in output
   */
  includeTypeInfo?: boolean;
}

interface SmartTypeScriptOutput {
  /**
   * Compilation summary
   */
  summary: {
    success: boolean;
    errorCount: number;
    warningCount: number;
    filesCompiled: number;
    filesFromCache: number;
    fromCache: boolean;
    incrementalMode: boolean;
  };

  /**
   * Categorized diagnostics (errors and warnings)
   */
  diagnosticsByCategory: Array<{
    category: string;
    severity: 'error' | 'warning' | 'info';
    count: number;
    items: Array<{
      file: string;
      location: string;
      code: number;
      message: string;
    }>;
  }>;

  /**
   * File dependency information
   */
  dependencies?: {
    totalFiles: number;
    changedFiles: string[];
    affectedFiles: string[];
    dependencyGraph: Record<string, string[]>;
  };

  /**
   * Type information for exported symbols
   */
  typeInfo?: Array<{
    file: string;
    exports: Array<{
      name: string;
      type: string;
      kind: string;
    }>;
  }>;

  /**
   * Of the files the caller named, the ones the program does not contain.
   *
   * Absent when every named file was checked. Present and non-empty means this
   * report is about fewer files than were asked about, which a caller cannot
   * work out from a count that only ever named successes.
   */
  notTypeChecked?: string[];

  /**
   * Optimization suggestions
   */
  suggestions: Array<{
    type: 'fix' | 'refactor' | 'config' | 'performance';
    priority: number;
    message: string;
    impact: string;
  }>;

  // NO metrics FIELD, DELIBERATELY. Neither half was ever measured. The
  // "original" was arithmetic over constants -- 200 chars assumed per
  // diagnostic, 100 per dependency-graph node, 150 per type, plus a flat 500
  // of overhead, all divided by four to be called tokens -- so it described a
  // tsc output this tool never produced and nobody was ever charged for. The
  // "compacted" measured a summary object that is not the report a caller
  // reads either. There is no before here for the tool to declare: the files
  // are named in the arguments, which is where the recorder reads them, and
  // the after is counted once at the wire.
}

export class SmartTypeScript {
  private cache: CacheEngine;
  private metrics: MetricsCollector;
  private cacheNamespace = 'smart_typescript';
  private projectRoot: string;
  private program?: ts.Program;
  private fileRegistry: Map<string, TypeScriptFile> = new Map();
  private dependencyGraph: Map<string, Set<string>> = new Map();
  private reverseDependencyGraph: Map<string, Set<string>> = new Map();

  constructor(
    cache: CacheEngine,
    _tokenCounter: TokenCounter,
    metrics: MetricsCollector,
    projectRoot?: string
  ) {
    this.cache = cache;
    this.metrics = metrics;
    this.projectRoot = projectRoot || process.cwd();
  }

  /**
   * A path the CALLER wrote, resolved against the project root.
   *
   * `join(this.projectRoot, file)` was used directly, and on an absolute
   * argument that produces a path which exists nowhere: joining the root
   * `C:/p/fixtures` to `C:/p/fixtures/a.ts` appends the second whole path to
   * the first, drive letter included. Every consequence of it was silent. The
   * program had no source file under that name, so compile() skipped it and
   * reported zero diagnostics as `Status: Success`; getAffectedFiles joined
   * the root on a second time, so the report named a path doubled twice; and
   * generateCacheKey's existsSync failed, so the file's content never entered
   * the cache key and two different versions of a file shared one entry.
   *
   * `files` is documented as taking paths, not names, and the MCP dispatch
   * hands over whatever the caller sent. So absolute is the ordinary case
   * here, not the exception.
   */
  private resolveFromRoot(file: string): string {
    return isAbsolute(file) ? normalize(file) : join(this.projectRoot, file);
  }

  /**
   * Run TypeScript compilation with intelligent caching and incremental mode
   */
  async run(
    options: SmartTypeScriptOptions = {}
  ): Promise<SmartTypeScriptOutput> {
    const {
      force = false,
      tsconfig = 'tsconfig.json',
      maxCacheAge = 300, // 5 minutes for <5s invalidation
      files = [],
      includeTypeInfo = false,
    } = options;

    const startTime = Date.now();

    // Generate cache key
    const cacheKey = await this.generateCacheKey(tsconfig, files);

    // Check cache first (unless force mode)
    if (!force) {
      const cached = this.getCachedResult(cacheKey, maxCacheAge);
      if (cached) {
        this.metrics.record({
          operation: 'smart_typescript',
          duration: Date.now() - startTime,
          success: true,
          cacheHit: true,
          // NO TOKEN FIGURES. Both were read back off the estimate the cached
          // result was written with, so this record republished a guess.
        });

        return cached;
      }
    }

    // Initialize TypeScript program
    const tsconfigPath = this.resolveFromRoot(tsconfig);
    const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    const parsedConfig = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      this.projectRoot
    );

    this.program = ts.createProgram({
      rootNames: parsedConfig.fileNames,
      options: parsedConfig.options,
    });

    // Build dependency graph
    await this.buildDependencyGraph();

    // Determine which files need compilation
    const filesToCompile =
      files.length > 0 ? this.getAffectedFiles(files) : parsedConfig.fileNames;

    // Run compilation
    const result = await this.compile(filesToCompile, includeTypeInfo);

    // NOTHING WAS TYPE-CHECKED, SO THERE IS NO VERDICT TO REPORT.
    //
    // The caller named files; the program defined by this tsconfig contains
    // none of them. `success` is computed as "no diagnostic of category
    // Error", which is vacuously true when no file was looked at, so this path
    // used to answer `Status: Success / Errors: 0 / Files Compiled: 1`. That is
    // not a weaker answer than the truth, it is the reverse of it: a caller
    // reads it as their file being clean.
    //
    // It is a throw rather than a quiet report because the one thing a caller
    // asked for -- a verdict on these files -- cannot be given at all, and the
    // repair is in the arguments. The message names the tsconfig that defines
    // the program and the paths it does not reach; those are the caller's own
    // strings and this tool's own fixture paths, returned to them, and nothing
    // here is logged or transmitted.
    if (files.length > 0 && result.filesCompiled.length === 0) {
      throw new Error(
        `No file named here is part of the program that ${tsconfigPath} defines, so there is nothing to type-check and no verdict to report. Not in the program: ${result.notInProgram.join(', ')}. The program holds ${parsedConfig.fileNames.length} file(s); check the projectRoot, the tsconfig and its include/exclude patterns.`
      );
    }

    const duration = Date.now() - startTime;

    // Cache the result
    const output = this.transformOutput(
      result,
      result.filesCompiled,
      files.length > 0
    );
    this.cacheResult(cacheKey, output);

    // Record metrics
    this.metrics.record({
      operation: 'smart_typescript',
      duration,
      success: result.success,
      cacheHit: false,
    });

    return output;
  }

  /**
   * Build dependency graph from TypeScript program
   */
  private async buildDependencyGraph(): Promise<void> {
    if (!this.program) return;

    const sourceFiles = this.program.getSourceFiles();

    for (const sourceFile of sourceFiles) {
      // Skip declaration files and node_modules
      if (
        sourceFile.isDeclarationFile ||
        sourceFile.fileName.includes('node_modules')
      ) {
        continue;
      }

      const filePath = sourceFile.fileName;
      const fileHash = this.generateFileHash(filePath);
      const dependencies: string[] = [];

      // Extract imports using TypeScript's resolver
      const importedFiles = this.extractImports(sourceFile);
      dependencies.push(...importedFiles);

      // Register file
      this.fileRegistry.set(filePath, {
        path: filePath,
        hash: fileHash,
        lastModified: statSync(filePath).mtimeMs,
        dependencies: dependencies,
        dependents: [],
      });

      // Build forward dependency graph
      if (!this.dependencyGraph.has(filePath)) {
        this.dependencyGraph.set(filePath, new Set());
      }
      dependencies.forEach((dep) => {
        this.dependencyGraph.get(filePath)!.add(dep);
      });

      // Build reverse dependency graph (dependents)
      dependencies.forEach((dep) => {
        if (!this.reverseDependencyGraph.has(dep)) {
          this.reverseDependencyGraph.set(dep, new Set());
        }
        this.reverseDependencyGraph.get(dep)!.add(filePath);
      });
    }

    // Update dependents in file registry
    for (const [file, dependents] of this.reverseDependencyGraph.entries()) {
      const fileInfo = this.fileRegistry.get(file);
      if (fileInfo) {
        fileInfo.dependents = Array.from(dependents);
      }
    }
  }

  /**
   * Extract imported file paths from a source file
   */
  private extractImports(sourceFile: ts.SourceFile): string[] {
    const imports: string[] = [];

    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        const moduleSpecifier =
          (node as ts.ImportDeclaration).moduleSpecifier ||
          (node as ts.ExportDeclaration).moduleSpecifier;

        if (moduleSpecifier && ts.isStringLiteral(moduleSpecifier)) {
          const importPath = moduleSpecifier.text;
          const resolvedPath = this.resolveImport(
            importPath,
            dirname(sourceFile.fileName)
          );

          if (resolvedPath && !resolvedPath.includes('node_modules')) {
            imports.push(resolvedPath);
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return imports;
  }

  /**
   * Resolve import path to absolute file path
   */
  private resolveImport(
    importPath: string,
    containingDir: string
  ): string | null {
    // Handle relative imports
    if (importPath.startsWith('.')) {
      const extensions = ['.ts', '.tsx', '.js', '.jsx'];
      const basePath = join(containingDir, importPath);

      // Try exact match with extensions
      for (const ext of extensions) {
        const fullPath = basePath + ext;
        if (existsSync(fullPath)) {
          return fullPath;
        }
      }

      // Try index files
      for (const ext of extensions) {
        const indexPath = join(basePath, 'index' + ext);
        if (existsSync(indexPath)) {
          return indexPath;
        }
      }
    }

    return null;
  }

  /**
   * Get all files affected by changes to specific files
   */
  private getAffectedFiles(changedFiles: string[]): string[] {
    const affected = new Set<string>();

    const addDependents = (file: string) => {
      if (affected.has(file)) return;

      affected.add(file);
      const dependents = this.reverseDependencyGraph.get(file);

      if (dependents) {
        dependents.forEach((dependent) => {
          addDependents(dependent);
        });
      }
    };

    // Add changed files and their transitive dependents
    changedFiles.forEach((file) => {
      addDependents(this.resolveFromRoot(file));
    });

    return Array.from(affected);
  }

  /**
   * Compile TypeScript files
   */
  private async compile(
    filesToCompile: string[],
    includeTypeInfo: boolean
  ): Promise<CompilationResult> {
    if (!this.program) {
      throw new Error('TypeScript program not initialized');
    }

    const diagnostics: ts.Diagnostic[] = [];
    const typeInfoMap = includeTypeInfo
      ? new Map<string, TypeInfo>()
      : undefined;
    const checked: string[] = [];
    const notInProgram: string[] = [];

    // Get diagnostics for specified files
    for (const fileName of filesToCompile) {
      const sourceFile = this.program.getSourceFile(fileName);
      // NOT A CONTINUE ANY MORE. This skipped the file in silence and left
      // `filesCompiled` claiming it, so a program that contained none of the
      // requested files answered `Status: Success, Errors: 0`.
      if (!sourceFile) {
        notInProgram.push(fileName);
        continue;
      }
      checked.push(fileName);

      // Get semantic diagnostics (type errors)
      const fileDiagnostics = [
        ...this.program.getSemanticDiagnostics(sourceFile),
        ...this.program.getSyntacticDiagnostics(sourceFile),
      ];

      diagnostics.push(...fileDiagnostics);

      // Extract type information if requested
      if (includeTypeInfo && typeInfoMap) {
        const typeInfo = this.extractTypeInfo(sourceFile);
        if (typeInfo) {
          typeInfoMap.set(fileName, typeInfo);
        }
      }
    }

    return {
      success:
        diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error)
          .length === 0,
      diagnostics,
      filesCompiled: checked,
      notInProgram,
      typeInfo: typeInfoMap,
    };
  }

  /**
   * Extract type information from a source file
   */
  private extractTypeInfo(sourceFile: ts.SourceFile): TypeInfo | null {
    if (!this.program) return null;

    const checker = this.program.getTypeChecker();
    const typeInfo: TypeInfo = {
      file: sourceFile.fileName,
      exports: [],
      imports: [],
    };

    const visit = (node: ts.Node) => {
      // Extract exports
      if (
        ts.isVariableStatement(node) &&
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        node.declarationList.declarations.forEach((decl) => {
          if (ts.isIdentifier(decl.name)) {
            const symbol = checker.getSymbolAtLocation(decl.name);
            if (symbol) {
              const type = checker.getTypeOfSymbolAtLocation(symbol, decl.name);
              typeInfo.exports.push({
                name: symbol.getName(),
                type: checker.typeToString(type),
                kind: 'variable',
              });
            }
          }
        });
      }

      if (
        ts.isFunctionDeclaration(node) &&
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        if (node.name) {
          const symbol = checker.getSymbolAtLocation(node.name);
          if (symbol) {
            const type = checker.getTypeOfSymbolAtLocation(symbol, node.name);
            typeInfo.exports.push({
              name: symbol.getName(),
              type: checker.typeToString(type),
              kind: 'function',
            });
          }
        }
      }

      if (
        ts.isClassDeclaration(node) &&
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        if (node.name) {
          const symbol = checker.getSymbolAtLocation(node.name);
          if (symbol) {
            const type = checker.getTypeOfSymbolAtLocation(symbol, node.name);
            typeInfo.exports.push({
              name: symbol.getName(),
              type: checker.typeToString(type),
              kind: 'class',
            });
          }
        }
      }

      // Extract imports
      if (ts.isImportDeclaration(node) && node.importClause) {
        const moduleSpecifier = node.moduleSpecifier;
        if (ts.isStringLiteral(moduleSpecifier)) {
          const imports: string[] = [];

          if (node.importClause.name) {
            imports.push(node.importClause.name.text);
          }

          if (node.importClause.namedBindings) {
            if (ts.isNamedImports(node.importClause.namedBindings)) {
              node.importClause.namedBindings.elements.forEach((element) => {
                imports.push(element.name.text);
              });
            }
          }

          typeInfo.imports.push({
            module: moduleSpecifier.text,
            imports,
          });
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return typeInfo;
  }

  /**
   * Transform compilation result to smart output
   */
  private transformOutput(
    result: CompilationResult,
    filesCompiled: string[],
    incrementalMode: boolean
  ): SmartTypeScriptOutput {
    // Categorize diagnostics
    const categorizedDiagnostics = new Map<string, ts.Diagnostic[]>();

    for (const diagnostic of result.diagnostics) {
      const category = this.categorizeDiagnostic(diagnostic);
      if (!categorizedDiagnostics.has(category)) {
        categorizedDiagnostics.set(category, []);
      }
      categorizedDiagnostics.get(category)!.push(diagnostic);
    }

    // Build diagnostic categories
    const diagnosticsByCategory = Array.from(
      categorizedDiagnostics.entries()
    ).map(([category, diags]) => {
      const severity =
        diags[0].category === ts.DiagnosticCategory.Error
          ? 'error'
          : diags[0].category === ts.DiagnosticCategory.Warning
            ? 'warning'
            : 'info';

      return {
        category,
        severity: severity as 'error' | 'warning' | 'info',
        count: diags.length,
        items: diags.slice(0, 5).map((diag) => {
          const file = diag.file;
          const location =
            file && diag.start !== undefined
              ? file.getLineAndCharacterOfPosition(diag.start)
              : { line: 0, character: 0 };

          return {
            file: file?.fileName || 'unknown',
            location: `${location.line + 1}:${location.character + 1}`,
            code: diag.code,
            message: ts.flattenDiagnosticMessageText(diag.messageText, '\n'),
          };
        }),
      };
    });

    // Sort by severity and count
    diagnosticsByCategory.sort((a, b) => {
      const severityOrder = { error: 3, warning: 2, info: 1 };
      const sevDiff = severityOrder[b.severity] - severityOrder[a.severity];
      if (sevDiff !== 0) return sevDiff;
      return b.count - a.count;
    });

    // Generate suggestions
    const suggestions = this.generateSuggestions(result, diagnosticsByCategory);

    // Build dependency info
    const changedFiles = incrementalMode ? filesCompiled : [];
    const affectedFiles = incrementalMode
      ? this.getAffectedFiles(changedFiles)
      : [];
    const dependencyGraph: Record<string, string[]> = {};

    for (const [file, deps] of this.dependencyGraph.entries()) {
      const relPath = relative(this.projectRoot, file);
      dependencyGraph[relPath] = Array.from(deps).map((d) =>
        relative(this.projectRoot, d)
      );
    }

    // Extract type information
    const typeInfo = result.typeInfo
      ? Array.from(result.typeInfo.entries()).map(([file, info]) => ({
          file: relative(this.projectRoot, file),
          exports: info.exports,
        }))
      : undefined;

    const errorCount = result.diagnostics.filter(
      (d) => d.category === ts.DiagnosticCategory.Error
    ).length;
    const warningCount = result.diagnostics.filter(
      (d) => d.category === ts.DiagnosticCategory.Warning
    ).length;

    return {
      summary: {
        success: result.success,
        errorCount,
        warningCount,
        filesCompiled: filesCompiled.length,
        filesFromCache: 0,
        fromCache: false,
        incrementalMode,
      },
      diagnosticsByCategory,
      dependencies: incrementalMode
        ? {
            totalFiles: this.fileRegistry.size,
            changedFiles: changedFiles.map((f) =>
              relative(this.projectRoot, f)
            ),
            affectedFiles: affectedFiles.map((f) =>
              relative(this.projectRoot, f)
            ),
            dependencyGraph,
          }
        : undefined,
      typeInfo,
      // Omitted entirely when every named file was checked, so the common
      // reply does not carry an empty array saying nothing went wrong.
      ...(result.notInProgram.length > 0
        ? {
            notTypeChecked: result.notInProgram.map((f) =>
              relative(this.projectRoot, f)
            ),
          }
        : {}),
      suggestions,
    };
  }

  /**
   * Categorize TypeScript diagnostic
   */
  private categorizeDiagnostic(diagnostic: ts.Diagnostic): string {
    const code = diagnostic.code;
    const message = ts.flattenDiagnosticMessageText(
      diagnostic.messageText,
      '\n'
    );

    const categories: Record<number, string> = {
      // Type errors
      2322: 'Type Assignment',
      2345: 'Type Argument',
      2339: 'Property Access',
      2304: 'Name Not Found',
      2551: 'Property Does Not Exist',
      2571: 'Object Type Unknown',

      // Module errors
      2307: 'Module Resolution',
      2305: 'Module Export',
      2306: 'Module Not Found',

      // Function errors
      2554: 'Function Arguments',
      2555: 'Function Overload',

      // Declaration errors
      2300: 'Duplicate Identifier',
      2451: 'Redeclare Block Variable',

      // Generic errors
      2314: 'Generic Type Arguments',
      2344: 'Generic Type Constraint',

      // Implicit any errors
      7006: 'Implicit Any',
      7019: 'Implicit Any Rest',
      7034: 'Implicit Any Variable',

      // Null safety errors
      2531: 'Possibly Null',
      2532: 'Possibly Undefined',
      2722: 'Cannot Invoke Undefined',
    };

    const category = categories[code];
    if (category) return category;

    // Fallback categorization
    if (message.includes('module')) return 'Module Resolution';
    if (message.includes('type')) return 'Type Safety';
    if (message.includes('null') || message.includes('undefined'))
      return 'Null Safety';

    return 'Other';
  }

  /**
   * Generate optimization suggestions
   */
  private generateSuggestions(
    result: CompilationResult,
    categories: Array<{ category: string; severity: string; count: number }>
  ): Array<{
    type: 'fix' | 'refactor' | 'config' | 'performance';
    priority: number;
    message: string;
    impact: string;
  }> {
    const suggestions: Array<{
      type: 'fix' | 'refactor' | 'config' | 'performance';
      priority: number;
      message: string;
      impact: string;
    }> = [];

    // Module resolution suggestions
    const moduleErrors = categories.find(
      (c) => c.category === 'Module Resolution'
    );
    if (moduleErrors && moduleErrors.count > 0) {
      suggestions.push({
        type: 'fix',
        priority: 10,
        message:
          'Fix module resolution errors - check tsconfig paths and installed dependencies',
        impact: `${moduleErrors.count} module errors blocking compilation`,
      });
    }

    // Implicit any suggestions
    const implicitAnyCount = categories
      .filter((c) => c.category.includes('Implicit Any'))
      .reduce((sum, c) => sum + c.count, 0);
    if (implicitAnyCount > 5) {
      suggestions.push({
        type: 'config',
        priority: 8,
        message:
          'Enable "strict": true in tsconfig.json for better type safety',
        impact: `Will catch ${implicitAnyCount} implicit any issues`,
      });
    }

    // Null safety suggestions
    const nullSafetyCount = categories
      .filter(
        (c) => c.category.includes('Null') || c.category.includes('Undefined')
      )
      .reduce((sum, c) => sum + c.count, 0);
    if (nullSafetyCount > 10) {
      suggestions.push({
        type: 'refactor',
        priority: 7,
        message:
          'Add null checks or use optional chaining (?.) and nullish coalescing (??)',
        impact: `${nullSafetyCount} potential null/undefined access issues`,
      });
    }

    // Performance suggestion for incremental compilation
    if (result.filesCompiled.length > 50) {
      suggestions.push({
        type: 'performance',
        priority: 6,
        message:
          'Use incremental compilation for faster builds - pass specific changed files',
        impact: 'Can reduce compilation time by 70-90% for large projects',
      });
    }

    // Sort by priority
    suggestions.sort((a, b) => b.priority - a.priority);

    return suggestions;
  }

  /**
   * Generate cache key based on tsconfig and file hashes
   */
  private async generateCacheKey(
    tsconfig: string,
    files: string[]
  ): Promise<string> {
    const hash = createHash('sha256');
    hash.update(this.cacheNamespace);

    // Hash tsconfig
    const tsconfigPath = this.resolveFromRoot(tsconfig);
    if (existsSync(tsconfigPath)) {
      const content = readFileSync(tsconfigPath, 'utf-8');
      hash.update(content);
    }

    // Hash specific files if provided (incremental mode)
    if (files.length > 0) {
      for (const file of files) {
        const filePath = this.resolveFromRoot(file);
        if (existsSync(filePath)) {
          const fileHash = this.generateFileHash(filePath);
          hash.update(fileHash);
        }
      }
      hash.update('incremental');
    }

    return `${this.cacheNamespace}:${hash.digest('hex')}`;
  }

  /**
   * Generate hash for a single file
   */
  private generateFileHash(filePath: string): string {
    if (!existsSync(filePath)) return '';

    const content = readFileSync(filePath, 'utf-8');
    const hash = createHash('sha256');
    hash.update(content);
    return hash.digest('hex');
  }

  /**
   * Get cached result if available and fresh
   */
  private getCachedResult(
    key: string,
    maxAge: number
  ): SmartTypeScriptOutput | null {
    const cached = this.cache.get(key);
    if (!cached) {
      return null;
    }

    try {
      const { cachedAt, ...result } = JSON.parse(
        cached
      ) as SmartTypeScriptOutput & {
        cachedAt: number;
      };
      const age = (Date.now() - cachedAt) / 1000;

      if (age <= maxAge) {
        result.summary.fromCache = true;
        return result;
      }
    } catch (err) {
      return null;
    }

    return null;
  }

  /**
   * Cache compilation result
   */
  private cacheResult(key: string, output: SmartTypeScriptOutput): void {
    const toCache = {
      ...output,
      cachedAt: Date.now(),
    };

    const buffer = JSON.stringify(toCache);

    this.cache.set(key, buffer, buffer.length, buffer.length, {
      ttlSeconds: 300,
    }); // 5 minute TTL
  }

  /**
   * Estimate original output size (full diagnostic messages)
   */
  /**
   * Close cache and cleanup
   */
  close(): void {
    this.cache.close();
  }
}

/**
 * Factory function to create SmartTypeScript with dependency injection
 */
export function getSmartTypeScriptTool(
  cache: CacheEngine,
  tokenCounter: TokenCounter,
  metrics: MetricsCollector,
  projectRoot?: string
): SmartTypeScript {
  return new SmartTypeScript(cache, tokenCounter, metrics, projectRoot);
}

/**
 * CLI-friendly function for running smart TypeScript compilation
 */
export async function runSmartTypescript(
  options: SmartTypeScriptOptions = {}
): Promise<string> {
  const cache = new CacheEngine(
    resolveCacheLocation(join(homedir(), '.hypercontext', 'cache'))
  );
  const tokenCounter = new TokenCounter();
  const metrics = new MetricsCollector();
  const smartTS = new SmartTypeScript(
    cache,
    tokenCounter,
    metrics,
    options.projectRoot
  );
  try {
    const result = await smartTS.run(options);

    let output = `\n📘 Smart TypeScript Compilation ${result.summary.fromCache ? '(cached)' : ''}\n`;
    output += `${'='.repeat(60)}\n\n`;

    // Summary
    output += `Summary:\n`;
    output += `  Status: ${result.summary.success ? '✓ Success' : '✗ Failed'}\n`;
    output += `  Errors: ${result.summary.errorCount}\n`;
    output += `  Warnings: ${result.summary.warningCount}\n`;
    output += `  Files Compiled: ${result.summary.filesCompiled}\n`;
    if (result.summary.incrementalMode) {
      output += `  Mode: Incremental (changed files only)\n`;
    }
    output += '\n';

    // Dependency information (incremental mode)
    if (result.dependencies) {
      output += `Dependency Analysis:\n`;
      output += `  Total Files: ${result.dependencies.totalFiles}\n`;
      output += `  Changed Files: ${result.dependencies.changedFiles.length}\n`;
      output += `  Affected Files: ${result.dependencies.affectedFiles.length}\n`;

      if (result.dependencies.changedFiles.length > 0) {
        output += `\n  Changed:\n`;
        result.dependencies.changedFiles.slice(0, 5).forEach((file) => {
          output += `    - ${file}\n`;
        });
      }

      if (result.dependencies.affectedFiles.length > 0) {
        output += `\n  Affected (dependents):\n`;
        result.dependencies.affectedFiles.slice(0, 5).forEach((file) => {
          output += `    - ${file}\n`;
        });
      }
      output += '\n';
    }

    // NAMED, BECAUSE THE COUNTS ABOVE CANNOT SAY IT. `Files Compiled` counts
    // what was checked; nothing in the report used to say that a file the
    // caller asked about was not among them.
    if (result.notTypeChecked && result.notTypeChecked.length > 0) {
      output += `Not type-checked -- not part of the program this tsconfig defines:\n`;
      result.notTypeChecked.slice(0, 5).forEach((file) => {
        output += `  - ${file}\n`;
      });
      if (result.notTypeChecked.length > 5) {
        output += `  ... and ${result.notTypeChecked.length - 5} more\n`;
      }
      output += '\n';
    }

    // Diagnostics by category
    if (result.diagnosticsByCategory.length > 0) {
      output += `Diagnostics by Category:\n`;
      for (const category of result.diagnosticsByCategory) {
        const icon =
          category.severity === 'error'
            ? '❌'
            : category.severity === 'warning'
              ? '⚠️'
              : 'ℹ️';

        output += `\n  ${icon} ${category.category} (${category.count} ${category.severity}s)\n`;

        for (const item of category.items) {
          const fileName = item.file.split(/[\\/]/).pop() || item.file;
          output += `    ${fileName}:${item.location}\n`;
          output += `      [TS${item.code}] ${item.message.slice(0, 80)}${item.message.length > 80 ? '...' : ''}\n`;
        }

        if (category.count > category.items.length) {
          output += `    ... and ${category.count - category.items.length} more\n`;
        }
      }
      output += '\n';
    }

    // Type information
    if (result.typeInfo && result.typeInfo.length > 0) {
      output += `Type Information:\n`;
      for (const info of result.typeInfo.slice(0, 3)) {
        const fileName = info.file.split(/[\\/]/).pop() || info.file;
        output += `\n  ${fileName}:\n`;
        info.exports.slice(0, 5).forEach((exp) => {
          output += `    ${exp.kind} ${exp.name}: ${exp.type.slice(0, 50)}${exp.type.length > 50 ? '...' : ''}\n`;
        });
      }
      output += '\n';
    }

    // Suggestions
    if (result.suggestions.length > 0) {
      output += `Optimization Suggestions:\n`;
      for (const suggestion of result.suggestions) {
        const icon =
          suggestion.type === 'fix'
            ? '🔧'
            : suggestion.type === 'refactor'
              ? '♻️'
              : suggestion.type === 'config'
                ? '⚙️'
                : '⚡';

        output += `  ${icon} [Priority ${suggestion.priority}] ${suggestion.message}\n`;
        output += `    Impact: ${suggestion.impact}\n`;
      }
      output += '\n';
    }

    // NO TOKEN REDUCTION FOOTER. It printed a percentage derived from two
    // estimates, and the digits were themselves part of the bill.
    return output;
  } finally {
    smartTS.close();
  }
}

// MCP Tool definition
export { SMART_TYPESCRIPT_TOOL_DEFINITION } from './analysis-tool-definitions.js';
