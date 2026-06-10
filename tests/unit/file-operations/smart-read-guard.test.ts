import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SmartReadTool } from '../../../src/tools/file-operations/smart-read.js';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { TokenCounter } from '../../../src/core/token-counter.js';
import { MetricsCollector } from '../../../src/core/metrics.js';

/**
 * Regression tests for the smart_read `path` guard: a missing, blank, or
 * whitespace-only path must fail fast with a clear message instead of an
 * opaque downstream error.
 */
describe('SmartReadTool path guard', () => {
  const tempDirs: string[] = [];
  const caches: CacheEngine[] = [];

  afterEach(() => {
    // Close SQLite handles before removing temp files (Windows locks open DBs).
    while (caches.length) {
      try {
        caches.pop()?.close();
      } catch {
        // already closed
      }
    }
    while (tempDirs.length) {
      const dir = tempDirs.pop();
      if (dir) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // temp dir may linger on Windows; OS reclaims it later
        }
      }
    }
  });

  function makeTool(): SmartReadTool {
    const dir = mkdtempSync(join(tmpdir(), 'token-optimizer-smartread-'));
    tempDirs.push(dir);
    const cache = new CacheEngine(join(dir, 'cache.db'));
    caches.push(cache);
    return new SmartReadTool(cache, new TokenCounter(), new MetricsCollector());
  }

  const invalidPaths: Array<[string, unknown]> = [
    ['empty string', ''],
    ['whitespace only', '   '],
    ['undefined', undefined],
    ['null', null],
    ['number', 123],
  ];

  for (const [label, value] of invalidPaths) {
    it(`rejects ${label} with the explicit guard message`, async () => {
      const tool = makeTool();
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tool.read(value as any)
      ).rejects.toThrow(/smart_read requires a non-empty "path" argument/);
    });
  }
});
