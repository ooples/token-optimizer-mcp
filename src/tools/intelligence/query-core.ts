/**
 * The query grammar this package can parse, the parse itself, and the three
 * renderings of a parsed query.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT: a parser for a restricted controlled
 * language whose entire vocabulary is published from this file, in `PHRASES`.
 * It is not natural-language understanding, and the distinction is about
 * honesty rather than ambition. A translator that accepted arbitrary English
 * and emitted SQL anyway would have to guess, and a guess rendered as a query
 * is indistinguishable from a correct translation until it runs against the
 * caller's data -- by which time the caller has acted on it. So `parse` binds
 * what the grammar covers, reports every word it did not use in
 * `unrecognized`, and refuses outright when a piece the query needs is
 * missing, naming the piece.
 *
 * WHY THE PARSER OWNS IDENTIFIER VALIDATION: a value can be parameterized at
 * render time, but a table or column name cannot -- it has to be interpolated
 * into the statement. Every name a parse binds is checked here against
 * IDENTIFIER_PATTERN, so no renderer can be reached with an unchecked one.
 * The renderers quote identifiers and parameterize values; neither of them
 * sanitizes, because by then there is nothing left to sanitize.
 */

/** The intents the grammar can express. */
export const QUERY_INTENTS = [
  'select',
  'count',
  'sum',
  'average',
  'min',
  'max',
] as const;
export type QueryIntent = (typeof QUERY_INTENTS)[number];

/** The intents that summarise a column rather than return rows. */
export const AGGREGATE_INTENTS: ReadonlyArray<QueryIntent> = Object.freeze([
  'count',
  'sum',
  'average',
  'min',
  'max',
]);

/** The comparisons a filter can use. */
export const COMPARISONS = [
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
] as const;
export type Comparison = (typeof COMPARISONS)[number];

/** The comparisons that need a number-like operand on both sides. */
const ORDERED_COMPARISONS: ReadonlyArray<Comparison> = Object.freeze([
  '>',
  '>=',
  '<',
  '<=',
  'between',
]);

/** The comparisons that only mean anything against text. */
const TEXT_COMPARISONS: ReadonlyArray<Comparison> = Object.freeze([
  'contains',
  'starts-with',
  'ends-with',
]);

export function isOrderedComparison(comparison: Comparison): boolean {
  return ORDERED_COMPARISONS.includes(comparison);
}

export function isTextComparison(comparison: Comparison): boolean {
  return TEXT_COMPARISONS.includes(comparison);
}

/** How the parse decided which table or collection the query is over. */
export enum SourceBinding {
  /** Named by `from x` or `in x`. */
  Keyword = 'keyword',
  /** Taken from the position of the subject noun, with no keyword to confirm it. */
  Position = 'position',
}

/** The SQL dialects `renderSql` knows how to differ for. */
export enum SqlDialect {
  Ansi = 'ansi',
  Postgres = 'postgres',
  MySql = 'mysql',
  Sqlite = 'sqlite',
}

export const SQL_DIALECTS: ReadonlyArray<SqlDialect> = Object.freeze([
  SqlDialect.Ansi,
  SqlDialect.Postgres,
  SqlDialect.MySql,
  SqlDialect.Sqlite,
]);

export function isSqlDialect(value: unknown): value is SqlDialect {
  return (
    typeof value === 'string' && SQL_DIALECTS.includes(value as SqlDialect)
  );
}

