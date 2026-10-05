/**
 * intelligent-assistant - the eight operations.
 *
 * Every test here pins a value derived from the INPUT. WHY THAT RULE: what this
 * file's subject replaced returned
 * `{ success: true, data: { result: "<operation> completed successfully" },
 *    metadata: { confidence: 0.85 } }`
 * for all eight operations, having read none of their arguments. A response of
 * that shape cannot be told apart from a correct one, so the only test that
 * proves work happened is one whose expected value could only come from the
 * arguments given.
 *
 * The scores below are the cosine defined in `knowledge-core.ts` and pinned
 * there against its algebra; the cases here pin WHICH documents and WHICH
 * sentences each operation selects, and what it says when it cannot answer.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { TokenCounter } from '../../../src/core/token-counter.js';
import { MetricsCollector } from '../../../src/core/metrics.js';
import {
  ConflictPolicy,
  ExclusionReason,
  INTELLIGENT_ASSISTANT_OPERATIONS,
  IntelligentAssistant,
  INTELLIGENTASSISTANTTOOL,
  UnansweredReason,
  type IntelligentAssistantOperation,
  type IntelligentAssistantOptions,
} from '../../../src/tools/intelligence/intelligent-assistant.js';
import type { KnowledgeDocument } from '../../../src/tools/intelligence/knowledge-core.js';
import { TOOL_DEFINITIONS } from '../../../src/server/tool-definitions.js';
import { toolSchemaMap } from '../../../src/validation/tool-schemas.js';

/** One corpus, so every expectation below can be read against it. */
const DOCUMENTS: readonly KnowledgeDocument[] = Object.freeze([
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

describe('intelligent-assistant', () => {
  let directory: string;
  let engine: CacheEngine;
  let tool: IntelligentAssistant;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'ia-test-'));
    engine = new CacheEngine(join(directory, 'c.db'));
    tool = new IntelligentAssistant(
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
    options: IntelligentAssistantOptions
  ): Promise<Record<string, unknown>> => {
    const result = await tool.run({ ...options, useCache: false });
    expect(result.success).toBe(true);
    return result.data;
  };

  describe('search-knowledge', () => {
    it('ranks the documents that share a term and counts the ones that do not', async () => {
      const data = await run({
        operation: 'search-knowledge',
        question: 'How is a content hash used?',
        documents: DOCUMENTS,
      });
      // `used` is a content term of the question that the corpus never uses.
      expect(data.terms).toEqual(['content', 'hash', 'used']);
      expect(data.considered).toBe(3);
      expect(data.matched).toBe(2);
      expect(data.matches).toEqual([
        {
          id: 'hash',
          title: 'Content hashing',
          score: 0.34571300526006055,
          matchedTerms: ['content', 'hash'],
        },
        {
          id: 'cache',
          title: 'Cache engine',
          score: 0.2664114367141022,
          matchedTerms: ['content', 'hash'],
        },
      ]);
      expect(data.absentTerms).toEqual(['used']);
    });

    it('names the terms the corpus has nothing on', async () => {
      const data = await run({
        operation: 'search-knowledge',
        question: 'kubernetes ingress for the cache',
        documents: DOCUMENTS,
      });
      /*
       * The decisive half: `cache` matches, so the result is a confident
       * two-document list, and nothing in that list says the question was
       * about something the corpus has never mentioned.
       */
      expect(data.absentTerms).toEqual(['ingress', 'kubernetes']);
      expect(data.matched).toBe(2);
    });

    it('applies the limit and the floor', async () => {
      const limited = await run({
        operation: 'search-knowledge',
        question: 'content hash',
        documents: DOCUMENTS,
        limit: 1,
      });
      expect((limited.matches as unknown[]).length).toBe(1);
      expect(limited.matched).toBe(2);

      const floored = await run({
        operation: 'search-knowledge',
        question: 'content hash',
        documents: DOCUMENTS,
        floor: 0.3,
      });
      expect(
        (floored.matches as Array<{ id: string }>).map((m) => m.id)
      ).toEqual(['hash']);
      expect(floored.floor).toBe(0.3);
    });
  });

  describe('ask', () => {
    it('quotes the sentences that answer, with the document each came from', async () => {
      const data = await run({
        operation: 'ask',
        question: 'How are blocks keyed?',
        documents: DOCUMENTS,
      });
      expect(data.answered).toBe(true);
      expect(data.grounded).toBe(true);
      expect(data.quotations).toEqual([
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
          terms: ['blocks', 'keyed'],
        },
      ]);
      expect(data.answeredFrom).toEqual(['cache']);
    });

    it('answers only with text from the corpus', async () => {
      const data = await run({
        operation: 'ask',
        question: 'How are blocks keyed?',
        documents: DOCUMENTS,
      });
      const corpus = DOCUMENTS.map((document) => document.text).join(' ');
      const quotations = data.quotations as Array<{ sentence: string }>;
      expect(quotations.length).toBeGreaterThan(0);
      for (const quotation of quotations) {
        expect(corpus).toContain(quotation.sentence);
      }
    });

    it('refuses to answer a question no document shares a term with', async () => {
      const data = await run({
        operation: 'ask',
        question: 'Which kubernetes ingress controller?',
        documents: DOCUMENTS,
      });
      expect(data.answered).toBe(false);
      expect(data.reason).toBe(UnansweredReason.NoSharedTerm);
      expect(data.quotations).toEqual([]);
      expect(data.absentTerms).toEqual(['controller', 'ingress', 'kubernetes']);
      expect(data.bestScore).toBe(0);
    });

    it('says the best score was below the floor rather than returning the best of a bad list', async () => {
      const data = await run({
        operation: 'ask',
        question: 'cache',
        documents: DOCUMENTS,
        floor: 0.9,
      });
      expect(data.answered).toBe(false);
      expect(data.reason).toBe(UnansweredReason.BelowFloor);
      // The figure a caller needs to choose a different floor.
      expect(data.bestScore).toBe(0.24445601036376938);
    });

    it('says so when the match was a title and no sentence could be quoted', async () => {
      const data = await run({
        operation: 'ask',
        question: 'hashing',
        documents: DOCUMENTS,
      });
      expect(data.answered).toBe(false);
      expect(data.reason).toBe(UnansweredReason.TitleOnly);
      expect(data.bestScore).toBeGreaterThan(0);
    });
  });

  describe('explain', () => {
    it('assembles one section per matching document, each keeping its own order', async () => {
      const data = await run({
        operation: 'explain',
        topic: 'content hash',
        documents: DOCUMENTS,
      });
      expect(data.sources).toEqual(['hash', 'cache']);
      expect(data.sections).toEqual([
        {
          documentId: 'hash',
          title: 'Content hashing',
          score: 0.34571300526006055,
          matchedTerms: ['content', 'hash'],
          sentences: [
            'A content hash makes the cache idempotent.',
            'The hash is computed over the uncompressed bytes.',
          ],
        },
        {
          documentId: 'cache',
          title: 'Cache engine',
          score: 0.2664114367141022,
          matchedTerms: ['content', 'hash'],
          sentences: ['Blocks are keyed by a content hash.'],
        },
      ]);
      expect(data.covered).toBe(2);
    });

    it('refuses a topic with no content terms', async () => {
      await expect(
        tool.run({
          operation: 'explain',
          topic: 'the and of',
          documents: DOCUMENTS,
          useCache: false,
        })
      ).rejects.toThrow(/has no content terms/);
    });
  });

  describe('suggest', () => {
    it('leaves out what the caller has seen and says why each document was left out', async () => {
      const data = await run({
        operation: 'suggest',
        topic: 'cache',
        documents: DOCUMENTS,
        seen: ['hash'],
      });
      expect(
        (data.suggestions as Array<{ id: string }>).map((s) => s.id)
      ).toEqual(['cache']);
      expect(data.excluded).toEqual([
        { id: 'hash', reason: ExclusionReason.AlreadySeen },
        { id: 'weather', reason: ExclusionReason.NoSharedTerm },
      ]);
    });

    it('reports the share of the corpus the topic reaches at all', async () => {
      const data = await run({
        operation: 'suggest',
        topic: 'cache',
        documents: DOCUMENTS,
      });
      // Two of three documents mention it; the third shares no term.
      expect(data.coverage).toBe(2 / 3);
      expect(data.considered).toBe(3);
    });

    it('names a seen id that is not in the corpus instead of ignoring it', async () => {
      const data = await run({
        operation: 'suggest',
        topic: 'cache',
        documents: DOCUMENTS,
        seen: ['hash', 'typo-id'],
      });
      expect(data.unknownSeen).toEqual(['typo-id']);
    });

    it('refuses a seen list that is not document ids', async () => {
      await expect(
        tool.run({
          operation: 'suggest',
          topic: 'cache',
          documents: DOCUMENTS,
          seen: [7] as unknown as string[],
          useCache: false,
        })
      ).rejects.toThrow('seen must be an array of document ids');
    });
  });

  describe('troubleshoot', () => {
    it('separates the sentences that describe the symptom from the ones that instruct', async () => {
      const data = await run({
        operation: 'troubleshoot',
        question: 'the cache directory changed',
        documents: DOCUMENTS,
      });
      const candidates = data.candidates as Array<{
        documentId: string;
        mentions: string[];
        remedies: string[];
      }>;
      const cache = candidates.find((c) => c.documentId === 'cache');
      expect(cache?.mentions).toEqual([
        'The cache engine stores compressed blocks on disk.',
        'Restart the daemon after changing the cache directory.',
      ]);
      expect(cache?.remedies).toEqual([
        'Restart the daemon after changing the cache directory.',
      ]);
      expect(data.remediesFound).toBe(true);
    });

    it('names the rule it used to call a sentence a remedy', async () => {
      const data = await run({
        operation: 'troubleshoot',
        question: 'cache directory',
        documents: DOCUMENTS,
      });
      expect(data.rule).toBe('remedy-sentence-verb');
    });

    it('reports a corpus that describes the symptom and says nothing about fixing it', async () => {
      const data = await run({
        operation: 'troubleshoot',
        question: 'the weather',
        documents: DOCUMENTS,
      });
      expect(
        (data.candidates as Array<{ documentId: string }>).map(
          (c) => c.documentId
        )
      ).toEqual(['weather']);
      /*
       * A match with no instruction in it is an answer -- "nothing here tells
       * you what to do" -- and conflating it with "no match" would hide which
       * of the two happened.
       */
      expect(data.remediesFound).toBe(false);
    });
  });

  describe('learn', () => {
    it('stores documents and makes later operations read them', async () => {
      const stored = await run({
        operation: 'learn',
        topic: 'infra',
        documents: [DOCUMENTS[0]],
      });
      expect(stored).toMatchObject({
        topic: 'infra',
        stored: 1,
        added: ['cache'],
        duplicate: [],
        replaced: [],
        conflicting: [],
        durability: 'cache',
        evictable: true,
      });

      const answered = await run({
        operation: 'ask',
        question: 'How are blocks keyed?',
        topic: 'infra',
      });
      expect(answered.answered).toBe(true);
      expect(answered.answeredFrom).toEqual(['cache']);
      expect(answered.corpus).toEqual({
        documents: 1,
        fromCall: 0,
        fromStore: 1,
        topic: 'infra',
        durability: 'cache',
        evictable: true,
      });
    });

    it('calls an identical document a duplicate rather than an addition', async () => {
      await run({
        operation: 'learn',
        topic: 'infra',
        documents: [DOCUMENTS[0]],
      });
      const again = await run({
        operation: 'learn',
        topic: 'infra',
        documents: [DOCUMENTS[0], DOCUMENTS[1]],
      });
      expect(again).toMatchObject({
        stored: 2,
        added: ['hash'],
        duplicate: ['cache'],
        replaced: [],
        conflicting: [],
      });
    });

    it('keeps the stored text and reports the disagreement by default', async () => {
      await run({
        operation: 'learn',
        topic: 'infra',
        documents: [DOCUMENTS[0]],
      });
      const conflicted = await run({
        operation: 'learn',
        topic: 'infra',
        documents: [{ id: 'cache', text: 'Something else entirely.' }],
      });
      expect(conflicted).toMatchObject({
        stored: 1,
        added: [],
        duplicate: [],
        replaced: [],
        onConflict: ConflictPolicy.KeepStored,
        conflicting: [
          {
            id: 'cache',
            storedLength: DOCUMENTS[0].text.length,
            incomingLength: 'Something else entirely.'.length,
            kept: 'stored',
          },
        ],
      });

      // And the stored text is still the one a later read answers from.
      const read = await run({
        operation: 'search-knowledge',
        question: 'blocks keyed',
        topic: 'infra',
      });
      expect(read.matched).toBe(1);
    });

    it('replaces the stored text when the caller says to', async () => {
      await run({
        operation: 'learn',
        topic: 'infra',
        documents: [DOCUMENTS[0]],
      });
      const replaced = await run({
        operation: 'learn',
        topic: 'infra',
        documents: [
          { id: 'cache', text: 'Blocks are now keyed by their offset.' },
        ],
        onConflict: ConflictPolicy.Replace,
      });
      expect(replaced).toMatchObject({
        stored: 1,
        replaced: ['cache'],
        conflicting: [],
        onConflict: ConflictPolicy.Replace,
      });

      const data = await run({
        operation: 'ask',
        question: 'How are blocks keyed?',
        topic: 'infra',
      });
      expect(data.quotations).toEqual([
        {
          documentId: 'cache',
          sentenceIndex: 0,
          sentence: 'Blocks are now keyed by their offset.',
          terms: ['blocks', 'keyed'],
        },
      ]);
    });

    it('keeps one store per topic', async () => {
      await run({
        operation: 'learn',
        topic: 'infra',
        documents: [DOCUMENTS[0]],
      });
      await run({
        operation: 'learn',
        topic: 'notes',
        documents: [DOCUMENTS[2]],
      });
      const data = await run({
        operation: 'search-knowledge',
        question: 'blocks keyed',
        topic: 'notes',
      });
      expect(data.matched).toBe(0);
      expect(data.considered).toBe(1);
    });

    it('prefers a document passed in over a stored one with the same id', async () => {
      await run({
        operation: 'learn',
        topic: 'infra',
        documents: [DOCUMENTS[0]],
      });
      const data = await run({
        operation: 'ask',
        question: 'How are blocks keyed?',
        topic: 'infra',
        documents: [{ id: 'cache', text: 'Blocks are keyed by their offset.' }],
      });
      expect(data.corpus).toEqual({
        documents: 1,
        fromCall: 1,
        fromStore: 0,
        topic: 'infra',
        durability: 'call',
        evictable: false,
      });
      expect((data.quotations as Array<{ sentence: string }>)[0].sentence).toBe(
        'Blocks are keyed by their offset.'
      );
    });

    it('refuses a read against a topic nothing was stored under, and says an eviction looks the same', async () => {
      await expect(
        tool.run({
          operation: 'ask',
          question: 'How are blocks keyed?',
          topic: 'never-written',
          useCache: false,
        })
      ).rejects.toThrow(
        /the store for topic "never-written" is empty, which is also what an evicted store looks like/
      );
    });
  });

  describe('get-context', () => {
    it('fills the budget with whole documents in score order', async () => {
      const data = await run({
        operation: 'get-context',
        question: 'content hash',
        documents: DOCUMENTS,
        budget: 100,
      });
      expect(data.included).toEqual([
        { id: 'hash', score: 0.34571300526006055, tokens: 19 },
        { id: 'cache', score: 0.2664114367141022, tokens: 26 },
      ]);
      expect(data.tokens).toBe(45);
      expect(data.remaining).toBe(55);
      expect(data.truncated).toBe(false);
      expect(data.text).toBe(`${DOCUMENTS[1].text}\n\n${DOCUMENTS[0].text}`);
    });

    it('skips a document whole and keeps going, rather than cutting one in half', async () => {
      const data = await run({
        operation: 'get-context',
        question: 'content hash',
        documents: DOCUMENTS,
        budget: 20,
      });
      // The 19-token document fits; the 26-token one is skipped entirely.
      expect(data.included).toEqual([
        { id: 'hash', score: 0.34571300526006055, tokens: 19 },
      ]);
      expect(data.excluded).toEqual([
        { id: 'cache', reason: ExclusionReason.OverBudget, tokens: 26 },
        { id: 'weather', reason: ExclusionReason.NoSharedTerm, tokens: 8 },
      ]);
      expect(data.text).toBe(DOCUMENTS[1].text);
    });

    it('includes a later document that still fits after a larger one did not', async () => {
      const data = await run({
        operation: 'get-context',
        question: 'cache weather',
        documents: DOCUMENTS,
        budget: 30,
      });
      /*
       * The two cache documents outrank the weather note and do not both fit;
       * a loop that stopped at the first over-budget document would leave the
       * 8-token one out and under-fill the budget by a quarter.
       */
      expect((data.included as Array<{ id: string }>).map((e) => e.id)).toEqual(
        ['weather', 'hash']
      );
      expect(data.tokens).toBe(27);
      expect(data.excluded).toEqual([
        { id: 'cache', reason: ExclusionReason.OverBudget, tokens: 26 },
      ]);
    });

    it('refuses a budget that is not a positive whole number of tokens', async () => {
      await expect(
        tool.run({
          operation: 'get-context',
          question: 'cache',
          documents: DOCUMENTS,
          budget: 0,
          useCache: false,
        })
      ).rejects.toThrow(
        'budget must be an integer of at least 1 token; received 0'
      );
      await expect(
        tool.run({
          operation: 'get-context',
          question: 'cache',
          documents: DOCUMENTS,
          useCache: false,
        })
      ).rejects.toThrow('get-context requires a budget in tokens');
    });
  });

  describe('generate-example', () => {
    it('builds a value and checks it against the schema it came from', async () => {
      const data = await run({
        operation: 'generate-example',
        schema: {
          type: 'object',
          properties: {
            operation: { type: 'string', enum: ['ask', 'learn'] },
            limit: { type: 'integer', minimum: 2 },
          },
          required: ['operation', 'limit'],
        },
      });
      expect(data.example).toEqual({ operation: 'ask', limit: 2 });
      expect(data.validated).toBe(true);
      expect(data.violations).toEqual([]);
      expect(data.validatedWith).toBe('schema-from-definition');
    });

    it('refuses rather than returning a value the schema would reject', async () => {
      await expect(
        tool.run({
          operation: 'generate-example',
          schema: {
            type: 'object',
            properties: { ref: { type: 'string', pattern: '^v\\d+$' } },
            required: ['ref'],
          },
          useCache: false,
        })
      ).rejects.toThrow(/cannot be constructed/);
    });

    it('builds an accepted example for every tool that publishes a buildable schema', async () => {
      /*
       * The whole published surface, driven through the builder: for each of
       * the advertised tools the example either validates against that tool's
       * own derived schema, or the builder refuses with a reason naming the
       * property it could not construct. A silent third outcome -- a value
       * that the server would reject -- is what this case exists to catch.
       */
      let built = 0;
      const refused: Array<{ name: string; message: string }> = [];
      for (const definition of TOOL_DEFINITIONS) {
        const schema = toolSchemaMap[definition.name];
        expect(schema).toBeDefined();
        let example: unknown;
        try {
          const data = await run({
            operation: 'generate-example',
            schema: definition.inputSchema as Record<string, unknown>,
          });
          expect(data.validated).toBe(true);
          expect(data.violations).toEqual([]);
          example = data.example;
          built += 1;
        } catch (error) {
          refused.push({
            name: definition.name,
            message: (error as Error).message,
          });
          continue;
        }
        expect(schema.safeParse(example).success).toBe(true);
      }
      /*
       * Every published tool, with none refused. A refusal here is not a bug
       * in this test: it means a tool requires something whose definition the
       * schema does not carry, or constrains it with a pattern nothing can be
       * built from -- a requirement no client could satisfy from the published
       * schema alone. Eight tools refused while the branch merge below was
       * wrong, so the count is pinned rather than tolerated.
       */
      expect(refused).toEqual([]);
      expect(built).toBe(TOOL_DEFINITIONS.length);
    });
  });

  describe('the published surface', () => {
    it('advertises exactly the operations it dispatches', () => {
      const published =
        INTELLIGENTASSISTANTTOOL.inputSchema.properties.operation.enum;
      expect([...published]).toEqual([...INTELLIGENT_ASSISTANT_OPERATIONS]);
    });

    it('refuses a value that is not a published operation', async () => {
      await expect(
        tool.run({
          operation: 'summarise' as IntelligentAssistantOperation,
          question: 'anything',
          documents: DOCUMENTS,
          useCache: false,
        })
      ).rejects.toThrow('unknown operation "summarise"');
    });

    it('returns no confidence, because there is no computation behind one', async () => {
      const result = await tool.run({
        operation: 'search-knowledge',
        question: 'content hash',
        documents: DOCUMENTS,
        useCache: false,
      });
      expect(Object.keys(result.metadata).sort()).toEqual([
        'cacheHit',
        'processingTime',
        'tokensSaved',
        'tokensUsed',
      ]);
    });

    it('enforces the conditional requirements it publishes', () => {
      const schema = toolSchemaMap['intelligent-assistant'];
      expect(
        schema.safeParse({
          operation: 'ask',
          documents: [{ id: 'a', text: 'b' }],
        }).success
      ).toBe(false);
      expect(
        schema.safeParse({
          operation: 'ask',
          question: 'why',
          documents: [{ id: 'a', text: 'b' }],
        }).success
      ).toBe(true);
      // A topic satisfies it too, because learn may have stored the corpus.
      expect(
        schema.safeParse({ operation: 'ask', question: 'why', topic: 't' })
          .success
      ).toBe(true);
      expect(schema.safeParse({ operation: 'learn', topic: 't' }).success).toBe(
        false
      );
      expect(
        schema.safeParse({
          operation: 'get-context',
          question: 'why',
          topic: 't',
        }).success
      ).toBe(false);
      expect(
        schema.safeParse({
          operation: 'get-context',
          question: 'why',
          topic: 't',
          budget: 10,
        }).success
      ).toBe(true);
    });

    it('refuses an unknown key and an out-of-range floor through the derived schema', () => {
      const schema = toolSchemaMap['intelligent-assistant'];
      expect(
        schema.safeParse({
          operation: 'ask',
          question: 'why',
          topic: 't',
          confidence: 0.85,
        }).success
      ).toBe(false);
      expect(
        schema.safeParse({
          operation: 'ask',
          question: 'why',
          topic: 't',
          floor: 1.5,
        }).success
      ).toBe(false);
      expect(
        schema.safeParse({
          operation: 'learn',
          topic: 't',
          documents: [{ id: 'a', text: 'b', note: 'c' }],
        }).success
      ).toBe(false);
    });
  });

  describe('the cache', () => {
    it('serves a repeated question from the cache', async () => {
      const options: IntelligentAssistantOptions = {
        operation: 'search-knowledge',
        question: 'content hash',
        documents: DOCUMENTS,
      };
      const first = await tool.run(options);
      expect(first.metadata.cacheHit).toBe(false);
      const second = await tool.run(options);
      expect(second.metadata.cacheHit).toBe(true);
      expect(second.data).toEqual(first.data);
      expect(second.metadata.tokensSaved).toBeGreaterThan(0);
    });

    it('does not serve an answer computed before a learn changed the corpus', async () => {
      const options: IntelligentAssistantOptions = {
        operation: 'search-knowledge',
        question: 'content hash',
        topic: 'infra',
        documents: [DOCUMENTS[2]],
      };
      const before = await tool.run(options);
      expect(before.data.matched).toBe(0);

      await tool.run({
        operation: 'learn',
        topic: 'infra',
        documents: [DOCUMENTS[1]],
      });

      const after = await tool.run(options);
      /*
       * The decisive assertion: the arguments are identical, so a key that did
       * not include the store would hand back the stale `matched: 0` and the
       * learn would have changed nothing a caller could see.
       */
      expect(after.metadata.cacheHit).toBe(false);
      expect(after.data.matched).toBe(1);
    });

    it('keeps the operations apart in the cache', async () => {
      await tool.run({
        operation: 'search-knowledge',
        question: 'content hash',
        documents: DOCUMENTS,
      });
      const asked = await tool.run({
        operation: 'ask',
        question: 'content hash',
        documents: DOCUMENTS,
      });
      expect(asked.metadata.cacheHit).toBe(false);
      expect(asked.operation).toBe('ask');
      expect(asked.data.answered).toBe(true);
    });
  });
});
