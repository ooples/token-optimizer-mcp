import { describe, it, expect } from '@jest/globals';
import { dedupBlocks, MIN_DEDUP_BYTES } from '../../../src/compress/dedup.js';
import type { DedupBlock } from '../../../src/compress/dedup.js';
import { v1Frontier, v3History } from '../../../src/compress/strategy.js';
import type { ProviderRequest } from '../../../src/compress/frontier.js';

/**
 * Cross-block dedup: the same bytes, sent twice, charged twice.
 *
 * The referent is inside the request, which is the whole argument. A reference
 * that points at bytes in the payload being sent cannot miss the way a hash
 * pointing at an external cache entry can, so these elisions are lossless with
 * no path to recover from -- and the tests below hold that claim to its word:
 * the content a reference names must actually still be there.
 */

const big = (seed: string, bytes = MIN_DEDUP_BYTES * 2): string =>
  `${seed}\n${seed.repeat(Math.ceil(bytes / seed.length))}`;

const block = (
  text: string,
  touchable = true,
  original = text
): DedupBlock => ({ text, original, touchable });

describe('dedupBlocks', () => {
  it('keeps the first copy whole and references it from the second', () => {
    const payload = big('the same tool output');
    const out = dedupBlocks([block(payload), block(payload)]);

    expect(out.texts[0]).toBe(payload);
    expect(out.texts[1]).not.toBe(payload);
    expect(out.texts[1].length).toBeLessThan(200);
    expect(out.elisions).toHaveLength(1);
  });

  it('names something the reader can actually find above', () => {
    // A hash is meaningful only to whoever holds the table. The reference has
    // to quote the referent, or a model cannot follow it.
    const payload = big('export class CacheEngine {');
    const out = dedupBlocks([block(payload), block(payload)]);

    const quoted = out.texts[1].match(/"([^"]+)"/)?.[1] ?? '';
    expect(quoted.length).toBeGreaterThan(8);
    expect(out.texts[0]).toContain(quoted.replace(/\.\.\.$/, ''));
  });

  it('reports the reference as lossless with nothing to look up', () => {
    // The referent is in the same request: there is no cache entry to miss,
    // which is exactly what HeadRoom's #2509 is about.
    const payload = big('a repeated grep result');
    const out = dedupBlocks([block(payload), block(payload)]);

    expect(out.elisions[0].lossless).toBe(true);
    expect(out.elisions[0].recoverAt).toBeNull();
    expect(out.elisions[0].removed).toContain('repeated verbatim');
  });

  it('references an untouchable block, because it is the strongest referent', () => {
    // A cached-prefix block arrives byte-identical no matter what, so a repeat
    // of it after the frontier can be dropped whole and never compressed.
    const payload = big('src/core/cache-engine.ts contents');
    const out = dedupBlocks([block(payload, false), block(payload, true)]);

    expect(out.texts[0]).toBe(payload);
    expect(out.texts[1].length).toBeLessThan(200);
  });

  it('never rewrites an untouchable repeat', () => {
    // Two identical blocks both behind the frontier: rewriting the second
    // would break the cache it is sitting in.
    const payload = big('cached twice');
    const out = dedupBlocks([block(payload, false), block(payload, false)]);
    expect(out.texts).toEqual([payload, payload]);
    expect(out.elisions).toHaveLength(0);
  });

  it('dedups two blocks that compressed to the same text', () => {
    const original = big('before compression');
    const compressed = big('after compression', MIN_DEDUP_BYTES + 10);
    const out = dedupBlocks([
      block(compressed, true, original),
      block(compressed, true, `${original} but different`),
    ]);

    expect(out.texts[1].length).toBeLessThan(200);
    expect(out.elisions[0].removed).toContain('compress to output already above');
  });

  it('leaves near-duplicates alone, because the difference is the point', () => {
    // A file read before and after an edit is NOT the same file. Collapsing
    // "almost the same" would hide the edit -- a silent wrong answer, which is
    // worse than the tokens it saves.
    const before = big('const timeout = 30;');
    const after = `${before}\nconst retries = 3;`;
    const out = dedupBlocks([block(before), block(after)]);

    expect(out.texts).toEqual([before, after]);
    expect(out.elisions).toHaveLength(0);
  });

  it('leaves a small repeat alone, because the reference costs more', () => {
    const small = 'ok';
    const out = dedupBlocks([block(small), block(small)]);
    expect(out.texts).toEqual([small, small]);
  });

  it('returns one text per input block, in order', () => {
    const a = big('alpha');
    const b = big('beta');
    const out = dedupBlocks([block(a), block(b), block(a), block(b), block(a)]);

    expect(out.texts).toHaveLength(5);
    expect(out.texts[0]).toBe(a);
    expect(out.texts[1]).toBe(b);
    expect(out.elisions).toHaveLength(3);
  });
});

describe('dedup through the strategies', () => {
  /** Compressible source: real bodies under real signatures. */
  const file = Array.from(
    { length: 12 },
    (_, i) => `export function step${i}(input: string): string {
  const trimmed = input.trim();
  const upper = trimmed.toUpperCase();
  const parts = upper.split(',');
  const kept = parts.filter((p) => p.length > ${i});
  return kept.join('|');
}`
  ).join('\n\n');

  /** A session that reads the same file before and after the frontier. */
  const session = (): ProviderRequest => ({
    system: 'You are a coding agent.',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: file, cache_control: { type: 'ephemeral' } },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: file }] },
    ],
  });

  const textsOf = (r: ProviderRequest): string[] =>
    (r.messages ?? []).flatMap((m) =>
      Array.isArray(m.content)
        ? m.content.map((b) => (typeof b.text === 'string' ? b.text : ''))
        : []
    );

  it('v1 leaves the cached copy whole and references it from the fresh one', () => {
    const out = v1Frontier(session(), {});
    const [cached, fresh] = textsOf(out.request);

    expect(cached).toBe(file);
    expect(fresh.length).toBeLessThan(300);
    // The reference has to be followable: what it quotes is in the request.
    const quoted = fresh.match(/"([^"]+)"/)?.[1]?.replace(/\.\.\.$/, '') ?? '';
    expect(cached).toContain(quoted);
  });

  it('v3 dedups behind the frontier too, once both copies compress alike', () => {
    // This is what content-addressed spilling buys. With a random spill path
    // per call the two copies differ by that path alone and neither collapses.
    const paths = new Map<string, string>();
    const spill = (content: string, hint: string): string => {
      if (!paths.has(content))
        paths.set(content, `/spill/${paths.size + 1}-${hint}`);
      return paths.get(content) as string;
    };

    const out = v3History(session(), { spill });
    const [first, second] = textsOf(out.request);

    expect(first.length).toBeLessThan(file.length);
    expect(second.length).toBeLessThan(300);
  });

  it('still refuses to touch a signed message, repeat or not', () => {
    // #3456. A repeat inside a signed message is still untouchable: the
    // signature covers the message as the provider received it.
    const req: ProviderRequest = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: file }] },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', signature: 'sig-abc' },
            { type: 'text', text: file },
          ],
        },
      ],
    };
    const out = v3History(req, {});
    const signedMessage = out.request.messages?.[1].content;
    expect(Array.isArray(signedMessage) ? signedMessage[1].text : '').toBe(file);
  });
});
