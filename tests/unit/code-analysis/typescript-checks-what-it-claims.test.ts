import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { TokenCounter } from '../../../src/core/token-counter.js';
import { MetricsCollector } from '../../../src/core/metrics.js';
import { SmartTypeScript } from '../../../src/tools/code-analysis/smart-typescript.js';

/**
 * A VERDICT HAS TO BE ABOUT THE FILES THAT WERE ASKED ABOUT.
 *
 * `Status: Success / Errors: 0 / Files Compiled: 1` was reachable without a
 * single file having been looked at. Four things conspired:
 *
 *  - every caller path was run through `join(projectRoot, file)`, which on an
 *    already-absolute argument appends one whole path to the other, drive
 *    letter included, producing a name that exists nowhere;
 *  - `program.getSourceFile` therefore missed, and `compile()` answered that
 *    with a bare `continue` -- no record that anything had been skipped;
 *  - `filesCompiled` was the REQUEST, echoed, so the count said 1 about a file
 *    the type-checker had never opened; and
 *  - the same doubled path made `generateCacheKey`'s `existsSync` fail, so no
 *    file's CONTENT entered the key and two versions of a file shared an entry.
 *
 * `success` is "no diagnostic of category Error", which is vacuously true of
 * nothing. That is not a weaker answer than the truth; a caller reads it as
 * their file being clean. The bench recorded it as an 87-88% saving.
 *
 * Each test below has its positive control alongside it, because every one of
 * these could be made to pass by a tool that refuses everything.
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
        /* windows holds handles */
      }
    }
  }
});

const CLEAN = 'export const n: number = 1;\n';
const BROKEN = "export const n: number = 'not a number';\n";

function project(files: Record<string, string> = {}): {
  dir: string;
  tool: SmartTypeScript;
  cache: CacheEngine;
} {
  const dir = mkdtempSync(join(tmpdir(), 'ts-claims-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), CLEAN);
  // Outside every include pattern, so the program cannot contain it.
  writeFileSync(join(dir, 'outside.ts'), CLEAN);
  for (const [rel, body] of Object.entries(files)) {
    writeFileSync(join(dir, rel), body);
  }
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
      include: ['src'],
    })
  );

  const cache = new CacheEngine(join(dir, 'c.db'));
  caches.push(cache);
  return {
    dir,
    cache,
    tool: new SmartTypeScript(
      cache,
      new TokenCounter(),
      new MetricsCollector(),
      dir
    ),
  };
}

function newTool(dir: string, cache: CacheEngine): SmartTypeScript {
  // A SECOND PROCESS WOULD GET A FRESH TOOL AND THE SAME CACHE. Reusing the
  // instance would let an in-memory program stand in for the cache being
  // consulted, which is the thing under test here.
  return new SmartTypeScript(
    cache,
    new TokenCounter(),
    new MetricsCollector(),
    dir
  );
}

