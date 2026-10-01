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
 * A tool has to be measured against what it replaced and what it sent.
 *
 * Both of these tools recorded their saving by counting
 * JSON.stringify(result, null, 2) -- indent-inflated, never sent -- against a
 * private compactResult() summary built only to be counted and then discarded.
 * No caller ever received either artifact, so the recorded figure described two
 * things that do not exist, and it could not have been wrong in the tool's
 * favour by accident: the pretty baseline is always bigger and the abbreviated
 * treatment is always smaller than what was actually served.
 *
 * The cache-hit path was fabricated differently and more simply: it recorded
 * `savedTokens: cached.originalTokens`, the whole baseline, which asserts that
 * the response cost nothing at all.
 *
 * These tests count the fixture and the served response independently and
 * require the recorded metrics to agree exactly.
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
  counter: TokenCounter;
  metrics: MetricsCollector;
  cache: CacheEngine;
} {
  const dir = mkdtempSync(join(tmpdir(), 'measure-sent-'));
  dirs.push(dir);
  const filePath = join(dir, 'subject.ts');
  writeFileSync(filePath, source);
  const cache = new CacheEngine(join(dir, 'c.db'));
  caches.push(cache);
  return {
    filePath,
    dir,
    counter: new TokenCounter(),
    metrics: new MetricsCollector(),
    cache,
  };
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

describe('smart_exports records what it read and what it sent', () => {
  it('takes its baseline from the file, not from a pretty-printed result', async () => {
    const { filePath, counter, metrics, cache } = fixture(EXPORTING);
    const tool = new SmartExportsTool(cache, new TokenCounter(), metrics);

    const result = await tool.run({ filePath, checkUsage: false });
    const recorded = metrics.getOperations(undefined, 'smart_exports');
    expect(recorded).toHaveLength(1);

    expect(recorded[0].inputTokens).toBe(counter.count(EXPORTING).tokens);
    expect(recorded[0].inputTokens).not.toBe(
      counter.count(JSON.stringify(result, null, 2)).tokens
    );
  });

  it('takes its cost from the response as sent', async () => {
    const { filePath, counter, metrics, cache } = fixture(EXPORTING);
    const tool = new SmartExportsTool(cache, new TokenCounter(), metrics);

    const result = await tool.run({ filePath, checkUsage: false });
    const recorded = metrics.getOperations(undefined, 'smart_exports');

    expect(recorded[0].cachedTokens).toBe(
      counter.count(JSON.stringify(result)).tokens
    );
    expect(recorded[0].savedTokens).toBe(
      (recorded[0].inputTokens ?? 0) - (recorded[0].cachedTokens ?? 0)
    );
  });

  it('reports a loss as a loss when the report costs more than the file', async () => {
    const { filePath, metrics, cache } = fixture('export const a = 1;\n');
    const tool = new SmartExportsTool(cache, new TokenCounter(), metrics);

    await tool.run({ filePath, checkUsage: false });
    const recorded = metrics.getOperations(undefined, 'smart_exports');

    expect(recorded[0].savedTokens).toBeLessThan(0);
  });

  it('credits a cache hit with the difference, not with the whole file', async () => {
    const { filePath, metrics, cache } = fixture(EXPORTING);
    const tool = new SmartExportsTool(cache, new TokenCounter(), metrics);

    await tool.run({ filePath, checkUsage: false });
    const again = await tool.run({ filePath, checkUsage: false });
    expect(again.cached).toBe(true);

    const recorded = metrics.getOperations(undefined, 'smart_exports');
    expect(recorded).toHaveLength(2);
    expect(recorded[1].cacheHit).toBe(true);
    expect(recorded[1].savedTokens).toBe(recorded[0].savedTokens);
    expect(recorded[1].savedTokens).not.toBe(recorded[0].inputTokens);
  });
});

describe('smart_imports records what it read and what it sent', () => {
  it('takes its baseline from the file, not from a pretty-printed result', async () => {
    const { filePath, counter, metrics, cache } = fixture(IMPORTING);
    const tool = new SmartImportsTool(cache, new TokenCounter(), metrics);

    const result = await tool.run({ filePath, checkCircular: false });
    const recorded = metrics.getOperations(undefined, 'smart_imports');
    expect(recorded).toHaveLength(1);

    expect(recorded[0].inputTokens).toBe(counter.count(IMPORTING).tokens);
    expect(recorded[0].inputTokens).not.toBe(
      counter.count(JSON.stringify(result, null, 2)).tokens
    );
  });

  it('takes its cost from the response as sent', async () => {
    const { filePath, counter, metrics, cache } = fixture(IMPORTING);
    const tool = new SmartImportsTool(cache, new TokenCounter(), metrics);

    const result = await tool.run({ filePath, checkCircular: false });
    const recorded = metrics.getOperations(undefined, 'smart_imports');

    expect(recorded[0].cachedTokens).toBe(
      counter.count(JSON.stringify(result)).tokens
    );
    expect(recorded[0].savedTokens).toBe(
      (recorded[0].inputTokens ?? 0) - (recorded[0].cachedTokens ?? 0)
    );
  });

  it('credits a cache hit with the difference, not with the whole file', async () => {
    const { filePath, metrics, cache } = fixture(IMPORTING);
    const tool = new SmartImportsTool(cache, new TokenCounter(), metrics);

    await tool.run({ filePath, checkCircular: false });
    const again = await tool.run({ filePath, checkCircular: false });
    expect(again.cached).toBe(true);

    const recorded = metrics.getOperations(undefined, 'smart_imports');
    expect(recorded).toHaveLength(2);
    expect(recorded[1].cacheHit).toBe(true);
    expect(recorded[1].savedTokens).toBe(recorded[0].savedTokens);
    expect(recorded[1].savedTokens).not.toBe(recorded[0].inputTokens);
  });
});
