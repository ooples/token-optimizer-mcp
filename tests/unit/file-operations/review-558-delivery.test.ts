import { afterEach, expect, it } from '@jest/globals';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { MetricsCollector } from '../../../src/core/metrics.js';
import { TokenCounter } from '../../../src/core/token-counter.js';
import { SmartReadTool } from '../../../src/tools/file-operations/smart-read.js';
import { SmartGlobTool } from '../../../src/tools/file-operations/smart-glob.js';
import { boundedGlob } from '../../../src/tools/shared/bounded-traversal.js';

const dirs: string[] = [];
const caches: CacheEngine[] = [];
afterEach(() => {
  for (const cache of caches.splice(0)) cache.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'review-558-'));
  dirs.push(dir);
  const cache = new CacheEngine(join(dir, 'cache.db'));
  caches.push(cache);
  const metrics = new MetricsCollector();
  return {
    dir,
    cache,
    metrics,
    reader: new SmartReadTool(cache, new TokenCounter(), metrics),
  };
}

it('represents the current directory as a usable dot path', async () => {
  const { dir } = fixture();
  const result = await boundedGlob('.', { cwd: dir, nodir: false });
  expect(result.items).toEqual(['.']);
});

it('keeps undelivered fallback changes available on repeated bounded reads', async () => {
  const { dir, reader } = fixture();
  const file = join(dir, 'data.txt');
  writeFileSync(file, 'old\n');
  await reader.read(file);
  const updated = Array.from(
    { length: 1000 },
    (_, i) => `changed line ${i}`
  ).join('\n');
  writeFileSync(file, updated);
  for (let i = 0; i < 2; i++) {
    const result = await reader.read(file, {
      maxSize: 1000,
      includeMetadata: true,
    });
    expect(result.metadata.truncated).toBe(true);
    expect(result.diff).toBeUndefined();
    expect(result.content).not.toBe('// No changes');
  }
  expect((await reader.read(file, { maxSize: 100000 })).content).toBe(updated);
  expect((await reader.read(file)).content).toBe('// No changes');
});

it('omits oversized diff details without advancing the delivered base', async () => {
  const { dir, reader } = fixture();
  const file = join(dir, 'data.txt');
  const lines = Array.from(
    { length: 1000 },
    (_, i) => `${i}: ${'a'.repeat(90)}`
  );
  writeFileSync(file, lines.join('\n'));
  await reader.read(file, { maxSize: 200000 });
  for (let i = 400; i < 500; i++) lines[i] = `${i}: ${'b'.repeat(90)}`;
  writeFileSync(file, lines.join('\n'));
  for (let i = 0; i < 2; i++) {
    const result = await reader.read(file, {
      maxSize: 5000,
      includeMetadata: true,
    });
    expect(result.metadata.truncated).toBe(true);
    expect(result.diff).toBeUndefined();
    expect(result.content).not.toBe('// No changes');
    expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(5000);
  }
});

it('hashes the returned snapshot even when a metrics listener removes the file', async () => {
  const { dir, reader, metrics } = fixture();
  const file = join(dir, 'data.txt');
  const content = 'snapshot\n';
  writeFileSync(file, content);
  metrics.once('metric', () => rmSync(file));
  const result = await reader.read(file, { includeMetadata: true });
  expect(result.content).toBe(content);
  expect(result.metadata.hash).toBe(
    createHash('sha256').update(content).digest('hex')
  );
});

it('excludes directory symlinks from file-only glob results before counting', async () => {
  const { dir, cache, metrics } = fixture();
  const tree = join(dir, 'tree');
  const target = join(dir, 'target');
  mkdirSync(tree);
  mkdirSync(target);
  writeFileSync(join(tree, 'file.txt'), 'data');
  symlinkSync(
    target,
    join(tree, 'dir-link'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  const tool = new SmartGlobTool(cache, new TokenCounter(), metrics);
  const result = await tool.glob('*', {
    cwd: tree,
    onlyFiles: true,
    ignore: [],
    limit: 10,
  });
  expect(result.files).toEqual(['file.txt']);
  expect(result.metadata.totalMatches).toBe(1);
});
