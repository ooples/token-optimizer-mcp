/**
 * Smart Complexity Analysis Tool
 *
 * Analyzes code complexity metrics with intelligent caching
 * Calculates cyclomatic, cognitive, and Halstead metrics
 */

import * as ts from 'typescript';
import { existsSync, readFileSync } from 'fs';
import { join, isAbsolute } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { CacheEngine, resolveCacheLocation } from '../../core/cache-engine.js';
import { MetricsCollector } from '../../core/metrics.js';
import { TokenCounter } from '../../core/token-counter.js';
import { displayPath } from '../shared/report-shape.js';
import { encodeTable, type Table } from '../shared/table.js';

/**
 * Places a reported complexity figure is rounded to.
 *
 * Halstead's derived quantities are irrational functions of four integer
 * counts, and they were serialised at full double precision: a single
 * function's block carried calculatedLength 88.71062275542812, volume
 * 176.41891628622352, effort 464.26030601637774 and five more like them.
 * Every digit past the second is a token spent stating a heuristic estimate
 * to a precision its own inputs do not have; on a 13-function file the
 * per-function complexity blocks cost 1692 tokens against a 1669-token
 * source file, and the long tails were most of that.
 */
const METRIC_DECIMALS = 2;

function round(value: number): number {
  return Number(value.toFixed(METRIC_DECIMALS));
}

export interface SmartComplexityOptions {
  filePath?: string;
  fileContent?: string;
  projectRoot?: string;
  includeHalstead?: boolean;
  includeMaintainability?: boolean;
  threshold?: {
    cyclomatic?: number;
    cognitive?: number;
  };
  force?: boolean;
  maxCacheAge?: number;
}

export interface ComplexityMetrics {
  cyclomatic: number;
  cognitive: number;
  halstead?: HalsteadMetrics;
  maintainabilityIndex?: number;
  linesOfCode: number;
  logicalLinesOfCode: number;
}

export interface HalsteadMetrics {
  distinctOperators: number;
  distinctOperands: number;
  totalOperators: number;
  totalOperands: number;
  vocabulary: number;
  length: number;
  calculatedLength: number;
  volume: number;
  difficulty: number;
  effort: number;
  time: number;
  bugs: number;
}

export interface FunctionComplexity {
  name: string;
  location: { line: number; column: number };
  complexity: ComplexityMetrics;
  aboveThreshold: boolean;
}

export interface SmartComplexityResult {
  summary: {
    file: string;
    totalComplexity: ComplexityMetrics;
    averageComplexity: number;
    maxComplexity: number;
    functionsAboveThreshold: number;
    totalFunctions: number;
    riskLevel: 'low' | 'medium' | 'high' | 'critical';
    fromCache: boolean;
  };
  /**
   * One row per function, field names sent once.
   *
   * Decode with `decodeTable<FunctionComplexity>(result.functions)` for the
   * records. They were sent as an array of objects, which repeated all 24
   * field names on every element -- about half of the 1639 tokens the block
   * cost on a 13-function file, to re-label numbers the first element had
   * already labelled.
   */
  functions: Table;
  // NO fileMetrics FIELD, DELIBERATELY. It was the same object as
  // summary.totalComplexity -- not a similar one, the identical reference --
  // so every response serialised the whole file-level block twice, measured at
  // 133 to 139 tokens a copy. summary.totalComplexity is the one that stays,
  // because it sits with the rest of the file-level answer.
  recommendations: string[];
  // NO metrics FIELD, DELIBERATELY, AND NO SAVING STATED ANYWHERE IN A REPLY.
  // This tool used to publish originalTokens, compactedTokens and a reduction
  // percentage computed from them. Both halves were guesses about a reply the
  // tool cannot see: the text a caller is charged for is built after this
  // object is returned, out of this object plus a report and its metadata, so
  // no figure counted in here is the figure that was sent. The after is now
  // counted once, at the wire, by the party that holds the bytes; the before
  // is the file named in the arguments, which the recorder reads for itself.
  // Nothing is left for the tool to say, so it says nothing -- and the three
  // fields' own digits stop being part of what the caller pays for.
}

export class SmartComplexityTool {
  private cache: CacheEngine;
  private metrics: MetricsCollector;
  private cacheNamespace = 'smart_complexity';
  private projectRoot: string;

