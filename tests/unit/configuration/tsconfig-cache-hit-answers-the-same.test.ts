import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getSmartTsConfig } from '../../../src/tools/configuration/smart-tsconfig.js';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { TokenCounter } from '../../../src/core/token-counter.js';
import { MetricsCollector } from '../../../src/core/metrics.js';

/**
 * Asking twice must not get a smaller answer.
 *
 * The output was built one way on a cold read and another way on a cache hit:
 * the cached branch returned compilerOptions, extendsChain and the path, and
 * dropped include, exclude, files and references. So the same tsconfig resolved
 * to two different configs depending on whether anyone had asked before, and
 * the second one was missing exactly the fields that say which files the config
 * applies to. The metrics block then subtracted the two shapes and published
 * the difference as a token saving -- dropped content reported as compression.
 *
 * Each assertion below is paired with a control that reproduces the old
 * behaviour on the same fixture, so a fixture that happened to carry none of
 * the dropped fields could not pass these quietly.
 */
describe('smart_tsconfig answers the same on a cache hit', () => {
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

  const CONFIG = [
    '{',
    '  "compilerOptions": {',
    '    "target": "ES2022",',
    '    "module": "ESNext",',
    '    "outDir": "dist"',
    '  },',
    '  "include": ["src/**/*"],',
    '  "exclude": ["node_modules", "dist", "**/*.test.ts"],',
    '  "files": ["src/index.ts"]',
    '}',
  ].join('\n');

  function makeTool() {
    const dir = mkdtempSync(join(tmpdir(), 'token-optimizer-tsconfig-'));
    dirs.push(dir);
    const cache = new CacheEngine(join(dir, 'cache.db'));
    caches.push(cache);
    const configPath = join(dir, 'tsconfig.json');
    writeFileSync(configPath, CONFIG);
    const tool = getSmartTsConfig(
      cache,
      new TokenCounter(),
      new MetricsCollector(),
      dir
    );
    return { tool, configPath };
  }

  it('returns the same resolved config cold and cached', async () => {
    const { tool, configPath } = makeTool();

    const cold = await tool.run({ configPath });
    const warm = await tool.run({ configPath });

    expect(cold.cacheHit).toBe(false);
    expect(warm.cacheHit).toBe(true);
    expect(warm.resolved).toEqual(cold.resolved);
  });

  it('keeps the fields that say which files the config applies to', async () => {
    const { tool, configPath } = makeTool();

    await tool.run({ configPath });
    const warm = await tool.run({ configPath });

    expect(warm.cacheHit).toBe(true);
    expect(warm.resolved.include).toEqual(['src/**/*']);
    expect(warm.resolved.exclude).toEqual([
      'node_modules',
      'dist',
      '**/*.test.ts',
    ]);
    expect(warm.resolved.files).toEqual(['src/index.ts']);
  });

  it('control: the shape this replaced does drop those fields', async () => {
    const { tool, configPath } = makeTool();
    const cold = await tool.run({ configPath });

    // What the cached branch used to build, on this very fixture.
    const oldShape = {
      compilerOptions: cold.resolved.compilerOptions,
      extendsChain: [configPath],
      configPath,
    };

    expect(oldShape).not.toEqual(cold.resolved);
    expect('include' in oldShape).toBe(false);
  });

  it('does not repeat the config path inside the resolved config', async () => {
    const { tool, configPath } = makeTool();
    const cold = await tool.run({ configPath });

    // The path is on the response already; a config that extends nothing has no
    // chain to report, and repeating an absolute path twice more was about a
    // fifth of the payload on a config this size.
    expect(cold.configPath).toBe(configPath);
    expect(cold.resolved).not.toHaveProperty('configPath');
    expect(cold.resolved.extendsChain).toBeUndefined();
  });

  it('measures its saving against the file it was asked to read', async () => {
    const { tool, configPath } = makeTool();
    const cold = await tool.run({ configPath });

    // The old baseline was a fuller response we never send, so the percentage
    // described a comparison the caller could not make. The only checkable
    // baseline is the file itself.
    const fileTokens = new TokenCounter().count(CONFIG).tokens;
    expect(cold.tokenMetrics.original).toBe(fileTokens);
    expect(cold.tokenMetrics.saved).toBe(
      Math.max(0, fileTokens - cold.tokenMetrics.compact)
    );
  });
});
