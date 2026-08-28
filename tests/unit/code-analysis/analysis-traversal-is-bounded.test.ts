/**
 * The whole-project tools walk the filesystem under a bound, and say when it bit.
 *
 * ISSUE #335 was reported against `smart_glob` and `smart_grep`, but those two
 * were only where it was NOTICED -- they are the tools the routing policy forces
 * callers into. Every tool that answers a question about "the project" carried
 * the identical defect: `globSync` or a recursive `readdirSync` that enumerated
 * the entire tree, blocked the event loop while doing it, and had no point at
 * which it could give up and answer.
 *
 * WHY NONE OF THESE TOOLS GETS A CAP, WHICH IS THE OPPOSITE OF `smart_glob`.
 * A cap is legitimate there because the caller passed `limit: N` -- "give me N
 * files" -- so stopping at N IS the answer. Nothing here takes a limit. Each one
 * answers a question about the whole tree, and for those a cap does not shorten
 * the answer, it falsifies it while leaving it looking complete:
 *
 *   - smart_dependencies: dropping a node also drops the `importedBy` edges of
 *     nodes that were KEPT, so a file that is imported is reported as unused.
 *   - smart_security: a file not scanned is indistinguishable from a file with
 *     no vulnerabilities. "No findings" is the most dangerous wrong answer this
 *     server can produce.
 *   - smart_exports: usage is proved by finding an importer, so a short walk
 *     turns "I did not look" into "nothing uses this, delete it".
 *   - smart_ast_grep: a missing file is a missing match.
 *   - smart_build: it is a COUNT. Any bound makes the number wrong.
 *
 * So the deadline is the only bound applied, and every tool has to REPORT it.
 * A partial answer that admits it is partial is useful; a partial answer wearing
 * a complete one's clothes is worse than a timeout, because the caller acts on
 * it.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { TokenCounter } from '../../../src/core/token-counter.js';
import { MetricsCollector } from '../../../src/core/metrics.js';
import { SmartDependenciesTool } from '../../../src/tools/code-analysis/smart-dependencies.js';
import { SmartSecurity } from '../../../src/tools/code-analysis/smart-security.js';
import { SmartAstGrepTool } from '../../../src/tools/code-analysis/smart-ast-grep.js';
import { SmartExportsTool } from '../../../src/tools/code-analysis/smart-exports.js';
import { countTypeScriptSources } from '../../../src/tools/build-systems/smart-build.js';

/**
 * Wide enough that a 1 ms deadline lands mid-walk rather than after it. The
 * bound cannot be observed on a tree small enough to finish instantly, which is
 * exactly why the unit suite never caught #335.
 */
const DIRECTORIES = 30;
const FILES_PER_DIRECTORY = 40; // 1,200 files
const SOURCE_FILES = DIRECTORIES * FILES_PER_DIRECTORY;

/**
 * The one planted file that is legitimately in scope.
 *
 * Two importers are planted outside `src` to make the skip lists observable
 * (see the fixture). `node_modules/sneaky.ts` is excluded by every tool here.
 * `.hidden/sneaky.ts` is NOT: only smart_exports skips dotted directories --
 * smart_security and smart_ast_grep exclude by name list, and neither list
 * mentions it. Counting it is correct, so the expected totals say so out loud
 * rather than quietly rounding to the tidier number.
 */
const PLANTED_IN_SCOPE = 1;

let root: string;
const caches: CacheEngine[] = [];

