/**
 * The published query grammar, its parser and its four renderings.
 *
 * WHY EVERY TEST HERE PINS AN EXACT VALUE: a parser that drops a clause still
 * returns a parse, and a renderer fed that parse still returns runnable SQL.
 * Nothing about the shape of either result says a filter went missing -- the
 * query simply answers a different question than the one asked. Three such
 * defects were found in this file's subject by exercising it, and each one is
 * kept below as a named regression case.
 */

import {
  AGGREGATE_INTENTS,
  COMPARISONS,
  isIdentifier,
  isOrderedComparison,
  isSqlDialect,
  isTextComparison,
  parseQuery,
  PHRASES,
  QUERY_INTENTS,
  renderGrammar,
  renderGraphql,
  renderMongo,
  renderSql,
  SourceBinding,
  SQL_DIALECTS,
  SqlDialect,
} from '../../../src/tools/intelligence/query-core.js';

describe('query-core: the published vocabulary', () => {
  it('names six intents and ten comparisons', () => {
    expect([...QUERY_INTENTS]).toEqual([
      'select',
      'count',
      'sum',
      'average',
      'min',
      'max',
    ]);
    expect([...COMPARISONS]).toEqual([
      '=',
      '!=',
      '>',
      '>=',
      '<',
      '<=',
      'contains',
      'starts-with',
      'ends-with',
      'between',
    ]);
    /*
     * `count` is here and `select` is not: every intent but `select` returns a
     * summary, which is what makes `by` a grouping rather than an ordering.
     */
    expect([...AGGREGATE_INTENTS]).toEqual([
      'count',
      'sum',
      'average',
      'min',
      'max',
    ]);
    expect([...SQL_DIALECTS]).toEqual(['ansi', 'postgres', 'mysql', 'sqlite']);
  });

  it('classifies each comparison into exactly the groups that apply', () => {
    const ordered = COMPARISONS.filter((entry) => isOrderedComparison(entry));
    const text = COMPARISONS.filter((entry) => isTextComparison(entry));
    expect(ordered).toEqual(['>', '>=', '<', '<=', 'between']);
    expect(text).toEqual(['contains', 'starts-with', 'ends-with']);
    // No comparison is both, so a check on one group never shadows the other.
    expect(ordered.filter((entry) => text.includes(entry))).toEqual([]);
  });

  it('publishes every phrase the parser will read, each exactly once', () => {
    expect(PHRASES.length).toBeGreaterThan(0);
    const texts = PHRASES.map(([text]) => text);
    // A duplicate phrase would make one of the two bindings unreachable.
    expect(new Set(texts).size).toBe(texts.length);
  });

  /*
   * The matching rule, asserted through what it decides rather than through
   * the order of the table: a shorter phrase that is a prefix of a longer one
   * must lose, or `highest first` would read as the max intent followed by a
   * stray word and the ordering would be dropped.
   */
  it('matches the longest phrase, so a prefix never wins', () => {
    const direction = parseQuery('show from users sorted by age highest first');
    expect(direction.ordering).toEqual({ field: 'age', descending: true });
    expect([...direction.unrecognized]).toEqual([]);

    const max = parseQuery('highest of age from users');
    expect(max.intent).toBe('max');
    expect(max.measure).toBe('age');

    const inequality = parseQuery('show from users where name is not "a"');
    expect([...inequality.filters]).toEqual([
      { field: 'name', comparison: '!=', value: 'a' },
    ]);
  });

  it('admits only a plain or one-dotted identifier', () => {
    expect(isIdentifier('name')).toBe(true);
    expect(isIdentifier('users.name')).toBe(true);
    expect(isIdentifier('_x9')).toBe(true);
    expect(isIdentifier('1name')).toBe(false);
    expect(isIdentifier('a"b')).toBe(false);
    expect(isIdentifier("a'b")).toBe(false);
    expect(isIdentifier('a b')).toBe(false);
    expect(isIdentifier('a.b.c')).toBe(false);
    expect(isIdentifier('')).toBe(false);
  });

  it('accepts only the four dialect names', () => {
    for (const dialect of SQL_DIALECTS)
      expect(isSqlDialect(dialect)).toBe(true);
    expect(isSqlDialect('oracle')).toBe(false);
    expect(isSqlDialect('ANSI')).toBe(false);
  });
});

