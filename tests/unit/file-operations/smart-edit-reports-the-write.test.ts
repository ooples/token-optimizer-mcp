/**
 * A completed write is reported as completed, whatever the cache does.
 *
 * FOUND WHILE FIXING #335, by using the tool: `smart_edit` returned
 * `success: false, operation: 'failed', editsApplied: 0` with
 * `error: 'database or disk is full'` -- and BOTH edits were already on disk.
 * The cache update ran inside the method's single try/catch, after
 * `writeFileSync`, so a SQLite failure rewrote the report of an edit that had
 * already happened.
 *
 * WHY THAT IS WORSE THAN A SLOW TOOL. The only sane response to "your edit
 * failed, 0 applied" is to retry it, and retrying a line-based edit against an
 * already-edited file does not fail -- it applies the change twice, to the
 * wrong lines. A stale cache costs one re-read; a false failure report costs
 * the file.
 */

import { describe, it, expect } from '@jest/globals';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SmartEditTool } from '../../../src/tools/file-operations/smart-edit.js';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { TokenCounter } from '../../../src/core/token-counter.js';
import { MetricsCollector } from '../../../src/core/metrics.js';

describe('smart_edit reports what actually happened to the file', () => {
  it('still reports success when the cache write throws', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'edit-report-'));
    const file = join(dir, 'target.ts');
    writeFileSync(file, ['one', 'two', 'three'].join('\n'));

    const cache = new CacheEngine(join(dir, 'cache.db'), 100);
    // The exact failure observed live, from the exact call that produced it.
    cache.set = () => {
      throw new Error('database or disk is full');
    };

    const tool = new SmartEditTool(
      cache,
      new TokenCounter(),
      new MetricsCollector()
    );

    try {
      const result = await tool.edit(file, {
        type: 'replace',
        startLine: 2,
        endLine: 2,
        content: 'TWO',
      });

      // The file changed, so the report must say the file changed.
      expect(readFileSync(file, 'utf-8')).toContain('TWO');
      expect(result.success).toBe(true);
      expect(result.metadata.editsApplied).toBe(1);
      expect(result.operation).not.toBe('failed');
    } finally {
      try {
        cache.close?.();
      } catch {
        /* ignore */
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows can still hold the sqlite handle; the assertions above are
        // the point, not the tidiness of the temp directory.
      }
    }
  });
});
