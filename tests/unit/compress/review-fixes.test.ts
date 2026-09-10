import { describe, it, expect } from '@jest/globals';
import { compressLog } from '../../../src/compress/log.js';
import { compressProse } from '../../../src/compress/prose.js';
import { compressSearchResults } from '../../../src/compress/search.js';
import { compressCode } from '../../../src/compress/code.js';
import { parse } from '@babel/parser';

/**
 * Defects found in review of the compression PR, each pinned by the case that
 * exposes it.
 *
 * Grouped here rather than scattered because they share a shape worth naming: a
 * transform that was CORRECT ABOUT WHAT IT REMOVED and wrong about what it
 * claimed. Three of the five reported `lossless: true` over content that could
 * not be reconstructed, one restored a context line as a match, and one elided
 * lines it never mentioned. None of them would have shown up in a size
 * benchmark -- every one of them made the number better.
 */

describe('log folding keeps the timestamps it removes', () => {
  const clocked = (n: number, text: string): string =>
    Array.from(
      { length: n },
      (_, i) => `12:00:${String(i).padStart(2, '0')} ${text}`
    ).join('\n');

  it('names every stamp it folded away', () => {
    // `foldKey` strips the clock so a line repeating once a second still folds
    // -- the whole reason this engine beats a naive one on the most repetitive
    // logs there are. The stamps were then simply gone, and the result still
    // said `lossless: true`. On a log, WHEN is often the question.
    const out = compressLog(clocked(9, 'connection pool warmed'));

    expect(out.text).toContain('12:00:01');
    expect(out.text).toContain('12:00:08');
    expect(out.elisions.some((e) => e.lossless)).toBe(true);
  });

  it('still folds, so honesty did not cost the compression', () => {
    const input = clocked(40, 'connection pool warmed and ready to serve');
    const out = compressLog(input);
    expect(out.text.length).toBeLessThan(input.length / 2);
  });

  it('spills instead of folding blind when listing costs more than it saves', () => {
    // A run of very short lines under long ISO stamps: listing them is more
    // expensive than the lines. The fold still happens, but it says it is lossy
    // and names where the original went.
    const terse = Array.from(
      { length: 30 },
      (_, i) => `2026-09-09T12:00:${String(i).padStart(2, '0')}.000Z ok`
    ).join('\n');
    const out = compressLog(terse, { spill: () => '/spill/log.txt' });

    expect(out.text).toContain('/spill/log.txt');
    expect(out.elisions.some((e) => !e.lossless && e.recoverAt)).toBe(true);
  });

  it('leaves the run whole when it can neither list nor spill', () => {
    // The honest last resort: no annotation it can afford, nowhere to put the
    // original, so nothing is removed.
    const terse = Array.from(
      { length: 30 },
      (_, i) => `2026-09-09T12:00:${String(i).padStart(2, '0')}.000Z ok`
    ).join('\n');
    const out = compressLog(terse);

    for (let i = 0; i < 30; i += 1) {
      expect(out.text).toContain(`12:00:${String(i).padStart(2, '0')}`);
    }
  });

  it('does not fold scattered duplicates it cannot place', () => {
    // A scattered fold removes lines from all over the file, so their
    // interleaving is lost too. With no timestamp there is no way to say where
    // a removed copy had been, and a marker that cannot be redeemed is the
    // thing this design exists to avoid.
    const unstamped = [
      'starting worker',
      'INFO cache warm',
      'starting worker',
      'INFO cache warm',
      'starting worker',
      'INFO queue drained',
      'starting worker',
      'INFO cache warm',
      'starting worker',
      'INFO queue drained',
    ].join('\n');
    const out = compressLog(unstamped);
    expect(out.text.split('starting worker').length - 1).toBe(5);
  });
});

describe('search restores a short hunk exactly', () => {
  /** Six hits so the block is claimed, with one isolated context line. */
  const grep = [
    'src/a.ts:1: const a = 1;',
    'src/a.ts:2: const b = 2;',
    'src/a.ts:3: const c = 3;',
    'src/a.ts:4: const d = 4;',
    'src/a.ts:5: const e = 5;',
    'src/a.ts:6: const f = 6;',
    'src/lonely.ts:11-  return 1;',
  ].join('\n');

  it('keeps a context line a context line', () => {
    // `-` means ripgrep matched a NEIGHBOUR, not this line. Restoring it as `:`
    // states that a line matched when it did not, which is the one distinction
    // this engine promises to preserve.
    const out = compressSearchResults(grep);
    expect(out.text).toContain('src/lonely.ts:11-  return 1;');
  });

  it('does not double the leading space', () => {
    // Group 4 of HIT begins immediately after the separator, so the line's own
    // indentation is already there. The restored line is pinned exactly rather
    // than only asserting the doubled form is absent -- a negative alone would
    // pass just as well if the line vanished or the call threw.
    const out = compressSearchResults(grep);
    const restored = out.text
      .split('\n')
      .find((line) => line.startsWith('src/lonely.ts:'));
    expect(restored).toBe('src/lonely.ts:11-  return 1;');
  });
});