/** The field types a caller-supplied schema can declare. */
export const FIELD_TYPES = ['number', 'string', 'boolean', 'date'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export function isFieldType(value: unknown): value is FieldType {
  return typeof value === 'string' && FIELD_TYPES.includes(value as FieldType);
}

/** A schema is sources, each naming its fields and their types. */
export type QuerySchema = Readonly<
  Record<string, Readonly<Record<string, FieldType>>>
>;

export type QueryValue = string | number | boolean;

export interface Filter {
  readonly field: string;
  readonly comparison: Comparison;
  readonly value: QueryValue;
  /** The upper operand, present only for `between`. */
  readonly upper?: QueryValue;
}

export interface Ordering {
  readonly field: string;
  readonly descending: boolean;
}

export interface ParsedQuery {
  readonly intent: QueryIntent;
  readonly source: string;
  readonly sourceFrom: SourceBinding;
  /** The column an aggregate is over; null for `select` and `count`. */
  readonly measure: string | null;
  /** The projected columns; empty means every column. */
  readonly fields: readonly string[];
  readonly filters: readonly Filter[];
  readonly groupBy: readonly string[];
  readonly ordering: Ordering | null;
  readonly limit: number | null;
  /** Every word the grammar read but did not use, in the order they appeared. */
  readonly unrecognized: readonly string[];
  /**
   * Every run of characters the tokenizer could not read at all, which is a
   * different thing from a word it read and did not use. Both are reported
   * because a query is acted on: a dropped `%` changes what a LIKE pattern
   * matches, and a dropped clause changes the answer.
   */
  readonly unparsed: readonly string[];
}

/*
 * A single segment of a name. Anchored, with no nested quantifier, so it is
 * linear in the length of the input. Anything a renderer interpolates must
 * match this, which is why the dot-qualified form is spelled out rather than
 * repeated with `+`.
 */
const IDENTIFIER_PATTERN =
  /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

export function isIdentifier(value: string): boolean {
  return IDENTIFIER_PATTERN.test(value);
}

/* ------------------------------------------------------------------------- */
/* Lexing                                                                    */
/* ------------------------------------------------------------------------- */

enum LexKind {
  Intent,
  Comparison,
  From,
  Where,
  And,
  Between,
  OrderBy,
  GroupBy,
  By,
  Of,
  Direction,
  Limit,
  Noise,
  Word,
  Literal,
}

/**
 * What a phrase binds to, before the text that matched it is attached. Every
 * lexeme carries its source text, so an unused one can be named back to the
 * caller instead of disappearing.
 */
type Seed =
  | { readonly kind: LexKind.Intent; readonly intent: QueryIntent }
  | { readonly kind: LexKind.Comparison; readonly comparison: Comparison }
  | { readonly kind: LexKind.Direction; readonly descending: boolean }
  | {
      readonly kind:
        | LexKind.From
        | LexKind.Where
        | LexKind.And
        | LexKind.Between
        | LexKind.OrderBy
        | LexKind.GroupBy
        | LexKind.By
        | LexKind.Of
        | LexKind.Limit
        | LexKind.Noise
        | LexKind.Word;
    }
  | {
      readonly kind: LexKind.Literal;
      readonly value: QueryValue;
      readonly quoted: boolean;
    };

type Lexeme = Seed & { readonly text: string };

const INTENT = (intent: QueryIntent): Seed => ({
  kind: LexKind.Intent,
  intent,
});
const CMP = (comparison: Comparison): Seed => ({
  kind: LexKind.Comparison,
  comparison,
});
const DIR = (descending: boolean): Seed => ({
  kind: LexKind.Direction,
  descending,
});

/**
 * THE PUBLISHED VOCABULARY. Everything the parser understands is in this
 * table; a word outside it is reported in `unrecognized` rather than guessed
 * at. Longer phrases are matched first, which is what lets `highest first`
 * mean a direction while `highest` alone means the max intent, and `is not`
 * mean inequality while `is` alone is the copula.
 */
export const PHRASES: ReadonlyArray<readonly [string, Seed]> = Object.freeze([
  // Intents.
  ['how many', INTENT('count')],
  ['number of', INTENT('count')],
  ['count of', INTENT('count')],
  ['count', INTENT('count')],
  ['sum of', INTENT('sum')],
  ['total of', INTENT('sum')],
  ['total', INTENT('sum')],
  ['sum', INTENT('sum')],
  ['average of', INTENT('average')],
  ['mean of', INTENT('average')],
  ['average', INTENT('average')],
  ['mean', INTENT('average')],
  ['avg', INTENT('average')],
  ['minimum of', INTENT('min')],
  ['min of', INTENT('min')],
  ['smallest', INTENT('min')],
  ['lowest', INTENT('min')],
  ['earliest', INTENT('min')],
  ['minimum', INTENT('min')],
  ['min', INTENT('min')],
  ['maximum of', INTENT('max')],
  ['max of', INTENT('max')],
  ['largest', INTENT('max')],
  ['highest', INTENT('max')],
  ['latest', INTENT('max')],
  ['maximum', INTENT('max')],
  ['max', INTENT('max')],
  ['show me', INTENT('select')],
  ['what are', INTENT('select')],
  ['show', INTENT('select')],
  ['list', INTENT('select')],
  ['get', INTENT('select')],
  ['find', INTENT('select')],
  ['select', INTENT('select')],
  ['which', INTENT('select')],
  ['what', INTENT('select')],
  // Directions, before the comparisons and intents they share a word with.
  ['highest first', DIR(true)],
  ['largest first', DIR(true)],
  ['newest first', DIR(true)],
  ['most recent first', DIR(true)],
  ['descending', DIR(true)],
  ['desc', DIR(true)],
  ['lowest first', DIR(false)],
  ['smallest first', DIR(false)],
  ['oldest first', DIR(false)],
  ['ascending', DIR(false)],
  ['asc', DIR(false)],
  // Comparisons.
  ['greater than', CMP('>')],
  ['more than', CMP('>')],
  ['larger than', CMP('>')],
  ['above', CMP('>')],
  ['over', CMP('>')],
  ['exceeds', CMP('>')],
  ['>', CMP('>')],
  ['less than', CMP('<')],
  ['fewer than', CMP('<')],
  ['smaller than', CMP('<')],
  ['below', CMP('<')],
  ['under', CMP('<')],
  ['<', CMP('<')],
  ['at least', CMP('>=')],
  ['no less than', CMP('>=')],
  ['>=', CMP('>=')],
  ['at most', CMP('<=')],
  ['no more than', CMP('<=')],
  ['up to', CMP('<=')],
  ['<=', CMP('<=')],
  ['is not', CMP('!=')],
  ['not equal to', CMP('!=')],
  ['does not equal', CMP('!=')],
  ['!=', CMP('!=')],
  ['<>', CMP('!=')],
  ['equal to', CMP('=')],
  ['equals', CMP('=')],
  ['is', CMP('=')],
  ['=', CMP('=')],
  ['==', CMP('=')],
  ['starts with', CMP('starts-with')],
  ['begins with', CMP('starts-with')],
  ['ends with', CMP('ends-with')],
  ['contains', CMP('contains')],
  ['includes', CMP('contains')],
  ['like', CMP('contains')],
  // Clause keywords.
  ['from', { kind: LexKind.From }],
  ['in', { kind: LexKind.From }],
  ['where', { kind: LexKind.Where }],
  ['whose', { kind: LexKind.Where }],
  ['having', { kind: LexKind.Where }],
  ['with', { kind: LexKind.Where }],
  ['between', { kind: LexKind.Between }],
  ['and', { kind: LexKind.And }],
  ['sorted by', { kind: LexKind.OrderBy }],
  ['ordered by', { kind: LexKind.OrderBy }],
  ['order by', { kind: LexKind.OrderBy }],
  ['sort by', { kind: LexKind.OrderBy }],
  ['grouped by', { kind: LexKind.GroupBy }],
  ['group by', { kind: LexKind.GroupBy }],
  ['for each', { kind: LexKind.GroupBy }],
  ['per', { kind: LexKind.GroupBy }],
  ['by', { kind: LexKind.By }],
  ['of', { kind: LexKind.Of }],
  ['limit', { kind: LexKind.Limit }],
  ['top', { kind: LexKind.Limit }],
  ['first', { kind: LexKind.Limit }],
  // Words carried for readability that bind to nothing.
  ['the', { kind: LexKind.Noise }],
  ['all', { kind: LexKind.Noise }],
  ['an', { kind: LexKind.Noise }],
  ['a', { kind: LexKind.Noise }],
  ['me', { kind: LexKind.Noise }],
  ['please', { kind: LexKind.Noise }],
  ['rows', { kind: LexKind.Noise }],
  ['row', { kind: LexKind.Noise }],
  ['records', { kind: LexKind.Noise }],
  ['record', { kind: LexKind.Noise }],
  ['entries', { kind: LexKind.Noise }],
  ['entry', { kind: LexKind.Noise }],
  ['are', { kind: LexKind.Noise }],
  ['there', { kind: LexKind.Noise }],
  [',', { kind: LexKind.Noise }],
]);

const MAX_PHRASE_WORDS = PHRASES.reduce(
  (longest, [phrase]) => Math.max(longest, phrase.split(' ').length),
  1
);

const PHRASE_TABLE: ReadonlyMap<string, Seed> = new Map(PHRASES);

interface RawToken {
  readonly text: string;
  readonly literal?: QueryValue;
  readonly quoted?: boolean;
}

/*
 * Quoted strings first so their contents are never phrase-matched, then dates
 * before numbers (a bare `-` in 2026-01-31 would otherwise start a negative
 * number), then numbers, names and finally the comparison symbols.
 */
const TOKEN_PATTERN =
  /"([^"]*)"|'([^']*)'|(\d{4}-\d{2}-\d{2})|(-?\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_.]*)|(<=|>=|<>|!=|==|<|>|=)|([,;])/g;