const newCache = (): CacheEngine => {
  const cache = new CacheEngine(
    join(root, `cache-${caches.length}.db`),
    100
  );
  caches.push(cache);
  return cache;
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'analysis-bounded-'));
  for (let d = 0; d < DIRECTORIES; d++) {
    const sub = join(root, 'src', `pkg-${String(d).padStart(3, '0')}`);
    mkdirSync(sub, { recursive: true });
    // file-000 is the only exporter; every sibling imports the SAME named
    // symbol from it. The usage scan proves a dependency by matching an
    // imported name against an exported one, so the two names have to agree.
    // With `export const value` on one side and `import { helper }` on the
    // other, every file was importable and nothing was ever found importing
    // it -- which reads exactly like a broken depth bound.
    writeFileSync(join(sub, 'file-000.ts'), 'export const helper = 1;\n');
    for (let f = 1; f < FILES_PER_DIRECTORY; f++) {
      writeFileSync(
        join(sub, `file-${String(f).padStart(3, '0')}.ts`),
        // EXTENSIONLESS ON PURPOSE. `resolveImportPath` appends candidate
        // extensions to the specifier as written, so a NodeNext-style
        // './file-000.js' is only ever tried as 'file-000.js', 'file-000.js.ts'
        // and so on -- it never reaches the '.ts' source. That is a real defect
        // in smart_exports and it is NOT what these tests are about, so the
        // fixture avoids it rather than encoding it.
        `import { helper } from './file-000';\nexport const value${f} = helper;\n`
      );
    }
  }
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'bounded-fixture', version: '0.0.1' })
  );

  // The directory every default `exclude` list names. It exists to prove that
  // excluded trees are PRUNED rather than enumerated and discarded: before this
  // change a project paid the full cost of reading the thing it excluded.
  const vendored = join(root, 'node_modules', 'left-pad', 'lib');
  mkdirSync(vendored, { recursive: true });
  for (let f = 0; f < 300; f++) {
    writeFileSync(join(vendored, `dep-${f}.js`), 'module.exports = 1;\n');
  }

  // TWO PLANTS THAT MAKE THE SKIP LIST OBSERVABLE. Counting files cannot catch
  // a lost skip, because the accept filter rejects the same paths a second
  // time -- so both of these IMPORT the target symbol. If `node_modules` or a
  // dotted directory is ever walked, the usage scan finds them and the
  // dependency count goes up by exactly two.
  const importsTarget =
    "import { helper } from '../src/pkg-000/file-000';\nexport const sneak = helper;\n";
  writeFileSync(join(root, 'node_modules', 'sneaky.ts'), importsTarget);
  mkdirSync(join(root, '.hidden'), { recursive: true });
  writeFileSync(join(root, '.hidden', 'sneaky.ts'), importsTarget);
});

afterAll(() => {
  while (caches.length) {
    try {
      caches.pop()?.close();
    } catch {
      /* a cache that will not close must not fail the suite */
    }
  }
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* windows can hold a handle briefly */
  }
});

describe('smart_ast_grep', () => {
  it('stops at the deadline, says so, and caches nothing', async () => {
    // THE CACHE IS THE DANGEROUS PART. The index key is derived from the
    // project path and language, NOT from the file set, so a partial index
    // stored under it is served in answer to every later search of this
    // project for the whole TTL -- reporting "no matches" for files that were
    // never walked, long after whatever made the walk slow is gone.
    const cache = newCache();
    const tool = new SmartAstGrepTool(
      cache,
      new TokenCounter(),
      new MetricsCollector()
    );

    const truncated = await tool.grep('const $NAME = $VALUE', {
      pattern: 'const $NAME = $VALUE',
      projectPath: root,
      language: 'ts',
      deadlineMs: 1,
    });
    expect(truncated.metadata.searchTruncated).toBe(true);
    expect(truncated.metadata.searchTruncatedBy).toBe('deadline');
    expect(truncated.metadata.searchNote).toContain('unvisited file');

    // `incrementalIndexing: false` IS WHAT MAKES THIS TEST ABLE TO FAIL, and it
    // took a surviving mutation to notice. With incremental indexing on, a
    // poisoned cache is indistinguishable from a clean one from the outside:
    // the second call finds the partial index, takes the update path, reindexes
    // everything missing from it, and arrives at exactly the same
    // `filesScanned` AND the same `reindexedFiles` as a fresh build. Both of
    // those assertions passed with the no-cache guard deleted.
    //
    // Turning incremental indexing off removes the repair step, so a stored
    // partial index is used AS-IS -- and then it can only answer for the
    // handful of files the 1 ms walk reached. A clean cache has nothing to
    // load, so it builds the index from scratch and sees the whole tree.
    const full = await tool.grep('const $NAME = $VALUE', {
      pattern: 'const $NAME = $VALUE',
      projectPath: root,
      language: 'ts',
      incrementalIndexing: false,
    });
    expect(full.metadata.searchTruncated).toBeUndefined();
    expect(full.metadata.fromCache).toBe(false);
    expect(full.metadata.filesScanned).toBe(SOURCE_FILES + PLANTED_IN_SCOPE);
  }, 300_000);
});

