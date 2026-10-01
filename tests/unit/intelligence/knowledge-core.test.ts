/**
 * The retrieval core and the example builder.
 *
 * WHY THE SCORES ARE PINNED TO EXACT FLOATS: a ranking function that weights
 * the wrong thing still returns a ranked list, and a list is what the caller
 * sees. The only way to show that a score is the published cosine rather than
 * something that merely sorts plausibly is to assert the number -- so each
 * case below carries the literal the implementation produces AND, separately,
 * the algebra derived from the published formula, so the two have to agree.
 */

import {
  absentTerms,
  buildIndex,
  exampleFromSchema,
  EXAMPLE_STRING,
  REMEDY_RULE,
  REMEDY_VERBS,
  remedySentences,
  scoreQuery,
  sentencesMentioning,
  validateDocuments,
  type KnowledgeDocument,
} from '../../../src/tools/intelligence/knowledge-core.js';
import { schemaFromDefinition } from '../../../src/validation/schema-from-definition.js';

/**
 * Three documents: two about the same subject and one about nothing related.
 * The third exists so that a term's document frequency can be 1 of 3 rather
 * than 1 of 2, which is what makes the idf weights distinguishable.
 */
const DOCS: readonly KnowledgeDocument[] = Object.freeze([
  Object.freeze({
    id: 'cache',
    title: 'Cache engine',
    text:
      'The cache engine stores compressed blocks on disk. ' +
      'Blocks are keyed by a content hash. ' +
      'Restart the daemon after changing the cache directory.',
  }),
  Object.freeze({
    id: 'hash',
    title: 'Content hashing',
    text:
      'A content hash makes the cache idempotent. ' +
      'The hash is computed over the uncompressed bytes.',
  }),
  Object.freeze({
    id: 'weather',
    title: 'Unrelated notes',
    text: 'The weather today is cold and bright.',
  }),
]);

/** ln(1 + N/df) for a term in one document of three. */
const IDF_RARE = Math.log(4);
/** ln(1 + N/df) for a term in two documents of three. */
const IDF_SHARED = Math.log(2.5);

describe('validateDocuments', () => {
  it('returns the documents it was given, keeping optional fields', () => {
    const validated = validateDocuments(
      [
        { id: 'a', text: 'one', title: 'A', tags: ['x'] },
        { id: 'b', text: 'two' },
      ],
      'documents'
    );
    expect(validated).toEqual([
      { id: 'a', title: 'A', text: 'one', tags: ['x'] },
      { id: 'b', text: 'two' },
    ]);
  });

  it('refuses two documents under one id, because a quote could not be attributed', () => {
    expect(() =>
      validateDocuments(
        [
          { id: 'a', text: 'one' },
          { id: 'a', text: 'two' },
        ],
        'documents'
      )
    ).toThrow(/two documents with id "a"/);
  });

  it('names the position and the id of an empty document', () => {
    expect(() =>
      validateDocuments(
        [
          { id: 'a', text: 'one' },
          { id: 'b', text: '   ' },
        ],
        'documents'
      )
    ).toThrow('documents[1].text must be a non-empty string (id "b")');
  });

  it('refuses a missing id, a non-object entry, an empty corpus and a non-array', () => {
    expect(() => validateDocuments([{ text: 'one' }], 'documents')).toThrow(
      'documents[0].id must be a non-empty string'
    );
    expect(() => validateDocuments(['one'], 'documents')).toThrow(
      'documents[0] must be an object'
    );
    expect(() => validateDocuments([], 'documents')).toThrow(
      'documents must contain at least one document'
    );
    expect(() => validateDocuments('one', 'documents')).toThrow(
      'documents must be an array of documents'
    );
  });

  it('refuses a non-string title and a non-string tag', () => {
    expect(() =>
      validateDocuments([{ id: 'a', text: 'one', title: 7 }], 'documents')
    ).toThrow('documents[0].title must be a string when present');
    expect(() =>
      validateDocuments([{ id: 'a', text: 'one', tags: ['x', 7] }], 'documents')
    ).toThrow('documents[0].tags must be an array of strings when present');
  });
});

