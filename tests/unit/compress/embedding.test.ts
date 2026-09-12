import { describe, it, expect } from '@jest/globals';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  candidateUnits,
  embeddingCache,
  queryIsUsable,
  semanticRanker,
  warmEmbeddings,
  type SemanticEncoder,
} from '../../../src/compress/embedding.js';
import { activeRanker } from '../../../src/compress/ranking.js';
import { compressJson } from '../../../src/compress/json.js';
import { hashingTokenizer, onnxEncoder } from '../../../src/compress/onnx.js';

/**
 * Semantic ranking behind the synchronous engine contract.
 *
 * This exists because an earlier version of `ranking.ts` claimed it could not:
 * the engines are sync, inference is async, and — the load-bearing and FALSE
 * clause — the units to embed supposedly only exist after an engine parses a
 * block. The two-phase pass below is the refutation, so these tests have to
 * prove the mechanism rather than merely exercise it.
 */

const MODEL = join(process.cwd(), 'tests', 'fixtures', 'tiny-encoder.onnx');
const DIMENSIONS = 8;

/**
 * A deterministic stand-in encoder.
 *
 * Maps a small vocabulary onto fixed axes so a test can assert an ORDERING
 * rather than that something came back. Two texts sharing a concept word land
 * on the same axis whether or not they share any token, which is the property
 * BM25 cannot have and the whole reason to want a model.
 */
function conceptEncoder(): SemanticEncoder {
  const axes: Record<string, number> = {
    // axis 0: exhaustion of a resource
    exhausted: 0,
    handles: 0,
    pool: 0,
    saturated: 0,
    // axis 1: timing
    slow: 1,
    latency: 1,
    timeout: 1,
    seconds: 1,
    // axis 2: permissions
    denied: 2,
    forbidden: 2,
    unauthorized: 2,
  };
  return {
    dimensions: DIMENSIONS,
    encode: (texts) =>
      Promise.resolve(
        texts.map((text) => {
          const vector = new Float32Array(DIMENSIONS);
          for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
            const axis = axes[word];
            if (axis !== undefined) vector[axis] += 1;
          }
          // A non-zero tail so unrelated texts are not all identical zeros.
          vector[7] = 0.01;
          return vector;
        })
      ),
  };
}

describe('warmEmbeddings', () => {
  it('embeds a batch into the cache', async () => {
    const cache = embeddingCache();
    const stored = await warmEmbeddings(
      conceptEncoder(),
      ['the pool is exhausted', 'unrelated text here'],
      cache
    );

    expect(stored).toBe(2);
    expect(cache.size).toBe(2);
    expect(cache.get('the pool is exhausted')).toBeInstanceOf(Float32Array);
  });

  it('skips what is already cached and what is too short', async () => {
    const cache = embeddingCache();
    await warmEmbeddings(conceptEncoder(), ['the pool is exhausted'], cache);
    const second = await warmEmbeddings(
      conceptEncoder(),
      ['the pool is exhausted', 'tiny'],
      cache
    );

    expect(second).toBe(0);
    expect(cache.size).toBe(1);
  });

  it('respects the per-request cap, keeping the longest units', async () => {
    const cache = embeddingCache();
    const texts = [
      'short but long enough',
      'a considerably longer unit of text here',
    ];
    await warmEmbeddings(conceptEncoder(), texts, cache, 1);

    expect(cache.size).toBe(1);
    expect(cache.has(texts[1])).toBe(true);
  });

  it('leaves the cache untouched when the encoder throws', async () => {
    // A model is far likelier to fail than a word count, and the proxy's rule
    // is that nothing it does may cost the request.
    const cache = embeddingCache();
    const broken: SemanticEncoder = {
      dimensions: DIMENSIONS,
      encode: () => Promise.reject(new Error('out of memory')),
    };
    expect(await warmEmbeddings(broken, ['the pool is exhausted'], cache)).toBe(
      0
    );
    expect(cache.size).toBe(0);
  });

  it('refuses a batch that came back the wrong length', async () => {
    // Taking the prefix would pair vectors with the WRONG text — worse than no
    // ranking, because the output looks correct.
    const cache = embeddingCache();
    const short: SemanticEncoder = {
      dimensions: DIMENSIONS,
      encode: () => Promise.resolve([new Float32Array(DIMENSIONS)]),
    };
    expect(
      await warmEmbeddings(
        short,
        ['first unit here', 'second unit here'],
        cache
      )
    ).toBe(0);
    expect(cache.size).toBe(0);
  });

  it('drops a vector of the wrong width rather than caching it', async () => {
    const cache = embeddingCache();
    const wrong: SemanticEncoder = {
      dimensions: DIMENSIONS,
      encode: (texts) => Promise.resolve(texts.map(() => new Float32Array(3))),
    };
    expect(await warmEmbeddings(wrong, ['a unit long enough'], cache)).toBe(0);
  });
});