describe('smart_exports', () => {
  it('does not call an export unused when it simply stopped looking', async () => {
    // `unusedExports` is computed from the dependencies the scan FOUND, so a
    // truncated scan produces exactly the output that gets acted on by
    // deleting live code. It must be flagged, and it must not be cached: the
    // key is the file content plus the scan settings, so the short answer
    // would be replayed for every later call on an unchanged file.
    const cache = newCache();
    const tool = new SmartExportsTool(
      cache,
      new TokenCounter(),
      new MetricsCollector(),
      root
    );
    const target = join(root, 'src', 'pkg-000', 'file-000.ts');

    const truncated = await tool.run({
      filePath: target,
      projectRoot: root,
      checkUsage: true,
      scanDepth: 5,
      deadlineMs: 1,
    });
    expect(truncated.summary.searchTruncated).toBe(true);
    expect(truncated.summary.searchTruncatedBy).toBe('deadline');
    expect(truncated.summary.searchNote).toContain('do not delete');

    const full = await tool.run({
      filePath: target,
      projectRoot: root,
      checkUsage: true,
      scanDepth: 5,
    });
    expect(full.cached).toBe(false);
    expect(full.summary.searchTruncated).toBeUndefined();
  }, 300_000);

  it('scans exactly as deep as scanDepth said, and no deeper', async () => {
    // The old walk refused to recurse once `currentDepth` reached `depth`.
    // Depth now comes from counting path segments instead, and getting that
    // off by one would silently change which files are considered -- widening
    // the scan, or narrowing it into false "unused" reports.
    const tool = new SmartExportsTool(
      newCache(),
      new TokenCounter(),
      new MetricsCollector(),
      root
    );
    // BOTH SIDES MUST TARGET THE FILE THAT IS ACTUALLY IMPORTED. Pointing the
    // shallow half at `file-001` made its "zero dependencies" true for the
    // wrong reason -- nothing imports `value1` at any depth -- so the
    // assertion held even with the depth bound deliberately broken.
    const target = join(root, 'src', 'pkg-000', 'file-000.ts');

    // Fixture layout is root/src/pkg-NNN/file-NNN.ts. At depth 2 the walk may
    // open `src` but not `src/pkg-000`, so no importer is reachable.
    const shallow = await tool.run({
      filePath: target,
      projectRoot: root,
      checkUsage: true,
      scanDepth: 2,
      force: true,
    });
    expect(shallow.summary.dependencyCount).toBe(0);

    // At depth 3 the siblings are reachable, and only pkg-000's resolve to
    // this target -- every other package's importers point at their own
    // file-000. An exact count, so a walk that goes too wide fails too.
    const deep = await tool.run({
      filePath: target,
      projectRoot: root,
      checkUsage: true,
      scanDepth: 3,
      force: true,
    });
    expect(deep.summary.dependencyCount).toBe(FILES_PER_DIRECTORY - 1);
  }, 300_000);

  it('never walks into node_modules or a dotted directory', async () => {
    // Both plants import the target symbol, so a lost skip shows up as a
    // dependency count that is too HIGH -- which counting files could never
    // reveal, since the accept filter rejects the same paths a second time.
    const tool = new SmartExportsTool(
      newCache(),
      new TokenCounter(),
      new MetricsCollector(),
      root
    );
    const result = await tool.run({
      filePath: join(root, 'src', 'pkg-000', 'file-000.ts'),
      projectRoot: root,
      checkUsage: true,
      scanDepth: 6,
      force: true,
    });

    expect(result.summary.dependencyCount).toBe(FILES_PER_DIRECTORY - 1);
    expect(
      result.dependencies.some((d) => d.importingFile.includes('node_modules'))
    ).toBe(false);
    expect(
      result.dependencies.some((d) => d.importingFile.includes('.hidden'))
    ).toBe(false);
  }, 300_000);
});

describe('smart_build', () => {
  it('counts every source file when nothing stops the walk', async () => {
    const counted = await countTypeScriptSources(join(root, 'src'));
    expect(counted.count).toBe(SOURCE_FILES);
    expect(counted.truncatedBy).toBeUndefined();
  }, 120_000);

  it('reports a floor rather than a wrong count when the deadline fires', async () => {
    // Unlike a search, the answer here IS the total, so any bound that stops
    // early does not shorten the answer -- it replaces it. Saying which one
    // happened is what keeps the number usable.
    const counted = await countTypeScriptSources(join(root, 'src'), 1);
    expect(counted.truncatedBy).toBe('deadline');
    expect(counted.count).toBeLessThan(SOURCE_FILES);
  }, 120_000);

  it('answers zero for a directory that is not there', async () => {
    const counted = await countTypeScriptSources(join(root, 'no-such-dir'));
    expect(counted).toEqual({ count: 0 });
  });
});

