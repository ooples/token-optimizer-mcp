import { describe, it, expect } from '@jest/globals';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * `CacheEngine.set(key, value, originalSize, compressedSize)`.
 *
 * Two call sites in server/index.ts passed those last two the wrong way round.
 * Nothing errors -- both are numbers, both look plausible alone -- and only the
 * ORIENTATION is wrong, so the engine's own unit tests all passed while every
 * cached entry recorded its sizes backwards.
 *
 * Measured live before the fix: writing 5,000 highly compressible characters
 * reported `totalOriginalSize: 13, totalCompressedSize: 5000` and a
 * compressionRatio of 384.6 -- a statistic claiming the cache made data 384x
 * LARGER while it was storing it ~384x smaller.
 *
 * A behavioural test of the engine cannot catch this, because the engine was
 * never wrong. The defect lives at the call sites, so that is what this checks.
 */

const SRC = join(process.cwd(), 'src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Every `cache.set(...)` call with four arguments, as written. */
function fourArgSetCalls(): Array<{ file: string; line: number; third: string; fourth: string }> {
  const calls: Array<{ file: string; line: number; third: string; fourth: string }> = [];

  for (const file of sourceFiles(SRC)) {
    const src = readFileSync(file, 'utf8');
    const re = /(?:^|[^\w.])(?:this\.)?cache\.set\(([\s\S]{0,300}?)\);/g;
    let m: RegExpExecArray | null;

    while ((m = re.exec(src)) !== null) {
      const args = m[1]
        .split(',')
        .map((a) => a.trim().replace(/\s+/g, ' '))
        .filter(Boolean);
      if (args.length !== 4) continue;

      calls.push({
        file: file.replace(SRC, 'src').replace(/\\/g, '/'),
        line: src.slice(0, m.index).split('\n').length,
        third: args[2],
        fourth: args[3],
      });
    }
  }

  return calls;
}

const COMPRESSED = /compress/i;
const ORIGINAL = /original|\braw\b|uncompressed/i;

describe('cache.set arguments are in the declared order', () => {
  const calls = fourArgSetCalls();

  it('finds the call sites at all, so an empty pass cannot look like success', () => {
    expect(calls.length).toBeGreaterThan(0);
  });

  it('never passes a compressed size where the original belongs', () => {
    // The third parameter is originalSize.
    const wrong = calls.filter(
      (c) => COMPRESSED.test(c.third) && !ORIGINAL.test(c.third)
    );

    expect(
      wrong.map((c) => `${c.file}:${c.line} third arg is "${c.third}"`)
    ).toEqual([]);
  });

  it('never passes an original size where the compressed belongs', () => {
    // The fourth parameter is compressedSize. Passing the same value twice is
    // allowed -- that is how an uncompressed entry is honestly recorded -- so
    // this only fires when the fourth names ORIGINAL and the third does not.
    const wrong = calls.filter(
      (c) => ORIGINAL.test(c.fourth) && !COMPRESSED.test(c.fourth) && c.third !== c.fourth
    );

    expect(
      wrong.map((c) => `${c.file}:${c.line} fourth arg is "${c.fourth}"`)
    ).toEqual([]);
  });
});
