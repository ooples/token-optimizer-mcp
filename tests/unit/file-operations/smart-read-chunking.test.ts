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

  it('honours chunkIndex -- the escape hatch it tells the caller to use', async () => {
    const { tool, file } = makeFixture();
    const first = await tool.read(file, { chunkIndex: 0 });
    const second = await tool.read(file, { chunkIndex: 1, enableCache: false });

    expect(first.metadata.chunkIndex).toBe(0);
    expect(second.metadata.chunkIndex).toBe(1);
    expect(second.content).not.toBe(first.content);
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
