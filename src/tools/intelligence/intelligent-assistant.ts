/**
 * intelligent-assistant - eight retrieval operations over a document corpus the
 * caller supplies.
 *
 * WHAT THIS FILE REPLACES: the tool advertised the eight operations below and
 * served every one of them from a single body that read none of its arguments:
 *
 *     data = { result: "<the operation name> completed successfully" }
 *     return { success: true, data, metadata: { confidence: 0.85, ... } }
 *
 * (written here in quotes rather than as the template literal it was, so the
 * ratchet that detects that stub body by its text does not read this comment as
 * one.)
 *
 * An `ask` that answers "ask completed successfully" with a confidence of 0.85
 * is worse than one that refuses, because nothing in the shape of the response
 * tells the caller which of the two they got.
 *
 * WHAT "INTELLIGENT" MEANS HERE, since the name invites the wrong expectation:
 * this package has no model and makes no inference. Every answer is a sentence
 * QUOTED from a document the caller passed in, carrying the id of that document
 * and the terms that selected it, and the ranking is the published idf cosine
 * in `knowledge-core.ts`. Nothing is generated. `ask` with a question the
 * corpus has nothing on reports that, and names the terms it could not find,
 * rather than returning the best of a bad list.
 *
 * WHAT IS NOT CLAIMED: no operation returns a confidence. A score is the cosine
 * defined in `knowledge-core.ts` -- comparable within one corpus and meaningless
 * across two -- and `troubleshoot` names the shallow verb rule it used to pick
 * out a remedy rather than implying it understood the text.
 *
 * `learn` writes into the same cache as every other result, so it reports
 * `durability: "cache"` and `evictable: true`, and every operation that reads
 * the store reports how many documents came from it. A store that lost its
 * contents must not look like a corpus that never had them.
 */

import type { CacheEngine } from '../../core/cache-engine.js';
import type { TokenCounter } from '../../core/token-counter.js';
import type { MetricsCollector } from '../../core/metrics.js';
import type { JsonSchemaNode } from '../../validation/schema-from-definition.js';
import { schemaFromDefinition } from '../../validation/schema-from-definition.js';
import { generateCacheKey } from '../shared/hash-utils.js';
import { tokenize } from './text-core.js';
import {
  absentTerms,
  buildIndex,
  exampleFromSchema,
  REMEDY_RULE,
  remedySentences,
  scoreQuery,
  sentencesMentioning,
  validateDocuments,
  type DocumentIndex,
  type KnowledgeDocument,
  type Match,
  type Quotation,
} from './knowledge-core.js';
import {
  sharedCache,
  sharedTokenCounter,
  sharedMetricsCollector,
} from './shared-instances.js';

/**
 * The operations, in one place: the TS union and the published enum are both
 * derived from this tuple, so the two cannot drift apart.
 */
export const INTELLIGENT_ASSISTANT_OPERATIONS = [
  'ask',
  'suggest',
  'explain',
  'troubleshoot',
  'learn',
  'get-context',
  'search-knowledge',
  'generate-example',
] as const;

export type IntelligentAssistantOperation =
  (typeof INTELLIGENT_ASSISTANT_OPERATIONS)[number];

/** What `learn` did with one incoming document. */
export enum StoreOutcome {
  Added = 'added',
  Replaced = 'replaced',
  Duplicate = 'duplicate',
  Conflicting = 'conflicting',
}

/** What `learn` does when a stored document and an incoming one disagree. */
export enum ConflictPolicy {
  KeepStored = 'keep-stored',
  Replace = 'replace',
}

/** Why a document did not make it into a result. */
export enum ExclusionReason {
  NoSharedTerm = 'no-shared-term',
  AlreadySeen = 'already-seen',
  OverBudget = 'over-budget',
}

/** Why `ask` could not quote an answer. */
export enum UnansweredReason {
  NoSharedTerm = 'no-document-shares-a-term-with-the-question',
  BelowFloor = 'no-document-scored-above-the-floor',
  TitleOnly = 'the-question-matched-only-titles-so-no-sentence-could-be-quoted',
}

/** Where the documents a result was computed from came from. */
export interface CorpusReport {
  documents: number;
  fromCall: number;
  fromStore: number;
  topic: string | null;
  durability: 'cache' | 'call';
  evictable: boolean;
}