describe('query-core: parseQuery', () => {
  /*
   * The comma is read and discarded. It used to land in `unparsed`, which made
   * every multi-column query report a character the parser could not read.
   */
  it('binds the source from the `from` keyword and says so', () => {
    const parsed = parseQuery('show name, email from users');
    expect(parsed.source).toBe('users');
    expect(parsed.sourceFrom).toBe(SourceBinding.Keyword);
    expect([...parsed.fields]).toEqual(['name', 'email']);
    expect(parsed.intent).toBe('select');
    expect(parsed.measure).toBeNull();
    expect([...parsed.unrecognized]).toEqual([]);
    expect([...parsed.unparsed]).toEqual([]);
  });

  it('takes the source from the subject position when no keyword names it', () => {
    const parsed = parseQuery('how many users');
    expect(parsed.intent).toBe('count');
    expect(parsed.source).toBe('users');
    // The two bindings carry different confidence, which is why they differ.
    expect(parsed.sourceFrom).toBe(SourceBinding.Position);
    expect([...parsed.fields]).toEqual([]);
  });

  it('reads two filters joined by and', () => {
    const parsed = parseQuery(
      'how many users where age at least 18 and country is "US"'
    );
    expect([...parsed.filters]).toEqual([
      { field: 'age', comparison: '>=', value: 18 },
      { field: 'country', comparison: '=', value: 'US' },
    ]);
    expect([...parsed.unrecognized]).toEqual([]);
  });

  it('reads a measure, a grouping and an ordering in one query', () => {
    const parsed = parseQuery(
      'average of salary per department and region from staff sorted by salary descending'
    );
    expect(parsed.intent).toBe('average');
    expect(parsed.measure).toBe('salary');
    expect(parsed.source).toBe('staff');
    expect([...parsed.groupBy]).toEqual(['department', 'region']);
    expect(parsed.ordering).toEqual({ field: 'salary', descending: true });
  });

  it('reads a limit as a whole number of rows', () => {
    const parsed = parseQuery('show from users sorted by name limit 25');
    expect(parsed.limit).toBe(25);
    expect(parsed.ordering).toEqual({ field: 'name', descending: false });
  });

  /*
   * REGRESSION. `total` is in the intent vocabulary (it reads as `sum`), so it
   * lexed as an intent rather than a column and the whole `between` clause
   * bound to nothing and was dropped. The query then ran as an unfiltered
   * count and returned a number that looked right.
   */
  it('treats a repeated intent word as a column name, keeping the filter', () => {
    const parsed = parseQuery('count of orders where total between 10 and 20');
    expect(parsed.intent).toBe('count');
    expect(parsed.source).toBe('orders');
    expect([...parsed.filters]).toEqual([
      { field: 'total', comparison: 'between', value: 10, upper: 20 },
    ]);
  });

  /*
   * REGRESSION. The `5` bound to nothing and vanished silently; only `Word`
   * lexemes were being reported as unused, so a dropped number looked like a
   * complete parse.
   */
  it('reports a number that bound to nothing', () => {
    const parsed = parseQuery('show the 5 highest paid from staff');
    expect([...parsed.unrecognized]).toEqual(['5']);
    expect([...parsed.fields]).toEqual(['highest', 'paid']);
  });

  /*
   * REGRESSION. `%` and other characters the tokenizer cannot read were being
   * discarded between matches, so a LIKE pattern's value was silently wrong.
   * They are reported separately from `unrecognized`, because a word that was
   * read and not used is a different fault from a character never read.
   */
  it('keeps a quoted value intact, metacharacters and all', () => {
    const parsed = parseQuery('find users whose name contains "50%_x"');
    expect([...parsed.filters]).toEqual([
      { field: 'name', comparison: 'contains', value: '50%_x' },
    ]);
    expect([...parsed.unparsed]).toEqual([]);
  });

  it('reports characters it could not read at all', () => {
    const parsed = parseQuery('show from users where name contains 50%');
    expect([...parsed.unparsed]).toEqual(['%']);
  });

  it('reports an orphan `where` but not one that bound a filter', () => {
    expect([
      ...parseQuery('show from users where age > 1').unrecognized,
    ]).toEqual([]);
    expect([...parseQuery('show from users where').unrecognized]).toEqual([
      'where',
    ]);
  });

  it('reads a date literal without splitting it into a negative number', () => {
    const parsed = parseQuery(
      'show from events where created at least 2026-01-31'
    );
    expect([...parsed.unparsed]).toEqual([]);
    expect([...parsed.filters]).toEqual([
      { field: 'created', comparison: '>=', value: '2026-01-31' },
    ]);
  });

  it('refuses an empty query', () => {
    expect(() => parseQuery('   ')).toThrow(/`query` is required/);
  });

  it('refuses a query that names nothing to read from', () => {
    expect(() => parseQuery('show')).toThrow(/does not name what to query/);
  });

  /*
   * `is not greater than` would otherwise collapse to `>`, which is the exact
   * opposite of what it says. Guessing here is worse than refusing: the
   * caller gets rows that satisfy the negation of their filter.
   */
  it('refuses two comparisons in a row rather than picking one', () => {
    expect(() => parseQuery('price is not greater than 10 from items')).toThrow(
      /puts two comparisons in a row \(!= then >\)/
    );
  });

  it('refuses a sort direction with no field to sort by', () => {
    expect(() => parseQuery('how many users descending')).toThrow(
      /names a sort direction but no field to sort by/
    );
  });

  it('refuses a limit that is not a whole number of at least 1', () => {
    expect(() => parseQuery('show from users limit 0')).toThrow(
      /whole number of at least 1/
    );
    expect(() => parseQuery('show from users limit')).toThrow(
      /whole number of at least 1/
    );
  });

  it('refuses a name the identifier rule does not admit', () => {
    // The renderers interpolate names, so an unchecked one can never reach them.
    expect(() => parseQuery('show from "users"')).toThrow();
  });
});

