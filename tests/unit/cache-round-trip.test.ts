import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  compress,
  decompress,
} from '../../src/tools/shared/compression-utils.js';

/**
 * A cache entry must be readable by the code that wrote it.
 *
 * smart_pretty wrote its compressed entry with `compressed.toString()` -- no
 * encoding, so utf8 -- and read it back with `Buffer.from(cached, 'base64')`.
 * utf8 mangles binary gzip irreversibly, so the entry could never be decoded
 * again. One call poisoned its own cache and EVERY later call failed with
 * "incorrect header check", permanently, until the cache file was deleted by
 * hand.
 *
 * No single-shot test could catch it: the first call in a clean cache succeeds
 * and returns a correct answer. It only appears on the second call, which is
 * why calling the tools repeatedly -- using them the way a person would -- is
 * what surfaced it.
 */
describe('compressed cache entries survive a round trip', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) {
      const d = dirs.pop();
      if (d) {
        try {
          rmSync(d, { recursive: true, force: true });
        } catch {
          /* windows */
        }
      }
    }
  });

  it('utf8 destroys gzip bytes, which is why the encoding must be explicit', () => {
    const payload = JSON.stringify({
      code: 'const x = 1;',
      language: 'typescript',
    });
    const { compressed } = compress(payload, 'gzip');

    // What the old write path did.
    const throughUtf8 = Buffer.from(compressed.toString(), 'base64');
    expect(() => decompress(throughUtf8, 'gzip')).toThrow();

    // What it does now.
    const throughBase64 = Buffer.from(compressed.toString('base64'), 'base64');
    expect(decompress(throughBase64, 'gzip').toString()).toBe(payload);
  });

  it('no tool writes a compressed buffer without naming the encoding', () => {
    // The specific shape of the bug: `<something>.compressed.toString()`.
    const offenders: string[] = [];
    const root = join(process.cwd(), 'src');

    (function walk(dir: string) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (
          entry.name.endsWith('.ts') &&
          !entry.name.endsWith('.test.ts')
        ) {
          const src = readFileSync(full, 'utf8');
          for (const m of src.matchAll(
            /\w*[Cc]ompress\w*\.compressed\.toString\(\)/g
          )) {
            offenders.push(`${entry.name}: ${m[0]}`);
          }
        }
      }
    })(root);

    expect(offenders).toEqual([]);
  });

  it('a real tool can read back what it just wrote', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'token-optimizer-roundtrip-'));
    dirs.push(dir);

    const { CacheEngine } = await import('../../src/core/cache-engine.js');
    const { TokenCounter } = await import('../../src/core/token-counter.js');
    const { MetricsCollector } = await import('../../src/core/metrics.js');
    const mod: Record<string, unknown> = await import(
      '../../src/tools/output-formatting/smart-pretty.js'
    );

    const cache = new CacheEngine(join(dir, 'c.db'));
    try {
      const ToolClass = (mod.SmartPretty ?? mod.SmartPrettyTool) as new (
        c: unknown,
        t: unknown,
        m: unknown
      ) => { run(args: unknown): Promise<unknown> };

      const tool = new ToolClass(
        cache,
        new TokenCounter(),
        new MetricsCollector()
      );
      const args = {
        operation: 'format-code',
        code: 'const   x=1',
        language: 'typescript',
      };

      await expect(tool.run(args)).resolves.toBeDefined();
      // The second call is the one that reads what the first wrote.
      await expect(tool.run(args)).resolves.toBeDefined();
    } finally {
      try {
        cache.close();
      } catch {
        /* already closed */
      }
    }
  });
});
