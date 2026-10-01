/**
 * SmartSummarization -- extractive summarisation, digests and categorisation
 * over text the caller supplies.
 *
 * WHAT WAS HERE: every one of the eight operations this tool publishes
 * returned `{ success: true, data: { result: "<operation> completed
 * successfully" } }` with a hard-coded `confidence: 0.85`, having read none of
 * its input and computed nothing. The tool was wired into the server, listed
 * in tools/list and carried no test. That is the worst defect class in this
 * repository: not a wrong answer, which a caller can notice, but a fabricated
 * one that is indistinguishable from a real result.
 *
 * TWO CONSEQUENCES FOR THE SHAPE OF THIS FILE:
 *
 * 1. `confidence` is gone from the result. The old value was not a measurement
 *    of anything, and no honest number belongs in its place: an extractive
 *    summary is not a probabilistic claim. Each operation instead returns the
 *    figures it actually computed -- scores, shares, counts -- which a caller
 *    can check against their own text.
 *
 * 2. An operation whose inputs are absent REFUSES, naming the missing key.
 *    Defaulting is how the fabrication came to exist: once a missing input has
 *    a stand-in, a call with no input at all still returns success.
 *
 * Nothing here generates prose. Summaries select sentences the caller wrote.
 * This package has no language model, and inventing a sentence would be the
 * same defect in a new costume.
 */

import type { CacheEngine } from '../../core/cache-engine.js';
import type { TokenCounter } from '../../core/token-counter.js';
import type { MetricsCollector } from '../../core/metrics.js';
import { generateCacheKey } from '../shared/hash-utils.js';
import { generateDiff, generateUnifiedDiff } from '../shared/diff-utils.js';
import {
  categorize,
  compareTermShares,
  keyTerms,
  splitSentences,
  summarize,
  tokenize,
  type Category,
} from './text-core.js';
import {
  sharedCache,
  sharedTokenCounter,
  sharedMetricsCollector,
} from './shared-instances.js';

/**
 * The operations, in one place: the TS union and the published enum are both
 * derived from this array, so they cannot drift apart.
 */
export const SMART_SUMMARIZATION_OPERATIONS = [
  'summarize',
  'create-digest',
  'compare-periods',
  'extract-insights',
  'highlight-changes',
  'categorize',
  'schedule',
  'export',
] as const;

export type SmartSummarizationOperation =
  (typeof SMART_SUMMARIZATION_OPERATIONS)[number];

/** Output formats `export` renders. */
export const EXPORT_FORMATS = ['markdown', 'json', 'csv'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/**
 * Defaults, collected so every one of them is visible at once. Each is a
 * presentation choice -- how many sentences, how many terms -- never a
 * stand-in for a missing input.
 */
export const SMART_SUMMARIZATION_DEFAULTS = Object.freeze({
  sentenceCount: 3,
  sentencesPerDocument: 1,
  termLimit: 10,
  occurrences: 5,
  contextLines: 3,
});

/** One document in a digest. */
export interface SummarizationDocument {
  title?: string;
  text: string;
}

/** One timestamped item `schedule` buckets into digest windows. */
export interface ScheduleItem {
  /** ISO 8601 timestamp. */
  at: string;
  text?: string;
}

export interface SmartSummarizationOptions {
  operation: SmartSummarizationOperation;
  /** summarize, extract-insights, categorize. */
  text?: string;
  /** create-digest. */
  documents?: SummarizationDocument[];
  /** compare-periods, highlight-changes. */
  before?: string;
  after?: string;
  /** categorize. */
  categories?: Category[];
  /** extract-insights: other documents the key terms are scored against. */
  corpus?: string[];
  /** schedule. */
  items?: ScheduleItem[];
  intervalHours?: number;
  startAt?: string;
  occurrences?: number;
  /** export. */
  format?: ExportFormat;
  payload?: unknown;
  /** Presentation. */
  sentenceCount?: number;
  sentencesPerDocument?: number;
  termLimit?: number;
  contextLines?: number;
  useCache?: boolean;
}

export interface SmartSummarizationResult {
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

const MILLISECONDS_PER_HOUR = 3_600_000;

/**
 * Refusals. Each names the key that is missing and the operation that needed
 * it, because a caller reading `data` must be given something they can act on
 * without reading this file.
 */
const requireText = (operation: string, value: string | undefined): string => {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new Error(
      `smart-summarization ${operation}: \`text\` is required and must be non-empty`
    );
  return value;
};

const requirePair = (
  operation: string,
  before: string | undefined,
  after: string | undefined
): { before: string; after: string } => {
  const missing: string[] = [];
  if (typeof before !== 'string') missing.push('before');
  if (typeof after !== 'string') missing.push('after');
  if (missing.length > 0 || before === undefined || after === undefined)
    throw new Error(
      `smart-summarization ${operation}: requires ${missing.join(' and ')}`
    );
  return { before, after };
};

const requireDocuments = (
  operation: string,
  documents: SummarizationDocument[] | undefined
): SummarizationDocument[] => {
  if (!Array.isArray(documents) || documents.length === 0)
    throw new Error(
      `smart-summarization ${operation}: \`documents\` is required and must hold at least one entry`
    );
  documents.forEach((document, index) => {
    if (typeof document?.text !== 'string' || document.text.length === 0)
      throw new Error(
        `smart-summarization ${operation}: documents[${index}].text is required and must be non-empty`
      );
  });
  return documents;
};

const positiveInteger = (
  operation: string,
  key: string,
  value: number | undefined,
  fallback: number
): number => {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1)
    throw new Error(
      `smart-summarization ${operation}: \`${key}\` must be an integer of at least 1; received ${String(value)}`
    );
  return value;
};

/** Parses an ISO timestamp, refusing anything Date cannot read. */
const parseInstant = (
  operation: string,
  key: string,
  value: string
): number => {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed))
    throw new Error(
      `smart-summarization ${operation}: \`${key}\` must be an ISO 8601 timestamp; received ${JSON.stringify(value)}`
    );
  return parsed;
};

