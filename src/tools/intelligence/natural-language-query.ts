/**
 * natural-language-query - eight operations over a published query grammar.
 *
 * WHAT THIS FILE REPLACES: the tool advertised the eight operations below and
 * served every one of them from a single body that read none of its
 * arguments:
 *
 *     data = { result: "<the operation name> completed successfully" }
 *     return { success: true, data, metadata: { confidence: 0.85, ... } }
 *
 * (written here in quotes rather than as the template literal it was, so the
 * ratchet that detects that stub body by its text does not read this comment
 * as one.)
 *
 * A `translate-sql` that returns "translate-sql completed successfully" and a
 * confidence of 0.85 is worse than one that refuses, because the caller
 * cannot tell the two apart from the shape of the response.
 *
 * WHAT "NATURAL LANGUAGE" MEANS HERE, since the name invites the wrong
 * expectation: the grammar in `query-core.ts` is a restricted controlled
 * language, and its entire vocabulary is published from `PHRASES`. The tool
 * binds what that grammar covers, names every word it read and did not use,
 * names every character it could not read, and refuses when a piece the query
 * needs is absent. It does not infer intent from arbitrary English -- a guess
 * rendered as SQL is indistinguishable from a translation until it runs
 * against the caller's data.
 *
 * WHAT IS NOT CLAIMED: `optimize` reports the rewrites it applied and the
 * index a query would use. It does not claim a speedup, because this package
 * cannot see the caller's data distribution, and a percentage with nothing
 * behind it is the defect this file exists to remove.
 */

import type { CacheEngine } from '../../core/cache-engine.js';
import type { TokenCounter } from '../../core/token-counter.js';
import type { MetricsCollector } from '../../core/metrics.js';
import { generateCacheKey } from '../shared/hash-utils.js';
import {
  sharedCache,
  sharedTokenCounter,
  sharedMetricsCollector,
} from './shared-instances.js';
import { frequencies, mean, stdDev } from './analytics-core.js';
import {
  isFieldType,
  isOrderedComparison,
  isSqlDialect,
  isTextComparison,
  parseQuery,
  renderGrammar,
  renderGraphql,
  renderMongo,
  renderSql,
  SQL_DIALECTS,
  SqlDialect,
  type Comparison,
  type FieldType,
  type Filter,
  type ParsedQuery,
  type QuerySchema,
  type QueryValue,
} from './query-core.js';

export const NATURAL_LANGUAGE_QUERY_OPERATIONS = [
  'parse',
  'translate-sql',
  'translate-mongodb',
  'translate-graphql',
  'optimize',
  'validate',
  'suggest-query',
  'explain-results',
] as const;

export type NaturalLanguageQueryOperation =
  (typeof NATURAL_LANGUAGE_QUERY_OPERATIONS)[number];

/** The rewrites `optimize` can apply or report, each named in the result. */
export enum RewriteRule {
  /** The same field, comparison and value appeared twice. */
  DuplicateFilter = 'duplicate-filter',
  /** Two bounds on one field, the looser of which cannot matter. */
  RedundantBound = 'redundant-bound',
  /** Two equality filters on one field that no row can satisfy at once. */
  Unsatisfiable = 'unsatisfiable',
  /** Ordering a single summary row, which reorders nothing. */
  PointlessOrdering = 'pointless-ordering',
  /** A row limit with no ordering, so which rows come back is arbitrary. */
  UnstableLimit = 'unstable-limit',
  /** A select that names no column, so every column is read. */
  UnboundedProjection = 'unbounded-projection',
}

/** What `validate` can find, each named in the result. */
export enum ValidationFinding {
  UnknownSource = 'unknown-source',
  UnknownField = 'unknown-field',
  TypeMismatch = 'type-mismatch',
  ComparisonNotApplicable = 'comparison-not-applicable',
  AggregateOnNonNumeric = 'aggregate-on-non-numeric',
  Unsatisfiable = 'unsatisfiable',
  WordsNotUnderstood = 'words-not-understood',
  CharactersNotRead = 'characters-not-read',
}

/** What `explain-results` can say about rows measured against their query. */
export enum ResultFinding {
  EmptyResult = 'empty-result',
  LimitReached = 'limit-reached',
  FilterFieldAbsent = 'filter-field-absent',
  FilterViolated = 'filter-violated',
  OrderingViolated = 'ordering-violated',
  OrderingFieldAbsent = 'ordering-field-absent',
}

