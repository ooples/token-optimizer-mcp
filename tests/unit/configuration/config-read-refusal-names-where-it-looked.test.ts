import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { getSmartConfigReadTool } from '../../../src/tools/configuration/smart-config-read.js';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { TokenCounter } from '../../../src/core/token-counter.js';
import { MetricsCollector } from '../../../src/core/metrics.js';
import { toolSchemaMap } from '../../../src/validation/tool-schemas.js';

/**
 * A refusal has to name the part the caller cannot derive.
 *
 * `smart_config_read` resolves a relative target against the SERVER's working
 * directory, which is not the caller's. "Config file not found: ./app.json"
 * is therefore true and useless: the caller is looking at a ./app.json that
 * exists. The absolute path the server actually opened is the half that
 * settles it, so the message carries both.
 *
 * The published schema left `path` an unconstrained string, so an empty one
 * was accepted and refused with a message that named nothing whatsoever.
 */
describe('smart_config_read refusal names where it looked', () => {
  const dirs: string[] = [];
  const caches: CacheEngine[] = [];

  afterEach(() => {
    for (const cache of caches) {
      try {
        cache.close();
      } catch {
        /* a closed cache is the state we want */
      }
    }
    caches.length = 0;
    for (const dir of dirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* the temp dir is the OS's to reclaim */
      }
    }
    dirs.length = 0;
  });

  const tool = () => {
    const dir = mkdtempSync(join(tmpdir(), 'config-read-'));
    dirs.push(dir);
    const cache = new CacheEngine(join(dir, 'c.db'));
    caches.push(cache);
    return getSmartConfigReadTool(
      cache,
      new TokenCounter(),
      new MetricsCollector()
    );
  };

  it('names the absolute path a relative target resolved to', async () => {
    const target = join('definitely-absent-dir', 'app.json');
    await expect(tool().read(target)).rejects.toThrow(
      `Config file not found: ${target} (resolved to ${resolve(target)})`
    );
  });

  it('does not repeat itself when the target is already absolute', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'config-read-abs-'));
    dirs.push(dir);
    const target = join(dir, 'app.json');
    /*
     * An absolute target resolves to itself, so appending "(resolved to ...)"
     * would print the same path twice and read as though two places were
     * checked.
     */
    await expect(tool().read(target)).rejects.toThrow(
      `Config file not found: ${target}`
    );
    await expect(tool().read(target)).rejects.not.toThrow(/resolved to/);
  });

  it('refuses an empty path at the published schema', () => {
    const schema = toolSchemaMap['smart_config_read'];
    expect(schema.safeParse({ path: '' }).success).toBe(false);
    expect(schema.safeParse({ path: 'a'.repeat(4097) }).success).toBe(false);
    expect(schema.safeParse({ path: 'tsconfig.json' }).success).toBe(true);
  });
});
