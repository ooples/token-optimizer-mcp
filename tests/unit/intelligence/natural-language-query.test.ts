/**
 * natural-language-query - the eight operations.
 *
 * Every test here pins a value derived from the INPUT. WHY THAT RULE: what
 * this file's subject replaced returned
 * `{ success: true, data: { result: "<operation> completed successfully" },
 *    metadata: { confidence: 0.85 } }`
 * for all eight operations, having read none of their arguments. A response of
 * that shape cannot be told apart from a correct one, so the only test that
 * proves work happened is one whose expected value could only come from the
 * arguments given.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { TokenCounter } from '../../../src/core/token-counter.js';
import { MetricsCollector } from '../../../src/core/metrics.js';
import {
  ColumnKind,
  NATURAL_LANGUAGE_QUERY_OPERATIONS,
  NaturalLanguageQuery,
  NATURALLANGUAGEQUERYTOOL,
  ResultFinding,
  RewriteRule,
  ValidationFinding,
  type NaturalLanguageQueryOperation,
  type NaturalLanguageQueryOptions,
} from '../../../src/tools/intelligence/natural-language-query.js';
import {
  SourceBinding,
  SqlDialect,
  type QuerySchema,
} from '../../../src/tools/intelligence/query-core.js';
import { toolSchemaMap } from '../../../src/validation/tool-schemas.js';

/*
 * One schema, used by every operation that takes one, so a field's type is
 * stated once and each test's expectation can be read against it.
 */
const SCHEMA: QuerySchema = Object.freeze({
  users: Object.freeze({
    id: 'number',
    name: 'string',
    age: 'number',
    active: 'boolean',
    joined: 'date',
  }),
  orders: Object.freeze({
    id: 'number',
    total: 'number',
    status: 'string',
  }),
}) as QuerySchema;