describe('smart_security', () => {
  it('never returns files from a pruned directory', async () => {
    // Pruning has to be equivalent to the old post-hoc filter, not a
    // tightening of it: a child's relative path contains its parent's, so
    // everything under an excluded directory already failed the same test.
    const tool = new SmartSecurity(
      newCache(),
      new TokenCounter(),
      new MetricsCollector(),
      root
    );
    const result = await tool.run({ force: true });

    expect(result.summary.searchTruncated).toBeUndefined();
    expect(result.summary.filesScanned).toBe(SOURCE_FILES + PLANTED_IN_SCOPE);
  }, 180_000);

  it('stops at the deadline and refuses to imply the project is clean', async () => {
    // "No findings" and "I never opened the files" are the same output without
    // this flag, and a security tool that silently means the second one while
    // appearing to mean the first is worse than one that times out.
    const tool = new SmartSecurity(
      newCache(),
      new TokenCounter(),
      new MetricsCollector(),
      root
    );
    const started = Date.now();
    const result = await tool.run({ force: true, deadlineMs: 1 });

    expect(Date.now() - started).toBeLessThan(15_000);
    expect(result.summary.searchTruncated).toBe(true);
    expect(result.summary.searchTruncatedBy).toBe('deadline');
    expect(result.summary.searchNote).toContain('does NOT mean');
  }, 180_000);
});

describe('smart_dependencies', () => {
  it('completes an unbounded walk without claiming truncation', async () => {
    const tool = new SmartDependenciesTool(
      newCache(),
      new TokenCounter(),
      new MetricsCollector()
    );
    const result = await tool.analyze({ cwd: root, useCache: false });

    expect(result.success).toBe(true);
    expect(result.metadata.searchTruncated).toBeUndefined();
    // No `+ PLANTED_IN_SCOPE`: glob does not match dotted paths unless asked,
    // so the planted `.hidden` importer is out of scope for this tool.
    expect(result.metadata.totalFiles).toBe(SOURCE_FILES);
  }, 120_000);

  it('stops at the deadline and reports the graph as partial', async () => {
    const tool = new SmartDependenciesTool(
      newCache(),
      new TokenCounter(),
      new MetricsCollector()
    );
    const started = Date.now();
    const result = await tool.analyze({
      cwd: root,
      useCache: false,
      deadlineMs: 1,
    });

    expect(result.success).toBe(true);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(result.metadata.searchTruncated).toBe(true);
    expect(result.metadata.searchTruncatedBy).toBe('deadline');
    expect(result.metadata.searchNote).toContain('only part of the tree');
  }, 120_000);

  it('never caches a partial graph', async () => {
    // THE REGRESSION THIS EXISTS FOR. Caching a truncated graph outlives the
    // call that knew it was truncated: every later request hits the cache,
    // reports `cacheHit: true` with no truncation flag, and answers "unused"
    // for files whose importers were never walked. The bad answer would then
    // persist for the TTL, long after the slow tree was gone.
    const cache = newCache();
    const tool = new SmartDependenciesTool(
      cache,
      new TokenCounter(),
      new MetricsCollector()
    );

    const truncated = await tool.analyze({
      cwd: root,
      useCache: true,
      deadlineMs: 1,
    });
    expect(truncated.metadata.searchTruncated).toBe(true);

    const second = await tool.analyze({ cwd: root, useCache: true });
    expect(second.metadata.cacheHit).toBe(false);
    expect(second.metadata.totalFiles).toBe(SOURCE_FILES);
  }, 120_000);

  it('carries the truncation flag into a mode that rebuilds its own metadata', async () => {
    // `circular`, `unused` and `impact` each construct metadata from the
    // finished graph, so the flag is dropped on three of the four paths unless
    // it is re-applied after the mode switch. A `circular` result that loses it
    // reads as "no cycles" rather than "no cycles in the part I reached".
    const tool = new SmartDependenciesTool(
      newCache(),
      new TokenCounter(),
      new MetricsCollector()
    );
    const result = await tool.analyze({
      cwd: root,
      useCache: false,
      mode: 'circular',
      deadlineMs: 1,
    });

    expect(result.mode).toBe('circular');
    expect(result.metadata.searchTruncated).toBe(true);
    expect(result.metadata.searchTruncatedBy).toBe('deadline');
  }, 120_000);
});