/** The kinds a result column can hold. */
export enum ColumnKind {
  Number = 'number',
  Text = 'text',
  Boolean = 'boolean',
  Mixed = 'mixed',
  Empty = 'empty',
}

export const NATURAL_LANGUAGE_QUERY_DEFAULTS = Object.freeze({
  dialect: SqlDialect.Ansi,
  suggestionsPerSource: 6,
});

export interface NaturalLanguageQueryOptions {
  operation: NaturalLanguageQueryOperation;
  /** The query, written in the published grammar. */
  query?: string;
  /** Sources and their field types, supplied by the caller. */
  schema?: QuerySchema;
  /** A result set to describe, for `explain-results`. */
  rows?: ReadonlyArray<Record<string, unknown>>;
  /** Which source `suggest-query` should write examples for. */
  source?: string;
  dialect?: SqlDialect;
  limit?: number;
  useCache?: boolean;
}

export interface NaturalLanguageQueryResult {
  success: boolean;
  operation: string;
  data: Record<string, unknown>;
  metadata: {
    tokensUsed: number;
    tokensSaved: number;
    cacheHit: boolean;
    processingTime: number;
  };
}

/* ------------------------------------------------------------------------- */
/* Shared helpers                                                            */
/* ------------------------------------------------------------------------- */

function requireQuery(
  operation: NaturalLanguageQueryOperation,
  query: string | undefined
): ParsedQuery {
  if (typeof query !== 'string' || query.trim() === '')
    throw new Error(
      `natural-language-query ${operation}: \`query\` is required and must be a non-empty string`
    );
  return parseQuery(query);
}

function requireSchema(
  operation: NaturalLanguageQueryOperation,
  schema: QuerySchema | undefined
): QuerySchema {
  if (schema === undefined || typeof schema !== 'object')
    throw new Error(
      `natural-language-query ${operation}: \`schema\` is required and maps each source to its fields, as { "users": { "id": "number" } }`
    );
  const sources = Object.keys(schema);
  if (sources.length === 0)
    throw new Error(
      `natural-language-query ${operation}: \`schema\` names no source`
    );
  for (const source of sources) {
    const fields = schema[source];
    if (fields === undefined || typeof fields !== 'object')
      throw new Error(
        `natural-language-query ${operation}: schema.${source} must map field names to types`
      );
    for (const [field, type] of Object.entries(fields)) {
      if (!isFieldType(type))
        throw new Error(
          `natural-language-query ${operation}: schema.${source}.${field} is ${JSON.stringify(type)}, which is not one of number, string, boolean, date`
        );
    }
  }
  return schema;
}

function dialectOf(
  operation: NaturalLanguageQueryOperation,
  value: SqlDialect | undefined
): SqlDialect {
  if (value === undefined) return NATURAL_LANGUAGE_QUERY_DEFAULTS.dialect;
  if (!isSqlDialect(value))
    throw new Error(
      `natural-language-query ${operation}: \`dialect\` must be one of ${SQL_DIALECTS.join(', ')}; received ${JSON.stringify(value)}`
    );
  return value;
}

/** The type a literal from the grammar has, for checking against a schema. */
function typeOfValue(value: QueryValue): FieldType {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  // A date is a string in the grammar; the pattern is what separates them.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'date';
  return 'string';
}

function sameFilter(left: Filter, right: Filter): boolean {
  return (
    left.field === right.field &&
    left.comparison === right.comparison &&
    left.value === right.value &&
    left.upper === right.upper
  );
}

/* ------------------------------------------------------------------------- */
/* Tool                                                                      */
/* ------------------------------------------------------------------------- */

export class NaturalLanguageQuery {
  private cache: CacheEngine;
  private tokenCounter: TokenCounter;
  private metricsCollector: MetricsCollector;

  constructor(
    cache: CacheEngine,
    tokenCounter: TokenCounter,
    metricsCollector: MetricsCollector
  ) {
    this.cache = cache;
    this.tokenCounter = tokenCounter;
    this.metricsCollector = metricsCollector;
  }