/** Escapes a cell so a value containing a pipe cannot forge a column. */
const markdownCell = (value: unknown): string =>
  String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');

/** Escapes a CSV field per RFC 4180. */
const csvField = (value: unknown): string => {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** The union of keys across an array of records, in first-seen order. */
const columnsOf = (rows: ReadonlyArray<Record<string, unknown>>): string[] => {
  const seen: string[] = [];
  for (const row of rows)
    for (const key of Object.keys(row)) if (!seen.includes(key)) seen.push(key);
  return seen;
};

const asRows = (
  payload: unknown
): Array<Record<string, unknown>> | undefined => {
  if (Array.isArray(payload)) {
    if (payload.every((entry) => entry !== null && typeof entry === 'object'))
      return payload as Array<Record<string, unknown>>;
    return undefined;
  }
  if (payload !== null && typeof payload === 'object')
    return [payload as Record<string, unknown>];
  return undefined;
};

/**
 * Renders the caller's own payload in the requested format. A payload that is
 * not a table refuses for csv rather than being flattened into one column,
 * because a silent reshape is how a caller ends up quoting a number this tool
 * invented.
 */
const render = (
  payload: unknown,
  format: ExportFormat
): { format: ExportFormat; content: string; rows: number } => {
  if (format === 'json')
    return {
      format,
      content: JSON.stringify(payload, null, 2),
      rows: asRows(payload)?.length ?? 0,
    };

  const rows = asRows(payload);
  if (rows === undefined)
    throw new Error(
      `smart-summarization export: \`${format}\` needs \`payload\` to be an object or an array of objects`
    );
  const columns = columnsOf(rows);
  if (columns.length === 0)
    throw new Error(
      'smart-summarization export: `payload` has no fields to write'
    );

  if (format === 'csv') {
    const lines = [columns.map(csvField).join(',')];
    for (const row of rows)
      lines.push(columns.map((key) => csvField(row[key])).join(','));
    return { format, content: lines.join('\n'), rows: rows.length };
  }

  const lines = [
    `| ${columns.map(markdownCell).join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
  ];
  for (const row of rows)
    lines.push(
      `| ${columns.map((key) => markdownCell(row[key])).join(' | ')} |`
    );
  return { format, content: lines.join('\n'), rows: rows.length };
};

export class SmartSummarization {
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
    options: SmartSummarizationOptions
  ): Promise<SmartSummarizationResult> {
    const startTime = Date.now();
    const cacheKey = generateCacheKey('smart-summarization', {
      op: options.operation,
      args: JSON.stringify(options),
    });

    if (options.useCache !== false) {
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
    this.cache.set(cacheKey, dataStr, dataStr.length, dataStr.length);
    this.metricsCollector.record({
      operation: `smart-summarization:${options.operation}`,
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
   * One branch per published operation, each naming the operation it performs.
   * No fall-through: a value added to the published enum without an
   * implementation here reaches the default and is refused, instead of being
   * silently serviced as whichever branch happened to be last.
   */
  private compute(options: SmartSummarizationOptions): Record<string, unknown> {
    const operation = options.operation;
    switch (operation) {
      case 'summarize':
        return this.summarizeOne(options);
      case 'create-digest':
        return this.createDigest(options);
      case 'compare-periods':
        return this.comparePeriods(options);
      case 'extract-insights':
        return this.extractInsights(options);
      case 'highlight-changes':
        return this.highlightChanges(options);
      case 'categorize':
        return this.categorizeText(options);
      case 'schedule':
        return this.schedule(options);
      case 'export':
        return this.exportPayload(options);
      default:
        throw new Error(
          `smart-summarization: unknown operation ${JSON.stringify(operation)}`
        );
    }
  }

  private summarizeOne(
    options: SmartSummarizationOptions
  ): Record<string, unknown> {
    const text = requireText('summarize', options.text);
    const wanted = positiveInteger(
      'summarize',
      'sentenceCount',
      options.sentenceCount,
      SMART_SUMMARIZATION_DEFAULTS.sentenceCount
    );
    const sentences = splitSentences(text);
    const selected = summarize(text, wanted);
    return {
      summary: selected.map((entry) => entry.sentence).join(' '),
      selected,
      sentenceCount: sentences.length,
      selectedCount: selected.length,
      termCount: tokenize(text).length,
    };
  }

  private createDigest(
    options: SmartSummarizationOptions
  ): Record<string, unknown> {
    const documents = requireDocuments('create-digest', options.documents);
    const perDocument = positiveInteger(
      'create-digest',
      'sentencesPerDocument',
      options.sentencesPerDocument,
      SMART_SUMMARIZATION_DEFAULTS.sentencesPerDocument
    );
    const termLimit = positiveInteger(
      'create-digest',
      'termLimit',
      options.termLimit,
      SMART_SUMMARIZATION_DEFAULTS.termLimit
    );
    const corpus = documents.map((document) => tokenize(document.text));
    const entries = documents.map((document, index) => ({
      title: document.title ?? `document ${index + 1}`,
      summary: summarize(document.text, perDocument)
        .map((entry) => entry.sentence)
        .join(' '),
      keyTerms: keyTerms(corpus[index], corpus, termLimit),
    }));
    return {
      documentCount: documents.length,
      entries,
      // Scored over the concatenation against the same corpus, so a term
      // common to every document still carries the smoothed weight rather
      // than vanishing.
      sharedTerms: keyTerms(corpus.flat(), corpus, termLimit),
    };
  }

  private comparePeriods(
    options: SmartSummarizationOptions
  ): Record<string, unknown> {
    const { before, after } = requirePair(
      'compare-periods',
      options.before,
      options.after
    );
    const termLimit = positiveInteger(
      'compare-periods',
      'termLimit',
      options.termLimit,
      SMART_SUMMARIZATION_DEFAULTS.termLimit
    );
    const shifts = compareTermShares(before, after, termLimit);
    return {
      shifts,
      rose: shifts.filter((shift) => shift.delta > 0),
      fell: shifts.filter((shift) => shift.delta < 0),
      beforeTermCount: tokenize(before).length,
      afterTermCount: tokenize(after).length,
    };
  }

  private extractInsights(
    options: SmartSummarizationOptions
  ): Record<string, unknown> {
    const text = requireText('extract-insights', options.text);
    const termLimit = positiveInteger(
      'extract-insights',
      'termLimit',
      options.termLimit,
      SMART_SUMMARIZATION_DEFAULTS.termLimit
    );
    const corpusTexts = Array.isArray(options.corpus) ? options.corpus : [];
    const corpus = [text, ...corpusTexts].map((entry) => tokenize(entry));
    const terms = keyTerms(corpus[0], corpus, termLimit);
    const sentences = splitSentences(text);
    // Each term is returned with a sentence the caller wrote that contains it,
    // so every insight can be traced back to its evidence.
    const evidence = terms.map((term) => ({
      term: term.term,
      score: term.score,
      sentence:
        sentences.find((sentence) => tokenize(sentence).includes(term.term)) ??
        null,
    }));
    return {
      terms,
      evidence,
      sentenceCount: sentences.length,
      corpusSize: corpus.length,
    };
  }

  private highlightChanges(
    options: SmartSummarizationOptions
  ): Record<string, unknown> {
    const { before, after } = requirePair(
      'highlight-changes',
      options.before,
      options.after
    );
    const contextLines = positiveInteger(
      'highlight-changes',
      'contextLines',
      options.contextLines,
      SMART_SUMMARIZATION_DEFAULTS.contextLines
    );
    const diff = generateDiff(before, after);
    return {
      added: diff.added,
      removed: diff.removed,
      unchangedLines: diff.unchanged,
      changed: diff.added.length > 0 || diff.removed.length > 0,
      unified: generateUnifiedDiff(
        before,
        after,
        'before',
        'after',
        contextLines
      ),
    };
  }

  private categorizeText(
    options: SmartSummarizationOptions
  ): Record<string, unknown> {
    const text = requireText('categorize', options.text);
    if (!Array.isArray(options.categories) || options.categories.length === 0)
      throw new Error(
        'smart-summarization categorize: `categories` is required -- there is no built-in taxonomy, because one would be a guess about your domain'
      );
    const scores = categorize(text, options.categories);
    const best = scores.find((score) => score.score > 0) ?? null;
    return {
      scores,
      // Null rather than the top row when nothing matched: a best category
      // with a zero score is the fabrication this file exists to remove.
      best,
      matched: best !== null,
      termCount: tokenize(text).length,
    };
  }

  /**
   * Buckets timestamped items into fixed digest windows and reports the next
   * window after the last item. Real arithmetic over the caller's own
   * timestamps; nothing is enqueued, because this package runs no job store
   * and reporting a scheduled job that does not exist would be a fabrication.
   */
  private schedule(
    options: SmartSummarizationOptions
  ): Record<string, unknown> {
    if (!Array.isArray(options.items) || options.items.length === 0)
      throw new Error(
        'smart-summarization schedule: `items` is required and must hold at least one entry with an ISO `at`'
      );
    if (
      typeof options.intervalHours !== 'number' ||
      !Number.isFinite(options.intervalHours) ||
      options.intervalHours <= 0
    )
      throw new Error(
        `smart-summarization schedule: \`intervalHours\` is required and must be greater than 0; received ${String(options.intervalHours)}`
      );
    const occurrences = positiveInteger(
      'schedule',
      'occurrences',
      options.occurrences,
      SMART_SUMMARIZATION_DEFAULTS.occurrences
    );
    const stamps = options.items.map((item, index) => {
      if (typeof item?.at !== 'string')
        throw new Error(
          `smart-summarization schedule: items[${index}].at is required and must be an ISO 8601 timestamp`
        );
      return parseInstant('schedule', `items[${index}].at`, item.at);
    });
    const earliest = Math.min(...stamps);
    const latest = Math.max(...stamps);
    const step = options.intervalHours * MILLISECONDS_PER_HOUR;
    const origin =
      options.startAt === undefined
        ? earliest
        : parseInstant('schedule', 'startAt', options.startAt);
    if (origin > earliest)
      throw new Error(
        `smart-summarization schedule: \`startAt\` (${new Date(origin).toISOString()}) is after the earliest item (${new Date(earliest).toISOString()}), so that item falls in no window`
      );

    const counts = new Map<number, number>();
    for (const stamp of stamps) {
      const index = Math.floor((stamp - origin) / step);
      counts.set(index, (counts.get(index) ?? 0) + 1);
    }
    const windows = [...counts.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([index, itemCount]) => ({
        index,
        startsAt: new Date(origin + index * step).toISOString(),
        endsAt: new Date(origin + (index + 1) * step).toISOString(),
        itemCount,
      }));

    const nextIndex = Math.floor((latest - origin) / step) + 1;
    const upcoming: string[] = [];
    for (let offset = 0; offset < occurrences; offset += 1)
      upcoming.push(
        new Date(origin + (nextIndex + offset) * step).toISOString()
      );

    return {
      intervalHours: options.intervalHours,
      origin: new Date(origin).toISOString(),
      itemCount: stamps.length,
      // Windows with no item are omitted rather than emitted empty: the gaps
      // are derivable from index, and inventing rows is this file's defect.
      windows,
      upcoming,
    };
  }

  private exportPayload(
    options: SmartSummarizationOptions
  ): Record<string, unknown> {
    if (options.payload === undefined)
      throw new Error(
        'smart-summarization export: `payload` is required -- this operation renders data you supply and holds none of its own'
      );
    const format = options.format;
    if (format === undefined)
      throw new Error(
        `smart-summarization export: \`format\` is required; one of ${EXPORT_FORMATS.join(', ')}`
      );
    if (!EXPORT_FORMATS.includes(format))
      throw new Error(
        `smart-summarization export: unknown format ${JSON.stringify(format)}; one of ${EXPORT_FORMATS.join(', ')}`
      );
    const rendered = render(options.payload, format);
    return {
      format: rendered.format,
      content: rendered.content,
      rows: rendered.rows,
      bytes: Buffer.byteLength(rendered.content, 'utf8'),
    };
  }
}