interface TokenScan {
  readonly tokens: readonly RawToken[];
  readonly unparsed: readonly string[];
}

function tokenize(query: string): TokenScan {
  const tokens: RawToken[] = [];
  const unparsed: string[] = [];
  const pattern = new RegExp(TOKEN_PATTERN.source, 'g');
  let consumedTo = 0;
  let match = pattern.exec(query);
  while (match !== null) {
    // Whatever sat between the last token and this one was read by nothing.
    const gap = query.slice(consumedTo, match.index).trim();
    if (gap !== '') unparsed.push(gap);
    consumedTo = match.index + match[0].length;
    const [, double, single, date, numeric, name, symbol, separator] = match;
    if (double !== undefined)
      tokens.push({ text: double, literal: double, quoted: true });
    else if (single !== undefined)
      tokens.push({ text: single, literal: single, quoted: true });
    else if (date !== undefined) tokens.push({ text: date, literal: date });
    else if (numeric !== undefined)
      tokens.push({ text: numeric, literal: Number(numeric) });
    else if (name !== undefined) tokens.push({ text: name });
    else if (symbol !== undefined) tokens.push({ text: symbol });
    /*
     * A separator is read and then discarded, which is not the same as being
     * unreadable: `show name, email from users` is the form this file's own
     * `renderGrammar` emits, so a comma landing in `unparsed` made every
     * multi-column query report a character it could not read -- and made the
     * canonical rendering of a query fail to round-trip through this parser.
     */ else if (separator !== undefined) tokens.push({ text: ',' });
    match = pattern.exec(query);
  }
  const tail = query.slice(consumedTo).trim();
  if (tail !== '') unparsed.push(tail);
  return { tokens, unparsed };
}

interface LexScan {
  readonly lexemes: readonly Lexeme[];
  readonly unparsed: readonly string[];
}