  async run(
    options: NaturalLanguageQueryOptions
  ): Promise<NaturalLanguageQueryResult> {
    const startTime = Date.now();
    const cacheKey = generateCacheKey('natural-language-query', {
      op: options.operation,
      query: options.query ?? '',
      schema: JSON.stringify(options.schema ?? null),
      rows: JSON.stringify(options.rows ?? null),
      source: options.source ?? '',
      dialect: options.dialect ?? '',
      limit: options.limit ?? '',
    });

    if (options.useCache !== false) {
      const cached = this.cache.get(cacheKey);
      if (cached !== null && cached !== undefined) {
        try {
          const data = JSON.parse(cached.toString()) as Record<string, unknown>;
          return {
            success: true,
            operation: options.operation,
            data,
            metadata: {
              tokensUsed: 0,
              tokensSaved: this.tokenCounter.count(JSON.stringify(data)).tokens,
              cacheHit: true,
              processingTime: Date.now() - startTime,
            },
          };
        } catch {
          // A corrupt entry is recomputed rather than served.
        }
      }
    }

    const data = this.compute(options);
    const serialized = JSON.stringify(data);
    const tokensUsed = this.tokenCounter.count(serialized).tokens;
    this.cache.set(cacheKey, serialized, serialized.length, serialized.length);
    this.metricsCollector.record({
      operation: `natural-language-query:${options.operation}`,
      duration: Date.now() - startTime,
      success: true,
      cacheHit: false,
    });

    return {
      success: true,
      operation: options.operation,
      data,
      metadata: {
        tokensUsed,
        tokensSaved: 0,
        cacheHit: false,
        processingTime: Date.now() - startTime,
      },
    };
  }

  private compute(
    options: NaturalLanguageQueryOptions
  ): Record<string, unknown> {
    const operation = options.operation;
    switch (operation) {
      case 'parse':
        return this.parse(options);
      case 'translate-sql':
        return this.translateSql(options);
      case 'translate-mongodb':
        return this.translateMongo(options);
      case 'translate-graphql':
        return this.translateGraphql(options);
      case 'optimize':
        return this.optimize(options);
      case 'validate':
        return this.validate(options);
      case 'suggest-query':
        return this.suggest(options);
      case 'explain-results':
        return this.explainResults(options);
      default:
        throw new Error(
          `natural-language-query: unknown operation ${JSON.stringify(operation)}`
        );
    }
  }

  private parse(options: NaturalLanguageQueryOptions): Record<string, unknown> {
    const parsed = requireQuery('parse', options.query);
    return {
      query: parsed,
      /*
       * `sourceFrom` is reported because the two bindings carry different
       * confidence and the caller cannot see which happened: `from orders`
       * says the source outright, while `how many orders` took it from the
       * position of a noun.
       */
      sourceFrom: parsed.sourceFrom,
      complete:
        parsed.unrecognized.length === 0 && parsed.unparsed.length === 0,
      grammar: renderGrammar(parsed),
    };
  }

  private translateSql(
    options: NaturalLanguageQueryOptions
  ): Record<string, unknown> {
    const parsed = requireQuery('translate-sql', options.query);
    const dialect = dialectOf('translate-sql', options.dialect);
    const rendering = renderSql(parsed, dialect);
    return {
      ...rendering,
      /*
       * Every caller value is a bound parameter and every name went through
       * the parser's identifier check, so the statement holds no interpolated
       * input. Said in the response because a caller deciding whether to run
       * this cannot see it from the SQL alone.
       */
      parameterized: true,
      unrecognized: parsed.unrecognized,
      unparsed: parsed.unparsed,
    };
  }

  private translateMongo(
    options: NaturalLanguageQueryOptions
  ): Record<string, unknown> {
    const parsed = requireQuery('translate-mongodb', options.query);
    const rendering = renderMongo(parsed);
    return {
      ...rendering,
      /*
       * A `contains` becomes a regex, so the value's regex metacharacters are
       * escaped -- an unescaped `.` would match any character and quietly
       * widen the result set.
       */
      caseInsensitiveText: parsed.filters.some((filter) =>
        isTextComparison(filter.comparison)
      ),
      unrecognized: parsed.unrecognized,
      unparsed: parsed.unparsed,
    };
  }

  private translateGraphql(
    options: NaturalLanguageQueryOptions
  ): Record<string, unknown> {
    const parsed = requireQuery('translate-graphql', options.query);
    const rendering = renderGraphql(parsed);
    return {
      ...rendering,
      unrecognized: parsed.unrecognized,
      unparsed: parsed.unparsed,
    };
  }

