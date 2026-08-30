/**
 * A read that follows a write should report what changed, not resend the file.
 *
 * The two sides never shared a key. smart_write stored
 * `generateCacheKey('file-write', { path })` while smart_read looked up
 * `generateCacheKey('smart-read', { path, options })`, and generateCacheKey
 * namespaces on its first argument -- so the first smart_read after a
 * smart_write returned the whole file, exactly as it does with no cache at all.
 *
 * Two further mismatches sat behind that one, and both are covered here:
 *
 *   - the smart-read key hashes the READ OPTIONS as well as the path, so an
 *     entry seeded under different options is invisible to a plain read;
 *   - smart_write stored raw text with `cache.set` while every reader goes
 *     through `cacheGet`, which expects base64 gzip and treats a decode failure
 *     as a miss. Even a matching key would have read back nothing.
 *
 * So the fix is a shared last-written-content entry keyed on the path alone and
 * written through the same compression helper the readers use.
 *
 * Assertions here are deliberately POSITIVE -- `content` equals a specific
 * string, `isDiff` is true. An earlier draft asserted only that the full file
 * was absent, which would have passed just as well if the call had thrown and
 * returned an error object.
 */

import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { TokenCounter } from '../../../src/core/token-counter.js';
import { MetricsCollector } from '../../../src/core/metrics.js';
import { SmartReadTool } from '../../../src/tools/file-operations/smart-read.js';
import { SmartWriteTool } from '../../../src/tools/file-operations/smart-write.js';
import { SmartEditTool } from '../../../src/tools/file-operations/smart-edit.js';

let workspace: string;
let cache: CacheEngine;
let tokenCounter: TokenCounter;
let metrics: MetricsCollector;

// Deliberately under the 4000-character default chunkSize. At 200 lines this
// fixture is ~5 KB and CHUNKS, so a plain read returns chunk 0 -- which made an
// earlier control test pass for a reason that had nothing to do with the cache.
const ORIGINAL = Array.from(
  { length: 100 },
  (_, i) => `export const value${i} = ${i};`
).join('\n');

// autoFormat defaults to true and would run prettier over the content, so the
// bytes on disk would no longer be the bytes handed in and "nothing changed"
// would be false for a reason that has nothing to do with the cache.
const EXACT = { autoFormat: false } as const;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'read-after-write-'));
  cache = new CacheEngine();
  tokenCounter = new TokenCounter();
  metrics = new MetricsCollector();
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('smart_read after smart_write', () => {
  test('reports no changes instead of resending the file just written', async () => {
    const file = join(workspace, 'generated.ts');
    const writer = new SmartWriteTool(cache, tokenCounter, metrics);
    const reader = new SmartReadTool(cache, tokenCounter, metrics);

    await writer.write(file, ORIGINAL, EXACT);

    // The premise: the bytes on disk are the bytes just written, so an honest
    // reader has nothing to report.
    expect(readFileSync(file, 'utf-8')).toBe(ORIGINAL);

    const result = await reader.read(file);

    expect(result.metadata.isDiff).toBe(true);
    expect(result.content).toBe('// No changes');
    expect(result.metadata.tokensSaved).toBeGreaterThan(0);
  });

  test('returns only the changed line when the file moved on after the write', async () => {
    const file = join(workspace, 'moved.ts');
    const writer = new SmartWriteTool(cache, tokenCounter, metrics);
    const reader = new SmartReadTool(cache, tokenCounter, metrics);

    await writer.write(file, ORIGINAL, EXACT);
    writeFileSync(file, ORIGINAL.replace('value7 = 7;', 'value7 = 4242;'));

    const result = await reader.read(file);

    expect(result.metadata.isDiff).toBe(true);
    expect(result.content).toContain('4242');
    // The point of the diff is that it is not the file.
    expect(result.content.length).toBeLessThan(ORIGINAL.length / 2);
  });

  test('a first read with no prior write still returns the file', async () => {
    // Guards against over-correction: the fallback must not invent a base and
    // start answering "no changes" to reads of files nobody has written.
    const file = join(workspace, 'untouched.ts');
    writeFileSync(file, ORIGINAL);

    const reader = new SmartReadTool(cache, tokenCounter, metrics);
    const result = await reader.read(file);

    expect(result.metadata.isDiff).toBe(false);
    expect(result.content).toContain('value99 = 99;');
  });
});

describe('smart_read after smart_edit', () => {
  test('reports the edit instead of resending the file', async () => {
    // smart_edit had the same gap in a third namespace, `file-edit`, also
    // stored raw. Fixing only smart_write would have left the more common
    // writer -- editing an existing file -- still resending it on next read.
    const file = join(workspace, 'edited.ts');
    writeFileSync(file, ORIGINAL);

    const editor = new SmartEditTool(cache, tokenCounter, metrics);
    const reader = new SmartReadTool(cache, tokenCounter, metrics);

    await editor.edit(
      file,
      { type: 'replace', startLine: 8, endLine: 8, content: 'export const value7 = 4242;' },
      { createBackup: false }
    );

    const result = await reader.read(file);

    // "No changes" is the CORRECT answer here, and the valuable one: the file
    // on disk is exactly what the edit left, so the honest report is three
    // tokens rather than a hundred lines. An earlier version of this test
    // expected to see the edited line, which confused "what did I change" with
    // "what changed since I changed it".
    expect(result.metadata.isDiff).toBe(true);
    expect(result.content).toBe('// No changes');
    expect(result.metadata.tokensSaved).toBeGreaterThan(0);
  });

  test('returns a diff when the file moves on after the edit', async () => {
    // Proves the edit really seeded a usable BASE, not merely a value equal to
    // the file: a later external change has to diff against it.
    const file = join(workspace, 'edited-then-changed.ts');
    writeFileSync(file, ORIGINAL);

    const editor = new SmartEditTool(cache, tokenCounter, metrics);
    const reader = new SmartReadTool(cache, tokenCounter, metrics);

    await editor.edit(
      file,
      { type: 'replace', startLine: 8, endLine: 8, content: 'export const value7 = 4242;' },
      { createBackup: false }
    );
    writeFileSync(
      file,
      readFileSync(file, 'utf-8').replace('value9 = 9;', 'value9 = 7777;')
    );

    const result = await reader.read(file);

    expect(result.metadata.isDiff).toBe(true);
    expect(result.content).toContain('7777');
    expect(result.content.length).toBeLessThan(ORIGINAL.length / 2);
  });
});
