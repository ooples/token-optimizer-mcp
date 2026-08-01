/**
 * Smart GraphQL Tool - 83% Token Reduction
 *
 * GraphQL query optimizer with intelligent features:
 * - Query complexity analysis (depth, breadth, field count)
 * - Optimization suggestions (fragment extraction, field reduction)
 * - Response caching with query fingerprinting
 * - Schema introspection caching
 * - Batched query detection
 * - N+1 query problem detection
 * - Token-optimized output
 */

import { CacheEngine } from '../../core/cache-engine.js';
import { measured } from '../shared/savings.js';
import { TokenCounter } from '../../core/token-counter.js';
import { MetricsCollector } from '../../core/metrics.js';
import { createHash } from 'crypto';

interface SmartGraphQLOptions {
  /**
   * GraphQL query to analyze
   */
  query: string;

  /**
   * Query variables (optional)
   */
  variables?: Record<string, unknown>;

  /**
   * Operation name (optional)
   */
  operationName?: string;

  /**
   * GraphQL endpoint for schema introspection (optional)
   */
  endpoint?: string;

  /**
   * Enable complexity analysis (default: true)
   */
  analyzeComplexity?: boolean;

  /**
   * Detect N+1 query problems (default: true)
   */
  detectN1?: boolean;

  /**
   * Suggest query optimizations (default: true)
   */
  suggestOptimizations?: boolean;

  /**
   * Force fresh analysis (bypass cache)
   */
  force?: boolean;

  /**
   * Cache TTL in seconds (default: 300 = 5 minutes)
   */
  ttl?: number;
}

interface ComplexityMetrics {
  depth: number;
  breadth: number;
  fieldCount: number;
  score: number;
}

interface FragmentSuggestion {
  name: string;
  fields: string[];
  /** How many places select this exact field set. */
  usage: number;
}

interface FieldReduction {
  field: string;
  reason: string;
  impact: 'high' | 'medium' | 'low';
}

interface BatchOpportunity {
  queries: string[];
  reason: string;
  estimatedSavings: string;
}

interface N1Problem {
  field: string;
  location: string;
  severity: 'high' | 'medium' | 'low';
  suggestion: string;
}

interface QueryAnalysis {
  operation: 'query' | 'mutation' | 'subscription';
  name?: string;
  fields: string[];
  complexity: ComplexityMetrics;
}

interface Optimizations {
  fragmentSuggestions: FragmentSuggestion[];
  fieldReductions: FieldReduction[];
  batchOpportunities: BatchOpportunity[];
  n1Problems: N1Problem[];
}

interface SchemaInfo {
  types: number;
  queries: number;
  mutations: number;
  subscriptions: number;
}

interface SmartGraphQLResult {
  query: QueryAnalysis;
  optimizations?: Optimizations;
  schema?: SchemaInfo;
  cached: boolean;
  metrics: {
    originalTokens: number;
    compactedTokens: number;
    reductionPercentage: number;
  };
}

interface ParsedQuery {
  operation: 'query' | 'mutation' | 'subscription';
  name?: string;
  selections: Selection[];
  fragments: Fragment[];
}

interface Selection {
  name: string;
  fields: Selection[];
  depth: number;
  /**
   * The arguments the field was called with, by name.
   *
   * Pagination arguments are the only reliable signal that a field returns a
   * LIST when no schema is available, and telling lists from objects is the
   * whole basis of N+1 detection.
   */
  args?: string[];
  /**
   * Those arguments' literal values, where they are literals.
   *
   * `first: 20` on the outer list and `first: 10` on the inner one is what
   * turns "there is an N+1 here" into "this costs up to 200 resolutions",
   * which is the sentence somebody acts on.
   */
  argValues?: Record<string, string>;
}

interface Fragment {
  name: string;
  type: string;
  fields: string[];
}

export class SmartGraphQL {
  constructor(
    private cache: CacheEngine,
    private tokenCounter: TokenCounter,
    private metrics: MetricsCollector
  ) {}