describe('query-core: renderSql', () => {
  const ORDERED = parseQuery(
    'show name, email from users where age > 18 sorted by name descending limit 5'
  );

  it('numbers placeholders and double-quotes identifiers for postgres', () => {
    const rendering = renderSql(ORDERED, SqlDialect.Postgres);
    expect(rendering.sql).toBe(
      'SELECT "name", "email" FROM "users" WHERE "age" > $1 ORDER BY "name" DESC LIMIT $2'
    );
    expect([...rendering.parameters]).toEqual([18, 5]);
    expect(rendering.placeholder).toBe('$n');
  });

  it('uses FETCH FIRST for ansi, which has no LIMIT clause', () => {
    const rendering = renderSql(ORDERED, SqlDialect.Ansi);
    expect(rendering.sql).toBe(
      'SELECT "name", "email" FROM "users" WHERE "age" > ? ORDER BY "name" DESC FETCH FIRST ? ROWS ONLY'
    );
    expect(rendering.placeholder).toBe('?');
  });

  it('back-quotes identifiers for mysql', () => {
    const rendering = renderSql(
      parseQuery('show from users where name contains "a"'),
      SqlDialect.MySql
    );
    expect(rendering.sql).toBe(
      "SELECT * FROM `users` WHERE `name` LIKE ? ESCAPE '\\'"
    );
  });

  it('keeps LIMIT for sqlite', () => {
    const rendering = renderSql(
      parseQuery('show from users limit 3'),
      SqlDialect.Sqlite
    );
    expect(rendering.sql).toBe('SELECT * FROM "users" LIMIT ?');
    expect([...rendering.parameters]).toEqual([3]);
  });

  it('defaults to ansi when no dialect is named', () => {
    expect(renderSql(parseQuery('show from users')).dialect).toBe(
      SqlDialect.Ansi
    );
  });

  /*
   * A `%` or `_` inside the caller's value is a LIKE wildcard unless escaped,
   * so an unescaped `50%` would match anything starting with 50. The escape
   * character is declared in the statement rather than assumed.
   */
  it('escapes LIKE wildcards in the caller value and declares the escape', () => {
    const rendering = renderSql(
      parseQuery('find users whose name contains "50%_x"')
    );
    expect([...rendering.parameters]).toEqual(['%50\\%\\_x%']);
    expect(rendering.sql).toBe(
      'SELECT * FROM "users" WHERE "name" LIKE ? ESCAPE \'\\\''
    );
  });

  it('renders an aggregate and a grouping', () => {
    const rendering = renderSql(
      parseQuery('average of total from orders where status is "open"'),
      SqlDialect.Postgres
    );
    expect(rendering.sql).toBe(
      'SELECT AVG("total") FROM "orders" WHERE "status" = $1'
    );
    expect([...rendering.parameters]).toEqual(['open']);
  });

  it('renders a count with BETWEEN as two parameters', () => {
    const rendering = renderSql(
      parseQuery('how many orders where total between 10 and 20')
    );
    expect(rendering.sql).toBe(
      'SELECT COUNT(*) FROM "orders" WHERE "total" BETWEEN ? AND ?'
    );
    expect([...rendering.parameters]).toEqual([10, 20]);
  });

  it('puts every caller value in parameters and none in the statement', () => {
    const rendering = renderSql(
      parseQuery(
        'show from users where name is "O\'Brien" and age > 30 limit 2'
      ),
      SqlDialect.Postgres
    );
    expect([...rendering.parameters]).toEqual(["O'Brien", 30, 2]);
    expect(rendering.sql).not.toContain('Brien');
  });
});

