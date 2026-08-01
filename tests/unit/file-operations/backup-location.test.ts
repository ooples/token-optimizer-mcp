import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, writeFileSync, existsSync, rmSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import { SmartWriteTool } from '../../../src/tools/file-operations/smart-write.js';
import { SmartEditTool, BACKUP_ROOT } from '../../../src/tools/file-operations/smart-edit.js';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { TokenCounter } from '../../../src/core/token-counter.js';
import { MetricsCollector } from '../../../src/core/metrics.js';

/**
 * A backup must never land inside the tree it is protecting.
 *
 * smart_edit was moved to a home-directory backup root, but smart_write kept
 * writing `${filePath}.bak`, so the defect went on shipping from a second tool.
 * Found the ordinary way: three stray .bak files in this repository -- beside a
 * benchmark fixture, beside a hook that a sync script regenerates, and in the
 * build output -- each untracked and one `git add -A` from being committed.
 *
 * Covering BOTH tools, because fixing one and not the other is exactly what
 * happened the first time.
 */

const backupDirFor = (filePath: string): string =>
  join(BACKUP_ROOT, createHash('sha256').update(filePath).digest('hex').slice(0, 16));

describe('backups never land next to the file', () => {
  let home: string;
  let file: string;
  let cache: CacheEngine;
  let counter: TokenCounter;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'backup-location-'));
    file = join(home, 'target.ts');
    writeFileSync(file, 'const original = 1;\n');

    cache = new CacheEngine(join(home, 'cache.db'), 100);
    counter = new TokenCounter();
  });

  afterEach(() => {
    cache.close();
    counter.free();
    try {
      rmSync(backupDirFor(file), { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    } catch {
      /* temp dirs, reclaimed by the OS */
    }
  });

  describe('smart_write', () => {
    it('does not create <file>.bak beside the original', async () => {
      const tool = new SmartWriteTool(cache, counter, new MetricsCollector());

      await tool.write(file, 'const replaced = 2;\n', {
        createBackup: true,
        autoFormat: false,
      });

      expect(existsSync(`${file}.bak`)).toBe(false);
    });

    it('leaves no new file in the edited directory at all', async () => {
      const tool = new SmartWriteTool(cache, counter, new MetricsCollector());
      const before = readdirSync(home).sort();

      await tool.write(file, 'const replaced = 2;\n', {
        createBackup: true,
        autoFormat: false,
      });

      // The cache db lives here too, so compare sets rather than counts.
      expect(readdirSync(home).sort()).toEqual(before);
    });

    it('still preserves the previous content, under the home backup root', async () => {
      const tool = new SmartWriteTool(cache, counter, new MetricsCollector());

      await tool.write(file, 'const replaced = 2;\n', {
        createBackup: true,
        autoFormat: false,
      });

      // A backup that is merely absent would also pass the assertions above,
      // so check the content actually went somewhere.
      const dir = backupDirFor(file);
      expect(existsSync(dir)).toBe(true);
      expect(readdirSync(dir).length).toBeGreaterThan(0);
    });
  });

  describe('smart_edit', () => {
    it('does not create <file>.bak beside the original', async () => {
      const tool = new SmartEditTool(cache, counter, new MetricsCollector());

      await tool.edit(
        file,
        [{ type: 'replace', startLine: 1, endLine: 1, content: 'const edited = 3;' }],
        { createBackup: true }
      );

      expect(existsSync(`${file}.bak`)).toBe(false);
    });

    it('preserves the previous content under the home backup root', async () => {
      const tool = new SmartEditTool(cache, counter, new MetricsCollector());

      await tool.edit(
        file,
        [{ type: 'replace', startLine: 1, endLine: 1, content: 'const edited = 3;' }],
        { createBackup: true }
      );

      const dir = backupDirFor(file);
      expect(existsSync(dir)).toBe(true);
      expect(readdirSync(dir).length).toBeGreaterThan(0);
    });
  });
});
