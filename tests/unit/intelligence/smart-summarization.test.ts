/**
 * smart-summarization computes its answers.
 *
 * WHY THIS FILE EXISTS: all eight operations used to return
 * `{ success: true, data: { result: "<operation> completed successfully" } }`
 * with a hard-coded `confidence: 0.85`, reading no input. The tool was
 * published in tools/list, wired into the server, and had no test at all --
 * which is how a tool that computes nothing stays shipped.
 *
 * So every test here pins a value derived from the INPUT. A test that only
 * checked `success === true` would still pass against the stub, and a suite of
 * those is what the stub's absence of tests was equivalent to.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { CacheEngine } from '../../../src/core/cache-engine.js';
import { TokenCounter } from '../../../src/core/token-counter.js';
import { MetricsCollector } from '../../../src/core/metrics.js';
import {
  SmartSummarization,
  SMARTSUMMARIZATIONTOOL,
  SMART_SUMMARIZATION_OPERATIONS,
  type SmartSummarizationOptions,
} from '../../../src/tools/intelligence/smart-summarization.js';
import { TEXTRANK_DAMPING } from '../../../src/tools/intelligence/text-core.js';
import { toolSchemaMap } from '../../../src/validation/tool-schemas.js';

const engines: CacheEngine[] = [];
const dirs: string[] = [];

afterEach(() => {
  while (engines.length) {
    try {
      engines.pop()?.close();
    } catch {
      /* already closed */
    }
  }
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir)
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* windows holds the handle briefly */
      }
  }
});

/** A tool over a temp cache, never the real home cache. */
const fixture = (): SmartSummarization => {
  const dir = mkdtempSync(join(tmpdir(), 'smart-sum-'));
  dirs.push(dir);
  const engine = new CacheEngine(join(dir, 'c.db'));
  engines.push(engine);
  return new SmartSummarization(
    engine,
    new TokenCounter(),
    new MetricsCollector()
  );
};

const run = async (
  options: SmartSummarizationOptions
): Promise<Record<string, unknown>> => {
  const result = await fixture().run({ useCache: false, ...options });
  expect(result.success).toBe(true);
  expect(result.operation).toBe(options.operation);
  return result.data;
};

const ARTICLE = [
  'The cache engine stores compressed blocks on disk.',
  'Compressed blocks are keyed by a content hash.',
  'A content hash makes the cache engine idempotent.',
  'Unrelated: the weather today is cold.',
].join(' ');

describe('smart-summarization summarize', () => {
  it('selects sentences from the input and counts them', async () => {
    const data = await run({
      operation: 'summarize',
      text: ARTICLE,
      sentenceCount: 2,
    });
    expect(data.sentenceCount).toBe(4);
    expect(data.selectedCount).toBe(2);
    const selected = data.selected as Array<{ sentence: string }>;
    // Every sentence returned is one the caller wrote, verbatim.
    for (const entry of selected) expect(ARTICLE).toContain(entry.sentence);
    expect(data.summary).toBe(
      selected.map((entry) => entry.sentence).join(' ')
    );
    // The sentence sharing no term with any other scores the damping floor,
    // so it cannot be selected while three sharing sentences exist.
    expect(data.summary).not.toContain('weather');
  });

  it('scores the unrelated sentence at the damping floor', async () => {
    const data = await run({
      operation: 'summarize',
      text: ARTICLE,
      sentenceCount: 4,
    });
    const selected = data.selected as Array<{
      sentence: string;
      score: number;
    }>;
    const unrelated = selected.find((entry) =>
      entry.sentence.includes('weather')
    );
    expect(unrelated?.score).toBeCloseTo(1 - TEXTRANK_DAMPING, 12);
  });

  it('refuses an empty text instead of answering', async () => {
    await expect(
      fixture().run({ operation: 'summarize', text: '   ' })
    ).rejects.toThrow(/`text` is required/);
  });
});