  async run(options: SmartGraphQLOptions): Promise<SmartGraphQLResult> {
    const startTime = Date.now();
    const cacheKey = this.generateCacheKey(options);

    // Check cache first (if not forced)
    if (!options.force) {
      const cached = await this.getCachedResult(cacheKey, options.ttl || 300);
      if (cached) {
        const duration = Date.now() - startTime;
        this.metrics.record({
          operation: 'smart_graphql',
          duration,
          cacheHit: true,
          success: true,
          savedTokens: (() => {
            const tokenResult = this.tokenCounter.count(JSON.stringify(cached));
            return tokenResult.tokens;
          })(),
        });
        return this.transformOutput(cached, true);
      }
    }

    // Execute analysis
    const result = await this.analyzeQuery(options);

    // Cache result
    await this.cacheResult(cacheKey, result, options.ttl || 300);

    const duration = Date.now() - startTime;
    this.metrics.record({
      operation: 'smart_graphql',
      duration,
      cacheHit: false,
      success: true,
      savedTokens: 0,
    });

    return this.transformOutput(result, false);
  }

  private async analyzeQuery(options: SmartGraphQLOptions): Promise<{
    query: QueryAnalysis;
    optimizations?: Optimizations;
    schema?: SchemaInfo;
  }> {
    // Parse GraphQL query
    const parsed = this.parseQuery(options.query);

    // Calculate complexity
    const complexity = this.calculateComplexity(parsed);

    // Extract fields
    const fields = this.extractFields(parsed);

    // Create query analysis
    const queryAnalysis: QueryAnalysis = {
      operation: parsed.operation,
      name: parsed.name,
      fields,
      complexity,
    };

    // Detect optimizations (if enabled)
    let optimizations: Optimizations | undefined;
    if (options.suggestOptimizations !== false) {
      optimizations = {
        fragmentSuggestions: this.detectFragmentOpportunities(parsed),
        fieldReductions: this.detectFieldReductions(parsed),
        batchOpportunities: this.detectBatchOpportunities(parsed),
        n1Problems:
          options.detectN1 !== false ? this.detectN1Problems(parsed) : [],
      };
    }

    // Introspect schema if endpoint provided
    let schema: SchemaInfo | undefined;
    if (options.endpoint) {
      schema = await this.introspectSchema(options.endpoint);
    }

    return {
      query: queryAnalysis,
      optimizations,
      schema,
    };
  }

  private parseQuery(query: string): ParsedQuery {
    // Simple regex-based GraphQL parsing
    const trimmed = query.trim();

    // Detect operation type
    let operation: 'query' | 'mutation' | 'subscription' = 'query';
    if (trimmed.startsWith('mutation')) {
      operation = 'mutation';
    } else if (trimmed.startsWith('subscription')) {
      operation = 'subscription';
    }

    // Extract operation name (if present)
    const nameMatch = trimmed.match(/(?:query|mutation|subscription)\s+(\w+)/);
    const name = nameMatch ? nameMatch[1] : undefined;

    // Extract fragments
    const fragments = this.extractFragments(query);

    // The operation's own selection set, parsed as a tree.
    const selections = this.parseOperationBody(query);

    return {
      operation,
      name,
      selections,
      fragments,
    };
  }

  private extractFragments(query: string): Fragment[] {
    const fragments: Fragment[] = [];
    const fragmentRegex = /fragment\s+(\w+)\s+on\s+(\w+)\s*\{([^}]+)\}/g;
    let match;

    while ((match = fragmentRegex.exec(query)) !== null) {
      const [, name, type, body] = match;
      const fields = body
        .split(/\s+/)
        .filter((f) => f && !f.includes('{') && !f.includes('}'))
        .map((f) => f.trim());

      fragments.push({ name, type, fields });
    }