describe('query-core: renderMongo', () => {
  it('renders a projection, a sort and a limit for a select', () => {
    expect(
      renderMongo(
        parseQuery(
          'show name from users where name starts with "a" sorted by name limit 3'
        )
      )
    ).toEqual({
      collection: 'users',
      method: 'find',
      filter: { name: { $regex: '^a', $options: 'i' } },
      projection: { name: 1 },
      sort: { name: 1 },
      limit: 3,
    });
  });

  it('renders a bare select with no projection at all', () => {
    expect(renderMongo(parseQuery('show from users'))).toEqual({
      collection: 'users',
      method: 'find',
      filter: {},
    });
  });

  it('uses countDocuments for a count, with the filter intact', () => {
    expect(
      renderMongo(parseQuery('how many orders where total between 10 and 20'))
    ).toEqual({
      collection: 'orders',
      method: 'countDocuments',
      filter: { total: { $gte: 10, $lte: 20 } },
    });
  });

  it('uses an aggregate pipeline for a grouped average', () => {
    const rendering = renderMongo(
      parseQuery('average of salary per department from staff')
    );
    expect(rendering.method).toBe('aggregate');
    expect(rendering.pipeline).toEqual([
      {
        $group: {
          _id: { department: '$department' },
          value: { $avg: '$salary' },
        },
      },
    ]);
  });

  /*
   * `contains` becomes a regex, so a `.` in the caller's value would match any
   * character and quietly widen the result set.
   */
  it('escapes regex metacharacters in a text value', () => {
    const rendering = renderMongo(
      parseQuery('find users whose name contains "a.b"')
    );
    expect(rendering.filter).toEqual({
      name: { $regex: 'a\\.b', $options: 'i' },
    });
  });
});

describe('query-core: renderGraphql', () => {
  it('emits typed variables and names the convention it used', () => {
    const rendering = renderGraphql(
      parseQuery(
        'show name, email from users where age > 18 sorted by name descending limit 5'
      )
    );
    expect(rendering.variables).toEqual({ v1: 18, v2: 5 });
    // GraphQL standardises no filter or pagination convention, so it is named.
    expect(rendering.convention).toBe('field-suffix-filters');
    expect(rendering.query).toContain('users(where: { age_gt: $v1 }');
    expect(rendering.query).toContain('orderBy: name_DESC');
    expect(rendering.query).toContain('first: $v2');
    expect(rendering.query).toContain('    name\n    email');
  });
});

describe('query-core: renderGrammar', () => {
  /*
   * Round-tripping is what lets `suggest-query` hand a caller an example: the
   * example is produced by this renderer, so it parses by construction rather
   * than by someone having typed it carefully.
   */
  it.each([
    'show from users',
    'how many users',
    'show name, email from users where age > 18 sorted by name descending limit 5',
    'average of salary from staff per department sorted by salary descending limit 10',
    'how many orders where total between 10 and 20',
    'show from users where name contains "50%_x"',
  ])('round-trips %s to the identical parse', (query) => {
    const once = parseQuery(query);
    const rendered = renderGrammar(once);
    expect(parseQuery(rendered)).toEqual(once);
  });

  it('writes the grammar phrase, not the parsed key', () => {
    // `starts-with` is the parsed key; `starts with` is what the grammar reads.
    const rendered = renderGrammar(
      parseQuery('show from users where name starts with "a"')
    );
    expect(rendered).toBe('show from users where name starts with "a"');
    expect(rendered).not.toContain('starts-with');
  });

  it('normalises an equivalent phrasing to one canonical form', () => {
    expect(
      renderGrammar(parseQuery('find users whose name contains "bo"'))
    ).toBe('show from users where name contains "bo"');
  });
});