describe('buildIndex', () => {
  const index = buildIndex(DOCS);

  it('weights a term by how many documents contain it', () => {
    expect(index.idf.get('keyed')).toBe(IDF_RARE);
    expect(index.idf.get('weather')).toBe(IDF_RARE);
    // `cache`, `content` and `hash` each appear in two of the three.
    expect(index.idf.get('cache')).toBe(IDF_SHARED);
    expect(index.idf.get('content')).toBe(IDF_SHARED);
    expect(index.idf.get('hash')).toBe(IDF_SHARED);
  });

  it('indexes the title as well as the text', () => {
    // `hashing` occurs only in the second document's title.
    expect(index.idf.get('hashing')).toBe(IDF_RARE);
    expect(index.termSets[1].has('hashing')).toBe(true);
  });

  it('drops stop words and single characters, so they can never match', () => {
    expect(index.idf.has('the')).toBe(false);
    expect(index.idf.has('a')).toBe(false);
    expect(index.idf.has('are')).toBe(false);
  });
});

describe('scoreQuery', () => {
  const index = buildIndex(DOCS);

  it('scores a two-term question as the published cosine', () => {
    const scored = scoreQuery(index, ['blocks', 'keyed']);
    expect(scored).toEqual([
      {
        id: 'cache',
        title: 'Cache engine',
        score: 0.4030649439170931,
        matchedTerms: ['blocks', 'keyed'],
      },
    ]);
    /*
     * Derived independently from the formula: both question terms are rare, and
     * the first document holds 14 distinct terms -- 3 of them shared with
     * another document, 11 of them rare.
     *   2*idf_rare^2 / ( sqrt(2)*idf_rare * sqrt(3*idf_shared^2 + 11*idf_rare^2) )
     */
    const expected =
      (2 * IDF_RARE ** 2) /
      (Math.SQRT2 *
        IDF_RARE *
        Math.sqrt(3 * IDF_SHARED ** 2 + 11 * IDF_RARE ** 2));
    expect(scored[0].score).toBeCloseTo(expected, 12);
  });

  it('scores a single-term question as one over the root of the document size', () => {
    const scored = scoreQuery(index, ['weather']);
    /*
     * Every term of the third document is rare, so the idf cancels and the
     * score collapses to 1/sqrt(6) for its six distinct terms: unrelated,
     * notes, weather, today, cold, bright.
     */
    expect(scored).toEqual([
      {
        id: 'weather',
        title: 'Unrelated notes',
        score: 0.4082482904638631,
        matchedTerms: ['weather'],
      },
    ]);
    expect(scored[0].score).toBe(1 / Math.sqrt(6));
  });

  it('ranks the shorter document first for a term both contain', () => {
    /*
     * Deliberately pinned: the cosine is length-normalised, so the document
     * whose other content is mostly about something else scores lower on a
     * term it mentions twice. A caller comparing two scores is comparing
     * concentration, not count, and that is the behaviour to notice if it ever
     * changes.
     */
    expect(scoreQuery(index, ['cache'])).toEqual([
      {
        id: 'hash',
        title: 'Content hashing',
        score: 0.24445601036376938,
        matchedTerms: ['cache'],
      },
      {
        id: 'cache',
        title: 'Cache engine',
        score: 0.18838133348619246,
        matchedTerms: ['cache'],
      },
    ]);
  });

  it('leaves out a document that shares no term rather than scoring it zero', () => {
    const scored = scoreQuery(index, ['content', 'hash']);
    expect(scored.map((match) => match.id)).toEqual(['hash', 'cache']);
    expect(scored.every((match) => match.score > 0)).toBe(true);
  });

  it('returns nothing for a question the corpus has no term of', () => {
    expect(scoreQuery(index, ['kubernetes', 'ingress'])).toEqual([]);
  });
});

describe('absentTerms', () => {
  const index = buildIndex(DOCS);

  it('names the question terms no document contains', () => {
    expect(absentTerms(index, ['cache', 'kubernetes', 'ingress'])).toEqual([
      'ingress',
      'kubernetes',
    ]);
  });

  it('is empty when every term occurs somewhere', () => {
    expect(absentTerms(index, ['cache', 'weather'])).toEqual([]);
  });
});