describe('semanticRanker', () => {
  const units = [
    'the deploy pipeline uploaded the artifact',
    'connection pool exhausted on worker seven',
    'the cache was warmed from the previous build',
  ];
  const question = 'why did the database run out of handles';

  it('finds a unit that shares no token with the question', async () => {
    // THE CLAIM BM25 CANNOT MAKE. "handles" and "exhausted" never co-occur
    // here, so a lexical ranker has nothing to match on.
    const cache = embeddingCache();
    await warmEmbeddings(conceptEncoder(), [question, ...units], cache);

    expect([...semanticRanker(question, cache).top(units, 1)]).toEqual([1]);
  });

  it('falls back to lexical when the query was never embedded', async () => {
    const cache = embeddingCache();
    await warmEmbeddings(conceptEncoder(), units, cache);

    const ranker = semanticRanker('artifact pipeline deploy', cache);
    expect([...ranker.top(units, 1)]).toEqual([0]);
  });

  it('judges an unembedded unit lexically rather than discarding it', async () => {
    // Missing a vector is OUR omission, not evidence about the unit. Scoring
    // it zero would drop it as irrelevant.
    const cache = embeddingCache();
    await warmEmbeddings(conceptEncoder(), [question], cache);

    const extra = [...units, 'a line mentioning handles explicitly'];
    const top = semanticRanker(question, cache).top(extra, 2);
    expect([...top]).toContain(3);
  });

  it('returns nothing for units that are merely unrelated', async () => {
    const cache = embeddingCache();
    const unrelated = ['the cache was warmed', 'the artifact uploaded'];
    await warmEmbeddings(conceptEncoder(), [question, ...unrelated], cache);

    expect([...semanticRanker(question, cache).top(unrelated, 2)]).toEqual([]);
  });

  it('is stable across calls, which is what keeps a cached prefix identical', async () => {
    const cache = embeddingCache();
    await warmEmbeddings(conceptEncoder(), [question, ...units], cache);
    const once = [...semanticRanker(question, cache).top(units, 2)];
    const twice = [...semanticRanker(question, cache).top(units, 2)];
    expect(once).toEqual(twice);
  });
});

describe('activeRanker prefers a warmed cache', () => {
  it('uses the cache when one is supplied, and BM25 when it is not', async () => {
    const units = ['connection pool exhausted', 'the build finished cleanly'];
    const question = 'why did the database run out of handles';

    const cache = embeddingCache();
    await warmEmbeddings(conceptEncoder(), [question, ...units], cache);

    expect([...activeRanker(question, cache).top(units, 1)]).toEqual([0]);
    // Without it BM25 picks the WRONG unit -- index 1, on incidental token
    // overlap -- which is a sharper demonstration than picking nothing: the
    // lexical ranker is not merely silent here, it is confidently mistaken.
    expect([...activeRanker(question).top(units, 1)]).toEqual([1]);
  });
});

describe('candidateUnits', () => {
  it('takes lines from line-shaped content', () => {
    const units = candidateUnits(
      'first line of content\nsecond line of content\ntiny'
    );
    expect(units).toContain('first line of content');
    expect(units).not.toContain('tiny');
  });

  it('falls back to sentences for prose, which has few lines', () => {
    const prose = `${'The service loads its configuration at boot. '.repeat(4)}Backpressure applies once the queue depth exceeds the mark.`;
    const units = candidateUnits(prose);
    expect(units.length).toBeGreaterThan(1);
  });

  it('says nothing about empty input', () => {
    expect(candidateUnits('')).toEqual([]);
  });
});

describe('queryIsUsable', () => {
  it('needs more than one token to be worth embedding', () => {
    expect(queryIsUsable('why is the pool exhausted')).toBe(true);
    expect(queryIsUsable('')).toBe(false);
    expect(queryIsUsable(undefined)).toBe(false);
  });
});