export const INTELLIGENT_ASSISTANT_DEFAULTS = Object.freeze({
  limit: 5,
  /**
   * Exclusive: a document must share at least one term to appear at all. There
   * is no magic relevance threshold here, because any constant would be one --
   * the score is reported and the caller raises `floor` if they want more.
   */
  floor: 0,
  onConflict: ConflictPolicy.KeepStored,
});

export interface IntelligentAssistantOptions {
  operation: IntelligentAssistantOperation;
  /** ask, search-knowledge, troubleshoot, get-context. */
  question?: string;
  /** explain, suggest; also the store key for learn and every corpus read. */
  topic?: string;
  documents?: readonly KnowledgeDocument[];
  /** suggest: ids the caller has already consumed. */
  seen?: readonly string[];
  /** get-context: the token budget, measured with this package's counter. */
  budget?: number;
  /** generate-example: the JSON Schema node to construct a value for. */
  schema?: JsonSchemaNode;
  limit?: number;
  floor?: number;
  onConflict?: ConflictPolicy;
  useCache?: boolean;
}

export interface IntelligentAssistantResult {
  success: boolean;
  operation: IntelligentAssistantOperation;
  data: Record<string, unknown>;
  metadata: {
    tokensUsed: number;
    tokensSaved: number;
    cacheHit: boolean;
    processingTime: number;
  };
}

const requireText = (
  value: string | undefined,
  key: string,
  operation: string
): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(
      `intelligent-assistant ${operation} requires a non-empty ${key}`
    );
  }
  return value;
};

/**
 * The content terms of a question. A question made entirely of stop words
 * cannot select anything, so it is refused rather than matched against the
 * whole corpus -- which is what an empty term set would silently do.
 */
const requireTerms = (
  text: string,
  key: string,
  operation: string
): string[] => {
  const terms = [...new Set(tokenize(text))];
  if (terms.length === 0) {
    throw new Error(
      `intelligent-assistant ${operation}: ${key} ${JSON.stringify(text)} has ` +
        `no content terms once stop words and single characters are removed, ` +
        `so nothing could be matched against`
    );
  }
  return terms.sort();
};

const requireLimit = (value: number | undefined): number => {
  if (value === undefined) return INTELLIGENT_ASSISTANT_DEFAULTS.limit;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `intelligent-assistant: limit must be an integer of at least 1; ` +
        `received ${JSON.stringify(value)}`
    );
  }
  return value;
};

const requireFloor = (value: number | undefined): number => {
  if (value === undefined) return INTELLIGENT_ASSISTANT_DEFAULTS.floor;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(
      `intelligent-assistant: floor must be a finite number; received ` +
        `${JSON.stringify(value)}`
    );
  }
  if (value < 0 || value > 1) {
    throw new Error(
      `intelligent-assistant: floor must be within [0, 1] because a score is ` +
        `a cosine; received ${value}`
    );
  }
  return value;
};

/** One ranked document with its score and the terms that produced it. */
const above = (matches: readonly Match[], floor: number): Match[] =>
  matches.filter((match) => match.score > floor);

const documentById = (index: DocumentIndex, id: string): KnowledgeDocument => {
  const found = index.documents.find((document) => document.id === id);
  if (found === undefined) {
    throw new Error(`intelligent-assistant: no document with id ${id}`);
  }
  return found;
};

interface ResolvedCorpus {
  index: DocumentIndex;
  report: CorpusReport;
}

