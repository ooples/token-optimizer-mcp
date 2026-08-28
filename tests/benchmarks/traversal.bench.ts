/**
 * Wall-clock ceilings for every tool that walks the filesystem.
 *
 * WHY THIS EXISTS RATHER THAN A UNIT TEST. Issue #335 was not a wrong answer,
 * it was an unbounded one: `smart_glob` and `smart_grep` enumerated a whole
 * tree before applying `limit`, and on a real home directory that ran **178
 * seconds without completing**. Nothing in the suite could fail for that,
 * because every existing test ran against a handful of fixture files where an
 * unbounded walk is indistinguishable from a bounded one. A defect that only
 * appears at scale needs a test that runs at scale.
 *
 * WHAT THESE ASSERT, and what they deliberately do not. The ceilings are
 * generous and shaped like "bounded, on a shared CI runner, under contention" --
 * not millisecond budgets, which would flake and then be deleted. The
 * interesting signal is the RATIO: a capped search must be dramatically cheaper
 * than an exhaustive one over the same tree. That relationship is what breaks
 * when someone reintroduces enumerate-then-filter, and it holds regardless of
 * how slow the machine is.
 *
 * The tree is built once and is deliberately wider than any fixture in the unit
 * suite, because that width is the entire point.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SmartGlobTool } from '../../src/tools/file-operations/smart-glob.js';
import { SmartGrepTool } from '../../src/tools/file-operations/smart-grep.js';
import { CacheEngine } from '../../src/core/cache-engine.js';
import { TokenCounter } from '../../src/core/token-counter.js';
import { MetricsCollector } from '../../src/core/metrics.js';

/** A tree big enough that enumerate-then-filter is visibly different. */
const DIRECTORIES = 120;
const FILES_PER_DIRECTORY = 100; // 12,000 files
const CEILING_MS = 30_000;

let root: string;
let cache: CacheEngine;
let glob: SmartGlobTool;
let grep: SmartGrepTool;

const report: Array<{ operation: string; ms: number }> = [];

const timed = async <T>(operation: string, run: () => Promise<T>) => {
  const started = Date.now();
  const value = await run();
  const ms = Date.now() - started;
  report.push({ operation, ms });
  return { value, ms };
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'traversal-bench-'));
  for (let d = 0; d < DIRECTORIES; d++) {
    const sub = join(root, `pkg-${String(d).padStart(4, '0')}`);
    mkdirSync(sub, { recursive: true });
    for (let f = 0; f < FILES_PER_DIRECTORY; f++) {
      writeFileSync(
        join(sub, `file-${String(f).padStart(4, '0')}.ts`),
        'export const NEEDLE = 1;\n'
      );
    }
  }
  cache = new CacheEngine(join(root, 'cache.db'), 100);
  glob = new SmartGlobTool(cache, new TokenCounter(), new MetricsCollector());
  grep = new SmartGrepTool(cache, new TokenCounter(), new MetricsCollector());
}, 300_000);

afterAll(() => {
  // eslint-disable-next-line no-console
  console.log(
    '\nTraversal benchmarks (' +
      DIRECTORIES * FILES_PER_DIRECTORY +
      ' files):\n' +
      report
        .map((r) => `  ${String(r.ms).padStart(7)} ms  ${r.operation}`)
        .join('\n')
  );
  try {
    cache.close?.();
  } catch {
    /* ignore */
  }
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* windows can hold a handle briefly */
  }
});

describe('traversal stays bounded at scale', () => {
  it('smart_glob: an exhaustive search finishes inside its ceiling', async () => {
    const { value, ms } = await timed('smart_glob exhaustive', () =>
      glob.glob('**/*.ts', { cwd: root })
    );
    expect(value.success).toBe(true);
    expect(ms).toBeLessThan(CEILING_MS);
  }, 120_000);

  it('smart_glob: a capped search is far cheaper than an exhaustive one', async () => {
    // THE REGRESSION THIS CATCHES. Enumerate-then-filter makes these two cost
    // the same, because the cap is applied to a list that was already built.
    const exhaustive = await timed('smart_glob exhaustive (ratio base)', () =>
      glob.glob('**/*.ts', { cwd: root })
    );
    const capped = await timed('smart_glob limit=10', () =>
      glob.glob('**/*.ts', { cwd: root, limit: 10 })
    );
    expect(capped.value.files).toHaveLength(10);
    expect(capped.ms).toBeLessThan(CEILING_MS);
    // Generous factor: the claim is "short-circuits", not a speed record.
    expect(capped.ms).toBeLessThanOrEqual(Math.max(250, exhaustive.ms / 2));
  }, 180_000);

  it('smart_grep: a capped search is far cheaper than an exhaustive one', async () => {
    const exhaustive = await timed('smart_grep exhaustive (ratio base)', () =>
      grep.grep('NEEDLE', { cwd: root })
    );
    const capped = await timed('smart_grep limit=5', () =>
      grep.grep('NEEDLE', { cwd: root, limit: 5 })
    );
    expect(capped.ms).toBeLessThan(CEILING_MS);
    expect(capped.ms).toBeLessThanOrEqual(Math.max(250, exhaustive.ms / 2));
  }, 180_000);

  it('a tight deadline is honoured rather than ignored', async () => {
    // The bound that covers the case a cap cannot: a walk that matches nothing
    // for a long time. Without it there is no ceiling at all on a wide tree.
    const { value, ms } = await timed('smart_glob deadline=250ms', () =>
      glob.glob('**/*.no-such-extension', { cwd: root, deadlineMs: 250 })
    );
    expect(value.success).toBe(true);
    expect(ms).toBeLessThan(CEILING_MS);
  }, 120_000);
});
