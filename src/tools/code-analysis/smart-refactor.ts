/**
 * Smart Refactor Tool
 *
 * Provides intelligent refactoring suggestions with code examples
 * Analyzes code patterns and suggests improvements
 */

import * as ts from 'typescript';
import { existsSync, readFileSync } from 'fs';
import { join, isAbsolute } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { CacheEngine, resolveCacheLocation } from '../../core/cache-engine.js';
import { MetricsCollector } from '../../core/metrics.js';
import { TokenCounter } from '../../core/token-counter.js';
import {
  SmartComplexityTool,
  getSmartComplexityTool,
  type FunctionComplexity,
  type SmartComplexityResult,
} from './smart-complexity.js';
import { decodeTable, encodeTable, type Table } from '../shared/table.js';
import { displayPath } from '../shared/report-shape.js';

export interface SmartRefactorOptions {
  filePath?: string;
  fileContent?: string;
  projectRoot?: string;
  refactorTypes?: Array<
    | 'extract-method'
    | 'simplify-conditional'
    | 'remove-duplication'
    | 'improve-naming'
    | 'reduce-complexity'
    | 'extract-constant'
  >;
  minComplexityForExtraction?: number;
  force?: boolean;
  maxCacheAge?: number;
}

export interface RefactorSuggestion {
  type: string;
  severity: 'info' | 'warning' | 'error';
  /**
   * Every place this same finding occurs, as [line, column] pairs.
   *
   * ONE FINDING, ALL ITS PLACES -- not one finding per place.
   *
   * These were separate suggestions, each carrying its own copy of the
   * message, the advice, the code example and the impact block. On one
   * 4937-token source file that produced 100 suggestions holding 26 distinct
   * messages: "Single-letter variable 'n' is not descriptive." was sent 50
   * times and the same sentence for 'f' 24 times, identical in every field
   * but the line. That is not 50 findings, and answering as though it were
   * cost 7214 tokens to report on a 4937-token file.
   *
   * The previous shape also declared endLine and endColumn, which no
   * producer ever set.
   */
  locations: Array<[line: number, column: number]>;
  message: string;
  suggestion: string;
  codeExample?: {
    before: string;
    after: string;
  };
  impact: {
    complexity?: number;
    readability?: 'low' | 'medium' | 'high';
    maintainability?: 'low' | 'medium' | 'high';
  };
}

/**
 * The advice and worked example for a kind of refactoring, sent once.
 *
 * Most of what a suggestion said was a property of its TYPE, not of the place
 * it was found: the same "Extract complex conditions into descriptively named
 * boolean variables." and the same before/after example went out with every
 * simplify-conditional finding. On one fixture the codeExample field alone
 * was 517 of the 1982 tokens the suggestions cost, most of it the same
 * textbook snippet repeated.
 *
 * Hoisting it here loses nothing: a finding that omits `suggestion` or
 * `codeExample` means the entry under its own type, which is in this same
 * response, and a finding whose advice genuinely differs still carries its
 * own.
 */
export interface RefactorGuidance {
  suggestion: string;
  codeExample?: {
    before: string;
    after: string;
  };
}

/**
 * A finding as it is sent: its own advice only where that differs from the
 * shared {`link RefactorGuidance} for its type.
 */
export type RefactorSuggestionRow = Omit<
  RefactorSuggestion,
  'suggestion' | 'codeExample'
> &
  Partial<Pick<RefactorSuggestion, 'suggestion' | 'codeExample'>>;