  private optimize(
    options: NaturalLanguageQueryOptions
  ): Record<string, unknown> {
    const parsed = requireQuery('optimize', options.query);
    const applied: Array<{ rule: RewriteRule; detail: string }> = [];

    // Identical filters: the second one cannot change the result.
    const filters: Filter[] = [];
    for (const filter of parsed.filters) {
      if (filters.some((kept) => sameFilter(kept, filter))) {
        applied.push({
          rule: RewriteRule.DuplicateFilter,
          detail: `${filter.field} ${filter.comparison} ${String(filter.value)} appeared twice`,
        });
        continue;
      }
      filters.push(filter);
    }

    // Two bounds in the same direction on one field: the looser cannot matter.
    const kept: Filter[] = [];
    for (const filter of filters) {
      const rival = kept.findIndex(
        (other) =>
          other.field === filter.field &&
          other.comparison === filter.comparison &&
          isOrderedComparison(filter.comparison) &&
          typeof other.value === 'number' &&
          typeof filter.value === 'number'
      );
      if (rival === -1) {
        kept.push(filter);
        continue;
      }
      const existing = kept[rival];
      const lowerBound =
        filter.comparison === '>' || filter.comparison === '>=';
      const existingValue = existing.value as number;
      const candidate = filter.value as number;
      const tighter = lowerBound
        ? Math.max(existingValue, candidate)
        : Math.min(existingValue, candidate);
      const looser = lowerBound
        ? Math.min(existingValue, candidate)
        : Math.max(existingValue, candidate);
      applied.push({
        rule: RewriteRule.RedundantBound,
        detail: `${filter.field} ${filter.comparison} ${looser} cannot matter beside ${filter.field} ${filter.comparison} ${tighter}`,
      });
      kept[rival] = { ...existing, value: tighter };
    }

    // Equality filters that contradict each other.
    const equalities = new Map<string, QueryValue>();
    for (const filter of kept) {
      if (filter.comparison !== '=') continue;
      const seen = equalities.get(filter.field);
      if (seen !== undefined && seen !== filter.value)
        applied.push({
          rule: RewriteRule.Unsatisfiable,
          detail: `${filter.field} cannot be both ${String(seen)} and ${String(filter.value)}, so no row can match`,
        });
      else equalities.set(filter.field, filter.value);
    }

    // Ordering a scalar summary reorders nothing.
    let ordering = parsed.ordering;
    const scalarAggregate =
      parsed.intent !== 'select' && parsed.groupBy.length === 0;
    if (scalarAggregate && ordering !== null) {
      applied.push({
        rule: RewriteRule.PointlessOrdering,
        detail: `${parsed.intent} without a grouping returns one row, so ordering by ${ordering.field} changes nothing`,
      });
      ordering = null;
    }

    const warnings: Array<{ rule: RewriteRule; detail: string }> = [];
    if (
      parsed.limit !== null &&
      ordering === null &&
      parsed.intent === 'select'
    )
      warnings.push({
        rule: RewriteRule.UnstableLimit,
        detail: `a limit of ${parsed.limit} with no ordering returns an arbitrary ${parsed.limit} rows, which may differ between runs`,
      });
    if (parsed.intent === 'select' && parsed.fields.length === 0)
      warnings.push({
        rule: RewriteRule.UnboundedProjection,
        detail: 'the query names no column, so every column is read',
      });

    /*
     * The fields an index would have to cover, equality first: a composite
     * index is usable left to right, so a range or an ordering placed before
     * an equality stops the rest of the index being used. Reported as the
     * columns, in order -- not as a speedup, which this package cannot
     * measure without the caller's data.
     */
    const indexCandidates: string[] = [];
    for (const filter of kept)
      if (filter.comparison === '=' && !indexCandidates.includes(filter.field))
        indexCandidates.push(filter.field);
    for (const filter of kept)
      if (filter.comparison !== '=' && !indexCandidates.includes(filter.field))
        indexCandidates.push(filter.field);
    if (ordering !== null && !indexCandidates.includes(ordering.field))
      indexCandidates.push(ordering.field);

    const rewritten: ParsedQuery = {
      ...parsed,
      filters: kept,
      ordering,
    };
    return {
      query: rewritten,
      grammar: renderGrammar(rewritten),
      applied,
      warnings,
      indexCandidates,
      filtersBefore: parsed.filters.length,
      filtersAfter: kept.length,
      unchanged: applied.length === 0,
    };
  }