describe('smart-summarization create-digest', () => {
  it('summarises each document and scores terms across them', async () => {
    const data = await run({
      operation: 'create-digest',
      documents: [
        { title: 'cache', text: 'The cache stores blocks. Blocks are hashed.' },
        { text: 'The queue drains jobs. Jobs are retried.' },
      ],
      sentencesPerDocument: 1,
      termLimit: 3,
    });
    expect(data.documentCount).toBe(2);
    const entries = data.entries as Array<{
      title: string;
      summary: string;
      keyTerms: Array<{ term: string }>;
    }>;
    expect(entries.map((entry) => entry.title)).toEqual([
      'cache',
      'document 2',
    ]);
    // A term in only one document outranks nothing in the other: the second
    // entry's terms are the second document's words, not the first's.
    const second = entries[1].keyTerms.map((term) => term.term);
    expect(second).toContain('jobs');
    expect(second).not.toContain('cache');
    for (const entry of entries)
      expect(entry.summary.length).toBeGreaterThan(0);
  });

  it('refuses an empty document list', async () => {
    await expect(
      fixture().run({ operation: 'create-digest', documents: [] })
    ).rejects.toThrow(/`documents` is required/);
  });

  it('names the document whose text is missing', async () => {
    await expect(
      fixture().run({
        operation: 'create-digest',
        documents: [{ text: 'fine' }, { text: '' }],
      })
    ).rejects.toThrow(/documents\[1\]\.text is required/);
  });
});

describe('smart-summarization compare-periods', () => {
  it('reports the share each term gained or lost', async () => {
    const data = await run({
      operation: 'compare-periods',
      before: 'timeout timeout cache cache',
      after: 'cache cache cache cache',
      termLimit: 5,
    });
    expect(data.beforeTermCount).toBe(4);
    expect(data.afterTermCount).toBe(4);
    const shifts = data.shifts as Array<{
      term: string;
      beforeShare: number;
      afterShare: number;
      delta: number;
    }>;
    const timeout = shifts.find((shift) => shift.term === 'timeout');
    const cache = shifts.find((shift) => shift.term === 'cache');
    // 2/4 -> 0/4 and 2/4 -> 4/4: exact fractions, not approximations.
    expect(timeout).toEqual({
      term: 'timeout',
      beforeShare: 0.5,
      afterShare: 0,
      delta: -0.5,
    });
    expect(cache).toEqual({
      term: 'cache',
      beforeShare: 0.5,
      afterShare: 1,
      delta: 0.5,
    });
    expect((data.rose as unknown[]).length).toBe(1);
    expect((data.fell as unknown[]).length).toBe(1);
  });

  it('names both missing sides', async () => {
    await expect(
      fixture().run({ operation: 'compare-periods' })
    ).rejects.toThrow(/requires before and after/);
  });
});

describe('smart-summarization extract-insights', () => {
  it('returns each term with a sentence from the input that contains it', async () => {
    const data = await run({
      operation: 'extract-insights',
      text: 'Retries failed on timeout. The timeout was raised.',
      termLimit: 2,
    });
    expect(data.sentenceCount).toBe(2);
    const evidence = data.evidence as Array<{
      term: string;
      sentence: string | null;
    }>;
    expect(evidence.length).toBe(2);
    for (const entry of evidence) {
      expect(entry.sentence).not.toBeNull();
      expect(entry.sentence).toContain(entry.term);
    }
    expect(evidence[0].term).toBe('timeout');
  });

  it('scores against the corpus it is given', async () => {
    const shared = { operation: 'extract-insights' as const, termLimit: 1 };
    const alone = await run({ ...shared, text: 'cache timeout' });
    const inCorpus = await run({
      ...shared,
      text: 'cache timeout',
      corpus: ['cache', 'cache'],
    });
    const termOf = (data: Record<string, unknown>): string =>
      (data.terms as Array<{ term: string }>)[0].term;
    // Alone, both terms tie on frequency and ties break alphabetically.
    // Against a corpus where `cache` appears everywhere, the rarer term wins.
    expect(termOf(alone)).toBe('cache');
    expect(termOf(inCorpus)).toBe('timeout');
    expect(inCorpus.corpusSize).toBe(3);
  });
});

