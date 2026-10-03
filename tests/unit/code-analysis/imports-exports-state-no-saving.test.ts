import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { TokenCounter } from '../../../src/core/token-counter.js';
import { MetricsCollector } from '../../../src/core/metrics.js';
import { SmartExportsTool } from '../../../src/tools/code-analysis/smart-exports.js';
import { SmartImportsTool } from '../../../src/tools/code-analysis/smart-imports.js';

/**
 * NEITHER OF THESE TOOLS IS IN A POSITION TO MEASURE ITS OWN SAVING.
 *
 * This file used to require the opposite, and the reason it was written is
 * still the reason it now requires the reverse. Both tools recorded a saving by
 * counting JSON.stringify(result, null, 2) -- indent-inflated, never sent --
 * against a private compactResult() summary built only to be counted and then
 * discarded. No caller received either artifact. That was replaced by two
 * honest-looking counts, the file on one side and the result serialised
 * compactly on the other, and the second one is still not what anybody pays
 * for: the text a caller is charged for is assembled from this object AFTER
 * the tool returns, out of the object plus a report and its metadata.
 *
 * A figure a tool cannot see is a figure a tool must not state. So the after is
 * counted once, at the wire, by the party that holds the bytes, and the before
 * -- the file named in the caller's own arguments -- is read by the recorder.
 * Nothing is left for these two to say, and what is asserted here is that they
 * say nothing: no token field on the metrics record, and no savings figure
 * anywhere in the reply, which is also a reply the caller is not billed for.
 *
 * The properties this file used to hold -- a baseline taken from the file, a
 * cost taken from the response as sent, a loss reported as a loss -- did not
 * go away. They moved to where both halves exist: the transport measurement in
 * tests/unit/analytics, which counts the real serialised reply.
 */

const dirs: string[] = [];
const caches: CacheEngine[] = [];

afterEach(() => {
  while (caches.length) {
    try {
      caches.pop()?.close();
    } catch {
      /* already closed */
    }
  }
  while (dirs.length) {
    const d = dirs.pop();
    if (d) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* windows holds the handle */
      }
    }
  }
});

function fixture(source: string): {
  filePath: string;
  dir: string;
  metrics: MetricsCollector;
  cache: CacheEngine;
} {
  const dir = mkdtempSync(join(tmpdir(), 'measure-sent-'));
  dirs.push(dir);
  const filePath = join(dir, 'subject.ts');
  writeFileSync(filePath, source);
  const cache = new CacheEngine(join(dir, 'c.db'));
  caches.push(cache);
  return { filePath, dir, metrics: new MetricsCollector(), cache };
}

/**
 * Every spelling of a saving this fleet has used.
 *
 * A reply is checked against all of them rather than against the one field a
 * given tool happened to delete, because the failure mode being prevented is a
 * figure coming back under a different name.
 */
const SAVINGS_KEYS = [
  'originalTokens',
  'originalTokenCount',
  'compactedTokens',
  'optimizedTokens',
  'reductionPercentage',
  'tokensSaved',
  'savedTokens',
  'tokensBefore',
  'tokensAfter',
  'baselineTokens',
  'tokensUsed',
  'savingsPercent',
  'compressionRatio',
] as const;

/** Every savings key anywhere in a reply tree, in the order they are found. */
function savingsKeysIn(node: unknown, found: string[] = []): string[] {
  if (!node || typeof node !== 'object') return found;
  for (const [key, value] of Object.entries(node)) {
    if ((SAVINGS_KEYS as readonly string[]).includes(key)) found.push(key);
    savingsKeysIn(value, found);
  }
  return found;
}

/** The token fields a record must not carry, since no tool measured them. */
function tokenFieldsOn(record: Record<string, unknown>): string[] {
  return ['inputTokens', 'savedTokens', 'cachedTokens', 'outputTokens'].filter(
    (field) => record[field] !== undefined
  );
}

const EXPORTING = [
  'export interface Shape {',
  '  width: number;',
  '  height: number;',
  '}',
  'export class Box implements Shape {',
  '  width = 0;',
  '  height = 0;',
  '}',
  'export function area(shape: Shape): number {',
  '  return shape.width * shape.height;',
  '}',
  'export const unit = new Box();',
].join('\n');

const IMPORTING = [
  "import { readFileSync, writeFileSync } from 'fs';",
  "import { join } from 'path';",
  "import { tmpdir } from 'os';",
  'export function copy(from: string, to: string): void {',
  '  writeFileSync(join(tmpdir(), to), readFileSync(from));',
  '}',
].join('\n');