describe('sentencesMentioning', () => {
  it('quotes whole sentences in the document order, with where they came from', () => {
    expect(sentencesMentioning(DOCS[0], ['blocks'])).toEqual([
      {
        documentId: 'cache',
        sentenceIndex: 0,
        sentence: 'The cache engine stores compressed blocks on disk.',
        terms: ['blocks'],
      },
      {
        documentId: 'cache',
        sentenceIndex: 1,
        sentence: 'Blocks are keyed by a content hash.',
        terms: ['blocks'],
      },
    ]);
  });

  it('reports which of the terms each sentence carried', () => {
    expect(sentencesMentioning(DOCS[0], ['keyed', 'daemon'])).toEqual([
      {
        documentId: 'cache',
        sentenceIndex: 1,
        sentence: 'Blocks are keyed by a content hash.',
        terms: ['keyed'],
      },
      {
        documentId: 'cache',
        sentenceIndex: 2,
        sentence: 'Restart the daemon after changing the cache directory.',
        terms: ['daemon'],
      },
    ]);
  });

  it('quotes nothing when the term is only in the title', () => {
    expect(sentencesMentioning(DOCS[1], ['hashing'])).toEqual([]);
  });
});

describe('remedySentences', () => {
  it('selects the sentence that instructs, not the ones that describe', () => {
    expect(remedySentences(DOCS[0])).toEqual([
      {
        documentId: 'cache',
        sentenceIndex: 2,
        sentence: 'Restart the daemon after changing the cache directory.',
        terms: ['restart'],
      },
    ]);
  });

  it('uses the leading word as written, so a verb mid-sentence is not an instruction', () => {
    const document: KnowledgeDocument = {
      id: 'd',
      text: 'The daemon should restart itself. Restart it by hand instead.',
    };
    expect(remedySentences(document).map((q) => q.sentence)).toEqual([
      'Restart it by hand instead.',
    ]);
  });

  it('publishes the verb list and the name of the rule it is', () => {
    expect(REMEDY_VERBS).toContain('restart');
    expect(REMEDY_RULE).toBe('remedy-sentence-verb');
    expect(new Set(REMEDY_VERBS).size).toBe(REMEDY_VERBS.length);
  });
});

