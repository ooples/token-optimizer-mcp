import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  SmartSecurity,
  runSmartSecurity,
} from '../../../src/tools/code-analysis/smart-security.js';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { TokenCounter } from '../../../src/core/token-counter.js';
import { MetricsCollector } from '../../../src/core/metrics.js';

/**
 * A SCAN THAT OPENED NO FILE MUST NOT READ AS A CLEAN ONE.
 *
 * `success` means "no critical or high findings", and over an empty file set
 * that was trivially true -- so a request this tool could not resolve rendered
 * as a green `Secure (no critical/high issues)`, identical to a scan that read
 * the code and found it clean.
 *
 * Measured over the bench fixtures before the fix, four of eight ways of naming
 * a target produced exactly that: an absolute path in `targets` (either
 * separator), a directory given by absolute path, and a path that simply does
 * not exist. The cause of the first three was `join(projectRoot, target)`,
 * which turns an absolute target into a path under the root that cannot exist,
 * after which the miss was skipped without a word.
 *
 * The fourth case is the one no amount of better path handling fixes: a caller
 * can always name something that is not there, and the only honest answer is
 * to refuse rather than to pass.
 */
describe('a security scan that examined nothing', () => {
  let root: string;
  let tool: SmartSecurity;
  let cache: CacheEngine;
  let cacheDirWas: string | undefined;

  const run = (options: Record<string, unknown>) =>
    tool.run({ force: true, projectRoot: root, ...options });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'security-targets-'));
    // `runSmartSecurity` builds its own CacheEngine under the real home. The
    // text cases below call it, so the one knob that moves it is set here --
    // no test may write to the operator's own cache.
    cacheDirWas = process.env.TOKEN_OPTIMIZER_CACHE_DIR;
    process.env.TOKEN_OPTIMIZER_CACHE_DIR = mkdtempSync(
      join(tmpdir(), 'security-cli-cache-')
    );
    writeFileSync(join(root, 'app.ts'), 'export const value = 1;');
    mkdirSync(join(root, 'config'));
    // Holds nothing with a scannable extension, which is a real way to ask for
    // a scan and get none.
    writeFileSync(join(root, 'config', 'settings.json'), '{}');
    // A CACHE PER TEST, NEVER THE REAL HOME. A shared cache would let one case
    // answer for another, which is the failure mode being tested here.
    cache = new CacheEngine(
      mkdtempSync(join(tmpdir(), 'security-cache-')),
      100
    );
    tool = new SmartSecurity(
      cache,
      new TokenCounter(),
      new MetricsCollector(),
      root
    );
  });

  afterEach(() => {
    tool.close();
    if (cacheDirWas === undefined) delete process.env.TOKEN_OPTIMIZER_CACHE_DIR;
    else process.env.TOKEN_OPTIMIZER_CACHE_DIR = cacheDirWas;
    rmSync(root, { recursive: true, force: true });
  });

  describe('resolves the targets it is given', () => {
    it('scans an absolute path in targets', async () => {
      const out = await run({ targets: [join(root, 'app.ts')] });
      // ONE, NOT ZERO. Joining an absolute target onto the root made this 0.
      expect(out.summary.filesScanned).toBe(1);
      expect(out.summary.scannedNothing).toBeUndefined();
    });

    it('scans a directory given by absolute path', async () => {
      const out = await run({ targets: [root] });
      expect(out.summary.filesScanned).toBe(1);
    });

    it('scans a relative path in targets', async () => {
      const out = await run({ targets: ['app.ts'] });
      expect(out.summary.filesScanned).toBe(1);
    });

    it('scans a file named through the filePath alias', async () => {
      // The name every other tool here uses for its subject. It was dropped by
      // the schema, so the implementation scanned the whole project and the
      // findings were reported as this one file's.
      const out = await run({ filePath: 'app.ts' });
      expect(out.summary.filesScanned).toBe(1);
    });

    it('scans an explicitly named file whatever its extension', async () => {
      // The extension filter exists to keep a BLIND walk cheap. The caller
      // named this one, so there is nothing for it to decide.
      const out = await run({ targets: [join('config', 'settings.json')] });
      expect(out.summary.filesScanned).toBe(1);
    });
  });

  describe('refuses rather than passing', () => {
    it('names a target that does not exist', async () => {
      const out = await run({ targets: ['nope.ts'] });
      expect(out.summary.filesScanned).toBe(0);
      expect(out.summary.scannedNothing).toBe(true);
      // THE ASSERTION THAT WOULD HAVE CAUGHT THIS: `success` was true here.
      expect(out.summary.success).toBe(false);
      expect(out.summary.unresolvedTargets).toEqual([
        {
          target: 'nope.ts',
          resolvedTo: join(root, 'nope.ts'),
          reason: 'missing',
        },
      ]);
      // Both halves: what was asked for, and where it was looked for -- the
      // second is the half a caller cannot work out alone.
      expect(out.summary.refusal).toContain('nope.ts');
      expect(out.summary.refusal).toContain(join(root, 'nope.ts'));
    });

    it('names a directory holding no scannable file', async () => {
      const out = await run({ targets: ['config'] });
      expect(out.summary.scannedNothing).toBe(true);
      expect(out.summary.unresolvedTargets?.[0]?.reason).toBe(
        'noScannableFile'
      );
    });

    it('names the project root when a full scan finds nothing', async () => {
      const empty = mkdtempSync(join(tmpdir(), 'security-empty-'));
      const bare = new SmartSecurity(
        cache,
        new TokenCounter(),
        new MetricsCollector(),
        empty
      );
      try {
        const out = await bare.run({ force: true, projectRoot: empty });
        expect(out.summary.scannedNothing).toBe(true);
        expect(out.summary.success).toBe(false);
        expect(out.summary.unresolvedTargets?.[0]?.target).toBe(empty);
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
    });

    it('claims no token saving for a file it never read', async () => {
      const out = await run({ targets: ['nope.ts'] });
      /*
       * THE REFUSAL USED TO CARRY A ZEROED metrics BLOCK, which was the right
       * instinct reached the wrong way: a measured zero still asserts that
       * somebody measured. The block is gone from every path of this tool now,
       * so the refusal is checked for the absence instead -- and the absence
       * is the stronger statement, because a zero can be summed and an absent
       * field cannot.
       */
      expect(out).not.toHaveProperty('metrics');
      expect(out.findingsBySeverity).toEqual([]);
      // THE POSITIVE CONTROL: the refusal really is the shape under test, so
      // the missing field above is not a missing reply.
      expect(out.summary.scannedNothing).toBe(true);
    });

    it('says the deadline stopped it, not that the path was wrong', async () => {
      // THE TWO REFUSALS ARE DIFFERENT ANSWERS and only one is the caller's to
      // fix. A bound that fires before anything is found must not be reported
      // as an unresolvable target -- discovery never got far enough to decide.
      // ONE FILE, FORTY LEVELS DOWN. The walk is breadth-first and checks the
      // deadline before every directory after the first, so reaching the file
      // inside 1ms would take forty readdir calls in under a millisecond. A
      // flat tree cannot test this at all: its file is found in the first pass,
      // which no deadline check precedes.
      const nested = mkdtempSync(join(tmpdir(), 'security-nested-'));
      let deep = nested;
      for (let level = 0; level < 40; level += 1) {
        deep = join(deep, `level-${level}`);
        mkdirSync(deep);
      }
      writeFileSync(join(deep, 'app.ts'), 'export const value = 1;');
      const slow = new SmartSecurity(
        cache,
        new TokenCounter(),
        new MetricsCollector(),
        nested
      );
      let out;
      try {
        out = await slow.run({
          force: true,
          projectRoot: nested,
          deadlineMs: 1,
        });
      } finally {
        rmSync(nested, { recursive: true, force: true });
      }
      expect(out.summary.filesScanned).toBe(0);
      expect(out.summary.scannedNothing).toBe(true);
      expect(out.summary.searchTruncated).toBe(true);
      expect(out.summary.searchTruncatedBy).toBe('deadline');
      expect(out.summary.unresolvedTargets).toEqual([]);
      expect(out.summary.refusal).toContain('does NOT mean');
    });

    it('does not serve one refusal in answer to another', async () => {
      // An empty file set hashes to ONE cache key, so a cached refusal would
      // answer for any other unresolvable target. `force: false` is the mode
      // where that would happen.
      const first = await tool.run({ projectRoot: root, targets: ['nope.ts'] });
      expect(first.summary.scannedNothing).toBe(true);
      const second = await tool.run({
        projectRoot: root,
        targets: ['other-missing.ts'],
      });
      expect(second.summary.fromCache).toBe(false);
      expect(second.summary.unresolvedTargets?.[0]?.target).toBe(
        'other-missing.ts'
      );
    });
  });

  describe('the text a caller actually reads', () => {
    it('does not print a pass over zero files', async () => {
      const text = await runSmartSecurity({
        force: true,
        projectRoot: root,
        targets: ['nope.ts'],
      });
      expect(text).toContain('SCANNED NOTHING');
      // The exact string the old code printed here. A reader who sees
      // `Files Scanned: 0` under a green status reads the status.
      expect(text).not.toContain('Secure (no critical/high issues)');
      expect(text).toContain('no such file or directory');
    });

    it('still prints a pass when files really were scanned', async () => {
      const text = await runSmartSecurity({
        force: true,
        projectRoot: root,
        targets: ['app.ts'],
      });
      // THE OTHER DIRECTION. A refusal that fires on a clean scan would be the
      // same defect with the sign flipped.
      expect(text).toContain('Secure (no critical/high issues)');
      expect(text).not.toContain('SCANNED NOTHING');
    });
  });
});
