import { describe, it, expect } from '@jest/globals';
import { execFileSync } from 'node:child_process';

describe('compiled lazy analysis tools', () => {
  it('loads schemas without TypeScript or WASM and can invoke analysis afterwards', () => {
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict';
      import { createRequire } from 'node:module';
      import { mkdtempSync, rmSync } from 'node:fs';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      const require = createRequire(import.meta.url);
      const tools = await import('./dist/tools/code-analysis/lazy-tools.js');
      const { TokenCounter } = await import('./dist/core/token-counter.js');
      const counter = new TokenCounter('gpt-4');
      const loaded = name => Object.keys(require.cache).some(p => p.includes('/' + name + '/') || p.includes('\\\\' + name + '\\\\'));
      assert(!loaded('typescript'));
      assert(!loaded('tiktoken'));
      const schemas = Object.values(tools).filter(v => v?.inputSchema);
      assert.equal(schemas.length, 6);
      assert.equal(counter.count('Hello, world!').tokens, 4);
      assert(loaded('tiktoken'));
      assert(!loaded('typescript'));
      const { CacheEngine } = await import('./dist/core/cache-engine.js');
      const { MetricsCollector } = await import('./dist/core/metrics.js');
      const dir = mkdtempSync(join(tmpdir(), 'lazy-analysis-'));
      const cache = new CacheEngine(dir, 10);
      try {
        const result = await tools.runSmartComplexity({ fileContent: 'export function twice(x: number) { return x * 2; }' }, cache, counter, new MetricsCollector());
        assert(loaded('typescript'));
        assert(result);
        console.log(JSON.stringify({ schemas: schemas.length, invoked: true }));
      } finally {
        counter.free();
        cache.close();
        rmSync(dir, { recursive: true, force: true });
      }
    `,
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 20000,
        windowsHide: true,
      }
    );
    expect(JSON.parse(output)).toEqual({ schemas: 6, invoked: true });
  });
});