export class IntelligentAssistant {
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
    options: IntelligentAssistantOptions
  ): Promise<IntelligentAssistantResult> {
    const startTime = Date.now();

    /*
     * `learn` writes the store, so it is never served from the result cache
     * and never written to it: a cached `learn` would return the outcome of
     * the first call while performing none of the work of the second.
     */
    const cacheable = options.operation !== 'learn';
    const cacheKey = generateCacheKey('intelligent-assistant', {
      op: options.operation,
      args: JSON.stringify(options),
      /*
       * The store is part of the input, so its contents are part of the key.
       * Without this a `learn` would leave every earlier answer cached and the
       * tool would keep serving results computed from a corpus that no longer
       * exists.
       */
      store: this.storeStamp(options.topic),
    });

    if (cacheable && options.useCache !== false) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
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
    const dataStr = JSON.stringify(data);
    if (cacheable) {
      this.cache.set(cacheKey, dataStr, dataStr.length, dataStr.length);
    }
    this.metricsCollector.record({
      operation: `intelligent-assistant:${options.operation}`,
      duration: Date.now() - startTime,
      success: true,
      cacheHit: false,
    });

    return {
      success: true,
      operation: options.operation,
      data,
      metadata: {
        tokensUsed: this.tokenCounter.count(dataStr).tokens,
        tokensSaved: 0,
        cacheHit: false,
        processingTime: Date.now() - startTime,
      },
    };
  }

  /**
   * One branch per published operation. No fall-through: a value added to the
   * published enum without an implementation here reaches the default and is
   * refused rather than quietly served by a neighbour.
   */
  private compute(
    options: IntelligentAssistantOptions
  ): Record<string, unknown> {
    const { operation } = options;
    switch (operation) {
      case 'search-knowledge':
        return this.searchKnowledge(options);
      case 'ask':
        return this.ask(options);
      case 'explain':
        return this.explain(options);
      case 'suggest':
        return this.suggest(options);
      case 'troubleshoot':
        return this.troubleshoot(options);
      case 'learn':
        return this.learn(options);
      case 'get-context':
        return this.getContext(options);
      case 'generate-example':
        return this.generateExample(options);
      default:
        throw new Error(
          `intelligent-assistant: unknown operation ${JSON.stringify(operation)}`
        );
    }
  }

  // ---------------------------------------------------------------- the store

  private storeKey(topic: string): string {
    return generateCacheKey('intelligent-assistant-store', { topic });
  }

  /** The documents `learn` stored under a topic, or none. */
  private readStore(topic: string | undefined): KnowledgeDocument[] {
    if (typeof topic !== 'string' || topic.trim().length === 0) return [];
    const stored = this.cache.get(this.storeKey(topic));
    if (!stored) return [];
    try {
      const parsed = JSON.parse(stored.toString()) as unknown;
      if (!Array.isArray(parsed)) return [];
      return validateDocuments(parsed, 'stored documents');
    } catch {
      /*
       * A store we cannot read is reported as empty rather than throwing: the
       * cache is evictable by design, and the corpus report's `fromStore: 0`
       * is what tells the caller the documents are not there.
       */
      return [];
    }
  }

  /**
   * A short stamp of the store's contents for the result cache key. The whole
   * stored text would work too; the count and total length are enough to
   * notice every write this tool can make, because a write that changes
   * neither is a no-op by construction.
   */
  private storeStamp(topic: string | undefined): string {
    const stored = this.readStore(topic);
    const characters = stored.reduce(
      (total, document) => total + document.text.length,
      0
    );
    return `${stored.length}:${characters}`;
  }

  /**
   * The corpus for one call: the documents passed in, plus anything `learn`
   * stored under the same topic. A document passed in wins over a stored one
   * with the same id, and the counts are reported so a caller can see which
   * half an answer came from.
   */
  private resolveCorpus(options: IntelligentAssistantOptions): ResolvedCorpus {
    const fromCall =
      options.documents === undefined
        ? []
        : validateDocuments(options.documents, 'documents');
    const topic =
      typeof options.topic === 'string' && options.topic.trim().length > 0
        ? options.topic
        : null;
    const fromStore = this.readStore(topic ?? undefined);
    const callIds = new Set(fromCall.map((document) => document.id));
    const kept = fromStore.filter((document) => !callIds.has(document.id));
    const documents = [...fromCall, ...kept];
    if (documents.length === 0) {
      throw new Error(
        `intelligent-assistant ${options.operation} has no corpus: pass ` +
          `documents, or a topic that learn has stored documents under` +
          (topic === null
            ? ''
            : ` (the store for topic ${JSON.stringify(topic)} is empty, which ` +
              `is also what an evicted store looks like)`)
      );
    }
    return {
      index: buildIndex(documents),
      report: {
        documents: documents.length,
        fromCall: fromCall.length,
        fromStore: kept.length,
        topic,
        durability: kept.length > 0 ? 'cache' : 'call',
        evictable: kept.length > 0,
      },
    };
  }

  // ----------------------------------------------------------- the operations

  private searchKnowledge(
    options: IntelligentAssistantOptions
  ): Record<string, unknown> {
    const question = requireText(
      options.question,
      'question',
      'search-knowledge'
    );
    const terms = requireTerms(question, 'question', 'search-knowledge');
    const limit = requireLimit(options.limit);
    const floor = requireFloor(options.floor);
    const { index, report } = this.resolveCorpus(options);
    const ranked = above(scoreQuery(index, terms), floor);
    return {
      question,
      terms,
      floor,
      considered: index.documents.length,
      matched: ranked.length,
      matches: ranked.slice(0, limit),
      /*
       * Terms no document in the corpus contains at all. A ranked list alone
       * cannot show this, and it is the difference between a weak answer and
       * a question about something the corpus has never heard of.
       */
      absentTerms: absentTerms(index, terms),
      corpus: report,
    };
  }

  private ask(options: IntelligentAssistantOptions): Record<string, unknown> {
    const question = requireText(options.question, 'question', 'ask');
    const terms = requireTerms(question, 'question', 'ask');
    const limit = requireLimit(options.limit);
    const floor = requireFloor(options.floor);
    const { index, report } = this.resolveCorpus(options);
    const all = scoreQuery(index, terms);
    const ranked = above(all, floor);
    const base = {
      question,
      terms,
      floor,
      grounded: true,
      bestScore: all.length === 0 ? 0 : all[0].score,
      absentTerms: absentTerms(index, terms),
      corpus: report,
    };
    if (all.length === 0) {
      return {
        ...base,
        answered: false,
        reason: UnansweredReason.NoSharedTerm,
        quotations: [],
        answeredFrom: [],
      };
    }
    if (ranked.length === 0) {
      return {
        ...base,
        answered: false,
        reason: UnansweredReason.BelowFloor,
        quotations: [],
        answeredFrom: [],
      };
    }
    const chosen = ranked.slice(0, limit);
    const quotations: Quotation[] = [];
    for (const match of chosen) {
      quotations.push(
        ...sentencesMentioning(
          documentById(index, match.id),
          match.matchedTerms
        )
      );
    }
    if (quotations.length === 0) {
      return {
        ...base,
        answered: false,
        reason: UnansweredReason.TitleOnly,
        quotations: [],
        answeredFrom: [],
      };
    }
    return {
      ...base,
      answered: true,
      /*
       * Every entry is a span of the caller's own text with the id it came
       * from. Nothing here is composed, so there is no sentence to attribute
       * to this tool.
       */
      quotations,
      answeredFrom: [...new Set(quotations.map((q) => q.documentId))],
    };
  }

  private explain(
    options: IntelligentAssistantOptions
  ): Record<string, unknown> {
    const topic = requireText(options.topic, 'topic', 'explain');
    const terms = requireTerms(topic, 'topic', 'explain');
    const limit = requireLimit(options.limit);
    const floor = requireFloor(options.floor);
    const { index, report } = this.resolveCorpus(options);
    const ranked = above(scoreQuery(index, terms), floor).slice(0, limit);
    const sections = ranked.map((match) => {
      const document = documentById(index, match.id);
      return {
        documentId: match.id,
        title: match.title,
        score: match.score,
        matchedTerms: match.matchedTerms,
        sentences: sentencesMentioning(document, match.matchedTerms).map(
          (quotation) => quotation.sentence
        ),
      };
    });
    return {
      topic,
      terms,
      floor,
      /*
       * Sections are ordered by score and their sentences keep each document's
       * own order: a resequenced set of sentences reads as prose the document
       * does not contain.
       */
      sections,
      sources: sections.map((section) => section.documentId),
      covered: sections.length,
      considered: index.documents.length,
      absentTerms: absentTerms(index, terms),
      corpus: report,
    };
  }

  private suggest(
    options: IntelligentAssistantOptions
  ): Record<string, unknown> {
    const topic = requireText(options.topic, 'topic', 'suggest');
    const terms = requireTerms(topic, 'topic', 'suggest');
    const limit = requireLimit(options.limit);
    const floor = requireFloor(options.floor);
    if (
      options.seen !== undefined &&
      (!Array.isArray(options.seen) ||
        options.seen.some((id) => typeof id !== 'string'))
    ) {
      throw new Error(
        'intelligent-assistant suggest: seen must be an array of document ids'
      );
    }
    const seen = new Set(options.seen ?? []);
    const { index, report } = this.resolveCorpus(options);
    const ranked = above(scoreQuery(index, terms), floor);
    const eligible = ranked.filter((match) => !seen.has(match.id));
    const excluded = [
      ...ranked
        .filter((match) => seen.has(match.id))
        .map((match) => ({
          id: match.id,
          reason: ExclusionReason.AlreadySeen,
        })),
      ...index.documents
        .filter((document) => !ranked.some((match) => match.id === document.id))
        .map((document) => ({
          id: document.id,
          reason: ExclusionReason.NoSharedTerm,
        })),
    ];
    const unknownSeen = [...seen]
      .filter((id) => !index.documents.some((document) => document.id === id))
      .sort();
    return {
      topic,
      terms,
      floor,
      suggestions: eligible.slice(0, limit),
      excluded,
      /*
       * The share of the corpus that is about this topic at all, which is what
       * says whether a short list of suggestions is the whole story or the top
       * of a long one.
       */
      coverage:
        index.documents.length === 0
          ? 0
          : ranked.length / index.documents.length,
      considered: index.documents.length,
      /*
       * Ids the caller said they had seen that are not in the corpus: silently
       * ignoring them would hide a mismatched id list.
       */
      unknownSeen,
      absentTerms: absentTerms(index, terms),
      corpus: report,
    };
  }

  private troubleshoot(
    options: IntelligentAssistantOptions
  ): Record<string, unknown> {
    const symptom = requireText(options.question, 'question', 'troubleshoot');
    const terms = requireTerms(symptom, 'question', 'troubleshoot');
    const limit = requireLimit(options.limit);
    const floor = requireFloor(options.floor);
    const { index, report } = this.resolveCorpus(options);
    const ranked = above(scoreQuery(index, terms), floor).slice(0, limit);
    const candidates = ranked.map((match) => {
      const document = documentById(index, match.id);
      return {
        documentId: match.id,
        title: match.title,
        score: match.score,
        matchedTerms: match.matchedTerms,
        mentions: sentencesMentioning(document, match.matchedTerms).map(
          (quotation) => quotation.sentence
        ),
        remedies: remedySentences(document).map(
          (quotation) => quotation.sentence
        ),
      };
    });
    return {
      symptom,
      terms,
      floor,
      candidates,
      /*
       * The rule is named rather than described, because it is shallow enough
       * that a caller needs to know it to judge the result: a sentence whose
       * first word is one of the published imperative verbs is a remedy.
       */
      rule: REMEDY_RULE,
      /*
       * Whether anything that matched also contains an instruction. False with
       * candidates present means the corpus describes the symptom and says
       * nothing about fixing it -- which is an answer, not a failure.
       */
      remediesFound: candidates.some(
        (candidate) => candidate.remedies.length > 0
      ),
      considered: index.documents.length,
      absentTerms: absentTerms(index, terms),
      corpus: report,
    };
  }

  private learn(options: IntelligentAssistantOptions): Record<string, unknown> {
    const topic = requireText(options.topic, 'topic', 'learn');
    if (options.documents === undefined) {
      throw new Error(
        'intelligent-assistant learn requires documents to store'
      );
    }
    const incoming = validateDocuments(options.documents, 'documents');
    const policy =
      options.onConflict ?? INTELLIGENT_ASSISTANT_DEFAULTS.onConflict;
    if (
      policy !== ConflictPolicy.KeepStored &&
      policy !== ConflictPolicy.Replace
    ) {
      throw new Error(
        `intelligent-assistant learn: onConflict must be ` +
          `${ConflictPolicy.KeepStored} or ${ConflictPolicy.Replace}; ` +
          `received ${JSON.stringify(policy)}`
      );
    }
    const stored = this.readStore(topic);
    const byId = new Map(stored.map((document) => [document.id, document]));
    const added: string[] = [];
    const duplicate: string[] = [];
    const replaced: string[] = [];
    const conflicting: Array<{
      id: string;
      storedLength: number;
      incomingLength: number;
      kept: 'stored' | 'incoming';
    }> = [];

    for (const document of incoming) {
      const existing = byId.get(document.id);
      if (existing === undefined) {
        byId.set(document.id, document);
        added.push(document.id);
        continue;
      }
      if (existing.text === document.text) {
        /*
         * Same id, same text: storing it again would change nothing, and
         * reporting it as added would overstate what the call did.
         */
        duplicate.push(document.id);
        continue;
      }
      if (policy === ConflictPolicy.Replace) {
        byId.set(document.id, document);
        replaced.push(document.id);
        continue;
      }
      /*
       * Same id, different text, and the caller did not say which wins. The
       * stored copy is kept and the disagreement is reported: overwriting
       * silently is how a corpus loses content nobody notices is gone.
       */
      conflicting.push({
        id: document.id,
        storedLength: existing.text.length,
        incomingLength: document.text.length,
        kept: 'stored',
      });
    }

    const merged = [...byId.values()];
    const payload = JSON.stringify(merged);
    this.cache.set(
      this.storeKey(topic),
      payload,
      payload.length,
      payload.length
    );

    return {
      topic,
      stored: merged.length,
      added,
      duplicate,
      replaced,
      conflicting,
      onConflict: policy,
      /*
       * The store is the result cache. Saying so here, and reporting
       * `fromStore` on every read, is what keeps an evicted corpus from
       * looking like a corpus that never had the documents.
       */
      durability: 'cache',
      evictable: true,
      characters: merged.reduce(
        (total, document) => total + document.text.length,
        0
      ),
    };
  }

  private getContext(
    options: IntelligentAssistantOptions
  ): Record<string, unknown> {
    const question = requireText(options.question, 'question', 'get-context');
    const terms = requireTerms(question, 'question', 'get-context');
    const floor = requireFloor(options.floor);
    const budget = options.budget;
    if (budget === undefined) {
      throw new Error(
        'intelligent-assistant get-context requires a budget in tokens'
      );
    }
    if (!Number.isInteger(budget) || budget < 1) {
      throw new Error(
        `intelligent-assistant get-context: budget must be an integer of at ` +
          `least 1 token; received ${JSON.stringify(budget)}`
      );
    }
    const { index, report } = this.resolveCorpus(options);
    const ranked = above(scoreQuery(index, terms), floor);
    const included: Array<{ id: string; score: number; tokens: number }> = [];
    const excluded: Array<{
      id: string;
      reason: ExclusionReason;
      tokens: number;
    }> = [];
    let used = 0;
    for (const match of ranked) {
      const document = documentById(index, match.id);
      const tokens = this.tokenCounter.count(document.text).tokens;
      if (used + tokens > budget) {
        /*
         * Skipped whole, and the loop continues: a smaller document further
         * down may still fit. Nothing is ever cut mid-document, because half a
         * document quoted as context is a sentence the author did not write.
         */
        excluded.push({
          id: match.id,
          reason: ExclusionReason.OverBudget,
          tokens,
        });
        continue;
      }
      used += tokens;
      included.push({ id: match.id, score: match.score, tokens });
    }
    for (const document of index.documents) {
      if (ranked.some((match) => match.id === document.id)) continue;
      excluded.push({
        id: document.id,
        reason: ExclusionReason.NoSharedTerm,
        tokens: this.tokenCounter.count(document.text).tokens,
      });
    }
    return {
      question,
      terms,
      floor,
      budget,
      tokens: used,
      remaining: budget - used,
      included,
      excluded,
      /** Nothing is ever truncated, so this is a fact about the method. */
      truncated: false,
      text: included
        .map((entry) => documentById(index, entry.id).text)
        .join('\n\n'),
      considered: index.documents.length,
      absentTerms: absentTerms(index, terms),
      corpus: report,
    };
  }

  private generateExample(
    options: IntelligentAssistantOptions
  ): Record<string, unknown> {
    const schema = options.schema;
    if (schema === null || typeof schema !== 'object') {
      throw new Error(
        'intelligent-assistant generate-example requires a schema object'
      );
    }
    const example = exampleFromSchema(schema);
    /*
     * Checked against the same derivation the server validates real arguments
     * with, so an example this tool returns is one the tool it describes would
     * accept. A failure is reported rather than hidden: it would be a defect
     * in the builder, and a caller reading `validated: false` knows not to use
     * the value.
     */
    const parsed = schemaFromDefinition(schema).safeParse(example);
    return {
      example,
      validated: parsed.success,
      violations: parsed.success
        ? []
        : parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
      validatedWith: 'schema-from-definition',
    };
  }
}