function lex(query: string): LexScan {
  const { tokens, unparsed } = tokenize(query);
  const lexemes: Lexeme[] = [];
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token.quoted === true) {
      const value: QueryValue =
        token.literal === undefined ? '' : token.literal;
      lexemes.push({
        kind: LexKind.Literal,
        value,
        quoted: true,
        text: token.text,
      });
      index += 1;
      continue;
    }
    // Longest phrase wins, so `is not` beats `is` and `highest first` beats
    // `highest`.
    let matched: Seed | undefined;
    let matchedText = '';
    let width = 0;
    for (
      let span = Math.min(MAX_PHRASE_WORDS, tokens.length - index);
      span >= 1;
      span -= 1
    ) {
      const slice = tokens.slice(index, index + span);
      if (slice.some((entry) => entry.quoted === true)) continue;
      const phrase = slice.map((entry) => entry.text.toLowerCase()).join(' ');
      const found = PHRASE_TABLE.get(phrase);
      if (found !== undefined) {
        matched = found;
        matchedText = slice.map((entry) => entry.text).join(' ');
        width = span;
        break;
      }
    }
    if (matched !== undefined) {
      lexemes.push({ ...matched, text: matchedText });
      index += width;
      continue;
    }
    const lowered = token.text.toLowerCase();
    if (lowered === 'true' || lowered === 'false')
      lexemes.push({
        kind: LexKind.Literal,
        value: lowered === 'true',
        quoted: false,
        text: token.text,
      });
    else if (token.literal !== undefined)
      lexemes.push({
        kind: LexKind.Literal,
        value: token.literal,
        quoted: false,
        text: token.text,
      });
    else lexemes.push({ kind: LexKind.Word, text: token.text });
    index += 1;
  }
  return {
    lexemes: collapseCopula(demoteLaterIntents(lexemes), query),
    unparsed,
  };
}

/**
 * An intent is named once, at the head of the query; a later occurrence of the
 * same word is a column name.
 *
 * WHY THIS RULE EXISTS: `count of orders where total between 10 and 20` has
 * `total` in the intent vocabulary, so without this the whole `between` filter
 * bound to nothing and was dropped -- the query ran as an unfiltered count and
 * returned a number that looked right. Demoting the later intent makes `total`
 * the field it plainly is.
 */
function demoteLaterIntents(lexemes: readonly Lexeme[]): Lexeme[] {
  let seen = false;
  return lexemes.map((lexeme) => {
    if (lexeme.kind !== LexKind.Intent) return lexeme;
    if (!seen) {
      seen = true;
      return lexeme;
    }
    return { kind: LexKind.Word, text: lexeme.text };
  });
}

/**
 * `price is greater than 10` lexes to two comparisons in a row, because `is`
 * is itself one. The copula is dropped so the real comparison survives. Two
 * comparisons where the first is NOT the copula is refused instead of
 * resolved: `is not greater than` would otherwise silently become `>`, the
 * exact opposite of what it says.
 */