  constructor(
    cache: CacheEngine,
    // ACCEPTED AND NOT USED, which is the point: this tool no longer counts
    // tokens, because the only thing it was counting them for was a saving it
    // was not in a position to measure. The parameter stays so that every
    // analysis tool is still built by the same three-argument factory call.
    _tokenCounter: TokenCounter,
    metrics: MetricsCollector,
    projectRoot?: string
  ) {
    this.cache = cache;
    this.metrics = metrics;
    this.projectRoot = projectRoot || process.cwd();
  }

  async run(
    options: SmartComplexityOptions = {}
  ): Promise<SmartComplexityResult> {
    const startTime = Date.now();
    const {
      filePath,
      fileContent,
      projectRoot = this.projectRoot,
      includeHalstead = true,
      includeMaintainability = true,
      threshold = { cyclomatic: 10, cognitive: 15 },
      force = false,
      maxCacheAge = 300,
    } = options;

    if (!filePath && !fileContent) {
      throw new Error('Either filePath or fileContent must be provided');
    }

    // Read file content
    let content: string;
    let absolutePath: string | undefined;

    if (fileContent) {
      content = fileContent;
    } else if (filePath) {
      // An ABSOLUTE filePath must be used as given.
      // join(projectRoot, filePath) on an absolute path produces nonsense --
      // a project root with a drive letter glued onto it -- and the tool then
      // reports "File not found" for a file that is plainly there. Measured
      // live: every call with an absolute path failed exactly this way.
      absolutePath = isAbsolute(filePath)
        ? filePath
        : join(projectRoot, filePath);
      if (!existsSync(absolutePath)) {
        throw new Error(`File not found: ${absolutePath}`);
      }
      content = readFileSync(absolutePath, 'utf-8');
    } else {
      throw new Error('No content provided');
    }

    // Generate cache key
    const cacheKey = await this.generateCacheKey(
      content,
      includeHalstead,
      includeMaintainability
    );

    // Check cache
    if (!force) {
      const cached = this.getCachedResult(cacheKey, maxCacheAge);
      if (cached) {
        this.metrics.record({
          operation: 'smart_complexity',
          duration: Date.now() - startTime,
          cacheHit: true,
          success: true,
        });
        return cached;
      }
    }

    // Parse TypeScript/JavaScript
    const sourceFile = ts.createSourceFile(
      filePath || 'anonymous.ts',
      content,
      ts.ScriptTarget.Latest,
      true
    );

    // Calculate metrics
    const functions = this.analyzeFunctions(
      sourceFile,
      threshold,
      includeHalstead,
      includeMaintainability
    );
    const fileMetrics = this.calculateFileMetrics(
      sourceFile,
      includeHalstead,
      includeMaintainability
    );

    // Generate recommendations
    const recommendations = this.generateRecommendations(
      functions,
      fileMetrics,
      threshold
    );

    // Calculate summary statistics
    const totalFunctions = functions.length;
    const functionsAboveThreshold = functions.filter(
      (f) => f.aboveThreshold
    ).length;
    const avgComplexity =
      totalFunctions > 0
        ? functions.reduce((sum, f) => sum + f.complexity.cyclomatic, 0) /
          totalFunctions
        : 0;
    const maxComplexity =
      totalFunctions > 0
        ? Math.max(...functions.map((f) => f.complexity.cyclomatic))
        : 0;

    // Determine risk level
    const riskLevel = this.calculateRiskLevel(avgComplexity, maxComplexity);

    // Build result
    const result: SmartComplexityResult = {
      summary: {
        // Relative to the working directory where that is shorter: JSON
        // escapes every Windows separator to a doubled backslash and each
        // escape is its own token.
        file: filePath ? displayPath(absolutePath ?? filePath) : 'anonymous',
        totalComplexity: fileMetrics,
        averageComplexity: avgComplexity,
        maxComplexity,
        functionsAboveThreshold,
        totalFunctions,
        riskLevel,
        fromCache: false,
      },
      functions: encodeTable(functions as unknown as Record<string, unknown>[]),
      recommendations,
    };

    // Cache result
    this.cacheResult(cacheKey, result);

    // NO TOKEN FIGURES ON THIS RECORD EITHER. inputTokens and cachedTokens
    // were the two halves of the deleted claim, and cache_analytics sums them
    // into a second savings total that nothing measured. The duration, the
    // cache outcome and the success are things this tool genuinely observed.
    this.metrics.record({
      operation: 'smart_complexity',
      duration: Date.now() - startTime,
      cacheHit: false,
      success: true,
    });

    return result;
  }