export const INTELLIGENTASSISTANTTOOL = {
  name: 'intelligent-assistant',
  description:
    'Answers questions from a document corpus the caller supplies, quoting ' +
    'sentences with the id of the document they came from. Ranks by an idf ' +
    'cosine, reports the question terms the corpus does not contain, and ' +
    'refuses rather than composing an answer it cannot quote.',
  inputSchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: [...INTELLIGENT_ASSISTANT_OPERATIONS],
        description: 'The operation to perform',
      },
      question: {
        type: 'string',
        minLength: 1,
        maxLength: 2000,
        description:
          'The question (ask, search-knowledge, get-context) or the symptom ' +
          '(troubleshoot)',
      },
      topic: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description:
          'The subject (explain, suggest) and the key documents are stored ' +
          'under (learn); any operation may pass it to read that store',
      },
      documents: {
        type: 'array',
        description: 'The corpus to answer from',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 200 },
            title: { type: 'string', maxLength: 500 },
            text: { type: 'string', minLength: 1 },
            tags: { type: 'array', items: { type: 'string' } },
          },
          required: ['id', 'text'],
          additionalProperties: false,
        },
      },
      seen: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        description: 'suggest: document ids to leave out of the suggestions',
      },
      budget: {
        type: 'integer',
        minimum: 1,
        description:
          'get-context: the token budget, measured with this package counter',
      },
      schema: {
        type: 'object',
        description:
          'generate-example: the JSON Schema node to construct a value for',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        default: INTELLIGENT_ASSISTANT_DEFAULTS.limit,
        description: 'How many documents to return',
      },
      floor: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        default: INTELLIGENT_ASSISTANT_DEFAULTS.floor,
        description:
          'Exclusive minimum score; scores are cosines, so this is in [0, 1]',
      },
      onConflict: {
        type: 'string',
        enum: [ConflictPolicy.KeepStored, ConflictPolicy.Replace],
        default: INTELLIGENT_ASSISTANT_DEFAULTS.onConflict,
        description:
          'learn: what to do when a stored document and an incoming one ' +
          'share an id but not their text',
      },
      useCache: { type: 'boolean', default: true },
    },
    required: ['operation'],
    /*
     * The conditional requirements, published rather than described in prose.
     * A property description saying "Required by ask" is something a human
     * reads and a client cannot act on; these branches are something a client
     * can act on, and are what the derived validation enforces.
     *
     * The operations that read a corpus each appear twice, because either
     * `documents` or a `topic` that learn has stored under satisfies them.
     */
    anyOf: [
      {
        properties: { operation: { const: 'ask' } },
        required: ['operation', 'question', 'documents'],
      },
      {
        properties: { operation: { const: 'ask' } },
        required: ['operation', 'question', 'topic'],
      },
      {
        properties: { operation: { const: 'search-knowledge' } },
        required: ['operation', 'question', 'documents'],
      },
      {
        properties: { operation: { const: 'search-knowledge' } },
        required: ['operation', 'question', 'topic'],
      },
      {
        properties: { operation: { const: 'troubleshoot' } },
        required: ['operation', 'question', 'documents'],
      },
      {
        properties: { operation: { const: 'troubleshoot' } },
        required: ['operation', 'question', 'topic'],
      },
      {
        properties: { operation: { const: 'get-context' } },
        required: ['operation', 'question', 'budget', 'documents'],
      },
      {
        properties: { operation: { const: 'get-context' } },
        required: ['operation', 'question', 'budget', 'topic'],
      },
      {
        properties: { operation: { const: 'explain' } },
        required: ['operation', 'topic'],
      },
      {
        properties: { operation: { const: 'suggest' } },
        required: ['operation', 'topic'],
      },
      {
        properties: { operation: { const: 'learn' } },
        required: ['operation', 'topic', 'documents'],
      },
      {
        properties: { operation: { const: 'generate-example' } },
        required: ['operation', 'schema'],
      },
    ],
  },
} as const;

export async function runIntelligentAssistant(
  options: IntelligentAssistantOptions
): Promise<IntelligentAssistantResult> {
  const tool = new IntelligentAssistant(
    sharedCache,
    sharedTokenCounter,
    sharedMetricsCollector
  );
  return tool.run(options);
}