function collapseCopula(lexemes: readonly Lexeme[], query: string): Lexeme[] {
  const out: Lexeme[] = [];
  for (let index = 0; index < lexemes.length; index += 1) {
    const current = lexemes[index];
    const next = lexemes[index + 1];
    if (
      current.kind === LexKind.Comparison &&
      next !== undefined &&
      (next.kind === LexKind.Comparison || next.kind === LexKind.Between)
    ) {
      if (current.comparison === '=') continue;
      const after =
        next.kind === LexKind.Comparison ? next.comparison : 'between';
      throw new Error(
        `natural-language-query parse: ${JSON.stringify(query)} puts two comparisons in a row (${current.comparison} then ${after}); the grammar cannot tell which one is meant`
      );
    }
    out.push(current);
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* Parsing                                                                   */
/* ------------------------------------------------------------------------- */

const CLAUSE_KINDS: ReadonlySet<LexKind> = new Set([
  LexKind.From,
  LexKind.Where,
  LexKind.OrderBy,
  LexKind.GroupBy,
  LexKind.By,
  LexKind.Limit,
  LexKind.Between,
  LexKind.Comparison,
]);

function requireIdentifier(role: string, name: string, query: string): string {
  if (!isIdentifier(name))
    throw new Error(
      `natural-language-query parse: ${JSON.stringify(query)} uses ${JSON.stringify(name)} as a ${role}, which is not a valid name`
    );
  return name;
}

function literalOf(lexeme: Lexeme | undefined): QueryValue | undefined {
  if (lexeme === undefined) return undefined;
  if (lexeme.kind === LexKind.Literal) return lexeme.value;
  // A bare word after a comparison is a string value: `status is active`.
  if (lexeme.kind === LexKind.Word) return lexeme.text;
  return undefined;
}

/**
 * Bind a query against the grammar, or refuse and name what is missing.
 */
export function parseQuery(query: string): ParsedQuery {
  if (typeof query !== 'string' || query.trim() === '')
    throw new Error(
      'natural-language-query: `query` is required and must be a non-empty string'
    );
  const { lexemes, unparsed } = lex(query);
  if (lexemes.length === 0)
    throw new Error(
      `natural-language-query parse: ${JSON.stringify(query)} holds no word the grammar can read`
    );

  const consumed = new Set<number>();
  const take = (index: number): void => {
    consumed.add(index);
  };

  // Filters: every `field comparison value` triple, wherever it appears.
  const filters: Filter[] = [];
  for (let index = 0; index < lexemes.length; index += 1) {
    const head = lexemes[index];
    if (head.kind !== LexKind.Word) continue;
    const operator = lexemes[index + 1];
    if (operator === undefined) continue;
    if (operator.kind === LexKind.Between) {
      const lower = literalOf(lexemes[index + 2]);
      const joiner = lexemes[index + 3];
      const upper = literalOf(lexemes[index + 4]);
      if (
        lower === undefined ||
        joiner === undefined ||
        joiner.kind !== LexKind.And ||
        upper === undefined
      )
        throw new Error(
          `natural-language-query parse: \`between\` on ${JSON.stringify(head.text)} needs two bounds, written \`between <low> and <high>\``
        );
      filters.push({
        field: requireIdentifier('field', head.text, query),
        comparison: 'between',
        value: lower,
        upper,
      });
      for (let offset = 0; offset <= 4; offset += 1) take(index + offset);
      index += 4;
      continue;
    }
    if (operator.kind !== LexKind.Comparison) continue;
    const value = literalOf(lexemes[index + 2]);
    if (value === undefined)
      throw new Error(
        `natural-language-query parse: ${JSON.stringify(head.text)} ${operator.comparison} has nothing to compare against`
      );
    filters.push({
      field: requireIdentifier('field', head.text, query),
      comparison: operator.comparison,
      value,
    });
    take(index);
    take(index + 1);
    take(index + 2);
    index += 2;
  }

  // Intent: the first one named, or `select` when none is.
  let intent: QueryIntent = 'select';
  let intentIndex = -1;
  for (let index = 0; index < lexemes.length; index += 1) {
    const lexeme = lexemes[index];
    if (lexeme.kind === LexKind.Intent) {
      intent = lexeme.intent;
      intentIndex = index;
      take(index);
      break;
    }
  }
  const aggregate = intent !== 'select';

  // Source: `from x` anywhere, else the subject noun in the head.
  let source: string | undefined;
  let sourceFrom = SourceBinding.Keyword;
  for (let index = 0; index < lexemes.length; index += 1) {
    if (lexemes[index].kind !== LexKind.From) continue;
    const named = lexemes[index + 1];
    if (
      named === undefined ||
      named.kind !== LexKind.Word ||
      consumed.has(index + 1)
    )
      continue;
    source = requireIdentifier('source', named.text, query);
    take(index);
    take(index + 1);
    break;
  }

  // The head runs from the intent to the first clause keyword, and holds the
  // measure or the projected fields.
  const headWords: Array<{ index: number; text: string }> = [];
  for (let index = intentIndex + 1; index < lexemes.length; index += 1) {
    const lexeme = lexemes[index];
    if (CLAUSE_KINDS.has(lexeme.kind)) break;
    if (consumed.has(index)) continue;
    if (lexeme.kind === LexKind.Word)
      headWords.push({ index, text: lexeme.text });
  }

  if (source === undefined) {
    const subject = headWords.pop();
    if (subject === undefined)
      throw new Error(
        `natural-language-query parse: ${JSON.stringify(query)} does not name what to query; write \`from <source>\` or name the subject`
      );
    source = requireIdentifier('source', subject.text, query);
    sourceFrom = SourceBinding.Position;
    take(subject.index);
  }

  let measure: string | null = null;
  const fields: string[] = [];
  if (aggregate && intent !== 'count') {
    const first = headWords.shift();
    if (first === undefined)
      throw new Error(
        `natural-language-query parse: ${intent} needs a field to summarise, written \`${intent} of <field> from ${source}\``
      );
    measure = requireIdentifier('field', first.text, query);
    take(first.index);
  } else if (!aggregate) {
    for (const word of headWords) {
      fields.push(requireIdentifier('field', word.text, query));
      take(word.index);
    }
    headWords.length = 0;
  }

  // Grouping: an explicit keyword, or `by` when the intent aggregates.
  const groupBy: string[] = [];
  for (let index = 0; index < lexemes.length; index += 1) {
    const lexeme = lexemes[index];
    const isGroup =
      lexeme.kind === LexKind.GroupBy ||
      (lexeme.kind === LexKind.By && aggregate);
    if (!isGroup) continue;
    take(index);
    for (let scan = index + 1; scan < lexemes.length; scan += 1) {
      const next = lexemes[scan];
      if (next.kind === LexKind.And) {
        take(scan);
        continue;
      }
      if (next.kind !== LexKind.Word || consumed.has(scan)) break;
      groupBy.push(requireIdentifier('field', next.text, query));
      take(scan);
    }
  }

  // Ordering: an explicit keyword, or `by` when the intent returns rows.
  let ordering: Ordering | null = null;
  let descending = false;
  let directionNamed = false;
  for (let index = 0; index < lexemes.length; index += 1) {
    const lexeme = lexemes[index];
    if (lexeme.kind === LexKind.Direction) {
      descending = lexeme.descending;
      directionNamed = true;
      take(index);
    }
  }
  for (let index = 0; index < lexemes.length; index += 1) {
    const lexeme = lexemes[index];
    const isOrder =
      lexeme.kind === LexKind.OrderBy ||
      (lexeme.kind === LexKind.By && !aggregate);
    if (!isOrder || ordering !== null) continue;
    take(index);
    const named = lexemes[index + 1];
    if (
      named === undefined ||
      named.kind !== LexKind.Word ||
      consumed.has(index + 1)
    )
      throw new Error(
        `natural-language-query parse: ${JSON.stringify(query)} asks to order but does not name the field to order by`
      );
    ordering = {
      field: requireIdentifier('field', named.text, query),
      descending,
    };
    take(index + 1);
  }
  if (ordering === null && directionNamed) {
    /*
     * A direction with no field is not resolved to a default. Ordering by the
     * wrong column silently reorders the caller's whole result, and "the
     * measure" or "the first column" would be a guess dressed as a parse.
     */
    throw new Error(
      `natural-language-query parse: ${JSON.stringify(query)} names a sort direction but no field to sort by`
    );
  }

  // Limit.
  let limit: number | null = null;
  for (let index = 0; index < lexemes.length; index += 1) {
    if (lexemes[index].kind !== LexKind.Limit) continue;
    const named = lexemes[index + 1];
    const value =
      named !== undefined && named.kind === LexKind.Literal
        ? named.value
        : undefined;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1)
      throw new Error(
        `natural-language-query parse: ${JSON.stringify(query)} asks for a row limit but does not follow it with a whole number of at least 1`
      );
    limit = value;
    take(index);
    take(index + 1);
    break;
  }

  /*
   * Everything left over, keyword or not. Reporting only the plain words would
   * hide the costlier case: a clause keyword or a number that bound to nothing
   * is a part of the query that was read and then dropped, and the caller acts
   * on the result either way.
   */
  const unrecognized: string[] = [];
  for (let index = 0; index < lexemes.length; index += 1) {
    const lexeme = lexemes[index];
    if (consumed.has(index)) continue;
    if (lexeme.kind === LexKind.Noise || lexeme.kind === LexKind.And) continue;
    if (lexeme.kind === LexKind.Of) continue;
    /*
     * `where` binds nothing of its own, so it is read rather than unused --
     * but only once a filter actually bound. `show users where` with nothing
     * after it did read the word and then do nothing with it, and that is
     * worth saying.
     */
    if (lexeme.kind === LexKind.Where && filters.length > 0) continue;
    unrecognized.push(lexeme.text);
  }

  return {
    intent,
    source,
    sourceFrom,
    measure,
    fields,
    filters,
    groupBy,
    ordering,
    limit,
    unrecognized,
    unparsed,
  };
}

/* ------------------------------------------------------------------------- */
/* Rendering                                                                 */
/* ------------------------------------------------------------------------- */

export interface SqlRendering {
  readonly dialect: SqlDialect;
  readonly sql: string;
  readonly parameters: readonly QueryValue[];
  /** The placeholder form this dialect uses, so the caller can bind by it. */
  readonly placeholder: string;
}

function quoteIdentifier(name: string, dialect: SqlDialect): string {
  /*
   * Safe without escaping only because every name here came through
   * IDENTIFIER_PATTERN, which admits no quote character of either kind.
   */
  const parts = name.split('.');
  const wrap =
    dialect === SqlDialect.MySql
      ? (part: string) => `\`${part}\``
      : (part: string) => `"${part}"`;
  return parts.map(wrap).join('.');
}

/**
 * Escape the wildcards a LIKE pattern would otherwise read as operators, so a
 * value containing `%` matches a literal percent rather than anything at all.
 */
function likeEscape(value: QueryValue): string {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}

const AGGREGATE_SQL: Readonly<Record<QueryIntent, string>> = Object.freeze({
  select: '*',
  count: 'COUNT(*)',
  sum: 'SUM',
  average: 'AVG',
  min: 'MIN',
  max: 'MAX',
});

export function renderSql(
  query: ParsedQuery,
  dialect: SqlDialect = SqlDialect.Ansi
): SqlRendering {
  const parameters: QueryValue[] = [];
  const placeholder = dialect === SqlDialect.Postgres ? '$n' : '?';
  const bind = (value: QueryValue): string => {
    parameters.push(value);
    return dialect === SqlDialect.Postgres ? `$${parameters.length}` : '?';
  };

  const projection: string[] = [];
  for (const field of query.groupBy)
    projection.push(quoteIdentifier(field, dialect));
  if (query.intent === 'select') {
    if (query.fields.length === 0) projection.push('*');
    else
      for (const field of query.fields)
        projection.push(quoteIdentifier(field, dialect));
  } else if (query.intent === 'count') {
    projection.push(AGGREGATE_SQL.count);
  } else {
    const measure = query.measure;
    if (measure === null)
      throw new Error(
        `natural-language-query translate-sql: ${query.intent} has no field to summarise`
      );
    projection.push(
      `${AGGREGATE_SQL[query.intent]}(${quoteIdentifier(measure, dialect)})`
    );
  }

  const clauses: string[] = [
    `SELECT ${projection.join(', ')}`,
    `FROM ${quoteIdentifier(query.source, dialect)}`,
  ];

  const conditions: string[] = [];
  for (const filter of query.filters) {
    const column = quoteIdentifier(filter.field, dialect);
    switch (filter.comparison) {
      case 'between': {
        const upper = filter.upper;
        if (upper === undefined)
          throw new Error(
            `natural-language-query translate-sql: \`between\` on ${filter.field} has no upper bound`
          );
        conditions.push(
          `${column} BETWEEN ${bind(filter.value)} AND ${bind(upper)}`
        );
        break;
      }
      case 'contains':
        conditions.push(
          `${column} LIKE ${bind(`%${likeEscape(filter.value)}%`)} ESCAPE '\\'`
        );
        break;
      case 'starts-with':
        conditions.push(
          `${column} LIKE ${bind(`${likeEscape(filter.value)}%`)} ESCAPE '\\'`
        );
        break;
      case 'ends-with':
        conditions.push(
          `${column} LIKE ${bind(`%${likeEscape(filter.value)}`)} ESCAPE '\\'`
        );
        break;
      default:
        conditions.push(`${column} ${filter.comparison} ${bind(filter.value)}`);
        break;
    }
  }
  if (conditions.length > 0) clauses.push(`WHERE ${conditions.join(' AND ')}`);
  if (query.groupBy.length > 0)
    clauses.push(
      `GROUP BY ${query.groupBy.map((field) => quoteIdentifier(field, dialect)).join(', ')}`
    );
  if (query.ordering !== null)
    clauses.push(
      `ORDER BY ${quoteIdentifier(query.ordering.field, dialect)} ${
        query.ordering.descending ? 'DESC' : 'ASC'
      }`
    );
  if (query.limit !== null) {
    // The limit is parameterized like any other value, and ANSI spells the
    // clause differently from the three dialects that followed MySQL.
    clauses.push(
      dialect === SqlDialect.Ansi
        ? `FETCH FIRST ${bind(query.limit)} ROWS ONLY`
        : `LIMIT ${bind(query.limit)}`
    );
  }

  return { dialect, sql: clauses.join(' '), parameters, placeholder };
}

export interface MongoRendering {
  readonly collection: string;
  readonly method: 'find' | 'countDocuments' | 'aggregate';
  readonly filter: Record<string, unknown>;
  readonly projection?: Record<string, 1>;
  readonly sort?: Record<string, 1 | -1>;
  readonly limit?: number;
  readonly pipeline?: ReadonlyArray<Record<string, unknown>>;
}

/** Escape the characters a regex would read as operators. */
function regexEscape(value: QueryValue): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const MONGO_OPERATORS: Readonly<Record<string, string>> = Object.freeze({
  '!=': '$ne',
  '>': '$gt',
  '>=': '$gte',
  '<': '$lt',
  '<=': '$lte',
});

const MONGO_GROUP: Readonly<Record<string, string>> = Object.freeze({
  sum: '$sum',
  average: '$avg',
  min: '$min',
  max: '$max',
});

export function renderMongo(query: ParsedQuery): MongoRendering {
  const filter: Record<string, unknown> = {};
  for (const entry of query.filters) {
    if (entry.comparison === '=') {
      filter[entry.field] = entry.value;
      continue;
    }
    if (entry.comparison === 'between') {
      const upper = entry.upper;
      if (upper === undefined)
        throw new Error(
          `natural-language-query translate-mongodb: \`between\` on ${entry.field} has no upper bound`
        );
      filter[entry.field] = { $gte: entry.value, $lte: upper };
      continue;
    }
    if (isTextComparison(entry.comparison)) {
      const escaped = regexEscape(entry.value);
      const anchored =
        entry.comparison === 'starts-with'
          ? `^${escaped}`
          : entry.comparison === 'ends-with'
            ? `${escaped}$`
            : escaped;
      // Case-insensitive, which is what `contains` means when a person writes
      // it; stated in the options so the caller is not guessing.
      filter[entry.field] = { $regex: anchored, $options: 'i' };
      continue;
    }
    const operator = MONGO_OPERATORS[entry.comparison];
    filter[entry.field] = { [operator]: entry.value };
  }

  const sort =
    query.ordering === null
      ? undefined
      : ({
          [query.ordering.field]: query.ordering.descending ? -1 : 1,
        } as Record<string, 1 | -1>);

  if (
    query.groupBy.length > 0 ||
    (query.intent !== 'select' && query.intent !== 'count')
  ) {
    const id =
      query.groupBy.length === 0
        ? null
        : query.groupBy.reduce<Record<string, string>>((into, field) => {
            into[field] = `$${field}`;
            return into;
          }, {});
    const group: Record<string, unknown> = { _id: id };
    if (query.intent === 'count' || query.intent === 'select')
      group.value = { $sum: 1 };
    else {
      const measure = query.measure;
      if (measure === null)
        throw new Error(
          `natural-language-query translate-mongodb: ${query.intent} has no field to summarise`
        );
      group.value = { [MONGO_GROUP[query.intent]]: `$${measure}` };
    }
    const pipeline: Array<Record<string, unknown>> = [];
    if (Object.keys(filter).length > 0) pipeline.push({ $match: filter });
    pipeline.push({ $group: group });
    if (sort !== undefined) pipeline.push({ $sort: sort });
    if (query.limit !== null) pipeline.push({ $limit: query.limit });
    return { collection: query.source, method: 'aggregate', filter, pipeline };
  }

  if (query.intent === 'count')
    return { collection: query.source, method: 'countDocuments', filter };

  const rendering: MongoRendering = {
    collection: query.source,
    method: 'find',
    filter,
    ...(query.fields.length === 0
      ? {}
      : {
          projection: query.fields.reduce<Record<string, 1>>((into, field) => {
            into[field] = 1;
            return into;
          }, {}),
        }),
    ...(sort === undefined ? {} : { sort }),
    ...(query.limit === null ? {} : { limit: query.limit }),
  };
  return rendering;
}

export interface GraphqlRendering {
  readonly query: string;
  readonly variables: Readonly<Record<string, QueryValue>>;
  /**
   * GraphQL has no standard filter or pagination convention, so the renderer
   * names the one it emits rather than implying there is only one.
   */
  readonly convention: 'field-suffix-filters';
}

const GRAPHQL_SUFFIX: Readonly<Record<string, string>> = Object.freeze({
  '=': 'eq',
  '!=': 'ne',
  '>': 'gt',
  '>=': 'gte',
  '<': 'lt',
  '<=': 'lte',
  contains: 'contains',
  'starts-with': 'startsWith',
  'ends-with': 'endsWith',
});

function graphqlType(value: QueryValue): string {
  if (typeof value === 'boolean') return 'Boolean!';
  if (typeof value === 'number')
    return Number.isInteger(value) ? 'Int!' : 'Float!';
  return 'String!';
}

export function renderGraphql(query: ParsedQuery): GraphqlRendering {
  const variables: Record<string, QueryValue> = {};
  const declarations: string[] = [];
  const bind = (value: QueryValue): string => {
    const name = `v${declarations.length + 1}`;
    variables[name] = value;
    declarations.push(`$${name}: ${graphqlType(value)}`);
    return `$${name}`;
  };

  const conditions: string[] = [];
  for (const entry of query.filters) {
    if (entry.comparison === 'between') {
      const upper = entry.upper;
      if (upper === undefined)
        throw new Error(
          `natural-language-query translate-graphql: \`between\` on ${entry.field} has no upper bound`
        );
      conditions.push(`${entry.field}_gte: ${bind(entry.value)}`);
      conditions.push(`${entry.field}_lte: ${bind(upper)}`);
      continue;
    }
    conditions.push(
      `${entry.field}_${GRAPHQL_SUFFIX[entry.comparison]}: ${bind(entry.value)}`
    );
  }

  const args: string[] = [];
  if (conditions.length > 0) args.push(`where: { ${conditions.join(', ')} }`);
  if (query.ordering !== null)
    args.push(
      `orderBy: ${query.ordering.field}_${query.ordering.descending ? 'DESC' : 'ASC'}`
    );
  if (query.limit !== null) args.push(`first: ${bind(query.limit)}`);

  const selection: string[] = [];
  if (query.intent === 'select')
    selection.push(
      ...(query.fields.length === 0 ? ['__typename'] : query.fields)
    );
  else if (query.intent === 'count') selection.push('count');
  else {
    const measure = query.measure;
    if (measure === null)
      throw new Error(
        `natural-language-query translate-graphql: ${query.intent} has no field to summarise`
      );
    selection.push(`${query.intent} { ${measure} }`);
  }
  const groupSelection = query.groupBy.map((field) => field);

  const root =
    query.intent === 'select' ? query.source : `${query.source}Aggregate`;
  const head =
    declarations.length === 0 ? 'query' : `query (${declarations.join(', ')})`;
  const argText = args.length === 0 ? '' : `(${args.join(', ')})`;
  const body = [...groupSelection, ...selection]
    .map((line) => `    ${line}`)
    .join('\n');

  return {
    query: `${head} {\n  ${root}${argText} {\n${body}\n  }\n}`,
    variables,
    convention: 'field-suffix-filters',
  };
}

/*
 * The phrase the grammar uses for each comparison. `starts-with` is a key in
 * the parsed form and `starts with` is what the grammar reads, so a rendering
 * that reused the key would emit something this parser cannot parse -- which
 * `suggest-query` would then hand to a caller as an example.
 */
const GRAMMAR_COMPARISON: Readonly<Record<Comparison, string>> = Object.freeze({
  '=': '=',
  '!=': '!=',
  '>': '>',
  '>=': '>=',
  '<': '<',
  '<=': '<=',
  contains: 'contains',
  'starts-with': 'starts with',
  'ends-with': 'ends with',
  between: 'between',
});

/** Render a parsed query back into the grammar, which is what `suggest-query` emits. */
export function renderGrammar(query: ParsedQuery): string {
  const words: string[] = [];
  if (query.intent === 'select') {
    words.push('show');
    if (query.fields.length > 0) words.push(query.fields.join(' and '));
    words.push('from', query.source);
  } else if (query.intent === 'count') {
    words.push('how many', query.source);
  } else {
    words.push(query.intent, 'of', String(query.measure), 'from', query.source);
  }
  if (query.filters.length > 0) {
    words.push('where');
    words.push(
      query.filters
        .map((filter) =>
          filter.comparison === 'between'
            ? `${filter.field} between ${String(filter.value)} and ${String(filter.upper)}`
            : `${filter.field} ${GRAMMAR_COMPARISON[filter.comparison]} ${
                typeof filter.value === 'string'
                  ? `"${filter.value}"`
                  : String(filter.value)
              }`
        )
        .join(' and ')
    );
  }
  if (query.groupBy.length > 0) words.push('per', query.groupBy.join(' and '));
  if (query.ordering !== null)
    words.push(
      'sorted by',
      query.ordering.field,
      query.ordering.descending ? 'descending' : 'ascending'
    );
  if (query.limit !== null) words.push('limit', String(query.limit));
  return words.join(' ');
}