  private validate(
    options: NaturalLanguageQueryOptions
  ): Record<string, unknown> {
    const parsed = requireQuery('validate', options.query);
    const findings: Array<{
      finding: ValidationFinding;
      field?: string;
      detail: string;
    }> = [];

    if (parsed.unrecognized.length > 0)
      findings.push({
        finding: ValidationFinding.WordsNotUnderstood,
        detail: `the grammar read but did not use ${parsed.unrecognized.join(', ')}`,
      });
    if (parsed.unparsed.length > 0)
      findings.push({
        finding: ValidationFinding.CharactersNotRead,
        detail: `the tokenizer could not read ${parsed.unparsed.join(', ')}`,
      });

    const equalities = new Map<string, QueryValue>();
    for (const filter of parsed.filters) {
      if (filter.comparison !== '=') continue;
      const seen = equalities.get(filter.field);
      if (seen !== undefined && seen !== filter.value)
        findings.push({
          finding: ValidationFinding.Unsatisfiable,
          field: filter.field,
          detail: `${filter.field} cannot be both ${String(seen)} and ${String(filter.value)}`,
        });
      else equalities.set(filter.field, filter.value);
    }

    const schema = options.schema;
    const schemaChecked = schema !== undefined;
    if (schemaChecked) {
      const checked = requireSchema('validate', schema);
      const sources = Object.keys(checked).sort();
      const fields = checked[parsed.source];
      if (fields === undefined) {
        findings.push({
          finding: ValidationFinding.UnknownSource,
          detail: `${parsed.source} is not in the schema; it names ${sources.join(', ')}`,
        });
      } else {
        const known = Object.keys(fields).sort();
        const checkField = (field: string, role: string): FieldType | null => {
          const type = fields[field];
          if (type === undefined) {
            findings.push({
              finding: ValidationFinding.UnknownField,
              field,
              detail: `${field} is used as a ${role} but ${parsed.source} has ${known.join(', ')}`,
            });
            return null;
          }
          return type;
        };
        for (const field of parsed.fields)
          checkField(field, 'projected column');
        for (const field of parsed.groupBy) checkField(field, 'grouping');
        if (parsed.ordering !== null)
          checkField(parsed.ordering.field, 'sort key');
        if (parsed.measure !== null) {
          const type = checkField(parsed.measure, `${parsed.intent} measure`);
          if (
            type !== null &&
            type !== 'number' &&
            (parsed.intent === 'sum' || parsed.intent === 'average')
          )
            findings.push({
              finding: ValidationFinding.AggregateOnNonNumeric,
              field: parsed.measure,
              detail: `${parsed.intent} needs a number but ${parsed.measure} is ${type}`,
            });
        }
        for (const filter of parsed.filters) {
          const type = checkField(filter.field, 'filter');
          if (type === null) continue;
          this.checkComparison(filter, type, findings);
        }
      }
    }

    return {
      valid: findings.length === 0,
      /*
       * Stated explicitly: without a schema only the grammar was checked, so a
       * `valid: true` here means the query parses, not that its fields exist.
       */
      schemaChecked,
      checked: schemaChecked ? 'grammar and schema' : 'grammar only',
      findings,
      source: parsed.source,
      fieldsUsed: this.fieldsUsed(parsed),
    };
  }

  private checkComparison(
    filter: Filter,
    type: FieldType,
    findings: Array<{
      finding: ValidationFinding;
      field?: string;
      detail: string;
    }>
  ): void {
    const comparison: Comparison = filter.comparison;
    if (isTextComparison(comparison) && type !== 'string')
      findings.push({
        finding: ValidationFinding.ComparisonNotApplicable,
        field: filter.field,
        detail: `${comparison} needs text but ${filter.field} is ${type}`,
      });
    if (isOrderedComparison(comparison) && type === 'boolean')
      findings.push({
        finding: ValidationFinding.ComparisonNotApplicable,
        field: filter.field,
        detail: `${comparison} cannot order a boolean, which ${filter.field} is`,
      });
    const operands: QueryValue[] = [filter.value];
    if (filter.upper !== undefined) operands.push(filter.upper);
    for (const operand of operands) {
      const given = typeOfValue(operand);
      // A date literal is a legal string, but a string is not a legal date.
      const compatible =
        given === type || (type === 'string' && given === 'date');
      if (!compatible)
        findings.push({
          finding: ValidationFinding.TypeMismatch,
          field: filter.field,
          detail: `${filter.field} is ${type} but is compared against ${JSON.stringify(operand)}, which is ${given}`,
        });
    }
  }