export const SMARTSUMMARIZATIONTOOL = {
  name: 'smart-summarization',
  description:
    'Extractive summarisation, digests, period comparison and categorisation over text you supply. Selects sentences from the input; never generates prose.',
  inputSchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: SMART_SUMMARIZATION_OPERATIONS,
        description: 'Operation to perform',
      },
      text: {
        type: 'string',
        minLength: 1,
        description:
          'The text to work on. Required by summarize, extract-insights and categorize.',
      },
      documents: {
        type: 'array',
        minItems: 1,
        description: 'Documents to digest. Required by create-digest.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Shown in the digest entry' },
            text: {
              type: 'string',
              minLength: 1,
              description: 'Document body',
            },
          },
          required: ['text'],
        },
      },
      before: {
        type: 'string',
        description:
          'Earlier text. Required by compare-periods and highlight-changes.',
      },
      after: {
        type: 'string',
        description:
          'Later text. Required by compare-periods and highlight-changes.',
      },
      categories: {
        type: 'array',
        minItems: 1,
        description:
          'Your taxonomy. Required by categorize; there is no built-in one.',
        items: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              minLength: 1,
              description: 'Category name',
            },
            terms: {
              type: 'array',
              minItems: 1,
              items: { type: 'string', minLength: 1 },
              description: 'Terms evidencing the category, matched whole',
            },
          },
          required: ['name', 'terms'],
        },
      },
      corpus: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Other documents to score key terms against (extract-insights)',
      },
      items: {
        type: 'array',
        minItems: 1,
        description: 'Timestamped items to bucket. Required by schedule.',
        items: {
          type: 'object',
          properties: {
            at: {
              type: 'string',
              minLength: 1,
              description: 'ISO 8601 instant',
            },
            text: { type: 'string', description: 'Item body' },
          },
          required: ['at'],
        },
      },
      intervalHours: {
        type: 'number',
        exclusiveMinimum: 0,
        description: 'Digest window length in hours. Required by schedule.',
      },
      startAt: {
        type: 'string',
        minLength: 1,
        description:
          'ISO 8601 instant the first window opens; defaults to the earliest item',
      },
      occurrences: {
        type: 'integer',
        minimum: 1,
        description: 'How many upcoming windows to report (schedule)',
      },
      format: {
        type: 'string',
        enum: EXPORT_FORMATS,
        description: 'Output format. Required by export.',
      },
      payload: {
        description:
          'The data to render. Required by export; csv and markdown need an object or an array of objects.',
      },
      sentenceCount: {
        type: 'integer',
        minimum: 1,
        description: 'Sentences to select (summarize)',
      },
      sentencesPerDocument: {
        type: 'integer',
        minimum: 1,
        description: 'Sentences per digest entry (create-digest)',
      },
      termLimit: {
        type: 'integer',
        minimum: 1,
        description: 'How many terms to return',
      },
      contextLines: {
        type: 'integer',
        minimum: 1,
        description: 'Unified-diff context lines (highlight-changes)',
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
     * A property description saying "Required by export" is something a human
     * reads and a client cannot act on; these branches are something a client
     * can act on, and are what the derived validation enforces. One branch per
     * operation, so a call is refused by the schema before it reaches the
     * refusals in this file -- which remain for direct programmatic callers.
     */
    anyOf: [
      {
        properties: { operation: { const: 'summarize' } },
        required: ['operation', 'text'],
      },
      {
        properties: { operation: { const: 'create-digest' } },
        required: ['operation', 'documents'],
      },
      {
        properties: { operation: { const: 'compare-periods' } },
        required: ['operation', 'before', 'after'],
      },
      {
        properties: { operation: { const: 'extract-insights' } },
        required: ['operation', 'text'],
      },
      {
        properties: { operation: { const: 'highlight-changes' } },
        required: ['operation', 'before', 'after'],
      },
      {
        properties: { operation: { const: 'categorize' } },
        required: ['operation', 'text', 'categories'],
      },
      {
        properties: { operation: { const: 'schedule' } },
        required: ['operation', 'items', 'intervalHours'],
      },
      {
        properties: { operation: { const: 'export' } },
        required: ['operation', 'format', 'payload'],
      },
    ],
  },
} as const;

export async function runSmartSummarization(
  options: SmartSummarizationOptions
): Promise<SmartSummarizationResult> {
  const tool = new SmartSummarization(
    sharedCache,
    sharedTokenCounter,
    sharedMetricsCollector
  );
  return await tool.run(options);
}
