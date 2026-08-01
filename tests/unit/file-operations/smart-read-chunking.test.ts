import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SmartReadTool } from '../../../src/tools/file-operations/smart-read.js';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { TokenCounter } from '../../../src/core/token-counter.js';
import { MetricsCollector } from '../../../src/core/metrics.js';

/**
 * What a chunked smart_read actually COSTS, measured from the response rather
 * than trusted from its own metadata.
 *
 * Found by pointing the real tool at a real 17 KB README: it reported
 * `tokensSaved: 4326, compressionRatio: 0.24` while attaching the complete
 * `chunks` array to the response. Every chunk reached the caller, plus a
 * duplicate of chunk 0 in `content` -- so the call cost MORE than reading the
 * file and claimed 76% saved. These tests weigh the whole response, because
 * asking the tool how much it saved is exactly what failed to catch it.
 */
describe('SmartReadTool chunking', () => {
  const tempDirs: string[] = [];
  const caches: CacheEngine[] = [];

  afterEach(() => {
    while (caches.length) {
      try {
        caches.pop()?.close();
      } catch {
        // already closed
      }
    }
    while (tempDirs.length) {
      const dir = tempDirs.pop();
      if (dir) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // temp dir may linger on Windows
        }
      }
    }
  });

  function makeFixture(): { tool: SmartReadTool; file: string; body: string } {
    const dir = mkdtempSync(join(tmpdir(), 'token-optimizer-chunk-'));
    tempDirs.push(dir);
    const cache = new CacheEngine(join(dir, 'cache.db'));
    caches.push(cache);

    // Comfortably over the 4 KB default chunk size, under the 100 KB maxSize,
    // so the chunking branch is the one that runs.
    const body = Array.from(
      { length: 900 },
      (_, i) => `export const value${i} = ${i}; // line ${i}`
    ).join('\n');
    const file = join(dir, 'big.ts');
    writeFileSync(file, body);

    return { tool: new SmartReadTool(cache, new TokenCounter(), new MetricsCollector()), file, body };
  }

  it('returns ONE chunk, not every chunk', async () => {
    const { tool, file, body } = makeFixture();
    const result = await tool.read(file);

    expect(result.metadata.chunked).toBe(true);
    expect(result.metadata.chunkCount).toBeGreaterThan(1);

    // The whole response, weighed. This is the assertion that would have failed
    // before: serialised, it exceeded the file it was supposed to save on.
    const wholeResponse = JSON.stringify(result);
    expect(wholeResponse.length).toBeLessThan(body.length);
  });

  it('reports a saving it actually delivered', async () => {
    const { tool, file } = makeFixture();
    const result = await tool.read(file);

    const { originalTokenCount, tokenCount, tokensSaved } = result.metadata;
    expect(tokenCount).toBeLessThan(originalTokenCount);
    expect(tokensSaved).toBe(originalTokenCount - tokenCount);
    // And the content really is only what was counted.
    expect(new TokenCounter().count(result.content).tokens).toBe(tokenCount);
  });

  it('never reports a NEGATIVE saving', async () => {
    // A single chunk plus its navigation footer can cost more than the whole
    // file when the file is barely over chunkSize, and the subtraction then
    // produced a negative -- which nothing downstream clamped, precisely
    // because it was non-zero. "-14 tokens saved" is a cost wearing a minus
    // sign; the honest number for a call that saved nothing is zero.
    const { tool, file } = makeFixture();
    for (const chunkSize of [200, 400, 800]) {
      const r = await tool.read(file, { chunkSize, enableCache: false });
      expect(r.metadata.tokensSaved).toBeGreaterThanOrEqual(0);
    }
  });

  it('honours chunkIndex -- the escape hatch it tells the caller to use', async () => {
    // DEFAULT CACHING, because that is what a caller has.
    //
    // This passed `enableCache: false` on the second read, which is the one
    // setting that made it pass. With caching on -- the default -- the second
    // call met the diff-mode branch, found the file unchanged since the first
    // call, and returned `// No changes` instead of chunk 2. So the documented
    // way to page through a file worked exactly once per file, and the test
    // written to prove it worked was quietly opting out of the failure.
    const { tool, file } = makeFixture();
    const first = await tool.read(file, { chunkIndex: 0 });
    const second = await tool.read(file, { chunkIndex: 1 });

    expect(first.metadata.chunkIndex).toBe(0);
    expect(second.metadata.chunkIndex).toBe(1);
    expect(second.content).not.toBe(first.content);
    expect(second.content).not.toContain('No changes');
  });

  it('still collapses to a diff on a plain re-read, when no chunk was asked for', async () => {
    // The other half of the same gate: omitting chunkIndex must keep the
    // diff-mode saving. Fixing chunk navigation by disabling diff mode
    // outright would trade one regression for another.
    const { tool, file } = makeFixture();
    await tool.read(file);
    const again = await tool.read(file);
    expect(again.metadata.fromCache).toBe(true);
  });

  it('falls back to the first chunk when the index is out of range or absent', async () => {
    const { tool, file } = makeFixture();
    for (const bad of [undefined, -1, 9999, Number.NaN]) {
      const r = await tool.read(file, { chunkIndex: bad as number, enableCache: false });
      expect(r.metadata.chunkIndex).toBe(0);
    }
  });

  it('tells the caller how to reach the rest', async () => {
    const { tool, file } = makeFixture();
    const result = await tool.read(file);
    // A pointer with no usable parameter behind it is what made the original
    // message a dead end.
    expect(result.content).toMatch(/chunkIndex=/);
    expect(result.content).toMatch(/chunk 1 of \d+/);
  });
});

