import { describe, it, expect, afterEach } from '@jest/globals';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from 'fs';
import { join, relative, resolve } from 'path';
import { tmpdir } from 'os';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { TokenCounter } from '../../../src/core/token-counter.js';
import { MetricsCollector } from '../../../src/core/metrics.js';
import { SmartDependenciesTool } from '../../../src/tools/code-analysis/smart-dependencies.js';
import { RESOLVED_INPUT_KEY } from '../../../src/tools/shared/savings.js';
import { measureDisplacedInput } from '../../../src/analytics/displaced-input.js';

/**
 * A baseline has to be measured from something that exists.
 *
 * smart_dependencies computed its baseline as `files.length * 2000` -- an
 * assumed 2,000 tokens per file, taken from nothing. That figure was the
 * denominator of every saving it reported, so the analytics showed it saving
 * 790,200 tokens per call at 95.97%. The same numbers would have appeared for
 * a project of EMPTY files, which is what makes it fabrication rather than
 * imprecision. The repair after that read the files for real -- and still got
 * them from the wrong root on the first attempt, measuring every baseline as 0
 * and turning every saving negative.
 *
 * SO THE TOOL NO LONGER COUNTS EITHER HALF. It names the files its baseline
 * comes from, and the recorder reads them with the same reader and counts them
 * with the same counter it uses on the reply, so both sides of the ratio are
 * measured by one party. These tests pin the half that is now the tool's job:
 * that the paths it declares are the real files, resolved against the project
 * it was pointed at, narrowed to what the mode actually answered about -- and
 * that no figure of its own survives anywhere in the reply.
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

describe('smart_dependencies names the baseline it displaced', () => {
  const declaredPaths = (reply: unknown): string[] => {
    const declaration = (reply as Record<string, unknown>)[
      RESOLVED_INPUT_KEY
    ] as { paths?: readonly string[]; baselineSource?: string } | null;
    expect(declaration).not.toBeNull();
    expect(declaration?.baselineSource).toBe('resolved-import-graph');
    return [...(declaration?.paths ?? [])].sort();
  };

  /** Every spelling of a saving this fleet has used, looked for anywhere. */
  const savingsKeysIn = (reply: unknown): string[] => {
    const SAVINGS_KEYS = [
      'tokensSaved',
      'savedTokens',
      'tokenCount',
      'originalTokenCount',
      'originalTokens',
      'optimizedTokens',
      'compressedTokens',
      'reductionPercentage',
      'compressionRatio',
      'totalTokensSaved',
      'averageReduction',
    ];
    const found: string[] = [];
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        if (SAVINGS_KEYS.includes(key)) found.push(key);
        walk(value);
      }
    };
    walk(reply);
    return found;
  };

  it('declares the real files, resolved against the project it was given', async () => {
    const { dir, tool } = project(LARGE);
    const r = await tool.run({ cwd: dir, mode: 'graph', useCache: false });

    // Absolute, because the recorder resolves a relative path against ITS own
    // working directory -- the bug that measured every baseline as 0.
    expect(declaredPaths(r)).toEqual(
      Object.keys(LARGE)
        .map((rel) => resolve(dir, rel))
        .sort()
    );
  });

  it('declares files whose measured size tracks content, not file count', async () => {
    // The signature of the old bug: identical baselines for very different
    // projects, because only the FILE COUNT was ever consulted. Measured here
    // the way the recorder measures it -- the same function, over the paths
    // the tool declared -- so this pins the declaration end to end.
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

    const measuredA = await measureDisplacedInput({}, declaredPaths(a));
    const measuredB = await measureDisplacedInput({}, declaredPaths(b));

    expect(measuredA?.files).toBe(Object.keys(TINY).length);
    expect(measuredB?.files).toBe(Object.keys(LARGE).length);
    // Within a token of an independent count of the same files: the recorder
    // joins them with a newline, which the per-file sum does not have.
    expect(measuredA?.tokens).toBeGreaterThanOrEqual(tiny.realTokens);
    expect(measuredA?.tokens).toBeLessThanOrEqual(tiny.realTokens + 4);
    expect(measuredB?.tokens).toBeGreaterThanOrEqual(large.realTokens);
    expect(measuredB?.tokens).toBeLessThanOrEqual(large.realTokens + 4);
    // Same file count, wildly different content.
    expect(measuredB?.tokens).toBeGreaterThan((measuredA?.tokens ?? 0) * 10);
  });

  it('narrows the declaration to what impact mode answered about', async () => {
    // Impact answers about one file and its dependents. Declaring the whole
    // graph there would credit the call with displacing files it said nothing
    // about -- the same overstatement as the invented per-file baseline, by a
    // different route.
    const { dir, tool } = project(TINY);
    const target = relative(dir, join(dir, 'src', 'b.ts'));
    const r = await tool.run({
      cwd: dir,
      mode: 'impact',
      targetFile: target,
      useCache: false,
    });

    expect(r.success).toBe(true);
    // ONE FILE IS AFFECTED, SO THE IMPACT IS ONE. The walk seeded itself with
    // the direct dependents and then recorded each of them as an indirect one
    // too, and `totalImpact` adds the two lengths -- so this read 2.
    expect(r.impact?.directDependents).toEqual([join('src', 'a.ts')]);
    expect(r.impact?.indirectDependents).toEqual([]);
    expect(r.impact?.totalImpact).toBe(1);
    // b.ts and the a.ts that imports it -- not the unrelated c.ts.
    expect(declaredPaths(r)).toEqual(
      [resolve(dir, 'src', 'a.ts'), resolve(dir, 'src', 'b.ts')].sort()
    );
  });

  it('declares nothing when it refused to answer', async () => {
    // A refusal displaced no reading at all, so a baseline on that row would
    // be a saving credited to a call that produced only an error string.
    const { dir, tool } = project(TINY);
    const r = await tool.run({
      cwd: dir,
      mode: 'impact',
      targetFile: 'src/nope.ts',
      useCache: false,
    });

    expect(r.success).toBe(false);
    expect(r[RESOLVED_INPUT_KEY]).toBeNull();
  });

  it('states no saving of its own, under any name', async () => {
    const { dir, tool } = project(TINY);
    const r = await tool.run({ cwd: dir, mode: 'graph', useCache: false });

    expect(savingsKeysIn(r)).toEqual([]);
    // Three trivial files cost less to read than the graph describing them, so
    // the old code reported a loss here -- correctly, and about two artifacts
    // nobody was ever sent. The comparison that matters is the reply against
    // the files, and neither half of it is countable from in there.
    expect(savingsKeysIn({ metadata: { tokensSaved: -11 } })).toEqual([
      'tokensSaved',
    ]);
  });

  it('also declares the baseline on a cache hit', async () => {
    // A hit had no baseline at all while the before was a number someone had
    // to have counted at analysis time and no longer had. The before is a set
    // of files, and the files are still on disk.
    const { dir, tool } = project(TINY);
    const first = await tool.run({ cwd: dir, mode: 'graph', useCache: true });
    const second = await tool.run({ cwd: dir, mode: 'graph', useCache: true });

    expect(second.metadata.cacheHit).toBe(true);
    expect(first.metadata.cacheHit).toBe(false);
    expect(declaredPaths(second)).toEqual(declaredPaths(first));
  });

  it('analyses the project it was pointed at, not the process cwd', async () => {
    const { dir, tool } = project(TINY);
    const r = await tool.run({ cwd: dir, mode: 'graph', useCache: false });
    expect(r.metadata.totalFiles).toBe(Object.keys(TINY).length);
  });
});