describe('through the json engine, end to end', () => {
  const rows = (): string =>
    JSON.stringify(
      Array.from({ length: 60 }, (_, i) => ({
        id: `evt_${i}`,
        level: 'info',
        message:
          i === 47
            ? 'connection pool exhausted'
            : 'routine heartbeat from the scheduler',
      }))
    );

  const spill = (): string => '/spill/rows.json';
  const question = 'why did the database run out of handles';

  it('BM25 cannot reach the answer, which is what makes the next test mean anything', () => {
    const out = compressJson(rows(), { spill, query: question });
    expect(out.text).toContain('evt_0');
    expect(out.text.length).toBeLessThan(rows().length);
    expect(out.text).not.toContain('connection pool exhausted');
  });

  it('the warmed cache does', async () => {
    const cache = embeddingCache();
    const units = JSON.parse(rows()).map((row: unknown) => JSON.stringify(row));
    await warmEmbeddings(conceptEncoder(), [question, ...units], cache);

    const out = compressJson(rows(), {
      spill,
      query: question,
      embeddings: cache,
    });
    expect(out.text).toContain('connection pool exhausted');
  });
});

/**
 * The ONNX adapter, against a real model and real onnxruntime inference.
 *
 * The fixture is generated by `tests/fixtures/make-tiny-encoder.py` — a real
 * ONNX graph with real weights, two kilobytes of it, so the tensor shapes and
 * types actually crossing into native code are exercised rather than mocked.
 * Skipped rather than failed when the optional dependency is absent, because
 * `onnxruntime-node` is deliberately not a dependency of this package.
 */
describe('onnxEncoder', () => {
  // SKIPPED UNDER JEST, AND VERIFIED ELSEWHERE. `onnxruntime-node` builds its
  // output tensor in native code and checks `data instanceof Float32Array`.
  // Jest runs each suite in its own VM context with its own copy of the global
  // typed arrays, so that check fails against a realm the native module never
  // saw -- `A float32 tensor's data must be type of function Float32Array()`,
  // thrown inside onnxruntime before any of our code runs. Nothing on our side
  // can fix it and a mock would prove nothing, so these run as
  // `node scripts/verify-onnx-adapter.mjs`, which exercises the same paths
  // against real inference and exits non-zero on failure.
  //
  // Everything that does NOT cross into native code -- the two-phase pass, the
  // cache, the ranker, every fallback -- is covered above in the ordinary way.
  const maybe = it.skip;
  void existsSync;
  void MODEL;
  void join;

  maybe('runs real inference and returns one vector per input', async () => {
    const encoder = await onnxEncoder({
      modelPath: MODEL,
      dimensions: DIMENSIONS,
      tokenize: hashingTokenizer(64),
    });

    const vectors = await encoder.encode([
      'connection pool exhausted',
      'the build finished',
    ]);

    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toBeInstanceOf(Float32Array);
    expect(vectors[0]).toHaveLength(DIMENSIONS);
    // Real weights, so the two texts must not land on the same vector.
    expect(Array.from(vectors[0])).not.toEqual(Array.from(vectors[1]));
  });

  maybe('is deterministic for the same text', async () => {
    const encoder = await onnxEncoder({
      modelPath: MODEL,
      dimensions: DIMENSIONS,
      tokenize: hashingTokenizer(64),
    });
    const [a] = await encoder.encode(['connection pool exhausted']);
    const [b] = await encoder.encode(['connection pool exhausted']);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  maybe('copies each vector out of the runtime buffer', async () => {
    // The runtime owns the output buffer and may reuse it on the next run. A
    // subarray view would be silently rewritten while the cache still held it.
    const encoder = await onnxEncoder({
      modelPath: MODEL,
      dimensions: DIMENSIONS,
      tokenize: hashingTokenizer(64),
    });
    const [first] = await encoder.encode(['connection pool exhausted']);
    const before = Array.from(first);
    await encoder.encode([
      'something completely different to reuse the buffer',
    ]);
    expect(Array.from(first)).toEqual(before);
  });

  maybe('warms a cache through the ordinary two-phase path', async () => {
    const encoder = await onnxEncoder({
      modelPath: MODEL,
      dimensions: DIMENSIONS,
      tokenize: hashingTokenizer(64),
    });
    const cache = embeddingCache();
    const stored = await warmEmbeddings(
      encoder,
      ['connection pool exhausted on worker seven'],
      cache
    );
    expect(stored).toBe(1);
  });

  it('refuses to guess a tokenizer', async () => {
    // A mismatched vocabulary produces confidently wrong embeddings, which is
    // the worst failure available here: the output looks like a ranking.
    await expect(
      onnxEncoder({
        modelPath: MODEL,
        dimensions: DIMENSIONS,
        tokenize: undefined as never,
      })
    ).rejects.toThrow(/tokenize/);
  });
});
