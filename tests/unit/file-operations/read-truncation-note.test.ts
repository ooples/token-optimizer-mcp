import { afterEach, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { MetricsCollector } from '../../../src/core/metrics.js';
import { TokenCounter } from '../../../src/core/token-counter.js';
import { SmartReadTool } from '../../../src/tools/file-operations/smart-read.js';
import { SmartWriteTool } from '../../../src/tools/file-operations/smart-write.js';

/**
 * A cut read says what it holds and the cheap way on (#565 log-needle-zh). The
 * note must describe the cut actually made: a minified file keeps only its
 * start, so "start and end" there would send the caller looking for an end
 * that is not in the response.
 */
const dirs: string[] = [];
const caches: CacheEngine[] = [];
afterEach(() => {
  for (const cache of caches.splice(0)) cache.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function reader() {
  const dir = mkdtempSync(join(tmpdir(), 'read-note-'));
  dirs.push(dir);
  const cache = new CacheEngine(join(dir, 'cache.db'));
  caches.push(cache);
  const counter = new TokenCounter();
  const metrics = new MetricsCollector();
  return {
    dir,
    tool: new SmartReadTool(cache, counter, metrics),
    writer: new SmartWriteTool(cache, counter, metrics),
  };
}

it('names the line count and the head-and-tail cut of a large text file', async () => {
  const { dir, tool } = reader();
  const file = join(dir, 'build.log');
  const lines = Array.from(
    { length: 5000 },
    (_, i) => `line ${i} of a routine build log with some ordinary text`
  );
  writeFileSync(file, lines.join('\n') + '\n');
  const { metadata } = await tool.read(file, { maxSize: 20_000 });
  expect(metadata.truncated).toBe(true);
  expect(metadata.totalLines).toBe(5000);
  expect(metadata.note).toContain('the start and end of 5,000 lines');
  expect(metadata.note).toContain('chunkIndex');
});

it('says only the start is kept when a minified file is cut', async () => {
  const { dir, tool } = reader();
  const file = join(dir, 'bundle.min.js');
  writeFileSync(file, 'var a=1;'.repeat(20_000));
  const { metadata } = await tool.read(file, { maxSize: 20_000 });
  expect(metadata.truncated).toBe(true);
  expect(metadata.totalLines).toBe(1);
  expect(metadata.note).toContain('the start of 1 line.');
  expect(metadata.note).not.toContain('end');
});

it('describes a cut diff as the changes, not the file', async () => {
  const { dir, tool, writer } = reader();
  const file = join(dir, 'module.py');
  const original = Array.from(
    { length: 1000 },
    (_, i) => `value_${i} = compute(${i})  # an ordinary line of source`
  );
  // The write is the read base, as in read-diffs-against-the-write.
  await writer.write(file, original.join('\n') + '\n', { autoFormat: false });
  // 100 changed lines in one block: a diff well under half the file, and
  // well over maxSize.
  const changed = original.map((line, i) =>
    i >= 100 && i < 200
      ? `value_${i} = recompute(${i}, scale=2)  # changed`
      : line
  );
  writeFileSync(file, changed.join('\n') + '\n');
  const { metadata } = await tool.read(file, { maxSize: 4_000 });
  expect(metadata.isDiff).toBe(true);
  expect(metadata.truncated).toBe(true);
  expect(metadata.note).toContain('changes since your last read, not the file');
  expect(metadata.note).toContain('now 1,000 lines');
});
