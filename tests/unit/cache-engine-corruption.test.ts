/**
 * Regression tests: CacheEngine must self-heal from a corrupt / invalid SQLite
 * database file instead of failing to construct.
 *
 * A partially-written file, a crashed process, or a stray non-DB file at the
 * cache path makes better-sqlite3 throw SQLITE_NOTADB on open. Previously the
 * recovery (delete + recreate) only ran on the 2nd of 3 attempts, so a single
 * failed delete stranded the remaining attempt and construction threw. Now the
 * corrupt DB + WAL/SHM sidecars are removed on every retry.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { CacheEngine } from '../../src/core/cache-engine.js';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('CacheEngine corrupt-database self-heal', () => {
  const dirs: string[] = [];
  const engines: CacheEngine[] = [];

  afterEach(() => {
    while (engines.length) {
      try {
        engines.pop()?.close();
      } catch {
        // already closed
      }
    }
    while (dirs.length) {
      const d = dirs.pop();
      if (d) {
        try {
          rmSync(d, { recursive: true, force: true });
        } catch {
          // OS reclaims later on Windows
        }
      }
    }
  });

  function tempDbPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'token-optimizer-corrupt-'));
    dirs.push(dir);
    return join(dir, 'cache.db');
  }

  function open(dbPath: string): CacheEngine {
    const engine = new CacheEngine(dbPath, 100);
    engines.push(engine);
    return engine;
  }

  it('recovers when the database file is not a valid SQLite database', () => {
    const dbPath = tempDbPath();
    // Simulate a corrupt / partially-written DB: a non-empty, non-SQLite file.
    writeFileSync(dbPath, 'this is definitely not a sqlite database header');

    // Construction must not throw — the invalid file is deleted and recreated.
    const engine = open(dbPath);

    // ...and the engine is fully usable afterwards.
    expect(engine.getDatabasePath()).toBe(dbPath);
    engine.set('k', 'hello world', 11, 11);
    expect(engine.get('k')).toBe('hello world');
    expect(engine.getStats().totalEntries).toBe(1);
  });

  it('recovers when stale WAL/SHM sidecars accompany a corrupt db', () => {
    const dbPath = tempDbPath();
    writeFileSync(dbPath, 'corrupt-main');
    writeFileSync(`${dbPath}-wal`, 'stale-wal');
    writeFileSync(`${dbPath}-shm`, 'stale-shm');

    const engine = open(dbPath);
    engine.set('a', 'b', 1, 1);
    expect(engine.get('a')).toBe('b');
  });
});