    return fragments;
  }

  /**
   * Parses a selection set into a real tree.
   *
   * THE OLD PARSER HAD NO TREE, AND EVERY ANALYSIS DEPENDED ON ONE.
   *
   * It ran one regex across the WHOLE query, deduplicated field names globally
   * with a `seenFields` set, and returned every identifier it found as a
   * top-level selection. So nesting was invented rather than observed: for
   *
   *     user { posts(first: 20) { comments(first: 10) { author { name } } }
   *            settings { theme locale notifications { email push sms } } }
   *
   * it reported `settings` as a top-level list with an N+1 problem, and never
   * saw the real one -- 20 posts each fetching 10 comments. It also collapsed
   * every repeat of a field, which is exactly the repetition the fragment
   * suggestions exist to find.
   *
   * GraphQL selection syntax is small enough to parse properly: alias, name,
   * arguments, directives, and an optional nested set. Doing so fixes all four
   * consumers -- complexity, field extraction, fragments and N+1 -- at once.
   *
   * @param body the INSIDE of a selection set, without its braces
   */
  private parseSelections(body: string, depth: number): Selection[] {
    const selections: Selection[] = [];
    let i = 0;

    const skipTrivia = (): void => {
      while (i < body.length) {
        const c = body[i];
        if (c === '#') {
          while (i < body.length && body[i] !== '\n') i++;
        } else if (c === ',' || /\s/.test(c)) {
          i++;
        } else {
          break;
        }
      }
    };

    /** Consumes a balanced (...) or {...} and returns its inside. */
    const consumeBalanced = (open: string, close: string): string => {
      if (body[i] !== open) return '';
      const from = i + 1;
      let level = 0;
      let inString: string | null = null;
      while (i < body.length) {
        const c = body[i];
        if (inString) {
          if (c === '\\') i++;
          else if (c === inString) inString = null;
        } else if (c === '"' || c === "'") {
          inString = c;
        } else if (c === open) {
          level++;
        } else if (c === close) {
          level--;
          if (level === 0) {
            const inside = body.slice(from, i);
            i++;
            return inside;
          }
        }
        i++;
      }
      return body.slice(from);
    };

    while (i < body.length) {
      skipTrivia();
      if (i >= body.length) break;

      // A fragment spread or inline fragment. `... on Type { ... }` contributes
      // its selections at this level, which is where they actually apply.
      if (body.startsWith('...', i)) {
        i += 3;
        skipTrivia();
        while (i < body.length && /[A-Za-z0-9_]/.test(body[i])) i++;
        skipTrivia();
        if (body[i] === '{') {
          const inner = consumeBalanced('{', '}');
          selections.push(...this.parseSelections(inner, depth));
        }
        continue;
      }

      // name, or alias: name
      const nameStart = i;
      while (i < body.length && /[A-Za-z0-9_]/.test(body[i])) i++;
      if (i === nameStart) {
        i++; // unrecognised character; do not spin
        continue;
      }
      let name = body.slice(nameStart, i);

      skipTrivia();
      if (body[i] === ':') {
        // What preceded the colon was the alias; the real field follows.
        i++;
        skipTrivia();
        const realStart = i;
        while (i < body.length && /[A-Za-z0-9_]/.test(body[i])) i++;
        if (i > realStart) name = body.slice(realStart, i);
      }

      // Arguments, kept by name so list-ness can be judged from them.
      let args: string[] | undefined;
      let argValues: Record<string, string> | undefined;
      skipTrivia();
      if (body[i] === '(') {
        const inside = consumeBalanced('(', ')');
        const pairs = [
          ...inside.matchAll(
            /(?:^|[,\s(])([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([^,()\s]+)/g
          ),
        ];
        if (pairs.length) {
          args = pairs.map((m) => m[1]);
          argValues = Object.fromEntries(pairs.map((m) => [m[1], m[2]]));
        }
      }

      // Directives: skipped, but their arguments must not be mistaken for the
      // field's own selection set.
      skipTrivia();
      while (body[i] === '@') {
        i++;
        while (i < body.length && /[A-Za-z0-9_]/.test(body[i])) i++;
        skipTrivia();
        if (body[i] === '(') consumeBalanced('(', ')');
        skipTrivia();
      }

      let fields: Selection[] = [];
      if (body[i] === '{') {
        const inner = consumeBalanced('{', '}');
        fields = this.parseSelections(inner, depth + 1);
      }

      selections.push({
        name,
        fields,
        depth,
        ...(args ? { args } : {}),
        ...(argValues ? { argValues } : {}),
      });
    }

    return selections;
  }

  /**
   * The selection set of the operation itself, without its header.
   */
  private parseOperationBody(query: string): Selection[] {
    const stripped = query.replace(/#[^\n]*/g, '');
    const open = stripped.indexOf('{');
    if (open === -1) return [];

    let level = 0;
    for (let j = open; j < stripped.length; j++) {
      if (stripped[j] === '{') level++;
      else if (stripped[j] === '}') {
        level--;
        if (level === 0) {
          return this.parseSelections(stripped.slice(open + 1, j), 0);
        }
      }
    }
    return this.parseSelections(stripped.slice(open + 1), 0);
  }

  private calculateComplexity(parsed: ParsedQuery): ComplexityMetrics {
    let maxDepth = 0;
    let totalBreadth = 0;
    let fieldCount = 0;

    const traverse = (selections: Selection[], currentDepth: number) => {
      if (selections.length === 0) return;

      maxDepth = Math.max(maxDepth, currentDepth);
      totalBreadth += selections.length;
      fieldCount += selections.length;

      for (const selection of selections) {
        traverse(selection.fields, currentDepth + 1);
      }
    };

    traverse(parsed.selections, 1);

    // Calculate complexity score: depth * breadth * log(fieldCount)
    const score = Math.round(
      maxDepth *
        (totalBreadth / Math.max(maxDepth, 1)) *
        Math.log10(Math.max(fieldCount, 1) + 1)
    );

    return {
      depth: maxDepth,
      breadth: Math.round(totalBreadth / Math.max(maxDepth, 1)),
      fieldCount,
      score,
    };
  }

  private extractFields(parsed: ParsedQuery): string[] {
    const fields: string[] = [];
    const seen = new Set<string>();

    const traverse = (selections: Selection[]) => {
      for (const selection of selections) {
        if (!seen.has(selection.name)) {
          seen.add(selection.name);
          fields.push(selection.name);
        }
        traverse(selection.fields);
      }
    };

    traverse(parsed.selections);
    return fields;
  }

  /**
   * Repeated field groups worth extracting into a fragment.
   *
   * THREE THINGS WERE WRONG, AND ALL THREE WERE VISIBLE IN ONE RESPONSE.
   *
   * The key was `${parentName}:${fields}`, so the SAME field set reached by two
   * differently-named parents produced two suggestions -- a real query returned
   * `idFragment [avatarUrl, id, name] usage 23` and `bodyFragment [avatarUrl,
   * id, name] usage 23`, which are one finding printed twice. The name came
   * from whichever parent was seen first, so `bodyFragment` described a group
   * containing no `body`. And `reason: "Field group repeated 23 times"`
   * restated `usage: 23` in prose, costing tokens to say nothing.
   *
   * Keying on the field SET fixes the duplication, naming from the content
   * fixes the label, and dropping `reason` removes the restatement.
   */
  private detectFragmentOpportunities(
    parsed: ParsedQuery
  ): FragmentSuggestion[] {
    // key: the sorted leaf-field set. value: every path that selects it.
    const groups = new Map<string, { fields: string[]; paths: string[] }>();

    const traverse = (selections: Selection[], path: string[]): void => {
      for (const selection of selections) {
        const here = [...path, selection.name];

        if (selection.fields.length > 1) {
          const fields = selection.fields.map((f) => f.name).sort();
          const key = fields.join(',');
          const entry = groups.get(key) ?? { fields, paths: [] };
          entry.paths.push(here.join('.'));
          groups.set(key, entry);
        }

        traverse(selection.fields, here);
      }
    };

    traverse(parsed.selections, []);

    const suggestions: FragmentSuggestion[] = [];
    for (const { fields, paths } of groups.values()) {
      if (paths.length < 2) continue;

      suggestions.push({
        // Named for what it CONTAINS. A fragment of {avatarUrl,id,name} is an
        // avatarUrlIdName fragment, whoever happens to select it.
        name: `${fields
          .slice(0, 3)
          .map((f, idx) => (idx === 0 ? f : f[0].toUpperCase() + f.slice(1)))
          .join('')}Fragment`,
        fields,
        usage: paths.length,
      });
    }

    // Most-repeated first: that is the order in which acting on them pays.
    suggestions.sort((a, b) => b.usage - a.usage);
    return suggestions.slice(0, 5);
  }

  private detectFieldReductions(parsed: ParsedQuery): FieldReduction[] {
    const reductions: FieldReduction[] = [];
    const commonFields = ['id', '__typename', 'createdAt', 'updatedAt'];

    // Check for overfetching common metadata fields
    const allFields = this.extractFields(parsed);
    const metadataCount = allFields.filter((f) =>
      commonFields.includes(f)
    ).length;

    if (metadataCount > 5) {
      reductions.push({
        field: 'metadata fields',
        reason: `Query includes ${metadataCount} metadata fields - consider if all are needed`,
        impact: 'medium',
      });
    }

    // Check for deeply nested queries
    if (parsed.selections.length > 0) {
      const maxDepth = Math.max(
        ...parsed.selections.map((s) => this.getSelectionDepth(s))
      );
      if (maxDepth > 4) {
        reductions.push({
          field: 'nested depth',
          reason: `Query depth of ${maxDepth} may indicate overfetching`,
          impact: 'high',
        });
      }
    }

    return reductions;
  }

  private getSelectionDepth(selection: Selection): number {
    if (selection.fields.length === 0) {
      return 1;
    }
    return (
      1 + Math.max(...selection.fields.map((f) => this.getSelectionDepth(f)))
    );
  }

  private detectBatchOpportunities(parsed: ParsedQuery): BatchOpportunity[] {
    const opportunities: BatchOpportunity[] = [];

    // Check for multiple root-level queries
    if (parsed.selections.length > 3 && parsed.operation === 'query') {
      opportunities.push({
        queries: parsed.selections.slice(0, 3).map((s) => s.name),
        reason: `${parsed.selections.length} separate queries could be batched`,
        estimatedSavings: 'Reduce network round trips by ~50%',
      });
    }

    return opportunities;
  }

  /**
   * Arguments that only ever appear on a field returning a LIST.
   *
   * Without a schema this is the strongest evidence available, and it is
   * evidence rather than a guess: `posts(first: 20)` is a list because it is
   * being paginated.
   */
  private static readonly PAGINATION_ARGS = new Set([
    'first',
    'last',
    'limit',
    'after',
    'before',
    'offset',
    'skip',
    'take',
  ]);

  /** Selection-set names that are list containers by convention. */
  private static readonly LIST_CONTAINERS = new Set([
    'edges',
    'nodes',
    'items',
    'results',
    'list',
  ]);

  /**
   * Whether a field returns a list.
   *
   * `name.endsWith('s')` was the whole test. It calls `settings`, `status`,
   * `address` and `analysis` lists, and that false positive was reported to
   * users as a high-severity N+1 problem on a plain object.
   */
  private isListField(selection: Selection): boolean {
    if (selection.fields.length === 0) return false;

    if (selection.args?.some((a) => SmartGraphQL.PAGINATION_ARGS.has(a))) {
      return true;
    }
    if (SmartGraphQL.LIST_CONTAINERS.has(selection.name.toLowerCase())) {
      return true;
    }
    // A Relay connection: `posts { edges { node { ... } } }`.
    if (
      selection.fields.some((f) =>
        SmartGraphQL.LIST_CONTAINERS.has(f.name.toLowerCase())
      )
    ) {
      return true;
    }
    return false;
  }

  /**
   * Finds the N+1 shape: a list whose members each pull another list.
   *
   * This used to flag ANY field ending in 's' that had nested objects, which
   * reported `settings -> theme, locale, notifications` as high severity while
   * missing `posts(first: 20) { comments(first: 10) }` -- the actual N+1, and
   * the one the query was written to demonstrate.
   *
   * Reporting the multiplication is what makes it actionable: 20 posts each
   * fetching 10 comments is 200 round trips, and that number is the argument
   * for a DataLoader.
   */
  private detectN1Problems(parsed: ParsedQuery): N1Problem[] {
    const problems: N1Problem[] = [];

    const countOf = (selection: Selection): number | null => {
      const raw =
        selection.argValues?.first ??
        selection.argValues?.last ??
        selection.argValues?.limit ??
        selection.argValues?.take;
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? n : null;
    };

    const walk = (selection: Selection, path: string[]): void => {
      const here = [...path, selection.name];

      if (this.isListField(selection)) {
        // Any list nested inside this one repeats per parent element.
        const nestedLists = selection.fields.filter((f) => this.isListField(f));
        for (const nested of nestedLists) {
          const outer = countOf(selection);
          const inner = countOf(nested);
          const multiplier =
            outer && inner
              ? ` -- up to ${outer} x ${inner} = ${outer * inner} resolutions`
              : '';

          problems.push({
            field: [...here, nested.name].join('.'),
            location: `${here.join('.')} -> ${nested.name}${multiplier}`,
            severity:
              outer && inner && outer * inner >= 100 ? 'high' : 'medium',
            suggestion:
              `Each ${selection.name} element resolves ${nested.name} separately. ` +
              'Batch with a DataLoader, or fetch the join in one round trip.',
          });
        }
      }

      for (const field of selection.fields) walk(field, here);
    };

    for (const selection of parsed.selections) walk(selection, []);

    return problems;
  }

  private async introspectSchema(endpoint: string): Promise<SchemaInfo> {
    // Placeholder for Phase 3 - return cached mock data
    // In production, this would execute an introspection query
    const cacheKey = `cache-${createHash('md5')
      .update('graphql_schema:' + endpoint)
      .digest('hex')}`;
    const cached = this.cache.get(cacheKey);

    if (cached) {
      return JSON.parse(cached.toString());
    }

    // Mock schema info
    const schemaInfo: SchemaInfo = {
      types: 42,
      queries: 15,
      mutations: 8,
      subscriptions: 3,
    };

    // Cache for 1 hour
    await this.cache.set(cacheKey, JSON.stringify(schemaInfo), 0, 3600);

    return schemaInfo;
  }

  private transformOutput(
    result: {
      query: QueryAnalysis;
      optimizations?: Optimizations;
      schema?: SchemaInfo;
    },
    fromCache: boolean
  ): SmartGraphQLResult {
    const fullOutput = JSON.stringify(result);
    const originalTokens = this.tokenCounter.count(fullOutput).tokens;
    // RETURN WHAT WAS MEASURED. See the note in smart-rest.ts -- this had the
    // same shape: three branches each built a compact payload and counted it,
    // then the function returned the full query/optimizations/schema anyway.
    // The last branch is the clearest: it measured "the complete data" and
    // reported an 80% reduction against itself.
    let compact: Record<string, unknown>;

    if (fromCache) {
      // Cached run: operation and complexity score only
      compact = {
        query: {
          operation: result.query.operation,
          complexity: { score: result.query.complexity.score },
        },
      };
    } else if (
      result.optimizations &&
      result.optimizations.fragmentSuggestions.length > 0
    ) {
      // Optimization scenario: top 3 suggestions, top 2 N+1 problems
      compact = {
        query: result.query,
        optimizations: {
          fragmentSuggestions: result.optimizations.fragmentSuggestions.slice(
            0,
            3
          ),
          totalFragmentSuggestions:
            result.optimizations.fragmentSuggestions.length,
          n1Problems: result.optimizations.n1Problems.slice(0, 2),
          totalN1Problems: result.optimizations.n1Problems.length,
        },
      };
    } else {
      // Nothing to trim: the analysis IS the answer, so no saving is claimed.
      compact = {
        query: result.query,
        optimizations: result.optimizations,
        schema: result.schema,
      };
    }

    const compactedTokens = this.tokenCounter.count(
      JSON.stringify(compact)
    ).tokens;
    const savings = measured(originalTokens, compactedTokens);

    return {
      ...compact,
      cached: fromCache,
      metrics: {
        originalTokens: savings.originalTokenCount,
        compactedTokens: savings.tokenCount,
        reductionPercentage: Math.round((1 - savings.compressionRatio) * 100),
      },
    } as SmartGraphQLResult;
  }

  private generateCacheKey(options: SmartGraphQLOptions): string {
    const keyData = {
      query: options.query,
      variables: options.variables,
      operationName: options.operationName,
      analyzeComplexity: options.analyzeComplexity,
      detectN1: options.detectN1,
      suggestOptimizations: options.suggestOptimizations,
    };

    const hash = createHash('sha256')
      .update(JSON.stringify(keyData))
      .digest('hex')
      .substring(0, 16);

    return `cache-${createHash('md5').update('smart_graphql').update(hash).digest('hex')}`;
  }

  private async getCachedResult(
    key: string,
    ttl: number
  ): Promise<{
    query: QueryAnalysis;
    optimizations?: Optimizations;
    schema?: SchemaInfo;
  } | null> {
    const cached = await this.cache.get(key);
    if (!cached) {
      return null;
    }

    const result = JSON.parse(cached.toString());
    const age = Date.now() - result.timestamp;

    if (age > ttl * 1000) {
      await this.cache.delete(key);
      return null;
    }

    return result;
  }

  private async cacheResult(
    key: string,
    result: {
      query: QueryAnalysis;
      optimizations?: Optimizations;
      schema?: SchemaInfo;
    },
    ttl: number
  ): Promise<void> {
    const cacheData = {
      ...result,
      timestamp: Date.now(),
    };

    const tokensSavedResult = this.tokenCounter.count(
      JSON.stringify(cacheData)
    );
    const tokensSaved = tokensSavedResult.tokens;

    this.cache.set(key, JSON.stringify(cacheData), tokensSaved, ttl);
  }
}

// ============================================================================
// Factory Function (for shared resources in benchmarks/tests)
// ============================================================================

export function getSmartGraphQL(
  cache: CacheEngine,
  tokenCounter: TokenCounter,
  metrics: MetricsCollector
): SmartGraphQL {
  return new SmartGraphQL(cache, tokenCounter, metrics);
}

// ============================================================================
// CLI Function (creates own resources for standalone use)
// ============================================================================

export async function runSmartGraphQL(
  options: SmartGraphQLOptions
): Promise<string> {
  const { homedir } = await import('os');
  const { join } = await import('path');

  const cache = new CacheEngine(join(homedir(), '.hypercontext', 'cache'), 100);
  const tokenCounter = new TokenCounter();
  const metrics = new MetricsCollector();
  const graphql = getSmartGraphQL(cache, tokenCounter, metrics);

  const result = await graphql.run(options);

  return JSON.stringify(result, null, 2);
}

// MCP tool definition
export const SMART_GRAPHQL_TOOL_DEFINITION = {
  name: 'smart_graphql',
  description:
    'GraphQL query optimizer with complexity analysis and caching (83% token reduction)',
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string' as const,
        description: 'GraphQL query to analyze',
      },
      variables: {
        type: 'object' as const,
        description: 'Query variables (optional)',
      },
      operationName: {
        type: 'string' as const,
        description: 'Operation name (optional)',
      },
      endpoint: {
        type: 'string' as const,
        description: 'GraphQL endpoint for schema introspection (optional)',
      },
      analyzeComplexity: {
        type: 'boolean' as const,
        description: 'Enable complexity analysis (default: true)',
      },
      detectN1: {
        type: 'boolean' as const,
        description: 'Detect N+1 query problems (default: true)',
      },
      suggestOptimizations: {
        type: 'boolean' as const,
        description: 'Suggest query optimizations (default: true)',
      },
      force: {
        type: 'boolean' as const,
        description: 'Force fresh analysis (bypass cache)',
      },
      ttl: {
        type: 'number' as const,
        description: 'Cache TTL in seconds (default: 300)',
      },
    },
    required: ['query'],
  },
};

// Export types
export type {
  SmartGraphQLOptions,
  SmartGraphQLResult,
  ComplexityMetrics,
  FragmentSuggestion,
  FieldReduction,
  BatchOpportunity,
  N1Problem,
  QueryAnalysis,
  Optimizations,
  SchemaInfo,
};