describe('natural-language-query', () => {
  let directory: string;
  let engine: CacheEngine;
  let tool: NaturalLanguageQuery;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'nlq-test-'));
    engine = new CacheEngine(join(directory, 'c.db'));
    tool = new NaturalLanguageQuery(
      engine,
      new TokenCounter(),
      new MetricsCollector()
    );
  });

  afterEach(() => {
    try {
      engine.close();
    } catch {
      // A cache that never opened needs no closing.
    }
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Windows can hold the file briefly; the temp dir is disposable.
    }
  });

  const run = async (
    options: NaturalLanguageQueryOptions
  ): Promise<Record<string, unknown>> => {
    const result = await tool.run({ ...options, useCache: false });
    expect(result.success).toBe(true);
    return result.data;
  };

  describe('parse', () => {
    it('returns the bound query and says the source came from a keyword', async () => {
      const data = await run({
        operation: 'parse',
        query: 'show name, email from users where age > 18 limit 5',
      });
      expect(data.query).toEqual({
        intent: 'select',
        source: 'users',
        sourceFrom: SourceBinding.Keyword,
        measure: null,
        fields: ['name', 'email'],
        filters: [{ field: 'age', comparison: '>', value: 18 }],
        groupBy: [],
        ordering: null,
        limit: 5,
        unrecognized: [],
        unparsed: [],
      });
      expect(data.sourceFrom).toBe(SourceBinding.Keyword);
      expect(data.complete).toBe(true);
      /*
       * The comma the caller wrote comes back as `and`: the grammar has one
       * canonical form, and a rendering that varied with the input's
       * punctuation would make two spellings of one query look like two
       * queries.
       */
      expect(data.grammar).toBe(
        'show name and email from users where age > 18 limit 5'
      );
    });

    /*
     * `complete` is false here and the stray word is named, because a parse
     * that quietly ignored the `5` would be reported as a full reading of a
     * query it only partly read.
     */
    it('marks a parse incomplete when a word bound to nothing', async () => {
      const data = await run({
        operation: 'parse',
        query: 'show the 5 highest paid from staff',
      });
      expect(data.complete).toBe(false);
      expect((data.query as { unrecognized: string[] }).unrecognized).toEqual([
        '5',
      ]);
    });

    it('says the source was taken from the subject position', async () => {
      const data = await run({ operation: 'parse', query: 'how many users' });
      expect(data.sourceFrom).toBe(SourceBinding.Position);
    });

    it('refuses with no query', async () => {
      await expect(tool.run({ operation: 'parse' })).rejects.toThrow(
        /`query` is required/
      );
    });
  });

  describe('translate-sql', () => {
    it('renders the dialect asked for, with values as parameters', async () => {
      const data = await run({
        operation: 'translate-sql',
        query: 'average of total from orders where status is "open"',
        dialect: SqlDialect.Postgres,
      });
      expect(data.sql).toBe(
        'SELECT AVG("total") FROM "orders" WHERE "status" = $1'
      );
      expect(data.parameters).toEqual(['open']);
      expect(data.dialect).toBe(SqlDialect.Postgres);
      expect(data.placeholder).toBe('$n');
      expect(data.parameterized).toBe(true);
    });

    it('defaults to ansi, which has no LIMIT clause', async () => {
      const data = await run({
        operation: 'translate-sql',
        query: 'show from users limit 7',
      });
      expect(data.dialect).toBe(SqlDialect.Ansi);
      expect(data.sql).toBe('SELECT * FROM "users" FETCH FIRST ? ROWS ONLY');
      expect(data.parameters).toEqual([7]);
    });

    it('refuses a dialect it does not render', async () => {
      await expect(
        tool.run({
          operation: 'translate-sql',
          query: 'show from users',
          dialect: 'oracle' as SqlDialect,
        })
      ).rejects.toThrow(/must be one of ansi, postgres, mysql, sqlite/);
    });
  });

  describe('translate-mongodb', () => {
    it('renders a find with the filter, projection, sort and limit', async () => {
      const data = await run({
        operation: 'translate-mongodb',
        query:
          'show name from users where name starts with "a" sorted by name limit 3',
      });
      expect(data.collection).toBe('users');
      expect(data.method).toBe('find');
      expect(data.filter).toEqual({ name: { $regex: '^a', $options: 'i' } });
      expect(data.projection).toEqual({ name: 1 });
      expect(data.sort).toEqual({ name: 1 });
      expect(data.limit).toBe(3);
      // Stated, not left for the caller to infer from the `$options`.
      expect(data.caseInsensitiveText).toBe(true);
    });

    it('renders a count as countDocuments and claims no text handling', async () => {
      const data = await run({
        operation: 'translate-mongodb',
        query: 'how many orders where total between 10 and 20',
      });
      expect(data.method).toBe('countDocuments');
      expect(data.filter).toEqual({ total: { $gte: 10, $lte: 20 } });
      expect(data.caseInsensitiveText).toBe(false);
    });
  });

  describe('translate-graphql', () => {
    it('emits variables for the values and names its convention', async () => {
      const data = await run({
        operation: 'translate-graphql',
        query: 'show name from users where age > 18 limit 5',
      });
      expect(data.variables).toEqual({ v1: 18, v2: 5 });
      expect(data.convention).toBe('field-suffix-filters');
      expect(data.query).toContain('users(where: { age_gt: $v1 }');
    });
  });

  describe('optimize', () => {
    it('drops a filter repeated word for word', async () => {
      const data = await run({
        operation: 'optimize',
        query: 'show from users where age > 18 and age > 18',
      });
      expect(data.filtersBefore).toBe(2);
      expect(data.filtersAfter).toBe(1);
      expect(data.applied).toEqual([
        {
          rule: RewriteRule.DuplicateFilter,
          detail: 'age > 18 appeared twice',
        },
      ]);
      expect(data.grammar).toBe('show from users where age > 18');
      expect(data.unchanged).toBe(false);
    });

    /*
     * `age > 18 and age > 21` cannot admit a row that `age > 21` alone would
     * reject, so the looser bound is dropped and the tighter one kept -- the
     * direction matters, and keeping the wrong one would widen the result.
     */
    it('keeps the tighter of two bounds in the same direction', async () => {
      const data = await run({
        operation: 'optimize',
        query: 'show from users where age > 18 and age > 21',
      });
      expect((data.query as { filters: unknown[] }).filters).toEqual([
        { field: 'age', comparison: '>', value: 21 },
      ]);
      expect(data.applied).toEqual([
        {
          rule: RewriteRule.RedundantBound,
          detail: 'age > 18 cannot matter beside age > 21',
        },
      ]);
    });

    it('keeps the tighter upper bound when the comparison points the other way', async () => {
      const data = await run({
        operation: 'optimize',
        query: 'show from users where age < 65 and age < 40',
      });
      expect((data.query as { filters: unknown[] }).filters).toEqual([
        { field: 'age', comparison: '<', value: 40 },
      ]);
    });

    it('names two equality filters no row can satisfy, without dropping either', async () => {
      const data = await run({
        operation: 'optimize',
        query: 'show from users where name is "a" and name is "b"',
      });
      expect(data.applied).toEqual([
        {
          rule: RewriteRule.Unsatisfiable,
          detail: 'name cannot be both a and b, so no row can match',
        },
      ]);
      // Both are kept: this is a finding about the query, not a rewrite of it.
      expect(data.filtersAfter).toBe(2);
    });

    it('removes an ordering that cannot reorder one summary row', async () => {
      const data = await run({
        operation: 'optimize',
        query: 'count of users sorted by age descending',
      });
      expect((data.query as { ordering: unknown }).ordering).toBeNull();
      expect(data.applied).toEqual([
        {
          rule: RewriteRule.PointlessOrdering,
          detail:
            'count without a grouping returns one row, so ordering by age changes nothing',
        },
      ]);
      expect(data.grammar).toBe('how many users');
    });

    it('keeps the ordering once a grouping makes it meaningful', async () => {
      const data = await run({
        operation: 'optimize',
        query: 'average of age per name from users sorted by age descending',
      });
      expect((data.query as { ordering: unknown }).ordering).toEqual({
        field: 'age',
        descending: true,
      });
      expect(data.applied).toEqual([]);
    });

    it('warns about a limit with nothing to order it, as a warning not a rewrite', async () => {
      const data = await run({
        operation: 'optimize',
        query: 'show from users limit 5',
      });
      expect(data.warnings).toEqual([
        {
          rule: RewriteRule.UnstableLimit,
          detail:
            'a limit of 5 with no ordering returns an arbitrary 5 rows, which may differ between runs',
        },
        {
          rule: RewriteRule.UnboundedProjection,
          detail: 'the query names no column, so every column is read',
        },
      ]);
      // Nothing was rewritten, which is what `unchanged` reports.
      expect(data.unchanged).toBe(true);
    });

    /*
     * Equality fields first: a composite index is read left to right, so a
     * range placed before an equality stops the rest of the index being used.
     */
    it('orders index candidates equality, then range, then the sort key', async () => {
      const data = await run({
        operation: 'optimize',
        query:
          'show from orders where total > 10 and status is "open" sorted by id descending',
      });
      expect(data.indexCandidates).toEqual(['status', 'total', 'id']);
    });

    /*
     * This package cannot see the caller's data distribution, so a percentage
     * or a millisecond figure here would have nothing behind it -- the exact
     * defect class this file's subject was rewritten to remove. The rewrite
     * reports what it did and nothing about what it saved.
     */
    it('reports the rewrite it made and claims no speedup for it', async () => {
      const data = await run({
        operation: 'optimize',
        query: 'show from users where age > 18 and age > 18',
      });
      expect(data.applied).toEqual([
        {
          rule: RewriteRule.DuplicateFilter,
          detail: 'age > 18 appeared twice',
        },
      ]);
      const text = JSON.stringify(data);
      for (const claim of ['faster', 'speedup', '%', 'ms', 'performance'])
        expect(text).not.toContain(claim);
    });
  });

  describe('validate', () => {
    it('finds nothing wrong with a query the schema supports', async () => {
      const data = await run({
        operation: 'validate',
        query: 'average of age from users where active is true',
        schema: SCHEMA,
      });
      expect(data.valid).toBe(true);
      expect(data.findings).toEqual([]);
      expect(data.schemaChecked).toBe(true);
      expect(data.checked).toBe('grammar and schema');
      expect(data.fieldsUsed).toEqual(['active', 'age']);
    });

    it('names the sources it knows when the one asked for is absent', async () => {
      const data = await run({
        operation: 'validate',
        query: 'show from invoices',
        schema: SCHEMA,
      });
      expect(data.findings).toEqual([
        {
          finding: ValidationFinding.UnknownSource,
          detail: 'invoices is not in the schema; it names orders, users',
        },
      ]);
    });

    /*
     * The available fields are listed and nothing is suggested in their place.
     * A guessed "did you mean" is a guess, and a caller who acts on it has
     * been handed a different query than the one they wrote.
     */
    it('lists the available fields for an unknown one', async () => {
      const data = await run({
        operation: 'validate',
        query: 'show from users where zzz contains "x"',
        schema: SCHEMA,
      });
      expect(data.findings).toEqual([
        {
          finding: ValidationFinding.UnknownField,
          field: 'zzz',
          detail:
            'zzz is used as a filter but users has active, age, id, joined, name',
        },
      ]);
    });

    it('rejects an average over a non-numeric column', async () => {
      const data = await run({
        operation: 'validate',
        query: 'sum of name from users',
        schema: SCHEMA,
      });
      expect(data.findings).toEqual([
        {
          finding: ValidationFinding.AggregateOnNonNumeric,
          field: 'name',
          detail: 'sum needs a number but name is string',
        },
      ]);
    });

    /*
     * Two findings, not one: the comparison cannot apply to a number AND the
     * value is text where a number belongs. Reporting only the first would
     * leave the caller fixing one half of a two-part mistake.
     */
    it('rejects a text comparison against a number, on both counts', async () => {
      const data = await run({
        operation: 'validate',
        query: 'show from users where age contains "1"',
        schema: SCHEMA,
      });
      expect(data.findings).toEqual([
        {
          finding: ValidationFinding.ComparisonNotApplicable,
          field: 'age',
          detail: 'contains needs text but age is number',
        },
        {
          finding: ValidationFinding.TypeMismatch,
          field: 'age',
          detail: 'age is number but is compared against "1", which is string',
        },
      ]);
    });

    it('rejects a value whose type cannot be the column type', async () => {
      const data = await run({
        operation: 'validate',
        query: 'show from users where age is "old"',
        schema: SCHEMA,
      });
      expect(data.findings).toEqual([
        {
          finding: ValidationFinding.TypeMismatch,
          field: 'age',
          detail:
            'age is number but is compared against "old", which is string',
        },
      ]);
    });

    it('accepts a date literal against a date column', async () => {
      const data = await run({
        operation: 'validate',
        query: 'show from users where joined at least 2026-01-31',
        schema: SCHEMA,
      });
      expect(data.findings).toEqual([]);
    });

    it('checks both operands of a between', async () => {
      const data = await run({
        operation: 'validate',
        query: 'show from orders where total between 10 and "x"',
        schema: SCHEMA,
      });
      expect(data.findings).toEqual([
        {
          finding: ValidationFinding.TypeMismatch,
          field: 'total',
          detail:
            'total is number but is compared against "x", which is string',
        },
      ]);
    });

    it('reports a word the grammar read but did not use', async () => {
      const data = await run({
        operation: 'validate',
        query: 'show the 5 highest paid from users',
        schema: undefined,
      });
      expect(data.findings).toEqual([
        {
          finding: ValidationFinding.WordsNotUnderstood,
          detail: 'the grammar read but did not use 5',
        },
      ]);
    });

    it('reports characters the tokenizer could not read', async () => {
      const data = await run({
        operation: 'validate',
        query: 'show from users where name contains 50%',
      });
      expect(data.findings).toContainEqual({
        finding: ValidationFinding.CharactersNotRead,
        detail: 'the tokenizer could not read %',
      });
    });

    /*
     * A `valid: true` with no schema means the query parses, not that its
     * fields exist, and the response says which of the two was checked.
     */
    it('says plainly that only the grammar was checked', async () => {
      const data = await run({
        operation: 'validate',
        query: 'show from users',
      });
      expect(data.valid).toBe(true);
      expect(data.schemaChecked).toBe(false);
      expect(data.checked).toBe('grammar only');
    });

    it('refuses a schema whose field type is not one of the four', async () => {
      await expect(
        tool.run({
          operation: 'validate',
          query: 'show from users',
          schema: { users: { id: 'integer' } } as unknown as QuerySchema,
        })
      ).rejects.toThrow(/schema.users.id is "integer"/);
    });
  });

  describe('suggest-query', () => {
    it('builds every example out of the schema it was given', async () => {
      const data = await run({
        operation: 'suggest-query',
        schema: { orders: SCHEMA.orders },
        limit: 8,
      });
      expect(data.sources).toEqual(['orders']);
      expect(data.found).toBe(8);
      expect(data.suggestions).toEqual([
        { query: 'show from orders', intent: 'select', uses: [] },
        { query: 'how many orders', intent: 'count', uses: [] },
        { query: 'average of id from orders', intent: 'average', uses: ['id'] },
        {
          query:
            'show from orders where id > 0 sorted by id descending limit 10',
          intent: 'select',
          uses: ['id'],
        },
        {
          query: 'average of total from orders',
          intent: 'average',
          uses: ['total'],
        },
        {
          query:
            'show from orders where total > 0 sorted by total descending limit 10',
          intent: 'select',
          uses: ['total'],
        },
        {
          query: 'show from orders where status = "example"',
          intent: 'select',
          uses: ['status'],
        },
        {
          query: 'average of id from orders per status',
          intent: 'average',
          uses: ['status', 'id'],
        },
      ]);
      expect(data.fieldsByType).toEqual({
        orders: {
          number: ['id', 'total'],
          string: ['status'],
          boolean: [],
          date: [],
        },
      });
      // Nothing here has seen the caller's data or their past queries.
      expect(data.basis).toBe('schema shape only');
    });

    /*
     * THE DECISIVE PROPERTY: every suggestion is produced by rendering the
     * grammar from a constructed parse, so it parses by construction. A
     * hand-written example is how a tool ends up suggesting a query it cannot
     * itself read.
     */
    it('suggests only queries this same tool can parse back', async () => {
      const data = await run({ operation: 'suggest-query', schema: SCHEMA });
      const suggestions = data.suggestions as Array<{ query: string }>;
      expect(suggestions.length).toBeGreaterThan(0);
      for (const suggestion of suggestions) {
        const parsed = await run({
          operation: 'parse',
          query: suggestion.query,
        });
        expect(parsed.complete).toBe(true);
      }
    });

    it('honours a limit per source', async () => {
      const data = await run({
        operation: 'suggest-query',
        schema: SCHEMA,
        limit: 2,
      });
      // Two sources, two each.
      expect(data.found).toBe(4);
      expect(data.sources).toEqual(['orders', 'users']);
    });

    it('restricts itself to the source asked for', async () => {
      const data = await run({
        operation: 'suggest-query',
        schema: SCHEMA,
        source: 'users',
        limit: 3,
      });
      expect(data.sources).toEqual(['users']);
      for (const suggestion of data.suggestions as Array<{ query: string }>)
        expect(suggestion.query).toContain('users');
    });

    it('refuses a source the schema does not name, listing the ones it does', async () => {
      await expect(
        tool.run({
          operation: 'suggest-query',
          schema: SCHEMA,
          source: 'invoices',
        })
      ).rejects.toThrow(
        /"invoices" is not in the schema; it names orders, users/
      );
    });

    it('refuses with no schema, naming the shape it needs', async () => {
      await expect(tool.run({ operation: 'suggest-query' })).rejects.toThrow(
        /`schema` is required and maps each source to its fields/
      );
    });

    it('refuses an empty schema', async () => {
      await expect(
        tool.run({ operation: 'suggest-query', schema: {} })
      ).rejects.toThrow(/names no source/);
    });

    it('refuses a limit below one', async () => {
      await expect(
        tool.run({ operation: 'suggest-query', schema: SCHEMA, limit: 0 })
      ).rejects.toThrow(/integer of at least 1/);
    });
  });

  describe('explain-results', () => {
    it('summarises a numeric column from the rows given', async () => {
      const data = await run({
        operation: 'explain-results',
        rows: [{ age: 10 }, { age: 20 }, { age: 30 }],
      });
      expect(data.rows).toBe(3);
      expect(data.columns).toEqual([
        {
          name: 'age',
          kind: ColumnKind.Number,
          present: 3,
          nulls: 0,
          count: 3,
          mean: 20,
          min: 10,
          max: 30,
          // Sample sd of 10,20,30 is sqrt(200/2) = 10 exactly.
          stdDev: 10,
        },
      ]);
    });

    it('leaves the deviation null when one value cannot define it', async () => {
      const data = await run({
        operation: 'explain-results',
        rows: [{ age: 10 }],
      });
      expect((data.columns as Array<{ stdDev: unknown }>)[0].stdDev).toBeNull();
    });

    it('counts the two sides of a boolean column', async () => {
      const data = await run({
        operation: 'explain-results',
        rows: [{ ok: true }, { ok: false }, { ok: true }],
      });
      expect(data.columns).toEqual([
        {
          name: 'ok',
          kind: ColumnKind.Boolean,
          present: 3,
          nulls: 0,
          trueCount: 2,
          falseCount: 1,
        },
      ]);
    });

    it('ranks the values of a text column', async () => {
      const data = await run({
        operation: 'explain-results',
        rows: [{ s: 'a' }, { s: 'b' }, { s: 'a' }, { s: 'a' }],
      });
      expect(data.columns).toEqual([
        {
          name: 's',
          kind: ColumnKind.Text,
          present: 4,
          nulls: 0,
          distinct: 2,
          top: [
            { value: 'a', count: 3, share: 0.75 },
            { value: 'b', count: 1, share: 0.25 },
          ],
        },
      ]);
    });

    it('names a column of more than one kind rather than averaging it', async () => {
      const data = await run({
        operation: 'explain-results',
        rows: [{ x: 1 }, { x: 'one' }],
      });
      expect(data.columns).toEqual([
        {
          name: 'x',
          kind: ColumnKind.Mixed,
          present: 2,
          nulls: 0,
          kinds: ['number', 'string'],
        },
      ]);
    });

    it('separates nulls from absent values', async () => {
      const data = await run({
        operation: 'explain-results',
        rows: [{ x: 1 }, { x: null }, { y: 2 }],
      });
      expect(data.columns).toEqual([
        {
          name: 'x',
          kind: ColumnKind.Number,
          present: 2,
          nulls: 2,
          count: 1,
          mean: 1,
          min: 1,
          max: 1,
          stdDev: null,
        },
        {
          name: 'y',
          kind: ColumnKind.Number,
          present: 1,
          nulls: 2,
          count: 1,
          mean: 2,
          min: 2,
          max: 2,
          stdDev: null,
        },
      ]);
    });

    it('says an empty result holds nothing to describe', async () => {
      const data = await run({ operation: 'explain-results', rows: [] });
      expect(data.columns).toEqual([]);
      expect(data.findings).toEqual([
        {
          finding: ResultFinding.EmptyResult,
          detail:
            'the result holds no rows, so nothing about the columns can be said',
        },
      ]);
    });

    /*
     * THE DECISIVE CASE: rows checked against the query that asked for them.
     * A row that fails its own filter, or an order the query asked for and did
     * not get, is the finding worth having -- and it is exactly what a row
     * count and a column summary cannot show.
     */
    it('catches a row that fails the filter and an order that was not kept', async () => {
      const data = await run({
        operation: 'explain-results',
        query:
          'show name, age from users where age > 18 sorted by age descending limit 2',
        rows: [
          { name: 'a', age: 10 },
          { name: 'b', age: 30 },
        ],
      });
      expect(data.queryChecked).toBe(true);
      expect(data.findings).toEqual([
        {
          finding: ResultFinding.LimitReached,
          detail:
            'the query asked for 2 rows and got exactly that, so there may be more behind the limit',
        },
        {
          finding: ResultFinding.FilterViolated,
          field: 'age',
          detail: '1 of 2 rows do not satisfy age > 18',
        },
        {
          finding: ResultFinding.OrderingViolated,
          field: 'age',
          detail: '1 adjacent pairs are out of descending order on age',
        },
      ]);
      expect(data.consistent).toBe(false);
    });

    it('finds nothing but the limit when the rows do satisfy the query', async () => {
      const data = await run({
        operation: 'explain-results',
        query:
          'show from users where age > 18 sorted by age descending limit 2',
        rows: [{ age: 30 }, { age: 20 }],
      });
      expect(data.findings).toEqual([
        {
          finding: ResultFinding.LimitReached,
          detail:
            'the query asked for 2 rows and got exactly that, so there may be more behind the limit',
        },
      ]);
      /*
       * A limit that was reached says nothing is wrong, only that there may be
       * more rows, so it alone still leaves the result consistent.
       */
      expect(data.consistent).toBe(true);
    });

    it('says a filtered field is not a column rather than passing it', async () => {
      const data = await run({
        operation: 'explain-results',
        query: 'show name from users where age > 18',
        rows: [{ name: 'a' }],
      });
      expect(data.findings).toEqual([
        {
          finding: ResultFinding.FilterFieldAbsent,
          field: 'age',
          detail:
            'age was filtered on but is not a column here, so the filter cannot be checked against these rows',
        },
      ]);
    });

    it('says the sort key is not a column', async () => {
      const data = await run({
        operation: 'explain-results',
        query: 'show name from users sorted by age',
        rows: [{ name: 'a' }],
      });
      expect(data.findings).toEqual([
        {
          finding: ResultFinding.OrderingFieldAbsent,
          field: 'age',
          detail: 'age was the sort key but is not a column here',
        },
      ]);
    });

    it('checks a text filter the same way the renderers read it', async () => {
      const data = await run({
        operation: 'explain-results',
        query: 'show from users where name starts with "a"',
        rows: [{ name: 'Alice' }, { name: 'bob' }],
      });
      expect(data.findings).toEqual([
        {
          finding: ResultFinding.FilterViolated,
          field: 'name',
          detail: '1 of 2 rows do not satisfy name starts-with a',
        },
      ]);
    });

    it('says when no query was given to check against', async () => {
      const data = await run({
        operation: 'explain-results',
        rows: [{ age: 1 }],
      });
      expect(data.queryChecked).toBe(false);
      expect(data.findings).toEqual([]);
    });

    it('refuses rows that are not objects, naming the index', async () => {
      await expect(
        tool.run({
          operation: 'explain-results',
          rows: [{ a: 1 }, 7 as unknown as Record<string, unknown>],
        })
      ).rejects.toThrow(/rows\[1\] must be an object of column values/);
    });

    it('refuses with no rows at all', async () => {
      await expect(tool.run({ operation: 'explain-results' })).rejects.toThrow(
        /`rows` is required and must be an array/
      );
    });
  });

  describe('the response itself', () => {
    it('carries exactly the four metadata keys, and no confidence', async () => {
      const result = await tool.run({
        operation: 'parse',
        query: 'show from users',
        useCache: false,
      });
      expect(Object.keys(result.metadata).sort()).toEqual([
        'cacheHit',
        'processingTime',
        'tokensSaved',
        'tokensUsed',
      ]);
      expect(result.metadata.tokensUsed).toBeGreaterThan(0);
      expect(result.operation).toBe('parse');
    });

    it('serves a repeat from cache with the same data', async () => {
      const first = await tool.run({
        operation: 'translate-sql',
        query: 'show from users where age > 18',
      });
      expect(first.metadata.cacheHit).toBe(false);
      const second = await tool.run({
        operation: 'translate-sql',
        query: 'show from users where age > 18',
      });
      expect(second.metadata.cacheHit).toBe(true);
      expect(second.data).toEqual(first.data);
      expect(second.metadata.tokensSaved).toBeGreaterThan(0);
    });

    it('does not serve one operation from another operation cache entry', async () => {
      await tool.run({ operation: 'parse', query: 'show from users' });
      const other = await tool.run({
        operation: 'translate-sql',
        query: 'show from users',
      });
      expect(other.metadata.cacheHit).toBe(false);
      expect(other.data.sql).toBe('SELECT * FROM "users"');
    });

    it('refuses an operation it does not implement', async () => {
      await expect(
        tool.run({
          operation: 'summarise' as NaturalLanguageQueryOperation,
        })
      ).rejects.toThrow(/unknown operation "summarise"/);
    });
  });

  describe('the published schema', () => {
    it('advertises exactly the operations the tool dispatches', () => {
      expect(
        NATURALLANGUAGEQUERYTOOL.inputSchema.properties.operation.enum
      ).toEqual([...NATURAL_LANGUAGE_QUERY_OPERATIONS]);
    });

    /*
     * The conditional requirements are published as `anyOf` branches, which a
     * client can act on, rather than described in a property's prose, which it
     * cannot. These assertions check the branches reach the derived validator.
     */
    it('rejects a translate-sql with no query before the tool runs', () => {
      const schema = toolSchemaMap['natural-language-query'];
      expect(schema.safeParse({ operation: 'translate-sql' }).success).toBe(
        false
      );
      expect(
        schema.safeParse({
          operation: 'translate-sql',
          query: 'show from users',
        }).success
      ).toBe(true);
    });

    it('rejects a suggest-query with no schema and an explain-results with no rows', () => {
      const schema = toolSchemaMap['natural-language-query'];
      expect(schema.safeParse({ operation: 'suggest-query' }).success).toBe(
        false
      );
      expect(
        schema.safeParse({
          operation: 'suggest-query',
          schema: { a: { b: 'number' } },
        }).success
      ).toBe(true);
      expect(schema.safeParse({ operation: 'explain-results' }).success).toBe(
        false
      );
      expect(
        schema.safeParse({ operation: 'explain-results', rows: [] }).success
      ).toBe(true);
    });

    it('rejects an unknown key and an unknown dialect', () => {
      const schema = toolSchemaMap['natural-language-query'];
      expect(
        schema.safeParse({
          operation: 'parse',
          query: 'show from users',
          dialekt: 'postgres',
        }).success
      ).toBe(false);
      expect(
        schema.safeParse({
          operation: 'translate-sql',
          query: 'show from users',
          dialect: 'oracle',
        }).success
      ).toBe(false);
    });

    it('rejects a schema field type outside the four, at the schema layer', () => {
      const schema = toolSchemaMap['natural-language-query'];
      expect(
        schema.safeParse({
          operation: 'suggest-query',
          schema: { users: { id: 'integer' } },
        }).success
      ).toBe(false);
    });
  });
});