describe('smart-summarization highlight-changes', () => {
  it('reports the lines that changed, not the whole text', async () => {
    const data = await run({
      operation: 'highlight-changes',
      before: 'one\ntwo\nthree\n',
      after: 'one\nTWO\nthree\n',
    });
    expect(data.changed).toBe(true);
    expect((data.added as string[]).join('')).toContain('TWO');
    expect((data.removed as string[]).join('')).toContain('two');
    const unified = data.unified as string;
    expect(unified).toContain('--- before');
    expect(unified).toContain('+++ after');
  });

  it('reports no change for identical text', async () => {
    const data = await run({
      operation: 'highlight-changes',
      before: 'same\n',
      after: 'same\n',
    });
    expect(data.changed).toBe(false);
    expect(data.added).toEqual([]);
    expect(data.removed).toEqual([]);
  });
});

describe('smart-summarization categorize', () => {
  const CATEGORIES = [
    { name: 'failures', terms: ['error', 'timeout'] },
    { name: 'caching', terms: ['cache', 'hit'] },
  ];

  it('scores whole-token matches as a share of the text', async () => {
    const data = await run({
      operation: 'categorize',
      text: 'cache cache error weather',
      categories: CATEGORIES,
    });
    expect(data.matched).toBe(true);
    const scores = data.scores as Array<{ name: string; score: number }>;
    // 2 of 4 tokens caching, 1 of 4 failures.
    expect(scores[0]).toEqual({
      name: 'caching',
      score: 0.5,
      matched: [{ term: 'cache', count: 2 }],
    });
    expect(scores[1].name).toBe('failures');
    expect(scores[1].score).toBe(0.25);
    expect((data.best as { name: string }).name).toBe('caching');
  });

  it('matches a whole token and never a substring', async () => {
    const data = await run({
      operation: 'categorize',
      // `terrorise` contains `error`; a substring match would score it.
      text: 'they terrorise the errorless build',
      categories: CATEGORIES,
    });
    expect(data.matched).toBe(false);
    expect(data.best).toBeNull();
    for (const score of data.scores as Array<{ score: number }>)
      expect(score.score).toBe(0);
  });

  it('refuses to classify without a taxonomy', async () => {
    await expect(
      fixture().run({ operation: 'categorize', text: 'anything' })
    ).rejects.toThrow(/`categories` is required/);
  });
});

