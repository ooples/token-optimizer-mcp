import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SmartEditTool } from '../../../src/tools/file-operations/smart-edit.js';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { TokenCounter } from '../../../src/core/token-counter.js';
import { MetricsCollector } from '../../../src/core/metrics.js';

/**
 * Pattern-based edits had two defects that fed each other, and both were hit
 * repeatedly while editing this repository with the tool itself.
 *
 *   1. The replace ran per LINE, so a pattern containing a newline could never
 *      match -- the text it was written against existed on no single line.
 *   2. A pattern that matched nothing returned success with editsApplied: 0 and
 *      operation: 'unchanged', which reads exactly like a legitimate no-op. A
 *      caller with a subtly wrong regex was told the edit worked.
 *
 * Together they were silent: write a multi-line pattern, get told it applied,
 * find the file unchanged later.
 */

describe('smart_edit pattern operations', () => {
  let home: string;
  let backups: string;
  let file: string;
  let tool: SmartEditTool;
  let cache: CacheEngine;
  let counter: TokenCounter;
  let originalBackupDir: string | undefined;

  const ORIGINAL = ['const a = 1;', 'const b = 2;', 'const c = 3;'].join('\n');

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'smart-edit-patterns-'));
    file = join(home, 'sample.ts');
    writeFileSync(file, ORIGINAL);

    // The `createBackup: true` case below wrote into the REAL
    // ~/.token-optimizer/backups, and `afterEach` only removed `home` -- so
    // every run of this suite left a new permanent directory under the
    // developer's home. Exactly the defect this file's subject matter is about.
    backups = mkdtempSync(join(tmpdir(), 'smart-edit-patterns-store-'));
    originalBackupDir = process.env.TOKEN_OPTIMIZER_BACKUP_DIR;
    process.env.TOKEN_OPTIMIZER_BACKUP_DIR = backups;

    cache = new CacheEngine(join(home, 'cache.db'), 100);
    counter = new TokenCounter();
    tool = new SmartEditTool(cache, counter, new MetricsCollector());
  });

  afterEach(() => {
    cache.close();
    counter.free();

    if (originalBackupDir === undefined)
      delete process.env.TOKEN_OPTIMIZER_BACKUP_DIR;
    else process.env.TOKEN_OPTIMIZER_BACKUP_DIR = originalBackupDir;

    for (const dir of [home, backups]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* temp dirs, reclaimed by the OS */
      }
    }
  });

  describe('a pattern that matches nothing', () => {
    it('fails rather than reporting success', async () => {
      const result = await tool.edit(
        file,
        [
          {
            type: 'replace',
            startLine: 1,
            pattern: 'NOT_PRESENT_ANYWHERE',
            replacement: 'x',
          },
        ],
        { createBackup: false }
      );

      // Was: success true, operation 'unchanged', editsApplied 0.
      expect(result.success).toBe(false);
      expect(result.operation).toBe('failed');
    });

    it('names the pattern that missed, so the caller can fix it', async () => {
      const result = await tool.edit(
        file,
        [
          {
            type: 'replace',
            startLine: 1,
            pattern: 'NOT_PRESENT_ANYWHERE',
            replacement: 'x',
          },
        ],
        { createBackup: false }
      );

      expect(result.error).toContain('NOT_PRESENT_ANYWHERE');
    });

    it('leaves the file untouched', async () => {
      await tool.edit(
        file,
        [
          {
            type: 'replace',
            startLine: 1,
            pattern: 'NOT_PRESENT_ANYWHERE',
            replacement: 'x',
          },
        ],
        { createBackup: false }
      );

      expect(readFileSync(file, 'utf8')).toBe(ORIGINAL);
    });

    it('applies NOTHING when one pattern of several misses', async () => {
      // All-or-nothing on purpose: applying the operations that did match would
      // leave the file in a state the caller never asked for.
      const result = await tool.edit(
        file,
        [
          {
            type: 'replace',
            startLine: 1,
            pattern: 'const a = 1;',
            replacement: 'const a = 11;',
          },
          {
            type: 'replace',
            startLine: 3,
            pattern: 'NOT_PRESENT',
            replacement: 'x',
          },
        ],
        { createBackup: false }
      );

      expect(result.success).toBe(false);
      expect(readFileSync(file, 'utf8')).toBe(ORIGINAL);
    });
  });

  describe('a multi-line pattern', () => {
    it('matches across the requested line range', async () => {
      const result = await tool.edit(
        file,
        [
          {
            type: 'replace',
            startLine: 1,
            endLine: 3,
            pattern: 'const a = 1;\\nconst b = 2;',
            replacement: 'const ab = 12;',
          },
        ],
        { createBackup: false }
      );

      expect(result.success).toBe(true);
      expect(readFileSync(file, 'utf8')).toBe(
        ['const ab = 12;', 'const c = 3;'].join('\n')
      );
    });

    it('is reported as applied, not as unchanged', async () => {
      const result = await tool.edit(
        file,
        [
          {
            type: 'replace',
            startLine: 1,
            endLine: 3,
            pattern: 'const a = 1;\\nconst b = 2;',
            replacement: 'const ab = 12;',
          },
        ],
        { createBackup: false }
      );

      expect(result.operation).toBe('applied');
      expect(result.metadata.editsApplied).toBe(1);
    });
  });

  describe('a pattern that matches but reproduces the same text', () => {
    // `replaced === target` was used as a proxy for "did not match". That
    // conflates a pattern that never matched with one that matched and whose
    // replacement rebuilt the same content, so an idempotent edit failed the
    // whole operation. Matching is now asked directly.

    it('is a no-op, not a failure', async () => {
      const result = await tool.edit(
        file,
        [
          {
            type: 'replace',
            startLine: 1,
            pattern: 'const a = 1;',
            replacement: 'const a = 1;',
          },
        ],
        { createBackup: false }
      );

      expect(result.success).toBe(true);
      expect(result.operation).toBe('unchanged');
    });

    it('handles a capture-group substitution that rebuilds the original', async () => {
      const result = await tool.edit(
        file,
        [
          {
            type: 'replace',
            startLine: 1,
            pattern: '(const) (a)',
            replacement: '$1 $2',
          },
        ],
        { createBackup: false }
      );

      expect(result.success).toBe(true);
      expect(readFileSync(file, 'utf8')).toBe(ORIGINAL);
    });

    it('still fails when the pattern genuinely does not match', async () => {
      // The distinction has to cut both ways, or the fix just disables the guard.
      const result = await tool.edit(
        file,
        [
          {
            type: 'replace',
            startLine: 1,
            pattern: 'NOT_HERE',
            replacement: 'NOT_HERE',
          },
        ],
        { createBackup: false }
      );

      expect(result.success).toBe(false);
    });

    it('does not let a /g pattern carry lastIndex between operations', async () => {
      // A global regex is stateful. Probing with the same object would make the
      // outcome depend on what was tested before it.
      const ops = [
        {
          type: 'replace' as const,
          startLine: 1,
          pattern: 'const',
          replacement: 'const',
        },
        {
          type: 'replace' as const,
          startLine: 2,
          pattern: 'const',
          replacement: 'const',
        },
        {
          type: 'replace' as const,
          startLine: 3,
          pattern: 'const',
          replacement: 'const',
        },
      ];
      const result = await tool.edit(file, ops, { createBackup: false });

      expect(result.success).toBe(true);
    });
  });

  describe('behaviour that must not regress', () => {
    it('still applies a matching single-line pattern', async () => {
      const result = await tool.edit(
        file,
        [
          {
            type: 'replace',
            startLine: 2,
            pattern: 'const b = 2;',
            replacement: 'const b = 22;',
          },
        ],
        { createBackup: false }
      );

      expect(result.success).toBe(true);
      expect(readFileSync(file, 'utf8')).toBe(
        ['const a = 1;', 'const b = 22;', 'const c = 3;'].join('\n')
      );
    });

    it('treats a line edit that changes nothing as an ordinary no-op', async () => {
      // Only PATTERN misses are errors. Line-based content that happens to match
      // what is already there is a real no-op and must stay success/unchanged,
      // or every idempotent edit becomes a failure.
      const result = await tool.edit(
        file,
        [
          {
            type: 'replace',
            startLine: 1,
            endLine: 1,
            content: 'const a = 1;',
          },
        ],
        { createBackup: false }
      );

      expect(result.success).toBe(true);
      expect(result.operation).toBe('unchanged');
    });

    it('does not write a .bak next to the edited file', async () => {
      // The backup belongs under the user's home directory; writing it beside
      // the original dirtied the repository it was meant to protect.
      await tool.edit(
        file,
        [
          {
            type: 'replace',
            startLine: 2,
            pattern: 'const b = 2;',
            replacement: 'const b = 22;',
          },
        ],
        { createBackup: true }
      );

      expect(() => readFileSync(`${file}.bak`, 'utf8')).toThrow();
    });
  });
});