describe('the savings-key walk', () => {
  it('finds a figure however deeply it is buried', () => {
    /*
     * THE POSITIVE CONTROL FOR EVERY ASSERTION BELOW. Each test claims a reply
     * holds no savings key, which a traversal that reached nothing would also
     * claim. This one proves the traversal descends, and descends past arrays.
     */
    expect(
      savingsKeysIn({ a: { b: [{ tokensSaved: 1 }] }, c: { savedTokens: 2 } })
    ).toEqual(['tokensSaved', 'savedTokens']);
    expect(savingsKeysIn({ a: { b: 1 } })).toEqual([]);
  });
});

describe('smart_exports states no saving', () => {
  it('records the call it made and no token figure', async () => {
    const { filePath, metrics, cache } = fixture(EXPORTING);
    const tool = new SmartExportsTool(cache, new TokenCounter(), metrics);

    await tool.run({ filePath, checkUsage: false });
    const recorded = metrics.getOperations(undefined, 'smart_exports');

    expect(recorded).toHaveLength(1);
    // What the tool genuinely observed is still recorded ...
    expect(recorded[0].success).toBe(true);
    expect(recorded[0].cacheHit).toBe(false);
    expect(typeof recorded[0].duration).toBe('number');
    // ... and the four halves of a saving it could not measure are not.
    expect(tokenFieldsOn(recorded[0] as unknown as Record<string, unknown>)) //
      .toEqual([]);
  });

  it('answers without a savings figure anywhere in the reply', async () => {
    const { filePath, metrics, cache } = fixture(EXPORTING);
    const tool = new SmartExportsTool(cache, new TokenCounter(), metrics);

    const result = await tool.run({ filePath, checkUsage: false });
    expect(savingsKeysIn(result)).toEqual([]);
    // The reply is the shape under test and not an empty object.
    expect(result.exports.length).toBeGreaterThan(0);
  });

  it('says nothing on a cache hit either', async () => {
    /*
     * THE PATH THAT WAS WRONG IN THE MOST MISLEADING WAY. It recorded
     * `savedTokens: cached.originalTokens` -- the whole baseline -- which
     * asserts the response cost nothing. A hit saves the analysis, not the
     * tokens: the same report is still sent.
     */
    const { filePath, metrics, cache } = fixture(EXPORTING);
    const tool = new SmartExportsTool(cache, new TokenCounter(), metrics);

    await tool.run({ filePath, checkUsage: false });
    const again = await tool.run({ filePath, checkUsage: false });
    expect(again.cached).toBe(true);

    const recorded = metrics.getOperations(undefined, 'smart_exports');
    expect(recorded).toHaveLength(2);
    expect(recorded[1].cacheHit).toBe(true);
    expect(tokenFieldsOn(recorded[1] as unknown as Record<string, unknown>)) //
      .toEqual([]);
    expect(savingsKeysIn(again)).toEqual([]);
  });
});

describe('smart_imports states no saving', () => {
  it('records the call it made and no token figure', async () => {
    const { filePath, metrics, cache } = fixture(IMPORTING);
    const tool = new SmartImportsTool(cache, new TokenCounter(), metrics);

    await tool.run({ filePath, checkCircular: false });
    const recorded = metrics.getOperations(undefined, 'smart_imports');

    expect(recorded).toHaveLength(1);
    expect(recorded[0].success).toBe(true);
    expect(recorded[0].cacheHit).toBe(false);
    expect(typeof recorded[0].duration).toBe('number');
    expect(tokenFieldsOn(recorded[0] as unknown as Record<string, unknown>)) //
      .toEqual([]);
  });

  it('answers without a savings figure anywhere in the reply', async () => {
    const { filePath, metrics, cache } = fixture(IMPORTING);
    const tool = new SmartImportsTool(cache, new TokenCounter(), metrics);

    const result = await tool.run({ filePath, checkCircular: false });
    expect(savingsKeysIn(result)).toEqual([]);
    expect(result.imports.length).toBeGreaterThan(0);
  });

  it('says nothing on a cache hit either', async () => {
    const { filePath, metrics, cache } = fixture(IMPORTING);
    const tool = new SmartImportsTool(cache, new TokenCounter(), metrics);

    await tool.run({ filePath, checkCircular: false });
    const again = await tool.run({ filePath, checkCircular: false });
    expect(again.cached).toBe(true);

    const recorded = metrics.getOperations(undefined, 'smart_imports');
    expect(recorded).toHaveLength(2);
    expect(recorded[1].cacheHit).toBe(true);
    expect(tokenFieldsOn(recorded[1] as unknown as Record<string, unknown>)) //
      .toEqual([]);
    expect(savingsKeysIn(again)).toEqual([]);
  });
});