describe('exampleFromSchema', () => {
  /** Every example returned here is checked against the schema it came from. */
  const accepted = (node: Parameters<typeof exampleFromSchema>[0]): unknown => {
    const value = exampleFromSchema(node);
    const parsed = schemaFromDefinition(node).safeParse(value);
    expect(parsed.success).toBe(true);
    return value;
  };

  it('returns a const and the first value of an enum', () => {
    expect(exampleFromSchema({ const: 'fixed' })).toBe('fixed');
    expect(exampleFromSchema({ type: 'string', enum: ['one', 'two'] })).toBe(
      'one'
    );
  });

  it('builds only the required properties of an object', () => {
    expect(
      accepted({
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['ask'] },
          limit: { type: 'integer', minimum: 1 },
        },
        required: ['operation'],
      })
    ).toEqual({ operation: 'ask' });
  });

  it('recurses into a required nested object', () => {
    expect(
      accepted({
        type: 'object',
        properties: {
          window: {
            type: 'object',
            properties: { size: { type: 'integer', minimum: 3 } },
            required: ['size'],
          },
        },
        required: ['window'],
      })
    ).toEqual({ window: { size: 3 } });
  });

  it('builds minItems items, each its own value', () => {
    const value = exampleFromSchema({
      type: 'array',
      minItems: 2,
      items: {
        type: 'object',
        properties: { a: { type: 'string' } },
        required: ['a'],
      },
    }) as Array<Record<string, unknown>>;
    expect(value).toEqual([{ a: EXAMPLE_STRING }, { a: EXAMPLE_STRING }]);
    value[0].a = 'changed';
    expect(value[1].a).toBe(EXAMPLE_STRING);
  });

  it('builds one item for an array with no minimum, and none without an item schema', () => {
    expect(
      exampleFromSchema({ type: 'array', items: { type: 'string' } })
    ).toEqual([EXAMPLE_STRING]);
    expect(exampleFromSchema({ type: 'array' })).toEqual([]);
  });

  it('satisfies string bounds and the two published formats', () => {
    expect(exampleFromSchema({ type: 'string', minLength: 10 })).toBe(
      'examplexxx'
    );
    expect(exampleFromSchema({ type: 'string', maxLength: 3 })).toBe('exa');
    expect(exampleFromSchema({ type: 'string', default: 'ansi' })).toBe('ansi');
    expect(exampleFromSchema({ type: 'string', format: 'date' })).toBe(
      '2026-01-01'
    );
    expect(exampleFromSchema({ type: 'string', format: 'date-time' })).toBe(
      '2026-01-01T00:00:00Z'
    );
  });

  it('satisfies numeric bounds, inclusive and exclusive', () => {
    expect(exampleFromSchema({ type: 'integer', minimum: 5 })).toBe(5);
    expect(exampleFromSchema({ type: 'integer', exclusiveMinimum: 4 })).toBe(5);
    expect(exampleFromSchema({ type: 'integer', maximum: -3 })).toBe(-3);
    expect(exampleFromSchema({ type: 'number' })).toBe(0);
    expect(exampleFromSchema({ type: 'number', default: 0.5 })).toBe(0.5);
    expect(exampleFromSchema({ type: 'integer', minimum: 1.5 })).toBe(2);
  });

  it('returns the published default of a boolean, and true otherwise', () => {
    expect(exampleFromSchema({ type: 'boolean', default: false })).toBe(false);
    expect(exampleFromSchema({ type: 'boolean' })).toBe(true);
    expect(exampleFromSchema({ type: 'null' })).toBeNull();
  });

  it('merges a branch with the properties beside it', () => {
    expect(
      accepted({
        type: 'object',
        properties: {
          operation: { const: 'learn' },
          topic: { type: 'string' },
        },
        anyOf: [{ required: ['operation', 'topic'] }],
      })
    ).toEqual({ operation: 'learn', topic: EXAMPLE_STRING });
  });

  it('keeps the parent definitions when a branch pins the discriminator', () => {
    /*
     * Regression: the branch was merged over the parent wholesale, so its
     * one-property map replaced the parent's and every property the branch
     * required was suddenly undefined. Eight of this package's own tools
     * refused with "requires X but publishes no definition for it" while that
     * was true, each naming a property the schema does define.
     */
    expect(
      accepted({
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['ask', 'learn'] },
          question: { type: 'string' },
        },
        required: ['operation'],
        anyOf: [
          {
            properties: { operation: { const: 'ask' } },
            required: ['operation', 'question'],
          },
        ],
      })
    ).toEqual({ operation: 'ask', question: EXAMPLE_STRING });
  });

  it('refuses a pattern rather than returning a string the schema rejects', () => {
    expect(() =>
      exampleFromSchema({
        type: 'object',
        properties: { ref: { type: 'string', pattern: '^v\\d+$' } },
        required: ['ref'],
      })
    ).toThrow(/\$\.ref publishes pattern "\^v\\\\d\+\$"/);
  });

  it('names the property when there is nothing to build from', () => {
    expect(() =>
      exampleFromSchema({
        type: 'object',
        properties: { free: {} },
        required: ['free'],
      })
    ).toThrow('$.free declares no type, enum, const or branch');
  });

  it('names a required property that has no definition', () => {
    expect(() =>
      exampleFromSchema({
        type: 'object',
        properties: {},
        required: ['missing'],
      })
    ).toThrow(/requires "missing" but publishes no definition/);
  });

  it('refuses bounds that accept no value at all', () => {
    expect(() => exampleFromSchema({ type: 'array', minItems: 2 })).toThrow(
      '$ requires 2 item(s) but publishes no item schema'
    );
    expect(() =>
      exampleFromSchema({ type: 'string', minLength: 5, maxLength: 2 })
    ).toThrow('$ publishes maxLength 2 below minLength 5');
    expect(() =>
      exampleFromSchema({ type: 'integer', minimum: 10, maximum: 5 })
    ).toThrow('$ publishes bounds that accept no integer');
    expect(() =>
      exampleFromSchema({
        type: 'array',
        items: { type: 'string' },
        minItems: 3,
        maxItems: 1,
      })
    ).toThrow('$ publishes maxItems 1 below minItems 3');
    expect(() => exampleFromSchema({ enum: [] })).toThrow(
      '$ publishes an empty enum, which accepts nothing'
    );
  });
});
