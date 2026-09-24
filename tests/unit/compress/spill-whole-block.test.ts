/**
 * The substitution dial: a block the engines could barely touch, moved out.
 *
 * NOTHING HERE MAKES A BLOCK SMALLER, and the tests are written to keep that
 * visible. The block leaves the request and a path takes its place, so what is
 * asserted is that the bytes are at the path, that the marker names it, and
 * that the elision says `lossless: false` -- not that a ratio improved.
 *
 * The default is off, and the first test is the one that matters most: every
 * measurement in this repository was taken with this dial at 0, so a change
 * that made it fire by accident would silently restate all of them.
 */
import { describe, it, expect } from '@jest/globals';
import { compressBlock } from '../../../src/compress/router.js';
import { DEFAULT_TUNING, resolveTuning } from '../../../src/compress/options.js';

/** Random-ish text no engine can fold: no shape, no repeats, over the floor. */
function incompressible(): string {
  let out = '';
  let seed = 7;
  while (out.length < 20_000) {
    seed = (seed * 1103515245 + 12345) % 2147483647;
    out += `${seed.toString(36)} `;
  }
  return out;
}

describe('spillWholeBlockBelow', () => {
  it('is off in the shipped defaults', () => {
    expect(DEFAULT_TUNING.spillWholeBlockBelow).toBe(0);
  });

  it('leaves a block alone when the dial is off, even with a sink', () => {
    const text = incompressible();
    const spilled: string[] = [];
    const out = compressBlock(text, {
      spill: (content) => {
        spilled.push(content);
        return '/spill/block.txt';
      },
    });

    expect(spilled).toHaveLength(0);
    expect(out.text).not.toMatch(/^\[\.\.\. /);
  });

  it('moves a block the engines could not compress, and names where', () => {
    const text = incompressible();
    const spilled: string[] = [];
    const out = compressBlock(text, {
      tuning: resolveTuning({ spillWholeBlockBelow: 0.9 }),
      spill: (content) => {
        spilled.push(content);
        return '/spill/block.txt';
      },
    });

    // The bytes are somewhere, and it is the whole block -- a move, not a cut.
    expect(spilled).toEqual([text]);
    expect(out.text).toBe(
      `[... ${text.length.toLocaleString('en-US')} bytes, moved whole -> /spill/block.txt]`
    );
    expect(out.lossless).toBe(false);
    expect(out.elisions).toHaveLength(1);
    expect(out.elisions[0].recoverAt).toBe('/spill/block.txt');
  });

  it('keeps a block the engines did compress well', () => {
    // A run of identical log lines folds to almost nothing, so the engine beat
    // the threshold and the reader keeps the block. Gating on the SAVING rather
    // than on the size is the whole difference from a content-cache reference.
    const text = `${'2026-09-09T12:00:00Z worker ready\n'.repeat(700)}`;
    const spilled: string[] = [];
    const out = compressBlock(text, {
      tuning: resolveTuning({ spillWholeBlockBelow: 0.9 }),
      spill: (content) => {
        spilled.push(content);
        return '/spill/block.txt';
      },
    });

    expect(spilled).toHaveLength(0);
    expect(out.text.length).toBeLessThan(text.length * 0.1);
  });

  it('refuses to move anything when lossy transforms are forbidden', () => {
    const text = incompressible();
    const spilled: string[] = [];
    const out = compressBlock(text, {
      tuning: resolveTuning({ spillWholeBlockBelow: 0.9, allowLossy: false }),
      spill: (content) => {
        spilled.push(content);
        return '/spill/block.txt';
      },
    });

    expect(spilled).toHaveLength(0);
    expect(out.text).not.toMatch(/^\[\.\.\. /);
  });

  it('keeps the block when the sink has failed', () => {
    // The proxy's sink reports a failed write by returning an empty string, and
    // an empty string is not a path. Emitting the marker anyway would point the
    // reader at nowhere and call it recoverable.
    const text = incompressible();
    const out = compressBlock(text, {
      tuning: resolveTuning({ spillWholeBlockBelow: 0.9 }),
      spill: () => '',
    });

    expect(out.text).not.toMatch(/^\[\.\.\. /);
  });

  it('moves a well-compressed block too at the content-cache setting', () => {
    // 1 is the like-for-like against a content cache: no saving is good enough,
    // so the block moves whatever the engines could have done with it.
    const text = `${'2026-09-09T12:00:00Z worker ready\n'.repeat(700)}`;
    const spilled: string[] = [];
    const out = compressBlock(text, {
      tuning: resolveTuning({ spillWholeBlockBelow: 1 }),
      spill: (content) => {
        spilled.push(content);
        return '/spill/block.txt';
      },
    });

    // ONE WRITE, NOT TWO. The engine is not run at that setting, so it cannot
    // spill elisions the move would immediately supersede -- measured across the
    // head-to-head workloads at 1.00x the input on disk against 1.44x.
    expect(spilled).toEqual([text]);
    expect(out.text).toBe(
      `[... ${text.length.toLocaleString('en-US')} bytes, moved whole -> /spill/block.txt]`
    );
  });

  it('leaves a small block alone however badly it compressed', () => {
    const text = incompressible().slice(0, 3_000);
    const spilled: string[] = [];
    const out = compressBlock(text, {
      tuning: resolveTuning({ spillWholeBlockBelow: 0.9 }),
      spill: (content) => {
        spilled.push(content);
        return '/spill/block.txt';
      },
    });

    expect(spilled).toHaveLength(0);
  });
});
