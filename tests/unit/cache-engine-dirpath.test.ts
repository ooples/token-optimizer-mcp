import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, existsSync, statSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CacheEngine } from '../../src/core/cache-engine.js';

/**
 * Regression test: CacheEngine must tolerate being handed a cache *directory*
 * as its `dbPath`. Older callers (and upgraders with a pre-existing
 * ~/.hypercontext/cache/ directory) passed a directory here; the constructor
 * previously tried to open the directory as a SQLite file and failed with
 * "unable to open database file". It should instead place cache.db inside it.
 */
describe('CacheEngine directory-path tolerance', () => {
  const tempDirs: string[] = [];
  const engines: CacheEngine[] = [];

  afterEach(() => {
    while (engines.length) {
      try {
        engines.pop()?.close();
      } catch {
        /* already closed */
      }
    }
    while (tempDirs.length) {
      const dir = tempDirs.pop();
      if (dir) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* Windows may hold the handle briefly; OS reclaims it */
        }
      }
    }
  });

  function tempRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'token-optimizer-cacheengine-'));
    tempDirs.push(dir);
    return dir;
  }

  function track(engine: CacheEngine): CacheEngine {
    engines.push(engine);
    return engine;
  }

  it('opens cache.db inside an existing directory passed as dbPath', () => {
    const root = tempRoot();
    const cacheDirAsPath = join(root, 'cache');
    mkdirSync(cacheDirAsPath, { recursive: true }); // simulate the stale dir layout

    // Should NOT throw "unable to open database file".
    const engine = track(new CacheEngine(cacheDirAsPath));

    // The DB file should live inside the directory, not replace it.
    expect(statSync(cacheDirAsPath).isDirectory()).toBe(true);
    expect(existsSync(join(cacheDirAsPath, 'cache.db'))).toBe(true);

    // And it should be a working cache.
    engine.set('k', 'v', 1, 1);
    expect(engine.get('k')).toBe('v');
  });

  it('still treats a non-existent dbPath as a database file path', () => {
    const root = tempRoot();
    const filePath = join(root, 'mycache.db');

    const engine = track(new CacheEngine(filePath));

    expect(existsSync(filePath)).toBe(true);
    expect(statSync(filePath).isFile()).toBe(true);
  });
});