describe('smart-summarization schedule', () => {
  const ITEMS = [
    { at: '2026-01-01T00:00:00Z' },
    { at: '2026-01-01T05:00:00Z' },
    { at: '2026-01-01T13:00:00Z' },
  ];

  it('buckets items into windows and names the next ones', async () => {
    const data = await run({
      operation: 'schedule',
      items: ITEMS,
      intervalHours: 12,
      occurrences: 2,
    });
    expect(data.origin).toBe('2026-01-01T00:00:00.000Z');
    expect(data.itemCount).toBe(3);
    // Two items in [00:00, 12:00), one in [12:00, 24:00).
    expect(data.windows).toEqual([
      {
        index: 0,
        startsAt: '2026-01-01T00:00:00.000Z',
        endsAt: '2026-01-01T12:00:00.000Z',
        itemCount: 2,
      },
      {
        index: 1,
        startsAt: '2026-01-01T12:00:00.000Z',
        endsAt: '2026-01-02T00:00:00.000Z',
        itemCount: 1,
      },
    ]);
    expect(data.upcoming).toEqual([
      '2026-01-02T00:00:00.000Z',
      '2026-01-02T12:00:00.000Z',
    ]);
  });

  it('honours an explicit startAt', async () => {
    const data = await run({
      operation: 'schedule',
      items: ITEMS,
      intervalHours: 24,
      startAt: '2025-12-31T00:00:00Z',
      occurrences: 1,
    });
    expect(data.origin).toBe('2025-12-31T00:00:00.000Z');
    // Everything falls in window 1 now, counted from the day before.
    expect(
      (data.windows as Array<{ index: number }>).map((w) => w.index)
    ).toEqual([1]);
    expect(data.upcoming).toEqual(['2026-01-02T00:00:00.000Z']);
  });

  it('refuses a startAt that leaves an item in no window', async () => {
    await expect(
      fixture().run({
        operation: 'schedule',
        items: ITEMS,
        intervalHours: 1,
        startAt: '2026-06-01T00:00:00Z',
      })
    ).rejects.toThrow(/is after the earliest item/);
  });

  it('refuses a non-positive interval', async () => {
    await expect(
      fixture().run({
        operation: 'schedule',
        items: ITEMS,
        intervalHours: 0,
      })
    ).rejects.toThrow(/`intervalHours` is required and must be greater than 0/);
  });

  it('names the item whose timestamp it cannot read', async () => {
    await expect(
      fixture().run({
        operation: 'schedule',
        items: [{ at: '2026-01-01T00:00:00Z' }, { at: 'last tuesday' }],
        intervalHours: 1,
      })
    ).rejects.toThrow(/items\[1\]\.at` must be an ISO 8601 timestamp/);
  });
});

describe('smart-summarization export', () => {
  const ROWS = [
    { term: 'cache', count: 2 },
    { term: 'with,comma', count: 1 },
  ];

  it('writes csv with a header and RFC 4180 quoting', async () => {
    const data = await run({
      operation: 'export',
      format: 'csv',
      payload: ROWS,
    });
    expect(data.rows).toBe(2);
    expect(data.content).toBe('term,count\ncache,2\n"with,comma",1');
    expect(data.bytes).toBe(Buffer.byteLength(data.content as string, 'utf8'));
  });

  it('writes a markdown table that a pipe in a value cannot break', async () => {
    const data = await run({
      operation: 'export',
      format: 'markdown',
      payload: [{ term: 'a|b' }],
    });
    expect(data.content).toBe('| term |\n| --- |\n| a\\|b |');
  });

  it('writes json unchanged', async () => {
    const data = await run({
      operation: 'export',
      format: 'json',
      payload: { a: 1 },
    });
    expect(data.content).toBe('{\n  "a": 1\n}');
  });

  it('refuses a csv of something that is not a table', async () => {
    await expect(
      fixture().run({ operation: 'export', format: 'csv', payload: [1, 2, 3] })
    ).rejects.toThrow(/needs `payload` to be an object or an array of objects/);
  });

  it('refuses an unknown format rather than guessing one', async () => {
    await expect(
      fixture().run({
        operation: 'export',
        format: 'yaml' as 'json',
        payload: { a: 1 },
      })
    ).rejects.toThrow(/unknown format "yaml"/);
  });
});

describe('smart-summarization surface', () => {
  it('publishes exactly the operations it implements', () => {
    expect(
      SMARTSUMMARIZATIONTOOL.inputSchema.properties.operation.enum
    ).toEqual(SMART_SUMMARIZATION_OPERATIONS);
    expect(SMART_SUMMARIZATION_OPERATIONS.length).toBe(8);
  });

  it('publishes the required inputs of every operation', () => {
    const branches = SMARTSUMMARIZATIONTOOL.inputSchema.anyOf;
    expect(branches.length).toBe(SMART_SUMMARIZATION_OPERATIONS.length);
    const covered = branches.map(
      (branch) => branch.properties.operation.const as string
    );
    expect([...covered].sort()).toEqual(
      [...SMART_SUMMARIZATION_OPERATIONS].sort()
    );
    // Each branch names its operation plus the inputs that operation reads.
    for (const branch of branches) expect(branch.required[0]).toBe('operation');
  });

  it('refuses an operation it does not implement', async () => {
    await expect(
      fixture().run({
        operation: 'translate' as 'summarize',
        text: 'x',
      })
    ).rejects.toThrow(/unknown operation "translate"/);
  });

  it('serves a repeated call from the cache without recomputing', async () => {
    const tool = fixture();
    const options: SmartSummarizationOptions = {
      operation: 'summarize',
      text: ARTICLE,
      sentenceCount: 2,
    };
    const first = await tool.run(options);
    const second = await tool.run(options);
    expect(first.metadata.cacheHit).toBe(false);
    expect(second.metadata.cacheHit).toBe(true);
    expect(second.data).toEqual(first.data);
    expect(second.metadata.tokensSaved).toBeGreaterThan(0);
  });

  it('reports no confidence, because it measures none', async () => {
    // The stub returned a hard-coded 0.85 here for every call. An extractive
    // summary is not a probabilistic claim, so the field is gone rather than
    // given a new invented value.
    const result = await fixture().run({
      operation: 'summarize',
      text: ARTICLE,
    });
    expect(Object.keys(result.metadata).sort()).toEqual([
      'cacheHit',
      'processingTime',
      'tokensSaved',
      'tokensUsed',
    ]);
    expect(result.metadata.tokensUsed).toBeGreaterThan(0);
  });
});

/**
 * What the PUBLISHED schema accepts, which is what an MCP caller is actually
 * held to. The refusals inside the tool are the second layer, for a direct
 * programmatic caller; these cases are the first, and they are the only half a
 * client can discover before making the call.
 */
const SCHEMA_CASES: ReadonlyArray<readonly [string, unknown, boolean]> =
  Object.freeze([
    ['summarize with text', { operation: 'summarize', text: 'a. b.' }, true],
    ['summarize without text', { operation: 'summarize' }, false],
    ['export without payload', { operation: 'export', format: 'csv' }, false],
    ['export without format', { operation: 'export', payload: {} }, false],
    [
      'export complete',
      { operation: 'export', format: 'csv', payload: { a: 1 } },
      true,
    ],
    [
      'categorize without categories',
      { operation: 'categorize', text: 'x' },
      false,
    ],
    [
      'categorize complete',
      {
        operation: 'categorize',
        text: 'x',
        categories: [{ name: 'n', terms: ['t'] }],
      },
      true,
    ],
    [
      // exclusiveMinimum: 0 -- the boundary itself is refused.
      'schedule with a zero interval',
      { operation: 'schedule', items: [{ at: 'x' }], intervalHours: 0 },
      false,
    ],
    [
      'schedule with a fractional interval',
      { operation: 'schedule', items: [{ at: 'x' }], intervalHours: 0.5 },
      true,
    ],
    [
      'schedule with no items',
      { operation: 'schedule', items: [], intervalHours: 1 },
      false,
    ],
    ['digest without documents', { operation: 'create-digest' }, false],
    [
      'digest with a document missing its text',
      { operation: 'create-digest', documents: [{ title: 't' }] },
      false,
    ],
    [
      'compare-periods missing after',
      { operation: 'compare-periods', before: 'a' },
      false,
    ],
    ['an unknown key', { operation: 'summarize', text: 'a', nope: 1 }, false],
    ['an unpublished operation', { operation: 'translate', text: 'a' }, false],
    [
      'a zero sentenceCount',
      { operation: 'summarize', text: 'a', sentenceCount: 0 },
      false,
    ],
  ] as const);

describe('smart-summarization published schema', () => {
  it.each(SCHEMA_CASES)('%s', (_name, value, accepted) => {
    const schema = toolSchemaMap['smart-summarization'];
    expect(schema).toBeDefined();
    expect(schema.safeParse(value).success).toBe(accepted);
  });

  it('refuses more cases than it accepts, so the table is not all-pass', () => {
    const refused = SCHEMA_CASES.filter(([, , accepted]) => !accepted).length;
    expect(refused).toBeGreaterThan(SCHEMA_CASES.length / 2);
  });
});