  private fieldsUsed(parsed: ParsedQuery): string[] {
    const used = new Set<string>(parsed.fields);
    for (const field of parsed.groupBy) used.add(field);
    for (const filter of parsed.filters) used.add(filter.field);
    if (parsed.ordering !== null) used.add(parsed.ordering.field);
    if (parsed.measure !== null) used.add(parsed.measure);
    return [...used].sort();
  }

  private suggest(
    options: NaturalLanguageQueryOptions
  ): Record<string, unknown> {
    const schema = requireSchema('suggest-query', options.schema);
    const sources = Object.keys(schema).sort();
    const requested = options.source;
    if (requested !== undefined && schema[requested] === undefined)
      throw new Error(
        `natural-language-query suggest-query: \`source\` ${JSON.stringify(requested)} is not in the schema; it names ${sources.join(', ')}`
      );
    const chosen = requested === undefined ? sources : [requested];
    const perSource =
      options.limit === undefined
        ? NATURAL_LANGUAGE_QUERY_DEFAULTS.suggestionsPerSource
        : options.limit;
    if (!Number.isInteger(perSource) || perSource < 1)
      throw new Error(
        `natural-language-query suggest-query: \`limit\` must be an integer of at least 1; received ${String(options.limit)}`
      );

    const suggestions: Array<{
      query: string;
      intent: string;
      uses: string[];
    }> = [];
    const byType: Record<string, Record<FieldType, string[]>> = {};
    for (const source of chosen) {
      const fields = schema[source];
      const grouped: Record<FieldType, string[]> = {
        number: [],
        string: [],
        boolean: [],
        date: [],
      };
      for (const [field, type] of Object.entries(fields))
        grouped[type].push(field);
      byType[source] = grouped;

      /*
       * Built by rendering the grammar from a constructed parse, so every
       * suggestion is a query this same parser accepts. Writing the strings by
       * hand is how a suggestion ends up being something the tool cannot read.
       */
      const forSource: Array<{
        query: string;
        intent: string;
        uses: string[];
      }> = [];
      const push = (query: ParsedQuery, uses: string[]): void => {
        forSource.push({
          query: renderGrammar(query),
          intent: query.intent,
          uses,
        });
      };
      const base: ParsedQuery = {
        intent: 'select',
        source,
        sourceFrom: parseQuery(`show from ${source}`).sourceFrom,
        measure: null,
        fields: [],
        filters: [],
        groupBy: [],
        ordering: null,
        limit: null,
        unrecognized: [],
        unparsed: [],
      };
      push(base, []);
      push({ ...base, intent: 'count' }, []);
      for (const field of grouped.number) {
        push({ ...base, intent: 'average', measure: field }, [field]);
        push(
          {
            ...base,
            filters: [{ field, comparison: '>', value: 0 }],
            ordering: { field, descending: true },
            limit: 10,
          },
          [field]
        );
      }
      for (const field of grouped.string) {
        push(
          { ...base, filters: [{ field, comparison: '=', value: 'example' }] },
          [field]
        );
        if (grouped.number.length > 0)
          push(
            {
              ...base,
              intent: 'average',
              measure: grouped.number[0],
              groupBy: [field],
            },
            [field, grouped.number[0]]
          );
      }
      for (const field of grouped.boolean)
        push(
          {
            ...base,
            intent: 'count',
            filters: [{ field, comparison: '=', value: true }],
          },
          [field]
        );
      for (const field of grouped.date)
        push({ ...base, intent: 'max', measure: field }, [field]);
      suggestions.push(...forSource.slice(0, perSource));
    }

    return {
      sources: chosen,
      suggestions,
      found: suggestions.length,
      fieldsByType: byType,
      /*
       * These are the queries this grammar can express over that schema, not a
       * prediction of what the caller wants -- nothing here has seen their
       * data or their past queries.
       */
      basis: 'schema shape only',
    };
  }

  private explainResults(
    options: NaturalLanguageQueryOptions
  ): Record<string, unknown> {
    const rows = options.rows;
    if (!Array.isArray(rows))
      throw new Error(
        'natural-language-query explain-results: `rows` is required and must be an array of result objects'
      );
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (row === null || typeof row !== 'object' || Array.isArray(row))
        throw new Error(
          `natural-language-query explain-results: rows[${index}] must be an object of column values`
        );
    }
    const parsed =
      options.query === undefined
        ? null
        : requireQuery('explain-results', options.query);