/**
 * A "compact unified diff" that contains the whole file is a copy of the file.
 *
 * Found by using smart_edit for real work: changing 13 lines of a 750-line file
 * returned 6,836 tokens and reported tokensSaved: 0. The context parameter was
 * named `_contextLines` and ignored, so every unchanged line was emitted --
 * making the tool cost MORE than the built-in edit on exactly the large files
 * it exists for.
 */
describe('smart_edit returns a diff, not the file', () => {
  const dirs2: string[] = [];
  const caches2: CacheEngine[] = [];

  afterEach(() => {
    while (caches2.length) {
      try { caches2.pop()?.close(); } catch { /* already closed */ }
    }
    while (dirs2.length) {
      const d = dirs2.pop();
      if (d) { try { rmSync(d, { recursive: true, force: true }); } catch { /* windows */ } }
    }
  });

  it('elides long unchanged runs instead of echoing them', async () => {
    const { mkdtempSync } = await import('fs');
    const dir = mkdtempSync(join(tmpdir(), 'token-optimizer-diff-'));
    dirs2.push(dir);
    const cache = new CacheEngine(join(dir, 'c.db'));
    caches2.push(cache);
    const counter = new TokenCounter();
    const tool = new (await import('../../../src/tools/file-operations/smart-edit.js')).SmartEditTool(
      cache, counter, new MetricsCollector()
    );

    const body = Array.from({ length: 750 }, (_, i) => `const value${i} = ${i};`).join('\n');
    const file = join(dir, 'big.js');
    writeFileSync(file, body);

    const result = await tool.edit(file, {
      type: 'replace', startLine: 84, endLine: 94, content: 'const replaced = true;',
    });

    const paid = counter.count(JSON.stringify(result)).tokens;
    const whole = counter.count(body).tokens;

    // The response must be a small fraction of the file it edited.
    expect(paid).toBeLessThan(whole * 0.25);
    expect(result.diff?.unifiedDiff.split('\n').length).toBeLessThan(60);
    expect(result.diff?.unifiedDiff).toMatch(/unchanged lines/);

    // ...and the saving reported must be one that was actually delivered.
    expect(result.metadata.tokensSaved).toBeGreaterThan(0);
  });
});
