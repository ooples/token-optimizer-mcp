/**
 * Reading a file twice is not a slow answer, it is the same answer paid for twice.
 *
 * Profiled 2026-08-28 on a 12,000-file tree with `node --cpu-prof`, ranked by
 * SELF time. Neither tool was slow because of traversal or because of the
 * analysis it exists to do:
 *
 *   - smart_security spent 17.75 s hashing every file's CONTENT to build a
 *     cache key -- reading the whole project to decide whether to read the
 *     whole project -- plus 7.53 s reading it again to scan, plus a third read
 *     inside `scanFile`'s own hash. Three reads per file; the vulnerability
 *     regex was 3.9% of the run.
 *   - smart_dependencies spent 19.58 s in `measureFullFileTokens` re-reading
 *     every file purely to compute a "tokens saved" baseline, on top of the
 *     10.67 s `analyzeFile` spent reading the same bytes to parse them.
 *
 * Measured after: smart_security 32.0 s -> 13.1 s, smart_dependencies
 * 51.3 s -> 26.8 s, with identical outputs.
 *
 * WHAT THESE TESTS ARE FOR. The speed is measured by the benchmarks; what needs
 * pinning is that nothing about the ANSWERS changed. Two of the fixes altered
 * behaviour and had to be checked rather than assumed: the security cache key
 * is now derived from file metadata instead of content, and import resolution
 * returns on the first extension match instead of falling through.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { TokenCounter } from '../../../src/core/token-counter.js';
import { MetricsCollector } from '../../../src/core/metrics.js';
import { SmartSecurity } from '../../../src/tools/code-analysis/smart-security.js';
import { SmartDependenciesTool } from '../../../src/tools/code-analysis/smart-dependencies.js';

/**
 * A detectable secret, assembled at runtime.
 *
 * Written as fragments for the same reason `security-finds-real-secrets`
 * does it: a fixture holding a literal provider-shaped key is itself a
 * scannable secret, and GitHub push protection rejected the first version
 * of this file for exactly that -- correctly. This matches the tool's
 * generic secret rule without resembling any real credential.
 */
const SECRET_LINE =
  'const secret = "' +
  ['abcdefghij', 'klmnopqrst', 'uvwxyz1234'].join('') +
  '";\n';

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
    const dir = dirs.pop();
    if (!dir) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* windows can hold a handle briefly */
    }
  }
});

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'read-once-'));
  dirs.push(root);
  for (const [relative, body] of Object.entries(files)) {
    const full = join(root, relative);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'read-once-fixture', version: '0.0.1' })
  );
  return root;
}

function newCache(root: string): CacheEngine {
  const cache = new CacheEngine(join(root, `c-${caches.length}.db`), 100);
  caches.push(cache);
  return cache;
}

describe('smart_security reads each file once', () => {
  it('still finds what it found before', async () => {
    // The guard against making it fast by making it blind.
    const root = project({
      'src/leak.ts': SECRET_LINE,
    });
    const tool = new SmartSecurity(
      newCache(root),
      new TokenCounter(),
      new MetricsCollector(),
      root
    );

    const result = await tool.run({ force: true });

    expect(result.summary.filesScanned).toBe(1);
    expect(result.summary.totalFindings).toBeGreaterThan(0);
  }, 120_000);

  it('serves a second identical scan from cache', async () => {
    const root = project({ 'src/a.ts': 'export const a = 1;\n' });
    const cache = newCache(root);
    const make = () =>
      new SmartSecurity(cache, new TokenCounter(), new MetricsCollector(), root);

    const first = await make().run({});
    const second = await make().run({});

    expect(first.summary.fromCache).toBe(false);
    expect(second.summary.fromCache).toBe(true);
  }, 120_000);

  it('rescans exactly the file that changed, and nothing else', async () => {
    // THE FILE HASH STILL HAS TO BE A CONTENT HASH. `scanFile` now hashes the
    // content it is already holding instead of re-reading the file, and the
    // stored hash is what `incrementalScan` compares against to decide whether
    // a file needs rescanning. A mutation that hashed the PATH instead survived
    // every other test here, because nothing exercised incremental mode -- the
    // path never changes, so no edit would ever be noticed again.
    const root = project({
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
    });
    const tool = new SmartSecurity(
      newCache(root),
      new TokenCounter(),
      new MetricsCollector(),
      root
    );

    // Populate the per-file hashes.
    const first = await tool.run({ targets: ['src'], force: true });
    expect(first.summary.filesScanned).toBe(2);

    // Nothing touched: the result cache answers before incremental mode is
    // even reached, which is the cheaper correct behaviour rather than a bug.
    const unchanged = await tool.run({ targets: ['src'] });
    expect(unchanged.summary.fromCache).toBe(true);

    writeFileSync(
      join(root, 'src', 'b.ts'),
      'export const b = 2;\n' + SECRET_LINE
    );

    const afterEdit = await tool.run({ targets: ['src'] });

    expect(afterEdit.summary.filesScanned).toBe(1);
    expect(afterEdit.summary.totalFindings).toBeGreaterThan(0);
  }, 120_000);

  it('still notices an edited file after the key stopped hashing content', async () => {
    // THE ONE THAT MATTERS. The cache key is derived from size and mtime now
    // rather than from a full read of every file. That is a real semantic
    // change and it is only acceptable while an ordinary edit still
    // invalidates -- so this asserts the invalidation directly rather than
    // trusting the reasoning.
    const root = project({ 'src/a.ts': 'export const a = 1;\n' });
    const cache = newCache(root);
    const make = () =>
      new SmartSecurity(cache, new TokenCounter(), new MetricsCollector(), root);

    await make().run({});
    const cached = await make().run({});
    expect(cached.summary.fromCache).toBe(true);

    writeFileSync(
      join(root, 'src', 'a.ts'),
      'export const a = 1;\n' + SECRET_LINE
    );

    const afterEdit = await make().run({});

    expect(afterEdit.summary.fromCache).toBe(false);
    expect(afterEdit.summary.totalFindings).toBeGreaterThan(0);
  }, 120_000);
});

