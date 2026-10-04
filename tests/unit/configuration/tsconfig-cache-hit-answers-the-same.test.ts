import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getSmartTsConfig } from '../../../src/tools/configuration/smart-tsconfig.js';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { TokenCounter } from '../../../src/core/token-counter.js';
import {
  asResolvedInputFiles,
  RESOLVED_INPUT_KEY,
} from '../../../src/tools/shared/savings.js';
import { measureDisplacedInput } from '../../../src/analytics/displaced-input.js';
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

  // THE SAME CONFIG, REACHED THROUGH AN EXTENDS.
  //
  // The agreement this file is about -- cold and cached must answer alike --
  // is about the merged config, and a config that extends nothing no longer
  // sends one, because it resolves to the file the caller already has. So the
  // fixture is read as a base here, and the tool is pointed at a one-line
  // config that extends it. Nothing about the merge under test changes: every
  // field asserted below still comes from CONFIG.
  //
  // Without this the assertions would still pass, on both sides being
  // undefined, and would have stopped testing anything.
  function makeExtendingTool() {
    const dir = mkdtempSync(join(tmpdir(), 'token-optimizer-tsconfig-'));
    dirs.push(dir);
    const cache = new CacheEngine(join(dir, 'cache.db'));
    caches.push(cache);
    const basePath = join(dir, 'base.json');
    writeFileSync(basePath, CONFIG);
    const configPath = join(dir, 'tsconfig.json');
    writeFileSync(configPath, '{ "extends": "./base.json" }');
    const tool = getSmartTsConfig(
      cache,
      new TokenCounter(),
      new MetricsCollector(),
      dir
    );
    return { tool, configPath, basePath };
  }

  it('returns the same resolved config cold and cached', async () => {
    const { tool, configPath } = makeExtendingTool();

    const cold = await tool.run({ configPath });
    const warm = await tool.run({ configPath });

    expect(cold.cacheHit).toBe(false);
    expect(warm.cacheHit).toBe(true);
    expect(warm.resolved).toEqual(cold.resolved);
  });

  it('keeps the fields that say which files the config applies to', async () => {
    const { tool, configPath } = makeExtendingTool();

    await tool.run({ configPath });
    const warm = await tool.run({ configPath });

    expect(warm.cacheHit).toBe(true);
    expect(warm.resolved?.include).toEqual(['src/**/*']);
    expect(warm.resolved?.exclude).toEqual([
      'node_modules',
      'dist',
      '**/*.test.ts',
    ]);
    expect(warm.resolved?.files).toEqual(['src/index.ts']);
  });

  it('control: the shape this replaced does drop those fields', async () => {
    const { tool, configPath } = makeExtendingTool();
    const cold = await tool.run({ configPath });

    // What the cached branch used to build, on this very fixture.
    const oldShape = {
      compilerOptions: cold.resolved?.compilerOptions,
      extendsChain: [configPath],
      configPath,
    };

    expect(oldShape).not.toEqual(cold.resolved);
    expect('include' in oldShape).toBe(false);
  });

  it('does not repeat the config path inside the resolved config', async () => {
    const { tool, configPath } = makeExtendingTool();
    const cold = await tool.run({ configPath });

    // The path is on the response already, and repeating that absolute path
    // inside the merge was about a tenth of the payload on a config this
    // size. The CHAIN is a different matter: those are files the caller
    // never named, which is the one thing only the tool knows.
    expect(cold.configPath).toBe(configPath);
    expect(cold.resolved).not.toHaveProperty('configPath');
    expect(cold.resolved?.extendsChain).toHaveLength(2);
  });

  it('states no saving of its own, under any name', async () => {
    /*
     * THIS TEST PINNED THE FIGURES AND NOW PINS THEIR ABSENCE. It asked for a
     * baseline equal to the file and a difference equal to the subtraction,
     * both of which were as carefully computed as this comment claimed -- and
     * both of which described an artifact nobody is sent, because the second
     * operand was this object and not the reply built around it after the tool
     * returns. The before is declared as the chain's paths and measured by the
     * recorder; the after is counted once, at the wire.
     */
    const { tool, configPath } = makeExtendingTool();
    const cold = await tool.run({ configPath });

    const SAVINGS_KEYS = [
      'tokenMetrics',
      'originalTokens',
      'compactedTokens',
      'savingsPercent',
      'tokensSaved',
      'savedTokens',
      'compressionRatio',
      'baselineTokens',
    ];
    const found: string[] = [];
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        if (SAVINGS_KEYS.includes(key)) found.push(key);
        walk(value);
      }
    };
    walk(cold);
    expect(found).toEqual([]);
    // THE POSITIVE CONTROL, twice: the reply really is the resolved config, and
    // the walk really does descend into a reply of this shape.
    expect(cold.resolved?.compilerOptions.target).toBeDefined();
    walk({ resolved: { a: { tokenMetrics: {} } } });
    expect(found).toEqual(['tokenMetrics']);
  });

  it('sends no merge when there was nothing to merge', async () => {
    const { tool, configPath } = makeTool();
    const cold = await tool.run({ configPath });

    // The answer in one word. This config extends nothing, so the resolved
    // config is the file the caller named -- 78 tokens of it, against a
    // 76-token file, to say that reading it changed nothing.
    expect(cold.resolution).toBe('as-written');
    expect(cold.resolved).toBeUndefined();

    // AND THE ANALYSIS STILL TRAVELS. This is the half the caller could not
    // have worked out from the file in front of them, and dropping the echo
    // must not drop it.
    expect(Array.isArray(cold.suggestions)).toBe(true);
    expect((cold.suggestions ?? []).length).toBeGreaterThan(0);
  });

  it('control: a config that does extend one gets the merge', async () => {
    // THE POSITIVE CONTROL for the test above. If `resolved` were simply gone
    // from the response, that test would pass just as well.
    const { tool, configPath } = makeExtendingTool();
    const cold = await tool.run({ configPath });

    expect(cold.resolution).toBe('merged');
    expect(cold.resolved?.compilerOptions.target).toBe('ES2022');
  });

  it('answers the same on a cache hit when there was no merge either', async () => {
    const { tool, configPath } = makeTool();

    const cold = await tool.run({ configPath });
    const warm = await tool.run({ configPath });

    expect(warm.cacheHit).toBe(true);
    expect(warm.resolution).toBe(cold.resolution);
    expect(warm.resolved).toBeUndefined();
    expect(warm.suggestions).toEqual(cold.suggestions);
  });

  it('declares the file it read, so the recorder has a before to measure', async () => {
    const { tool, configPath } = makeTool();
    const cold = await tool.run({ configPath });

    // A config that extends nothing is a chain of one. The declaration still
    // names it: the recorder reads the arguments' configPath too and counts the
    // file once, so declaring the leaf costs nothing and the chain case below
    // needs no separate branch in the tool.
    const declared = asResolvedInputFiles(cold[RESOLVED_INPUT_KEY]);
    expect(declared).not.toBeNull();
    expect(declared?.baselineSource).toBe('resolved-config-chain');
    expect(declared?.paths).toEqual([configPath]);

    // AND IT IS A COUNT OF THE FILE, taken by the recorder from those paths --
    // which is the figure the tool used to publish for itself.
    const measuredFromPaths = await measureDisplacedInput(
      {},
      declared?.paths ?? []
    );
    expect(measuredFromPaths?.tokens).toBe(
      new TokenCounter().count(CONFIG).tokens
    );
  });
});