  private analyzeFunctions(
    sourceFile: ts.SourceFile,
    threshold: { cyclomatic?: number; cognitive?: number },
    includeHalstead: boolean,
    includeMaintainability: boolean
  ): FunctionComplexity[] {
    const functions: FunctionComplexity[] = [];

    const visit = (node: ts.Node) => {
      if (
        ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isArrowFunction(node) ||
        ts.isFunctionExpression(node)
      ) {
        const name = this.getFunctionName(node);
        const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        const complexity = this.calculateComplexity(
          node,
          sourceFile,
          includeHalstead,
          includeMaintainability
        );

        const aboveThreshold =
          (threshold.cyclomatic &&
            complexity.cyclomatic > threshold.cyclomatic) ||
          (threshold.cognitive && complexity.cognitive > threshold.cognitive) ||
          false;

        functions.push({
          name,
          location: { line: pos.line + 1, column: pos.character },
          complexity,
          aboveThreshold,
        });
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return functions;
  }

  private getFunctionName(node: ts.Node): string {
    if (ts.isFunctionDeclaration(node) && node.name) {
      return node.name.text;
    }
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      return node.name.text;
    }
    if (ts.isFunctionExpression(node) && node.name) {
      return node.name.text;
    }
    return '<anonymous>';
  }

  private calculateComplexity(
    node: ts.Node,
    sourceFile: ts.SourceFile,
    includeHalstead: boolean,
    includeMaintainability: boolean
  ): ComplexityMetrics {
    const cyclomatic = this.calculateCyclomaticComplexity(node);
    const cognitive = this.calculateCognitiveComplexity(node, 0);
    const { loc, lloc } = this.countLines(node, sourceFile);

    const metrics: ComplexityMetrics = {
      cyclomatic,
      cognitive,
      linesOfCode: loc,
      logicalLinesOfCode: lloc,
    };

    if (includeHalstead) {
      metrics.halstead = this.calculateHalsteadMetrics(node);
    }

    if (includeMaintainability && metrics.halstead) {
      metrics.maintainabilityIndex = this.calculateMaintainabilityIndex(
        metrics.halstead,
        cyclomatic,
        lloc
      );
    }

    return metrics;
  }

  private calculateCyclomaticComplexity(node: ts.Node): number {
    let complexity = 1; // Base complexity

    const visit = (n: ts.Node) => {
      // Decision points that increase complexity
      if (
        ts.isIfStatement(n) ||
        ts.isConditionalExpression(n) ||
        ts.isForStatement(n) ||
        ts.isForInStatement(n) ||
        ts.isForOfStatement(n) ||
        ts.isWhileStatement(n) ||
        ts.isDoStatement(n) ||
        ts.isCaseClause(n) ||
        ts.isCatchClause(n)
      ) {
        complexity++;
      }

      // Logical operators
      if (ts.isBinaryExpression(n)) {
        if (
          n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          n.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        ) {
          complexity++;
        }
      }

      ts.forEachChild(n, visit);
    };

    visit(node);
    return complexity;
  }

  private calculateCognitiveComplexity(
    node: ts.Node,
    nestingLevel: number
  ): number {
    let complexity = 0;

    const visit = (n: ts.Node, level: number) => {
      // Structures that increase cognitive complexity
      if (ts.isIfStatement(n)) {
        complexity += 1 + level;
        ts.forEachChild(n, (child) => visit(child, level + 1));
        return;
      }

      if (ts.isConditionalExpression(n)) {
        complexity += 1 + level;
        ts.forEachChild(n, (child) => visit(child, level + 1));
        return;
      }

      if (
        ts.isForStatement(n) ||
        ts.isForInStatement(n) ||
        ts.isForOfStatement(n) ||
        ts.isWhileStatement(n) ||
        ts.isDoStatement(n)
      ) {
        complexity += 1 + level;
        ts.forEachChild(n, (child) => visit(child, level + 1));
        return;
      }

      if (ts.isSwitchStatement(n)) {
        complexity += 1 + level;
        ts.forEachChild(n, (child) => visit(child, level + 1));
        return;
      }

      if (ts.isCatchClause(n)) {
        complexity += 1 + level;
        ts.forEachChild(n, (child) => visit(child, level + 1));
        return;
      }

      // Logical operators (but not nested ones at the same level)
      if (ts.isBinaryExpression(n)) {
        if (
          n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          n.operatorToken.kind === ts.SyntaxKind.BarBarToken
        ) {
          complexity += 1;
        }
      }

      // Continue with children at the same level
      ts.forEachChild(n, (child) => visit(child, level));
    };

    visit(node, nestingLevel);
    return complexity;
  }

  private calculateHalsteadMetrics(node: ts.Node): HalsteadMetrics {
    const operators = new Set<string>();
    const operands = new Set<string>();
    let totalOperators = 0;
    let totalOperands = 0;

    const visit = (n: ts.Node) => {
      // Operators
      if (ts.isBinaryExpression(n)) {
        const op = n.operatorToken.getText();
        operators.add(op);
        totalOperators++;
      }

      if (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) {
        const op = n.operator.toString();
        operators.add(op);
        totalOperators++;
      }

      if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
        operators.add('()');
        totalOperators++;
      }

      if (ts.isPropertyAccessExpression(n)) {
        operators.add('.');
        totalOperators++;
      }

      // Operands
      if (ts.isIdentifier(n)) {
        operands.add(n.text);
        totalOperands++;
      }

      if (ts.isStringLiteral(n) || ts.isNumericLiteral(n)) {
        operands.add(n.text);
        totalOperands++;
      }

      ts.forEachChild(n, visit);
    };

    visit(node);

    const n1 = operators.size; // Distinct operators
    const n2 = operands.size; // Distinct operands
    const N1 = totalOperators; // Total operators
    const N2 = totalOperands; // Total operands

    const vocabulary = n1 + n2;
    const length = N1 + N2;
    const calculatedLength = n1 * Math.log2(n1) + n2 * Math.log2(n2);
    const volume = length * Math.log2(vocabulary);
    const difficulty = (n1 / 2) * (N2 / n2);
    const effort = difficulty * volume;
    const time = effort / 18; // seconds
    const bugs = volume / 3000;

    // The four counts are integers and stay exact. The rest are estimates
    // derived from them, and are rounded on the way out: see METRIC_DECIMALS.
    return {
      distinctOperators: n1,
      distinctOperands: n2,
      totalOperators: N1,
      totalOperands: N2,
      vocabulary,
      length,
      calculatedLength: round(calculatedLength),
      volume: round(volume),
      difficulty: round(difficulty),
      effort: round(effort),
      time: round(time),
      bugs: round(bugs),
    };
  }

