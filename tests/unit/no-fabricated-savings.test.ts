import { describe, it, expect } from '@jest/globals';
import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import { measured, unmeasured } from '../../src/tools/shared/savings.js';

/**
 * No tool may invent what it saved.
 *
 * A static guard, because this was not one bug in one place: 38 sites across
 * roughly fifteen tools derived a baseline by multiplying their own result by a
 * constant and reported the difference as tokens saved. smart_user used eight
 * different multipliers between 5x and 25x. Nothing was measured, and the
 * numbers reached the metrics collector and the optimization report.
 *
 * A unit test per tool would not have caught it -- each tool was internally
 * consistent. What catches it is asking, of the whole source tree, whether any
 * baseline is a multiple of the thing it is supposed to be compared against.
 */
const ROOT = join(process.cwd(), 'src');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
      out.push(full);
  }
  return out;
}

/** `originalTokens = resultTokens * 20` and every spelling of it. */
const FABRICATED_BASELINE =
  /(original\w*Tokens?|baseline\w*Tokens?)\s*=\s*[\w.]+\s*\*\s*\d/;

/** `tokensSaved = something * 1000` -- a saving conjured from a count. */
const FABRICATED_SAVING =
  /(tokensSaved|savedTokens)\s*=\s*[\w.()]+\s*\*\s*[\d.]/;

describe('savings are measured, never assumed', () => {
  const files = sourceFiles(ROOT);

  it('has a source tree to scan', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('no tool derives its baseline by multiplying its own result', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (FABRICATED_BASELINE.test(line) || FABRICATED_SAVING.test(line)) {
          offenders.push(
            `${relative(ROOT, file).split('\\').join('/')}:${i + 1}  ${line.trim()}`
          );
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});

describe('the one sanctioned way to report a saving', () => {
  it('reports the difference between two measurements', () => {
    const s = measured(1000, 250);
    expect(s.tokensSaved).toBe(750);
    expect(s.compressionRatio).toBeCloseTo(0.25);
  });

  it('never reports a negative saving', () => {
    // A baseline smaller than the response means there was nothing to save.
    const s = measured(100, 400);
    expect(s.tokensSaved).toBe(0);
    expect(s.originalTokenCount).toBe(400);
  });

  it('claims nothing when nothing was measured', () => {
    const s = unmeasured(320);
    expect(s.tokensSaved).toBe(0);
    expect(s.compressionRatio).toBe(1);
    expect(s.originalTokenCount).toBe(s.tokenCount);
  });

  it('does not divide by a zero baseline', () => {
    expect(measured(0, 0).compressionRatio).toBe(1);
    expect(Number.isFinite(measured(0, 0).compressionRatio)).toBe(true);
  });
});
