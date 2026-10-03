/**
 * smart_refactor answered once per OCCURRENCE and then repeated itself.
 *
 * On a 4937-token fixture it produced 100 suggestions holding 26 distinct
 * messages -- "Single-letter variable 'n' is not descriptive." sent 50 times,
 * identical in every field but the line -- and each carried its own copy of
 * the advice and the worked example for its type. The response cost 7304
 * tokens to report on a 4937-token file, while claiming a saving, because the
 * figure it published compared two artifacts it never sent.
 *
 * These tests pin the three things that fixed: one entry per finding with all
 * its places, type-level advice sent once, and a metrics block that is the
 * response measured against the file.
 */

import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { TokenCounter } from '../../../src/core/token-counter.js';
import { MetricsCollector } from '../../../src/core/metrics.js';
import {
  getSmartRefactorTool,
  type SmartRefactorResult,
  type RefactorSuggestionRow,
} from '../../../src/tools/code-analysis/smart-refactor.js';
import { decodeTable } from '../../../src/tools/shared/table.js';

function analyse(source: string): Promise<SmartRefactorResult> {
  const dir = mkdtempSync(join(tmpdir(), 'refactor-once-'));
  const file = join(dir, 'subject.ts');
  writeFileSync(file, source);
  const tool = getSmartRefactorTool(
    new CacheEngine(mkdtempSync(join(tmpdir(), 'refactor-cache-')), 100),
    new TokenCounter(),
    new MetricsCollector(),
    dir
  );
  return tool.run({ filePath: file });
}

function rows(result: SmartRefactorResult): RefactorSuggestionRow[] {
  return decodeTable<RefactorSuggestionRow>(result.suggestions);
}

describe('smart_refactor answers once per finding', () => {
  it('folds identical findings onto one entry carrying every place', async () => {
    // The same single-letter name in four functions: one finding, every place.
    const result = await analyse(
      [
        'export function first() { const n = 1; return n; }',
        'export function second() { const n = 2; return n; }',
        'export function third() { const n = 3; return n; }',
        'export function fourth() { const n = 4; return n; }',
      ].join('\n')
    );

    const naming = rows(result).filter((row) => row.type === 'improve-naming');

    expect(naming).toHaveLength(1);
    expect(naming[0].message).toContain("'n'");
    expect(new Set(naming[0].locations.map(([line]) => line))).toEqual(
      new Set([1, 2, 3, 4])
    );
    // No count is lost by folding: the occurrences are still totalled.
    expect(result.summary.totalSuggestions).toBe(rows(result).length);
    expect(result.summary.totalOccurrences).toBeGreaterThanOrEqual(4);
  });

  it('keeps findings that differ in any field apart', async () => {
    const result = await analyse(
      [
        'export function first() { const n = 1; return n; }',
        'export function second() { const q = 2; return q; }',
      ].join('\n')
    );

    const naming = rows(result).filter((row) => row.type === 'improve-naming');

    expect(naming).toHaveLength(2);
    expect(new Set(naming.map((row) => row.message)).size).toBe(2);
  });

  it('sends each type advice once and omits the repeats', async () => {
    const result = await analyse(
      [
        'export function first() { const n = 1; return n; }',
        'export function second() { const q = 2; return q; }',
      ].join('\n')
    );

    const naming = rows(result).filter((row) => row.type === 'improve-naming');

    expect(result.guidance['improve-naming']?.suggestion).toBeTruthy();
    // Both findings share the same advice, so neither carries a copy of it.
    expect(naming.every((row) => row.suggestion === undefined)).toBe(true);
  });

  it('keeps a finding whose advice differs from its type entry', async () => {
    // extract-constant names the value in its advice, so two values give two
    // different strings and only the first can be the shared entry.
    // Both literals are longer than the five characters the check needs and
    // each appears the three times it takes to be reported.
    const result = await analyse(
      [
        "export const first = 'alphabet';",
        "export const second = 'alphabet';",
        "export const third = 'alphabet';",
        "export const fourth = 'betamaxine';",
        "export const fifth = 'betamaxine';",
        "export const sixth = 'betamaxine';",
      ].join('\n')
    );

    const constants = rows(result).filter(
      (row) => row.type === 'extract-constant'
    );

    expect(constants).toHaveLength(2);
    // Every occurrence, at the line it is on -- this reported [[1, 0]] for
    // all of them regardless of where the literal actually appeared.
    expect(constants[0].locations).toEqual([
      [1, 21],
      [2, 22],
      [3, 21],
    ]);
    expect(constants[1].locations.map(([line]) => line)).toEqual([4, 5, 6]);
    const shared = result.guidance['extract-constant'];
    expect(shared).toBeDefined();
    const carried = constants.filter((row) => row.suggestion !== undefined);
    // Exactly the ones that do not match the shared entry keep their own.
    expect(carried.every((row) => row.suggestion !== shared?.suggestion)).toBe(
      true
    );
    expect(
      constants.filter((row) => row.suggestion === undefined).length
    ).toBeGreaterThanOrEqual(1);
  });

  it('reports one boolean expression once, not once per nesting level', async () => {
    const result = await analyse(
      'export function f(a: boolean, b: boolean, c: boolean, d: boolean, e: boolean) {\n' +
        '  if (a && b || c && d || e && a || b && c) {\n' +
        '    return 1;\n' +
        '  }\n' +
        '  return 0;\n' +
        '}\n'
    );

    const conditionals = rows(result).filter(
      (row) => row.type === 'simplify-conditional'
    );

    // One expression, one finding -- previously the visitor walked into it and
    // reported its sub-expressions at the same line with a lower count.
    expect(conditionals).toHaveLength(1);
    const places = conditionals.flatMap((row) => row.locations);
    expect(new Set(places.map((place) => place.join(':'))).size).toBe(
      places.length
    );
  });

  it('states no saving of its own, under any name', async () => {
    /*
     * THIS TEST REQUIRED THE OPPOSITE AND WAS ASKING THE SAME QUESTION. It
     * pinned a metrics block whose "after" was this reply serialised compactly
     * with the metrics block itself removed -- a careful count of an artifact
     * nobody is sent. What a caller pays for is built from this object after
     * the tool returns, so no figure counted in here can be it.
     *
     * The before is the file the caller named in the arguments, which the
     * recorder reads for itself, and the after is counted once at the wire. So
     * the tool has nothing to declare and nothing to print, and the reply is
     * checked against every spelling of a saving this fleet has used rather
     * than against the one field that was deleted.
     */
    const source = [
      'export function first() { const n = 1; return n; }',
      'export function second() { const q = 2; return q; }',
    ].join('\n');
    const result = await analyse(source);

    const SAVINGS_KEYS = [
      'metrics',
      'originalTokens',
      'compactedTokens',
      'reductionPercentage',
      'tokensSaved',
      'savedTokens',
      'originalTokenCount',
      'compressionRatio',
    ];
    const found: string[] = [];
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        if (SAVINGS_KEYS.includes(key)) found.push(key);
        walk(value);
      }
    };
    walk(result);
    expect(found).toEqual([]);
    // THE POSITIVE CONTROL, twice over: the reply really is the analysis under
    // test, and the walk really does descend into a reply of this shape.
    expect(Object.keys(result.guidance).length).toBeGreaterThan(0);
    walk({ guidance: { a: { metrics: {} } } });
    expect(found).toEqual(['metrics']);
  });
});
