import { describe, it, expect, afterEach } from '@jest/globals';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { TokenCounter } from '../../../src/core/token-counter.js';
import { MetricsCollector } from '../../../src/core/metrics.js';
import { SmartDependenciesTool } from '../../../src/tools/code-analysis/smart-dependencies.js';

/**
 * A saving has to be measured from something that exists.
 *
 * smart_dependencies computed its baseline as `files.length * 2000` -- an
 * assumed 2,000 tokens per file, taken from nothing. That figure was the
 * denominator of every saving it reported, so the analytics showed it saving
 * 790,200 tokens per call at 95.97%. The same numbers would have appeared for
 * a project of EMPTY files, which is what makes it fabrication rather than
 * imprecision.
 *
 * Two things had to be true for the fix to work, and the first attempt only
 * got one of them: the files must be read, and they must be read from the
 * PROJECT. The graph is keyed by paths relative to `cwd`, so reading them
 * as-is looked under the server's own directory, measured every baseline as 0,
 * and turned every saving negative.
 *
 * These tests count the fixture's tokens independently and require the tool to
 * agree exactly.
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
        /* windows */
      }
    }
  }
});

function project(files: Record<string, string>): {
  dir: string;
  tool: SmartDependenciesTool;
  realTokens: number;
} {
  const dir = mkdtempSync(join(tmpdir(), 'dep-measured-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'src'), { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    writeFileSync(join(dir, rel), body);
  }
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'f', version: '0.0.1' })
  );

  const counter = new TokenCounter();
  const realTokens = Object.keys(files).reduce(
    (n, rel) => n + counter.count(readFileSync(join(dir, rel), 'utf8')).tokens,
    0
  );

  const cache = new CacheEngine(join(dir, 'c.db'));
  caches.push(cache);
  return {
    dir,
    realTokens,
    tool: new SmartDependenciesTool(
      cache,
      new TokenCounter(),
      new MetricsCollector()
    ),
  };
}

const TINY = {
  'src/a.ts': "import { b } from './b';\nexport const a = b;\n",
  'src/b.ts': 'export const b = 1;\n',
  'src/c.ts': 'export const c = 2;\n',
};

const BULK = Array.from(
  { length: 300 },
  (_, i) => `export const v${i} = ${i};`
).join('\n');
const LARGE = {
  'src/a.ts': `import { b } from './b';\n${BULK}\n`,
  'src/b.ts': `export const b = 1;\n${BULK}\n`,
  'src/c.ts': `${BULK}\n`,
};

describe('smart_dependencies reports a measured baseline', () => {
  it('matches an independent token count of the real files', async () => {
    const { dir, tool, realTokens } = project(LARGE);
    const r = await tool.run({ cwd: dir, mode: 'graph', useCache: false });
    expect(r.metadata.originalTokenCount).toBe(realTokens);
  });

  it('scales with content, instead of being fixed per file', async () => {
    // The signature of the old bug: identical baselines for very different
    // projects, because only the FILE COUNT was ever consulted.
    const tiny = project(TINY);
    const large = project(LARGE);

    const a = await tiny.tool.run({
      cwd: tiny.dir,
      mode: 'graph',
      useCache: false,
    });
    const b = await large.tool.run({
      cwd: large.dir,
      mode: 'graph',
      useCache: false,
    });

    expect(a.metadata.originalTokenCount).toBe(tiny.realTokens);
    expect(b.metadata.originalTokenCount).toBe(large.realTokens);
    // Same file count, wildly different content.
    expect(b.metadata.originalTokenCount).toBeGreaterThan(
      a.metadata.originalTokenCount * 10
    );
  });

  it('never reports a negative saving, even when the graph costs more', async () => {
    // Three trivial files are cheaper to read than the graph describing them,
    // so the honest saving is zero -- not the difference with a minus sign.
    const { dir, tool } = project(TINY);
    const r = await tool.run({ cwd: dir, mode: 'graph', useCache: false });
    expect(r.metadata.tokensSaved).toBeGreaterThanOrEqual(0);
  });

  it('never claims to save more than the files actually contain', async () => {
    const { dir, tool, realTokens } = project(LARGE);
    const r = await tool.run({ cwd: dir, mode: 'graph', useCache: false });
    expect(r.metadata.tokensSaved).toBeLessThanOrEqual(realTokens);
  });

  it('analyses the project it was pointed at, not the process cwd', async () => {
    // `cwd` was honoured all along, but a baseline resolved against the wrong
    // root measured zero -- so this pins both halves at once.
    const { dir, tool } = project(TINY);
    const r = await tool.run({ cwd: dir, mode: 'graph', useCache: false });
    expect(r.metadata.totalFiles).toBe(Object.keys(TINY).length);
  });
});