export interface SmartRefactorResult {
  summary: {
    file: string;
    /** Distinct findings, after identical ones were folded onto one entry. */
    totalSuggestions: number;
    /**
     * Places those findings occur, summed over every entry's locations.
     *
     * Kept so folding loses no count: this is what totalSuggestions used to
     * report, when one occurrence was one suggestion.
     */
    totalOccurrences: number;
    /**
     * COUNTS PER SEVERITY AND PER TYPE ARE NOT SENT.
     *
     * They were, and they were 146 tokens across the three benched files --
     * a tenth of the smallest reply -- for sums the caller can take from the
     * `severity` and `type` columns of `suggestions`, which travel in the
     * same response either way. A tally of rows the reader already has is
     * the reader doing less adding, not the tool answering more.
     */
    estimatedImpact: 'low' | 'medium' | 'high';
    fromCache: boolean;
  };
  /**
   * One row per finding, field names sent once.
   *
   * Decode with `decodeTable<RefactorSuggestionRow>(result.suggestions)`. As
   * an array of objects this re-labelled every field on every element; on a
   * 26-finding response that repetition cost 526 tokens.
   *
   * A row's `suggestion` and `codeExample` may be absent, which means the
   * entry for its type in {`link SmartRefactorResult.guidance}.
   */
  suggestions: Table;
  /** Per-type advice, keyed by `type`, referenced by the rows above. */
  guidance: Record<string, RefactorGuidance>;
  // NO metrics FIELD, DELIBERATELY. The after half was never knowable here:
  // the text a caller is billed for is assembled from this object after it is
  // returned, so a count taken inside the tool describes a different artifact
  // than the one that was sent. It is counted once now, at the wire. The
  // before half is the file named in the arguments, which the recorder reads
  // for itself, so there is nothing left for this reply to assert.
}

export class SmartRefactorTool {
  private cache: CacheEngine;
  private metrics: MetricsCollector;
  private cacheNamespace = 'smart_refactor';
  private projectRoot: string;
  private complexityTool: SmartComplexityTool;

  constructor(
    cache: CacheEngine,
    tokenCounter: TokenCounter,
    metrics: MetricsCollector,
    projectRoot?: string
  ) {
    this.cache = cache;
    this.metrics = metrics;
    this.projectRoot = projectRoot || process.cwd();
    this.complexityTool = getSmartComplexityTool(cache, tokenCounter, metrics);
  }

