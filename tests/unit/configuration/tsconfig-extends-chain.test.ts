import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getSmartTsConfig } from '../../../src/tools/configuration/smart-tsconfig.js';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { TokenCounter } from '../../../src/core/token-counter.js';
import { MetricsCollector } from '../../../src/core/metrics.js';

/**
 * A resolution is only as fresh as the files it was merged from.
 *
 * Two defects, both of which only show up on the case this tool exists for --
 * a config that extends another:
 *
 *   1. The cache key and the validity check both covered the LEAF config's
 *      hash. Edit the base, ask again, and the tool answered from a merge that
 *      no longer held: the wrong target, the wrong strictness, with no sign
 *      that anything was stale. The chain is re-read and hashed on a hit now.
 *
 *   2. The saving was measured against the leaf file alone. But a caller
 *      answering this by hand reads the config, sees what it extends, reads
 *      that too and merges them -- so the baseline was a fraction of the work
 *      being replaced, and it under-counted by exactly as much as the tool
 *      does for you.
 */
describe('smart_tsconfig resolves an extends chain', () => {
  const dirs: string[] = [];
  const caches: CacheEngine[] = [];

  afterEach(() => {
    while (caches.length) {
      try {
        caches.pop()?.close();
      } catch {
        // already closed
      }
    }
    while (dirs.length) {
      const dir = dirs.pop();
      if (dir) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // temp dir may linger on Windows
        }
      }
    }
  });

  const BASE = [
    '{',
    '  "compilerOptions": {',
    '    "target": "ES2022",',
    '    "strict": true,',
    '    "declaration": true',
    '  },',
    '  "exclude": ["node_modules"]',
    '}',
  ].join('\n');

  const LEAF = [
    '{',
    '  "extends": "./tsconfig.base.json",',
    '  "compilerOptions": {',
    '    "outDir": "dist",',
    '    "rootDir": "src"',
    '  },',
    '  "include": ["src/**/*"]',
    '}',
  ].join('\n');

  function makeTool() {
    const dir = mkdtempSync(join(tmpdir(), 'tsconfig-chain-'));
    dirs.push(dir);
    const basePath = join(dir, 'tsconfig.base.json');
    const configPath = join(dir, 'tsconfig.json');
    writeFileSync(basePath, BASE);
    writeFileSync(configPath, LEAF);

    const cache = new CacheEngine(join(dir, 'cache'), 100);
    caches.push(cache);
    const tool = getSmartTsConfig(
      cache,
      new TokenCounter(),
      new MetricsCollector(),
      dir
    );
    return { tool, basePath, configPath };
  }

  it('merges the base in and names the chain', async () => {
    const { tool, configPath } = makeTool();
    const out = await tool.run({ configPath });

    // From the base, which the leaf never mentions.
    expect(out.resolved.compilerOptions.target).toBe('ES2022');
    expect(out.resolved.compilerOptions.strict).toBe(true);
    // From the leaf.
    expect(out.resolved.compilerOptions.outDir).toBe('dist');
    expect(out.resolved.extendsChain).toHaveLength(2);
  });

  it('measures its saving against every file in the chain', async () => {
    const { tool, configPath } = makeTool();
    const out = await tool.run({ configPath });

    // Base first, joined with a newline: the order and the separator the tool
    // merged them in, so both sides of the subtraction count the same bytes.
    const counter = new TokenCounter();
    const chainTokens = counter.count([BASE, LEAF].join('\n')).tokens;
    const leafTokens = counter.count(LEAF).tokens;

    expect(out.tokenMetrics.original).toBe(chainTokens);
    // The control: the leaf alone is a strictly smaller baseline, so a test
    // that passed with either number would not be testing anything. This is
    // the figure the tool used to report.
    expect(leafTokens).toBeLessThan(chainTokens);
    expect(out.tokenMetrics.original).not.toBe(leafTokens);

    expect(out.tokenMetrics.saved).toBe(
      out.tokenMetrics.original - out.tokenMetrics.compact
    );
  });

  it('does not answer from a cached merge after the base changes', async () => {
    const { tool, basePath, configPath } = makeTool();

    const first = await tool.run({ configPath });
    expect(first.cacheHit).toBe(false);
    expect(first.resolved.compilerOptions.target).toBe('ES2022');

    // Only the BASE changes. The leaf, whose hash is the cache key, is byte
    // for byte what it was.
    writeFileSync(basePath, BASE.replace('"ES2022"', '"ES2017"'));

    const second = await tool.run({ configPath });
    expect(second.resolved.compilerOptions.target).toBe('ES2017');
    // And it was re-resolved rather than served from the stale entry.
    expect(second.cacheHit).toBe(false);
  });

  it('still hits the cache when nothing in the chain has changed', async () => {
    const { tool, configPath } = makeTool();

    await tool.run({ configPath });
    const again = await tool.run({ configPath });

    // The control for the test above: the invalidation must be driven by the
    // files actually changing, not by the check failing every time.
    expect(again.cacheHit).toBe(true);
    expect(again.resolved.compilerOptions.target).toBe('ES2022');
  });
});