describe('smart_dependencies reads each file once', () => {
  it('reports the same graph and the same measured baseline', async () => {
    // `measureFullFileTokens` now reads its counts from what `analyzeFile`
    // recorded while the file was open. Same tokenizer, same content, so the
    // baseline must be unchanged -- and it must not be zero, which is what a
    // broken lookup would silently produce.
    const root = project({
      'src/a.ts': "import { b } from './b';\nexport const a = b;\n",
      'src/b.ts': 'export const b = 2;\n',
    });
    const tool = new SmartDependenciesTool(
      newCache(root),
      new TokenCounter(),
      new MetricsCollector()
    );

    const result = await tool.analyze({ cwd: root, useCache: false });

    expect(result.success).toBe(true);
    expect(result.metadata.totalFiles).toBe(2);
    expect(result.metadata.originalTokenCount).toBeGreaterThan(0);
  }, 120_000);

  it('does not point an edge at a directory that is not a node', async () => {
    // A CORRECTNESS BUG FOUND WHILE MAKING THIS FAST -- and not the one I first
    // claimed. I asserted from reading the code that the index-file loop
    // overwrote an extension match; the test disproved it. The real fault is
    // that `existsSync` is TRUE FOR A DIRECTORY, so `./foo` in a project with a
    // `foo/` directory resolved to `src/foo` and recorded an edge to a path
    // that is not in the graph at all. Measured before the fix:
    //   edges: [{ from: "src\\main.ts", to: "src\\foo" }]
    // where the nodes were src\main.ts, src\foo.ts and src\foo\index.ts.
    //
    // Node resolves `./foo` to `foo.ts` when it exists, so that is what the
    // edge must say.
    const root = project({
      'src/main.ts': "import { value } from './foo';\nexport const main = value;\n",
      'src/foo.ts': 'export const value = 1;\n',
      'src/foo/index.ts': 'export const value = 2;\n',
    });
    const tool = new SmartDependenciesTool(
      newCache(root),
      new TokenCounter(),
      new MetricsCollector()
    );

    const result = await tool.analyze({ cwd: root, useCache: false });
    const nodes = (result.graph?.nodes ?? []).map((n) => n.replace(/\\/g, '/'));
    const targets = (result.graph?.edges ?? []).map((e) =>
      e.to.replace(/\\/g, '/')
    );

    expect(result.success).toBe(true);
    expect(targets).toContain('src/foo.ts');
    // The invariant the old behaviour broke: every edge lands on a real node.
    for (const target of targets) expect(nodes).toContain(target);
  }, 120_000);

  it('falls back to index.ts when only the directory exists', async () => {
    // The other half of Node's rule, and the case the directory check must not
    // break on its way to fixing the one above.
    const root = project({
      'src/main.ts': "import { value } from './foo';\nexport const main = value;\n",
      'src/foo/index.ts': 'export const value = 2;\n',
    });
    const tool = new SmartDependenciesTool(
      newCache(root),
      new TokenCounter(),
      new MetricsCollector()
    );

    const result = await tool.analyze({ cwd: root, useCache: false });
    const targets = (result.graph?.edges ?? []).map((e) =>
      e.to.replace(/\\/g, '/')
    );

    expect(result.success).toBe(true);
    expect(targets).toContain('src/foo/index.ts');
  }, 120_000);
});