  private calculateMaintainabilityIndex(
    halstead: HalsteadMetrics,
    cyclomatic: number,
    lloc: number
  ): number {
    // Microsoft's Maintainability Index formula
    // MI = 171 - 5.2 * ln(V) - 0.23 * G - 16.2 * ln(LOC)
    // Where V = Halstead Volume, G = Cyclomatic Complexity, LOC = Lines of Code

    const volume = halstead.volume || 1;
    const mi =
      171 -
      5.2 * Math.log(volume) -
      0.23 * cyclomatic -
      16.2 * Math.log(lloc || 1);

    // Normalize to 0-100 scale. Rounded like the Halstead figures it is
    // derived from -- the volume it reads is already rounded, so the digits
    // this used to carry past the second were not even self-consistent.
    return round(Math.max(0, Math.min(100, mi)));
  }

  private countLines(
    node: ts.Node,
    sourceFile: ts.SourceFile
  ): { loc: number; lloc: number } {
    const text = node.getText(sourceFile);
    const lines = text.split('\n');
    const loc = lines.length;

    // Count logical lines (non-empty, non-comment lines)
    let lloc = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (
        trimmed &&
        !trimmed.startsWith('//') &&
        !trimmed.startsWith('/*') &&
        !trimmed.startsWith('*')
      ) {
        lloc++;
      }
    }

