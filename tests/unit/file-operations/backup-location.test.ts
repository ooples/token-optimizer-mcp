import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, writeFileSync, existsSync, rmSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SmartWriteTool } from '../../../src/tools/file-operations/smart-write.js';
import { SmartEditTool } from '../../../src/tools/file-operations/smart-edit.js';
import { backupDirFor } from '../../../src/utils/file-backup.js';
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

describe('backups never land next to the file', () => {
  let home: string;
  let backups: string;
  let file: string;
  let cache: CacheEngine;
  let counter: TokenCounter;
  let originalBackupDir: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'backup-location-'));
    file = join(home, 'target.ts');
    writeFileSync(file, 'const original = 1;\n');

    // REDIRECTED, not cleaned up afterwards. These tests used to write into the
    // real ~/.token-optimizer/backups and remove the directory by hand, which
    // works only as long as every test remembers -- and one did not, leaking a
    // permanent directory under the developer's home on every run.
    //
    // A SIBLING of `home`, not a child: one test below asserts that the edited
    // directory gains no new entries, and a backup root inside it is a new
    // entry.
    backups = mkdtempSync(join(tmpdir(), 'backup-location-store-'));
    originalBackupDir = process.env.TOKEN_OPTIMIZER_BACKUP_DIR;
    process.env.TOKEN_OPTIMIZER_BACKUP_DIR = backups;

    cache = new CacheEngine(join(home, 'cache.db'), 100);
    counter = new TokenCounter();
  });

  afterEach(() => {
    cache.close();
    counter.free();

    if (originalBackupDir === undefined) delete process.env.TOKEN_OPTIMIZER_BACKUP_DIR;
    else process.env.TOKEN_OPTIMIZER_BACKUP_DIR = originalBackupDir;

    for (const dir of [home, backups]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* temp dirs, reclaimed by the OS */
      }
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
