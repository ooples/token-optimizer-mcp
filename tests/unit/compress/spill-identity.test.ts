import { describe, it, expect } from '@jest/globals';
import { spillFor } from '../../../src/compress/types.js';
import { compressBlock } from '../../../src/compress/router.js';

/**
 * One path per distinct content, for the life of one sink.
 *
 * A request that reads the same file three times used to hand the identical
 * bytes to the sink three times and get three different paths back. That is
 * three round trips where one would do, and it costs more than the two extra
 * fetches: the three elided skeletons are byte-identical except for the path
 * inside their markers, so the lossless repeat fold can no longer recognise
 * them as repeats and the hand-off carries three copies of a structure it
 * could have carried once.
 */
describe('spillFor addresses content, not calls', () => {
  it('returns one path for repeated content and calls the sink once', () => {
    const calls: string[] = [];
    let n = 0;
    const spill = (content: string): string => {
      calls.push(content);
      n += 1;
      return `spill/${n}.txt`;
    };

    const a = spillFor({ spill }, 'the same bytes', 'block.txt');
    const b = spillFor({ spill }, 'the same bytes', 'block.txt');
    const c = spillFor({ spill }, 'other bytes', 'block.txt');

    expect(a).toBe('spill/1.txt');
    expect(b).toBe('spill/1.txt');
    expect(c).toBe('spill/2.txt');
    expect(calls).toHaveLength(2);
  });

  it('keeps hints apart, because they name different things', () => {
    let n = 0;
    const spill = (_content: string, hint: string): string =>
      `spill/${(n += 1)}-${hint}`;
    expect(spillFor({ spill }, 'x', 'block.txt')).toBe('spill/1-block.txt');
    expect(spillFor({ spill }, 'x', 'body.txt')).toBe('spill/2-body.txt');
  });

  it('does not remember a sink that failed', () => {
    // The proxy reports a failed write with an empty string. Caching that
    // would turn one bad write into a permanent refusal to spill those bytes.
    let attempts = 0;
    const flaky = (): string => {
      attempts += 1;
      return attempts === 1 ? '' : 'spill/late.txt';
    };
    expect(spillFor({ spill: flaky }, 'content', 'block.txt')).toBeNull();
    expect(spillFor({ spill: flaky }, 'content', 'block.txt')).toBe(
      'spill/late.txt'
    );
  });

  it('scopes the memo to the sink, so a later request shares nothing', () => {
    const first = (): string => 'spill/first.txt';
    const second = (): string => 'spill/second.txt';
    expect(spillFor({ spill: first }, 'content', 'block.txt')).toBe(
      'spill/first.txt'
    );
    expect(spillFor({ spill: second }, 'content', 'block.txt')).toBe(
      'spill/second.txt'
    );
  });

  it('spills a file read three times in one request once', () => {
    // The shape the `repeated-reads` fixture is built from: one source file,
    // quoted three times in the same request.
    const file = Array.from(
      { length: 60 },
      (_, i) =>
        `function handler${i}(input: string): string {\n` +
        `  const trimmed = input.trim();\n` +
        `  const upper = trimmed.toUpperCase();\n` +
        `  return upper + ' ${i}';\n` +
        `}`
    ).join('\n\n');
    const text = [file, file, file].join('\n\n// ---- next read ----\n\n');

    const written: string[] = [];
    const out = compressBlock(text, {
      spill: (content) => {
        written.push(content);
        return `.token-optimizer/spill/${written.length}-block.txt`;
      },
    });

    expect(written).toHaveLength(1);
    // And the saving is not merely the two writes: every marker now points at
    // the same path, so the output holds one skeleton rather than three.
    expect(out.text.length).toBeLessThan(text.length);
  });
});

/**
 * No sink is a decision, and it is the default one.
 *
 * An elided body is a `Read` the agent has to spend a turn on, and no
 * compression ratio pays a turn back. The engines already treat an absent sink
 * as `stay lossless or leave it alone`; these pin that this is the arm a caller
 * gets by default, and that it is not merely the lossy one with the recovery
 * path filed off.
 */
describe('an absent sink keeps the content in the request', () => {
  const LF = String.fromCharCode(10);
  const file = Array.from({ length: 60 }, (_, i) =>
    [
      `function handler${i}(input: string): string {`,
      `  const trimmed = input.trim();`,
      `  const upper = trimmed.toUpperCase();`,
      `  return upper + ' ${i}';`,
      `}`,
    ].join(LF)
  ).join(LF + LF);
  const text = [file, file, file].join(
    LF + LF + '// ---- next read ----' + LF + LF
  );

  it('compresses losslessly and quotes no recovery path', () => {
    const out = compressBlock(text);
    expect(out.lossless).toBe(true);
    expect(out.text).not.toContain('.token-optimizer/spill');
    // The identifiers are still there to be read, not to be fetched.
    for (const id of ['handler0', 'handler17', 'handler59'])
      expect(out.text).toContain(id);
  });

  it('still collapses the repeated copies, which is why it is affordable', () => {
    // Two of the three copies fold away losslessly, so the duplication is
    // already gone before anything could have been elided. That is why a sink
    // buys so little on this shape, and why it is not worth a round trip.
    const out = compressBlock(text);
    expect(out.text.length).toBeLessThan(text.length / 2);
  });

  it('is larger than the spilled arm, and that is the trade being made', () => {
    const sinkless = compressBlock(text);
    const spilledOut = compressBlock(text, {
      spill: (_content, hint) => `.token-optimizer/spill/1-${hint}`,
    });
    expect(spilledOut.text.length).toBeLessThan(sinkless.text.length);
    expect(spilledOut.lossless).toBe(false);
    expect(sinkless.lossless).toBe(true);
  });
});