describe('smart_typescript answers about the files it was asked about', () => {
  it('refuses when the program contains none of the named files', async () => {
    const { dir, tool } = project();
    await expect(
      tool.run({ files: [join(dir, 'outside.ts')], force: true })
    ).rejects.toThrow(/nothing to type-check and no verdict to report/);
  });

  it('names the tsconfig and the unreachable path in the refusal', async () => {
    // Both are the caller's own strings and this project's own paths, handed
    // back so the repair -- which is in the arguments -- is findable. Nothing
    // here is logged or transmitted.
    const { dir, tool } = project();
    await expect(
      tool.run({ files: [join(dir, 'outside.ts')], force: true })
    ).rejects.toThrow(/outside\.ts/);
    await expect(
      tool.run({ files: [join(dir, 'outside.ts')], force: true })
    ).rejects.toThrow(/tsconfig\.json/);
  });

  it('answers a file the program does contain', async () => {
    // THE POSITIVE CONTROL for the refusal: a tool that threw unconditionally
    // would pass every assertion above.
    const { dir, tool } = project();
    const out = await tool.run({ files: [join(dir, 'src', 'a.ts')] });
    expect(out.summary.filesCompiled).toBe(1);
    expect(out.summary.success).toBe(true);
    expect(out.summary.errorCount).toBe(0);
    expect(out.notTypeChecked).toBeUndefined();
  });

  it('reports a real type error on that same path', async () => {
    // THE POSITIVE CONTROL for `success`. Before the fix this project reported
    // `Success / 0 errors`, so a clean verdict proved nothing about the file.
    const { dir, tool } = project({ 'src/a.ts': BROKEN });
    const out = await tool.run({ files: [join(dir, 'src', 'a.ts')] });
    expect(out.summary.success).toBe(false);
    expect(out.summary.errorCount).toBe(1);
    const codes = out.diagnosticsByCategory.flatMap((c) =>
      c.items.map((i) => i.code)
    );
    expect(codes).toContain(2322);
  });

  it('resolves an absolute path instead of joining the root onto it', async () => {
    // The mechanism, stated as the report it used to corrupt: `join` on an
    // absolute argument produced a name carrying the project root twice, and
    // the dependency graph was keyed by it.
    const { dir, tool } = project();
    const out = await tool.run({ files: [join(dir, 'src', 'a.ts')] });
    const slash = (s: string) => s.split('\\').join('/');
    const graph = slash(
      JSON.stringify(out.dependencies?.dependencyGraph ?? {})
    );
    const root = slash(dir);
    expect(graph.split(root).length - 1).toBeLessThan(2);
    expect(out.dependencies?.changedFiles).toHaveLength(1);
  });

  it('gives a relative path the same answer as the absolute one', async () => {
    // THE POSITIVE CONTROL for the resolver: relative is the case `join` was
    // written for, and it must still work.
    const { dir, cache } = project();
    const abs = await newTool(dir, cache).run({
      files: [join(dir, 'src', 'a.ts')],
      force: true,
    });
    const rel = await newTool(dir, cache).run({
      files: [join('src', 'a.ts')],
      force: true,
    });
    expect(rel.summary.filesCompiled).toBe(abs.summary.filesCompiled);
    expect(rel.summary.errorCount).toBe(abs.summary.errorCount);
  });

  it('stops serving a cached verdict once the file content changes', async () => {
    // The cache key hashed the file only if `existsSync` found it, and the
    // doubled path never existed -- so content never entered the key and the
    // clean answer below would have been served for the broken file.
    const { dir, cache } = project();
    const first = await newTool(dir, cache).run({
      files: [join(dir, 'src', 'a.ts')],
    });
    expect(first.summary.errorCount).toBe(0);

    writeFileSync(join(dir, 'src', 'a.ts'), BROKEN);
    const second = await newTool(dir, cache).run({
      files: [join(dir, 'src', 'a.ts')],
    });
    expect(second.summary.fromCache).toBe(false);
    expect(second.summary.errorCount).toBe(1);
  });

  it('does serve the cache when nothing changed', async () => {
    // THE POSITIVE CONTROL for the test above: without this, a key that was
    // merely unstable -- a timestamp, say -- would satisfy it, and the
    // invalidation would not be attributable to the content at all.
    const { dir, cache } = project();
    await newTool(dir, cache).run({ files: [join(dir, 'src', 'a.ts')] });
    const again = await newTool(dir, cache).run({
      files: [join(dir, 'src', 'a.ts')],
    });
    expect(again.summary.fromCache).toBe(true);
  });

  it('names the files it did not type-check when only some were missed', async () => {
    // The counts cannot say this. `Files Compiled: 1` is true of a two-file
    // request whose second file was never opened, and nothing in the reply
    // used to distinguish that from a one-file request.
    const { dir, tool } = project();
    const out = await tool.run({
      files: [join(dir, 'src', 'a.ts'), join(dir, 'outside.ts')],
    });
    expect(out.summary.filesCompiled).toBe(1);
    expect(out.notTypeChecked).toEqual(['outside.ts']);
  });
});