  async run(options: SmartRefactorOptions = {}): Promise<SmartRefactorResult> {
    const startTime = Date.now();
    const {
      filePath,
      fileContent,
      projectRoot = this.projectRoot,
      refactorTypes = [
        'extract-method',
        'simplify-conditional',
        'remove-duplication',
        'improve-naming',
        'reduce-complexity',
        'extract-constant',
      ],
      minComplexityForExtraction = 10,
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
      refactorTypes,
      minComplexityForExtraction
    );

    // Check cache
    if (!force) {
      const cached = this.getCachedResult(cacheKey, maxCacheAge);
      if (cached) {
        this.metrics.record({
          operation: 'smart_refactor',
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

    // Get complexity metrics
    const complexityResult = await this.complexityTool.run({
      fileContent: content,
      projectRoot,
      force: true,
    });

    // Analyze and generate suggestions
    const rawSuggestions: RefactorSuggestion[] = [];

    for (const type of refactorTypes) {
      switch (type) {
        case 'extract-method':
          rawSuggestions.push(
            ...this.suggestExtractMethod(
              complexityResult,
              minComplexityForExtraction
            )
          );
          break;
        case 'simplify-conditional':
          rawSuggestions.push(...this.suggestSimplifyConditional(sourceFile));
          break;
        case 'remove-duplication':
          rawSuggestions.push(...this.suggestRemoveDuplication(sourceFile));
          break;
        case 'improve-naming':
          rawSuggestions.push(...this.suggestImproveNaming(sourceFile));
          break;
        case 'reduce-complexity':
          rawSuggestions.push(
            ...this.suggestReduceComplexity(complexityResult)
          );
          break;
        case 'extract-constant':
          rawSuggestions.push(...this.suggestExtractConstant(sourceFile));
          break;
      }
    }

    // Identical findings are one finding at many places. The producers above
    // each emit one entry per occurrence, which is the natural way to write a
    // visitor; folding them here keeps that simple and still answers once.
    const suggestions = this.foldIdenticalFindings(rawSuggestions);

    const estimatedImpact = this.calculateEstimatedImpact(suggestions);

    // Advice that belongs to the kind of refactoring, not to the place, is
    // said once for that kind.
    const { guidance, rows } = this.hoistGuidance(suggestions);

    // Build result
    const result: SmartRefactorResult = {
      summary: {
        file: filePath ? displayPath(absolutePath ?? filePath) : 'anonymous',
        totalSuggestions: suggestions.length,
        totalOccurrences: suggestions.reduce(
          (total, entry) => total + entry.locations.length,
          0
        ),
        estimatedImpact,
        fromCache: false,
      },
      suggestions: encodeTable(rows as unknown as Record<string, unknown>[]),
      guidance,
    };

    // Cache result
    this.cacheResult(cacheKey, result);

    // NO TOKEN FIGURES HERE EITHER. These two fields fed cache_analytics a
    // savings total built entirely from tool self-claims, in parallel with the
    // one the recorder measures. One measurement, one place.
    this.metrics.record({
      operation: 'smart_refactor',
      duration: Date.now() - startTime,
      cacheHit: false,
      success: true,
    });

    return result;
  }

  private suggestExtractMethod(
    complexityResult: SmartComplexityResult,
    minComplexity: number
  ): RefactorSuggestion[] {
    const suggestions: RefactorSuggestion[] = [];

    // Decoded back to records. smart_complexity sends the field names once
    // and the values as rows, which costs the caller nothing to reverse and
    // saved about half the size of that block.
    const analysed = decodeTable<FunctionComplexity>(
      complexityResult.functions
    );

    // Find complex functions
    const complexFunctions = analysed.filter(
      (f) => f.complexity.cyclomatic >= minComplexity
    );

    for (const func of complexFunctions) {
      suggestions.push({
        type: 'extract-method',
        severity: func.complexity.cyclomatic > 20 ? 'error' : 'warning',
        locations: [[func.location.line, func.location.column]],
        message: `Function '${func.name}' has high complexity (${func.complexity.cyclomatic}). Consider extracting smaller methods.`,
        suggestion: `Break down '${func.name}' into smaller, focused functions with single responsibilities.`,
        impact: {
          complexity: func.complexity.cyclomatic - minComplexity,
          readability: 'high',
          maintainability: 'high',
        },
      });
    }

    return suggestions;
  }

  private suggestSimplifyConditional(
    sourceFile: ts.SourceFile
  ): RefactorSuggestion[] {
    const suggestions: RefactorSuggestion[] = [];

    // A REPORTED CONSTRUCT IS NOT REPORTED AGAIN FROM THE INSIDE.
    //
    // Both checks below measure a whole construct -- the depth of an if
    // chain, the operator count of a boolean expression -- and the visitor
    // then walked into it and measured the same construct again, one level
    // down. A four-level if chain was reported at four levels and again at
    // three; one conditional in the fixtures produced two findings at the
    // identical line and column, "5 logical operators" and "4", which are
    // the same expression counted from two of its nodes. The visitor runs
    // parents before children, so the first report of a construct is its
    // outermost node, and anything inside that range is the same finding.
    const reportedIfs: ts.TextRange[] = [];
    const reportedBooleans: ts.TextRange[] = [];
    const within = (ranges: ts.TextRange[], node: ts.Node): boolean =>
      ranges.some(
        (range) => node.getStart() >= range.pos && node.getEnd() <= range.end
      );

    const visit = (node: ts.Node) => {
      // Nested if statements
      if (ts.isIfStatement(node) && !within(reportedIfs, node)) {
        const nestedIfs = this.countNestedIfs(node);
        if (nestedIfs > 2) {
          reportedIfs.push({ pos: node.getStart(), end: node.getEnd() });
          const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          suggestions.push({
            type: 'simplify-conditional',
            severity: 'warning',
            locations: [[pos.line + 1, pos.character]],
            message: `Deeply nested if statements (${nestedIfs} levels). Consider using early returns or guard clauses.`,
            suggestion:
              'Use early returns or extract conditions into well-named variables.',
            codeExample: {
              before:
                'if (a) {\n  if (b) {\n    if (c) {\n      doSomething();\n    }\n  }\n}',
              after:
                'if (!a) return;\nif (!b) return;\nif (!c) return;\ndoSomething();',
            },
            impact: {
              readability: 'high',
              maintainability: 'high',
            },
          });
        }
      }

      // Complex boolean expressions
      if (ts.isBinaryExpression(node) && !within(reportedBooleans, node)) {
        const complexity = this.countLogicalOperators(node);
        if (complexity > 3) {
          reportedBooleans.push({ pos: node.getStart(), end: node.getEnd() });
          const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          suggestions.push({
            type: 'simplify-conditional',
            severity: 'warning',
            locations: [[pos.line + 1, pos.character]],
            message: `Complex boolean expression with ${complexity} logical operators. Consider extracting into well-named variables.`,
            suggestion:
              'Extract complex conditions into descriptively named boolean variables.',
            // NO CODE EXAMPLE. It was `if (a && b || c && d || e && f)`
            // rewritten into three named booleans, with placeholder
            // identifiers -- the same 69 tokens whatever file was scanned,
            // illustrating a transformation the suggestion above states in
            // full. The example named nothing the caller had asked about.
            impact: {
              readability: 'high',
              maintainability: 'medium',
            },
          });
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return suggestions;
  }

  private suggestRemoveDuplication(
    sourceFile: ts.SourceFile
  ): RefactorSuggestion[] {
    const suggestions: RefactorSuggestion[] = [];
    const codeBlocks = new Map<
      string,
      Array<{ location: ts.TextRange; text: string }>
    >();

    const visit = (node: ts.Node) => {
      // Look for duplicate blocks (functions, if statements, etc.)
      if (
        ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isIfStatement(node) ||
        ts.isBlock(node)
      ) {
        const text = node.getText(sourceFile).trim();
        if (text.length > 100) {
          // Only consider substantial blocks
          const hash = createHash('md5').update(text).digest('hex');
          if (!codeBlocks.has(hash)) {
            codeBlocks.set(hash, []);
          }
          codeBlocks.get(hash)!.push({
            location: { pos: node.getStart(), end: node.getEnd() },
            text,
          });
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    // Report duplicates
    for (const [_hash, blocks] of codeBlocks) {
      if (blocks.length > 1) {
        const firstBlock = blocks[0];
        const pos = sourceFile.getLineAndCharacterOfPosition(
          firstBlock.location.pos
        );
        suggestions.push({
          type: 'remove-duplication',
          severity: 'warning',
          locations: [[pos.line + 1, pos.character]],
          message: `Found ${blocks.length} duplicate or very similar code blocks.`,
          suggestion:
            'Extract common logic into a reusable function or utility.',
          impact: {
            maintainability: 'high',
            readability: 'medium',
          },
        });
      }
    }

    return suggestions;
  }

  private suggestImproveNaming(
    sourceFile: ts.SourceFile
  ): RefactorSuggestion[] {
    const suggestions: RefactorSuggestion[] = [];

    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node)) {
        const name = node.text;

        // Check for single-letter variables (except common ones like i, j, k in loops)
        if (
          name.length === 1 &&
          !['i', 'j', 'k', 'x', 'y', 'z'].includes(name)
        ) {
          const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          suggestions.push({
            type: 'improve-naming',
            severity: 'info',
            locations: [[pos.line + 1, pos.character]],
            message: `Single-letter variable '${name}' is not descriptive.`,
            suggestion:
              "Use a descriptive name that explains the variable's purpose.",
            impact: {
              readability: 'medium',
              maintainability: 'low',
            },
          });
        }

        // Check for generic names
        const genericNames = [
          'data',
          'temp',
          'tmp',
          'foo',
          'bar',
          'test',
          'obj',
          'arr',
        ];
        if (genericNames.includes(name.toLowerCase())) {
          const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          suggestions.push({
            type: 'improve-naming',
            severity: 'info',
            locations: [[pos.line + 1, pos.character]],
            message: `Generic variable name '${name}' lacks clarity.`,
            suggestion:
              'Use a more specific name that describes what this variable contains or represents.',
            impact: {
              readability: 'medium',
              maintainability: 'low',
            },
          });
        }

        // Check for inconsistent naming conventions
        if (name.includes('_') && name.includes(name.toUpperCase())) {
          // Mix of snake_case and SCREAMING_CASE
          const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          suggestions.push({
            type: 'improve-naming',
            severity: 'info',
            locations: [[pos.line + 1, pos.character]],
            message: `Inconsistent naming convention in '${name}'.`,
            suggestion:
              'Use consistent naming: camelCase for variables/functions, PascalCase for classes, SCREAMING_CASE for constants.',
            impact: {
              readability: 'low',
              maintainability: 'low',
            },
          });
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return suggestions;
  }

  private suggestReduceComplexity(
    complexityResult: SmartComplexityResult
  ): RefactorSuggestion[] {
    const suggestions: RefactorSuggestion[] = [];

    // Check for high cognitive complexity
    for (const func of decodeTable<FunctionComplexity>(
      complexityResult.functions
    )) {
      if (func.complexity.cognitive > 15) {
        suggestions.push({
          type: 'reduce-complexity',
          severity: func.complexity.cognitive > 25 ? 'error' : 'warning',
          locations: [[func.location.line, func.location.column]],
          message: `Function '${func.name}' has high cognitive complexity (${func.complexity.cognitive}).`,
          suggestion:
            'Reduce nesting, extract helper functions, and simplify control flow.',
          // NO CODE EXAMPLE. Both halves of it were prose sitting in a
          // field a consumer reads as code -- `Complex nested logic with
          // multiple conditions` is not a before, it is the message above
          // restated, and the suggestion already names the transformation.
          impact: {
            complexity: func.complexity.cognitive - 15,
            readability: 'high',
            maintainability: 'high',
          },
        });
      }
    }

    return suggestions;
  }

  private suggestExtractConstant(
    sourceFile: ts.SourceFile
  ): RefactorSuggestion[] {
    const suggestions: RefactorSuggestion[] = [];
    // WHERE each occurrence is, not just how many there are. This counted
    // occurrences and then reported every finding at line 1, column 0, so the
    // one field that would let a caller go and change the literals pointed at
    // the top of the file instead. The positions are free here -- the visitor
    // is already standing on the node.
    const repeatedValues = new Map<string, Array<[number, number]>>();

    const record = (value: string, node: ts.Node): void => {
      const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      const places = repeatedValues.get(value);
      if (places === undefined) {
        repeatedValues.set(value, [[pos.line + 1, pos.character]]);
        return;
      }
      places.push([pos.line + 1, pos.character]);
    };

    const visit = (node: ts.Node) => {
      if (ts.isNumericLiteral(node)) {
        const value = node.text;
        // Skip common non-magic numbers
        if (!['0', '1', '-1', '2'].includes(value)) {
          record(value, node);
        }
      }

      if (ts.isStringLiteral(node)) {
        const value = node.text;
        // Look for repeated string literals that might be constants
        if (value.length > 5) {
          // Skip very short strings
          record(value, node);
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    // Report values that appear multiple times
    for (const [value, places] of repeatedValues) {
      const count = places.length;
      if (count > 2) {
        suggestions.push({
          type: 'extract-constant',
          severity: 'info',
          locations: places,
          message: `Value '${value}' appears ${count} times. Consider extracting as a named constant.`,
          suggestion: `Extract '${value}' into a descriptively named constant to improve maintainability.`,
          codeExample: {
            before: `const x = ${value};\nconst y = ${value};`,
            after: `const DESCRIPTIVE_NAME = ${value};\nconst x = DESCRIPTIVE_NAME;\nconst y = DESCRIPTIVE_NAME;`,
          },
          impact: {
            maintainability: 'medium',
            readability: 'low',
          },
        });
      }
    }

    return suggestions;
  }

  private countNestedIfs(node: ts.IfStatement, depth = 1): number {
    if (ts.isIfStatement(node.thenStatement)) {
      return this.countNestedIfs(
        node.thenStatement as ts.IfStatement,
        depth + 1
      );
    }
    if (ts.isBlock(node.thenStatement)) {
      for (const statement of node.thenStatement.statements) {
        if (ts.isIfStatement(statement)) {
          return this.countNestedIfs(statement, depth + 1);
        }
      }
    }
    return depth;
  }

  private countLogicalOperators(node: ts.Node): number {
    let count = 0;

    const visit = (n: ts.Node) => {
      if (ts.isBinaryExpression(n)) {
        if (
          n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          n.operatorToken.kind === ts.SyntaxKind.BarBarToken
        ) {
          count++;
        }
      }
      ts.forEachChild(n, visit);
    };

    visit(node);
    return count;
  }

  private calculateEstimatedImpact(
    suggestions: RefactorSuggestion[]
  ): 'low' | 'medium' | 'high' {
    const highImpact = suggestions.filter(
      (s) =>
        s.impact.readability === 'high' || s.impact.maintainability === 'high'
    ).length;

    const errors = suggestions.filter((s) => s.severity === 'error').length;

    if (errors > 0 || highImpact > 5) return 'high';
    if (highImpact > 2) return 'medium';
    return 'low';
  }

  /**
   * Folds findings that differ only in where they occur onto one entry.
   *
   * The key is every field but the locations, so two entries merge only when
   * their message, advice, code example, severity and impact are all
   * identical -- a merge can therefore not change what the response says
   * about any one place. Locations keep first-seen order, and a location
   * repeated for the same finding is kept once.
   */
  private foldIdenticalFindings(
    raw: RefactorSuggestion[]
  ): RefactorSuggestion[] {
    const folded = new Map<string, RefactorSuggestion>();

    for (const finding of raw) {
      const { locations, ...withoutLocations } = finding;
      const key = JSON.stringify(withoutLocations);
      const existing = folded.get(key);
      if (existing === undefined) {
        folded.set(key, { ...withoutLocations, locations: [...locations] });
        continue;
      }
      for (const place of locations) {
        const alreadyThere = existing.locations.some(
          ([line, column]) => line === place[0] && column === place[1]
        );
        if (!alreadyThere) {
          existing.locations.push(place);
        }
      }
    }

    return [...folded.values()];
  }

  /**
   * Moves each type's advice into a shared map and drops the copies that
   * repeat it -- BUT ONLY WHERE SHARING IT SAVES SOMETHING.
   *
   * The entry for a type was previously taken from the first finding of that
   * type whatever its reuse, so a type with one finding paid a dictionary key
   * and a wrapper object to avoid repeating a value that appeared once. On the
   * benched fixture four of the five entries served exactly one row each: 70
   * tokens spent to deduplicate nothing.
   *
   * So each field is hoisted only when AT LEAST TWO findings would rely on it,
   * counted per field, because a finding can share a type's advice while
   * carrying its own example. A field that would serve one finding stays on
   * that finding instead, and a type left with neither field gets no entry.
   *
   * Which advice is shareable follows from how it is written, not from this
   * count: `improve-naming` states a general rule and every finding of that
   * type repeats it, while `extract-constant` names the literal it found, so
   * two of those findings never produce the same string and that type is now
   * never hoisted. A field is still left off a finding only when it is
   * byte-identical to the entry, so a finding whose advice differs keeps its
   * own and reads exactly as before.
   */
  private hoistGuidance(suggestions: RefactorSuggestion[]): {
    guidance: Record<string, RefactorGuidance>;
    rows: RefactorSuggestionRow[];
  } {
    const candidates = new Map<string, RefactorGuidance>();

    for (const finding of suggestions) {
      if (candidates.has(finding.type)) continue;
      const entry: RefactorGuidance = { suggestion: finding.suggestion };
      if (finding.codeExample !== undefined) {
        entry.codeExample = finding.codeExample;
      }
      candidates.set(finding.type, entry);
    }

    // How many findings each candidate field would actually save a copy of.
    const sharesSuggestion = new Map<string, number>();
    const sharesExample = new Map<string, number>();
    for (const finding of suggestions) {
      const candidate = candidates.get(finding.type);
      if (candidate === undefined) continue;
      if (candidate.suggestion === finding.suggestion) {
        sharesSuggestion.set(
          finding.type,
          (sharesSuggestion.get(finding.type) ?? 0) + 1
        );
      }
      if (
        finding.codeExample !== undefined &&
        JSON.stringify(candidate.codeExample) ===
          JSON.stringify(finding.codeExample)
      ) {
        sharesExample.set(
          finding.type,
          (sharesExample.get(finding.type) ?? 0) + 1
        );
      }
    }

    const guidance: Record<string, RefactorGuidance> = {};
    for (const [type, candidate] of candidates) {
      const keepSuggestion = (sharesSuggestion.get(type) ?? 0) > 1;
      const keepExample = (sharesExample.get(type) ?? 0) > 1;
      if (!keepSuggestion && !keepExample) continue;
      const entry: RefactorGuidance = {
        suggestion: keepSuggestion ? candidate.suggestion : '',
      };
      if (keepExample && candidate.codeExample !== undefined) {
        entry.codeExample = candidate.codeExample;
      }
      if (!keepSuggestion) {
        // The example is shared and the advice is not, so the entry carries
        // only the example; an empty string would read as advice that exists.
        delete (entry as { suggestion?: string }).suggestion;
      }
      guidance[type] = entry;
    }

    const rows = suggestions.map((finding) => {
      const shared = guidance[finding.type];
      const row: RefactorSuggestionRow = {
        type: finding.type,
        severity: finding.severity,
        locations: finding.locations,
        message: finding.message,
        impact: finding.impact,
      };
      if (shared === undefined || shared.suggestion !== finding.suggestion) {
        row.suggestion = finding.suggestion;
      }
      if (
        finding.codeExample !== undefined &&
        (shared === undefined ||
          JSON.stringify(shared.codeExample) !==
            JSON.stringify(finding.codeExample))
      ) {
        row.codeExample = finding.codeExample;
      }
      return row;
    });

    return { guidance, rows };
  }

  private async generateCacheKey(
    content: string,
    refactorTypes: string[],
    minComplexity: number
  ): Promise<string> {
    const hash = createHash('sha256');
    hash.update(this.cacheNamespace);
    hash.update(content);
    hash.update(JSON.stringify({ refactorTypes, minComplexity }));
    return `${this.cacheNamespace}:${hash.digest('hex')}`;
  }

  private getCachedResult(
    key: string,
    maxAge: number
  ): SmartRefactorResult | null {
    const cached = this.cache.get(key);
    if (!cached) return null;

    const { cachedAt, ...result } = JSON.parse(
      cached
    ) as SmartRefactorResult & {
      cachedAt: number;
    };
    const age = (Date.now() - cachedAt) / 1000;

    if (age <= maxAge) {
      result.summary.fromCache = true;
      return result;
    }

    return null;
  }

  private cacheResult(key: string, output: SmartRefactorResult): void {
    const toCache = { ...output, cachedAt: Date.now() };
    const buffer = JSON.stringify(toCache);
    this.cache.set(key, buffer, buffer.length, buffer.length, {
      ttlSeconds: 300,
    });
  }
}

// Factory function for dependency injection
export function getSmartRefactorTool(
  cache: CacheEngine,
  tokenCounter: TokenCounter,
  metrics: MetricsCollector,
  projectRoot?: string
): SmartRefactorTool {
  return new SmartRefactorTool(cache, tokenCounter, metrics, projectRoot);
}

// Standalone function for CLI usage
export async function runSmartRefactor(
  options: SmartRefactorOptions
): Promise<SmartRefactorResult> {
  const cache = new CacheEngine(
    resolveCacheLocation(join(homedir(), '.hypercontext', 'cache'))
  );
  const tokenCounter = new TokenCounter();
  const metrics = new MetricsCollector();
  const tool = getSmartRefactorTool(
    cache,
    tokenCounter,
    metrics,
    options.projectRoot
  );
  return tool.run(options);
}

// MCP tool definition
export { SMART_REFACTOR_TOOL_DEFINITION } from './analysis-tool-definitions.js';