describe('prose keeps its paragraphs', () => {
  const paragraphs = [
    'The service loads its configuration from disk at boot. It is worth noting that this is generally considered good practice.',
    'The connection pool is sized from the worker count. As we mentioned, callers should handle the error.',
    'Backpressure applies once the queue depth exceeds the high water mark. Needless to say, this is documented elsewhere.',
  ].join('\n\n');

  it('does not flatten a multi-paragraph document into one block', () => {
    // Joining survivors with a single space turned a design note into a wall of
    // text -- a structural change nobody asked for, on top of the sentence
    // elision that was the actual job.
    const out = compressProse(paragraphs, { spill: () => '/spill/prose.txt' });
    expect(out.text).toContain('\n\n');
  });

  it('still removes sentences, so structure did not cost the compression', () => {
    const out = compressProse(paragraphs, { spill: () => '/spill/prose.txt' });
    expect(out.text.length).toBeLessThan(paragraphs.length);
    expect(out.elisions).toHaveLength(1);
  });
});

describe('code spans stop at the last real line', () => {
  it('does not elide trailing blank lines or name them in the range', () => {
    // A blank line must not CLOSE a block -- a function with a blank line in
    // the middle is ordinary -- but letting it EXTEND one put the blanks after
    // a function inside the span, so the recovery range pointed at lines the
    // marker never claimed to have removed.
    const source = [
      'def handler(request):',
      '    trimmed = request.strip()',
      '    upper = trimmed.upper()',
      '    parts = upper.split(",")',
      '    return "|".join(parts)',
      '',
      '',
      'def other(x):',
      '    return x',
    ].join('\n');

    const out = compressCode(source, {
      sourcePath: 'src/h.py',
      language: 'python',
    });
    const range = out.elisions[0]?.recoverAt ?? '';
    // The body is lines 2-5; the blanks at 6 and 7 are not part of it.
    expect(range).toBe('src/h.py:2-5');
  });
});

describe('a concise arrow body is not a brace-delimited body', () => {
  // The same parser the engine uses, so "valid" here means what the engine means.
  const parses = (source: string): boolean => {
    try {
      parse(source, { sourceType: 'module', plugins: ['typescript'] });
      return true;
    } catch {
      return false;
    }
  };

  it('leaves a multiline concise arrow as valid source', () => {
    // BABEL STORES A CONCISE BODY AS AN EXPRESSION, not a BlockStatement -- there are
    // no braces around it. Eliding "the lines between the first and the last" then cuts
    // the middle out of an expression and splices a marker into it, and what reaches
    // the model is not compressed source but broken source.
    const source = [
      'export const pick = (rows: Row[]) =>',
      '  rows',
      '    .filter((row) => row.enabled)',
      '    .filter((row) => row.score > 0)',
      '    .filter((row) => row.owner !== null)',
      '    .filter((row) => row.kind === "leaf")',
      '    .filter((row) => row.parent !== undefined)',
      '    .map((row) => row.id)',
      '    .sort((a, b) => a - b);',
      '',
    ].join('\n');

    expect(parses(source)).toBe(true);

    const out = compressCode(source, { sourcePath: 'src/pick.ts' });

    expect(parses(out.text)).toBe(true);
  });

  it('still elides an ordinary block body', () => {
    // The control. A fix that simply stopped eliding functions would pass the test
    // above and destroy the engine.
    const body = Array.from(
      { length: 40 },
      (_, i) => `  const value${i} = compute(${i}) * factor + offset;`
    );
    const source = [
      'export function work(): number {',
      ...body,
      '  return 0;',
      '}',
      '',
    ].join('\n');

    const out = compressCode(source, { sourcePath: 'src/work.ts' });

    expect(out.elisions.length).toBeGreaterThan(0);
    expect(out.text.length).toBeLessThan(source.length);
  });
});
