import { describe, it, expect } from '@jest/globals';
import {
  queryFrom,
  ranker,
  tokenize,
} from '../../../src/compress/relevance.js';
import { compressJson } from '../../../src/compress/json.js';
import { compressProse } from '../../../src/compress/prose.js';
import { compressCode } from '../../../src/compress/code.js';

/**
 * Relevance-ranked retention.
 *
 * THE MEASUREMENT PROBLEM THESE TESTS EXIST TO SOLVE. Relevance decides WHICH
 * units survive at a fixed budget, so it is invisible to a size benchmark --
 * the reduction percentage is identical with it on and off, by design. The only
 * way to know it works is to plant something the structural rules would drop
 * and the question asks for, and check that it is still there.
 *
 * The planted rows below are deliberately shape-identical to their neighbours,
 * so anomaly preservation cannot rescue them. If relevance is not working, they
 * are gone.
 */

describe('tokenize', () => {
  it('splits a compound identifier into its parts as well as the whole', () => {
    // A query typed as "skip lib check" must find `skipLibCheck`.
    const tokens = tokenize('skipLibCheck');
    expect(tokens).toContain('skiplibcheck');
    expect(tokens).toContain('skip');
    expect(tokens).toContain('lib');
    expect(tokens).toContain('check');
  });

  it('splits a letter-digit run, so "TS 2345" finds TS2345', () => {
    const tokens = tokenize('TS2345');
    expect(tokens).toContain('ts');
    expect(tokens).toContain('2345');
  });
});

describe('ranker', () => {
  const units = [
    'the deploy pipeline uploaded the artifact',
    'worker-07 handled request 4471 and returned 200',
    'the cache was warmed from the previous build',
    'worker-03 handled request 9182 and returned 200',
  ];

  it('is inactive without a usable question', () => {
    // "No information" and "everything is relevant" must not be the same
    // answer: an inactive ranker keeps the structural rules in charge.
    expect(ranker('').active).toBe(false);
    expect(ranker(undefined).active).toBe(false);
    expect(ranker('a of to').active).toBe(false);
  });

  it('ranks the unit that answers the question first', () => {
    const top = ranker('which worker handled request 4471').top(units, 1);
    expect([...top]).toEqual([1]);
  });

  it('never returns a unit that scores zero, even with budget to spare', () => {
    // Keeping an irrelevant line because the budget allowed it is how a
    // relevance filter becomes noise.
    const top = ranker('4471').top(units, 4);
    expect([...top]).toEqual([1]);
  });

  it('ignores a term that appears in almost every unit', () => {
    // "handled" is in half of these and "returned" carries no signal about
    // WHICH row; a term present nearly everywhere cannot discriminate.
    const everywhere = [
      'x handled a',
      'x handled b',
      'x handled c',
      'x handled d',
    ];
    expect([...ranker('handled').top(everywhere, 2)]).toEqual([]);
  });

  it('is deterministic, so a benchmark number means something', () => {
    const once = [...ranker('worker request 4471').top(units, 2)];
    const twice = [...ranker('worker request 4471').top(units, 2)];
    expect(once).toEqual(twice);
  });

  it('breaks ties on position, not on hash order', () => {
    const same = ['alpha beta', 'gamma delta', 'alpha beta'];
    expect([...ranker('alpha beta').top(same, 1)]).toEqual([0]);
  });
});

describe('queryFrom', () => {
  it('reads the instruction and ignores the payload', () => {
    // THE FOOTGUN THIS PREVENTS. The last message in an agentic conversation
    // is usually a tool result -- the very content being compressed. Taking it
    // as the question would make every block maximally relevant to itself,
    // which would look like it was working.
    const payload = 'row '.repeat(3000);
    const query = queryFrom([
      { text: payload },
      { text: 'find the retry helper' },
    ]);

    expect(query).toContain('find the retry helper');
    expect(query).not.toContain(payload);
    expect(query.length).toBeLessThan(500);
  });

  it('reads back several short turns, most recent last', () => {
    const query = queryFrom([
      { text: 'first instruction' },
      { text: 'second instruction' },
    ]);
    expect(query.indexOf('first')).toBeLessThan(query.indexOf('second'));
  });
});