    const names: string[] = [];
    for (const row of rows)
      for (const name of Object.keys(row))
        if (!names.includes(name)) names.push(name);

    const columns = names.map((name) => this.describeColumn(name, rows));
    const findings: Array<{
      finding: ResultFinding;
      field?: string;
      detail: string;
    }> = [];
    if (rows.length === 0)
      findings.push({
        finding: ResultFinding.EmptyResult,
        detail:
          'the result holds no rows, so nothing about the columns can be said',
      });

    if (parsed !== null) {
      if (parsed.limit !== null && rows.length === parsed.limit)
        findings.push({
          finding: ResultFinding.LimitReached,
          detail: `the query asked for ${parsed.limit} rows and got exactly that, so there may be more behind the limit`,
        });
      for (const filter of parsed.filters) {
        if (!names.includes(filter.field)) {
          findings.push({
            finding: ResultFinding.FilterFieldAbsent,
            field: filter.field,
            detail: `${filter.field} was filtered on but is not a column here, so the filter cannot be checked against these rows`,
          });
          continue;
        }
        const offenders = rows.filter(
          (row) => !this.satisfies(row[filter.field], filter)
        );
        if (offenders.length > 0)
          findings.push({
            finding: ResultFinding.FilterViolated,
            field: filter.field,
            detail: `${offenders.length} of ${rows.length} rows do not satisfy ${filter.field} ${filter.comparison} ${String(filter.value)}`,
          });
      }
      if (parsed.ordering !== null) {
        const field = parsed.ordering.field;
        if (!names.includes(field))
          findings.push({
            finding: ResultFinding.OrderingFieldAbsent,
            field,
            detail: `${field} was the sort key but is not a column here`,
          });
        else {
          const breaks = this.orderBreaks(
            rows,
            field,
            parsed.ordering.descending
          );
          if (breaks > 0)
            findings.push({
              finding: ResultFinding.OrderingViolated,
              field,
              detail: `${breaks} adjacent pairs are out of ${parsed.ordering.descending ? 'descending' : 'ascending'} order on ${field}`,
            });
        }
      }
    }

    return {
      rows: rows.length,
      columns,
      /*
       * Checked against the query rather than summarised beside it. A result
       * set that violates its own filter or its own ordering is the finding
       * worth having, and it is the one a row count cannot show.
       */
      queryChecked: parsed !== null,
      findings,
      consistent: findings.every(
        (entry) => entry.finding === ResultFinding.LimitReached
      ),
    };
  }

  private describeColumn(
    name: string,
    rows: ReadonlyArray<Record<string, unknown>>
  ): Record<string, unknown> {
    const present = rows.filter((row) => name in row).length;
    const values = rows
      .map((row) => row[name])
      .filter((value) => value !== null && value !== undefined);
    const nulls = rows.length - values.length;
    const kinds = new Set(values.map((value) => typeof value));
    if (values.length === 0)
      return { name, kind: ColumnKind.Empty, present, nulls, distinct: 0 };
    if (kinds.size > 1)
      return {
        name,
        kind: ColumnKind.Mixed,
        present,
        nulls,
        kinds: [...kinds].sort(),
      };
    const only = [...kinds][0];
    if (only === 'number') {
      const numbers = values.filter(
        (value): value is number => typeof value === 'number'
      );
      return {
        name,
        kind: ColumnKind.Number,
        present,
        nulls,
        count: numbers.length,
        mean: mean(numbers),
        min: Math.min(...numbers),
        max: Math.max(...numbers),
        // Sample standard deviation needs two values to be defined at all.
        stdDev: numbers.length >= 2 ? stdDev(numbers) : null,
      };
    }
    if (only === 'boolean') {
      const trueCount = values.filter((value) => value === true).length;
      return {
        name,
        kind: ColumnKind.Boolean,
        present,
        nulls,
        trueCount,
        falseCount: values.length - trueCount,
      };
    }
    const counts = frequencies(values.map((value) => String(value)));
    return {
      name,
      kind: ColumnKind.Text,
      present,
      nulls,
      distinct: counts.length,
      top: counts.slice(0, 5),
    };
  }

  private satisfies(value: unknown, filter: Filter): boolean {
    if (value === null || value === undefined) return false;
    switch (filter.comparison) {
      case '=':
        return value === filter.value;
      case '!=':
        return value !== filter.value;
      case 'contains':
        return String(value)
          .toLowerCase()
          .includes(String(filter.value).toLowerCase());
      case 'starts-with':
        return String(value)
          .toLowerCase()
          .startsWith(String(filter.value).toLowerCase());
      case 'ends-with':
        return String(value)
          .toLowerCase()
          .endsWith(String(filter.value).toLowerCase());
      case 'between': {
        const upper = filter.upper;
        if (upper === undefined) return false;
        return value >= filter.value && value <= upper;
      }
      case '>':
        return value > filter.value;
      case '>=':
        return value >= filter.value;
      case '<':
        return value < filter.value;
      case '<=':
        return value <= filter.value;
      default:
        return false;
    }
  }

  private orderBreaks(
    rows: ReadonlyArray<Record<string, unknown>>,
    field: string,
    descending: boolean
  ): number {
    let breaks = 0;
    for (let index = 1; index < rows.length; index += 1) {
      const previous = rows[index - 1][field];
      const current = rows[index][field];
      if (previous === undefined || current === undefined) continue;
      if (previous === null || current === null) continue;
      const wrong = descending
        ? (current as number | string) > (previous as number | string)
        : (current as number | string) < (previous as number | string);
      if (wrong) breaks += 1;
    }
    return breaks;
  }
}