    return { loc, lloc };
  }

  private calculateFileMetrics(
    sourceFile: ts.SourceFile,
    includeHalstead: boolean,
    includeMaintainability: boolean
  ): ComplexityMetrics {
    return this.calculateComplexity(
      sourceFile,
      sourceFile,
      includeHalstead,
      includeMaintainability
    );
  }

  private generateRecommendations(
    functions: FunctionComplexity[],
    fileMetrics: ComplexityMetrics,
    threshold: { cyclomatic?: number; cognitive?: number }
  ): string[] {
    const recommendations: string[] = [];

    // Check for high complexity functions
    const highComplexityFunctions = functions.filter(
      (f) => f.complexity.cyclomatic > (threshold.cyclomatic || 10)
    );

    if (highComplexityFunctions.length > 0) {
      recommendations.push(
        `Found ${highComplexityFunctions.length} function(s) with high cyclomatic complexity. Consider breaking down: ${highComplexityFunctions
          .map((f) => f.name)
          .join(', ')}`
      );
    }

    // Check for high cognitive complexity
    const highCognitiveFunctions = functions.filter(
      (f) => f.complexity.cognitive > (threshold.cognitive || 15)
    );

    if (highCognitiveFunctions.length > 0) {
      recommendations.push(
        `Found ${highCognitiveFunctions.length} function(s) with high cognitive complexity. Simplify logic in: ${highCognitiveFunctions
          .map((f) => f.name)
          .join(', ')}`
      );
    }

    // Check maintainability index
    if (
      fileMetrics.maintainabilityIndex !== undefined &&
      fileMetrics.maintainabilityIndex < 20
    ) {
      recommendations.push(
        'File has low maintainability index (<20). Consider refactoring to improve code quality.'
      );
    } else if (
      fileMetrics.maintainabilityIndex !== undefined &&
      fileMetrics.maintainabilityIndex < 50
    ) {
      recommendations.push(
        'File maintainability could be improved. Consider reducing complexity and improving documentation.'
      );
    }

    // Check for very long functions
    const longFunctions = functions.filter(
      (f) => f.complexity.linesOfCode > 50
    );
    if (longFunctions.length > 0) {
      recommendations.push(
        `Found ${longFunctions.length} function(s) with more than 50 lines. Consider splitting: ${longFunctions
          .map((f) => f.name)
          .join(', ')}`
      );
    }

    return recommendations;
  }

  private calculateRiskLevel(
    avgComplexity: number,
    maxComplexity: number
  ): 'low' | 'medium' | 'high' | 'critical' {
    if (maxComplexity > 30 || avgComplexity > 20) {
      return 'critical';
    }
    if (maxComplexity > 20 || avgComplexity > 15) {
      return 'high';
    }
    if (maxComplexity > 10 || avgComplexity > 10) {
      return 'medium';
    }
    return 'low';
  }

  private async generateCacheKey(
    content: string,
    includeHalstead: boolean,
    includeMaintainability: boolean
  ): Promise<string> {
    const hash = createHash('sha256');
    hash.update(this.cacheNamespace);
    hash.update(content);
    hash.update(JSON.stringify({ includeHalstead, includeMaintainability }));
    return `${this.cacheNamespace}:${hash.digest('hex')}`;
  }

  private getCachedResult(
    key: string,
    maxAge: number
  ): SmartComplexityResult | null {
    const cached = this.cache.get(key);
    if (!cached) return null;

    const { cachedAt, ...result } = JSON.parse(
      cached
    ) as SmartComplexityResult & {
      cachedAt: number;
    };
    const age = (Date.now() - cachedAt) / 1000;

    if (age <= maxAge) {
      result.summary.fromCache = true;
      return result;
    }

    return null;
  }

  private cacheResult(key: string, output: SmartComplexityResult): void {
    const toCache = { ...output, cachedAt: Date.now() };
    const json = JSON.stringify(toCache);
    const originalSize = Buffer.byteLength(json, 'utf-8');
    const compressedSize = Math.ceil(originalSize * 0.3); // Estimate compression
    this.cache.set(key, json, originalSize, compressedSize);
  }
}

// Factory function for dependency injection
export function getSmartComplexityTool(
  cache: CacheEngine,
  tokenCounter: TokenCounter,
  metrics: MetricsCollector
): SmartComplexityTool {
  return new SmartComplexityTool(cache, tokenCounter, metrics);
}

// Standalone function for CLI usage
export async function runSmartComplexity(
  options: SmartComplexityOptions,
  cache?: CacheEngine,
  tokenCounter?: TokenCounter,
  metrics?: MetricsCollector
): Promise<SmartComplexityResult> {
  const cacheInstance =
    cache ||
    new CacheEngine(
      resolveCacheLocation(join(homedir(), '.hypercontext', 'cache')),
      100
    );
  const tokenCounterInstance = tokenCounter || new TokenCounter();
  const metricsInstance = metrics || new MetricsCollector();

  const tool = getSmartComplexityTool(
    cacheInstance,
    tokenCounterInstance,
    metricsInstance
  );
  return tool.run(options);
}

// MCP tool definition
export { SMART_COMPLEXITY_TOOL_DEFINITION } from './analysis-tool-definitions.js';