describe('relevance through the engines', () => {
  /**
   * Rows that are all the same shape, with one that answers a question.
   *
   * Shape-identical on purpose: `anomalousRows` cannot rescue this one, so
   * survival is attributable to relevance and nothing else.
   */
  const rows = (): string =>
    JSON.stringify(
      Array.from({ length: 60 }, (_, i) => ({
        id: `doc_${i}`,
        score: 0.5,
        title:
          i === 47
            ? 'connection pool exhausted in the retry helper'
            : 'A reasonably long result title for bulk',
        metadata: { author: 'Someone', category: 'technical' },
      }))
    );

  const spill = (): string => '/spill/rows.json';

  it('keeps a shape-identical row that answers the question', () => {
    const out = compressJson(rows(), {
      spill,
      query: 'why is the connection pool exhausted',
    });
    expect(out.text).toContain('connection pool exhausted');
  });

  it('drops that same row when nothing asked about it', () => {
    // The other half of the claim. Without this, the test above would pass
    // just as well if the engine had stopped eliding anything at all.
    const out = compressJson(rows(), { spill });
    expect(out.text).not.toContain('connection pool exhausted');
    expect(out.text.length).toBeLessThan(rows().length);
  });

  it('does not enlarge the output beyond its bounded allowance', () => {
    // Relevance reorders at a fixed budget; the escape hatch in `json` is
    // capped at three extra rows and this pins that it stays capped.
    const withQuery = compressJson(rows(), {
      spill,
      query: 'connection pool exhausted retry helper doc_12 doc_31 doc_44',
    });
    const without = compressJson(rows(), { spill });
    expect(withQuery.text.length).toBeLessThan(without.text.length * 2);
  });

  const passage = [
    'The service starts by loading its configuration from disk.',
    'It is worth noting that this is generally considered good practice.',
    'The connection pool is sized from the worker count at boot.',
    'As we mentioned, callers should handle the error.',
    'In other words, the system might possibly retry more often than needed.',
    'Needless to say, this is documented elsewhere.',
    'Of course, that is only one approach among several.',
    'Please note that the defaults are usually fine for most users.',
    'Backpressure is applied once the queue depth exceeds the high water mark.',
    'The scheduler wakes every second to drain whatever has accumulated.',
  ].join(' ');

  it('keeps the sentence the question is about', () => {
    const out = compressProse(passage, {
      spill: () => '/spill/prose.txt',
      query: 'how is the queue depth high water mark handled',
    });
    expect(out.text).toContain('high water mark');
  });

  it('still keeps the same fraction, so relevance cannot buy outcomes with size', () => {
    const withQuery = compressProse(passage, {
      spill: () => '/spill/prose.txt',
      query: 'how is the queue depth high water mark handled',
    });
    const without = compressProse(passage, { spill: () => '/spill/prose.txt' });
    const sentences = (t: string) => t.split(/(?<=[.!?])\s+/).length;
    expect(sentences(withQuery.text)).toBe(sentences(without.text));
  });
});

describe('liveness in the code engine', () => {
  /**
   * Liveness is relevance in the shape a coding agent actually needs.
   *
   * A signature-preserving compressor elides the body of the ONE function the
   * agent just named, because a signature is all it keeps. These pin that the
   * named body survives, that its neighbours still do not, and that a question
   * broad enough to name everything is ignored rather than silently switching
   * compression off.
   */
  const source = Array.from(
    { length: 10 },
    (
      _,
      i
    ) => `export function ${['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa'][i]}Handler(input: string): string {
  const trimmed = input.trim();
  const upper = trimmed.toUpperCase();
  const parts = upper.split(',');
  return parts.join('|');
}`
  ).join('\n\n');

  const compress = (query?: string) =>
    compressCode(source, { sourcePath: 'src/handlers.ts', query });

  it('keeps the body of the function the agent just named', () => {
    const out = compress('why does gammaHandler drop the separator');
    expect(out.text).toContain("const parts = upper.split(',');");
  });

  it('still elides the bodies nobody asked about', () => {
    const out = compress('why does gammaHandler drop the separator');
    // Nine of ten bodies are gone, so this is compression with an exception,
    // not compression switched off.
    expect(out.elisions.length).toBe(9);
  });

  it('matches a name written with spaces against one written without', () => {
    const out = compress('what does the gamma handler do');
    expect(out.elisions.length).toBe(9);
  });

  it('elides every body when nothing was named', () => {
    expect(compress().elisions.length).toBe(10);
  });

  it('ignores a question broad enough to name every body', () => {
    // A signal that fires everywhere is not a signal. Without this guard a
    // broad question is a compression switch, and no reader could see why.
    const out = compress(
      'alphaHandler betaHandler gammaHandler deltaHandler epsilonHandler zetaHandler etaHandler thetaHandler iotaHandler kappaHandler'
    );
    expect(out.elisions.length).toBe(10);
  });

  it('is not fooled by language keywords', () => {
    // "function", "export", "return" name a construct, not a thing here.
    const out = compress('which exported function should return early');
    expect(out.elisions.length).toBe(10);
  });
});