export const NATURALLANGUAGEQUERYTOOL = {
  name: 'natural-language-query',
  description:
    'Parse, translate, optimize and validate queries written in a published restricted grammar, and describe a result set against the query that produced it',
  inputSchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: [...NATURAL_LANGUAGE_QUERY_OPERATIONS],
        description: 'Operation to perform',
      },
      query: {
        type: 'string',
        minLength: 1,
        maxLength: 2000,
        description:
          'A query in the published grammar, e.g. "average of price from orders where status is active sorted by price descending limit 10"',
      },
      schema: {
        type: 'object',
        description:
          'Each source mapped to its fields and their types, as { "users": { "id": "number", "name": "string" } }',
        additionalProperties: {
          type: 'object',
          additionalProperties: {
            type: 'string',
            enum: ['number', 'string', 'boolean', 'date'],
          },
        },
      },
      rows: {
        type: 'array',
        minItems: 0,
        description: 'A result set to describe, one object per row',
        items: { type: 'object' },
      },
      source: {
        type: 'string',
        minLength: 1,
        description: 'Restrict suggest-query to one source from the schema',
      },
      dialect: {
        type: 'string',
        enum: [...SQL_DIALECTS],
        default: SqlDialect.Ansi,
        description:
          'Which SQL dialect translate-sql renders; they differ in placeholders, identifier quoting and the row-limit clause',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        description: 'How many suggestions per source suggest-query returns',
      },
      useCache: {
        type: 'boolean',
        default: true,
        description: 'Enable caching',
      },
    },
    required: ['operation'],
    /*
     * The conditional requirements, published rather than described in prose.
     * A property description saying "Required by parse" is something a human
     * reads and a client cannot act on; these branches are something a client
     * can act on, and are what the derived validation enforces.
     */
    anyOf: [
      {
        properties: { operation: { const: 'parse' } },
        required: ['operation', 'query'],
      },
      {
        properties: { operation: { const: 'translate-sql' } },
        required: ['operation', 'query'],
      },
      {
        properties: { operation: { const: 'translate-mongodb' } },
        required: ['operation', 'query'],
      },
      {
        properties: { operation: { const: 'translate-graphql' } },
        required: ['operation', 'query'],
      },
      {
        properties: { operation: { const: 'optimize' } },
        required: ['operation', 'query'],
      },
      {
        properties: { operation: { const: 'validate' } },
        required: ['operation', 'query'],
      },
      {
        properties: { operation: { const: 'suggest-query' } },
        required: ['operation', 'schema'],
      },
      {
        properties: { operation: { const: 'explain-results' } },
        required: ['operation', 'rows'],
      },
    ],
  },
} as const;

export async function runNaturalLanguageQuery(
  options: NaturalLanguageQueryOptions
): Promise<NaturalLanguageQueryResult> {
  const tool = new NaturalLanguageQuery(
    sharedCache,
    sharedTokenCounter,
    sharedMetricsCollector
  );
  return await tool.run(options);
}
