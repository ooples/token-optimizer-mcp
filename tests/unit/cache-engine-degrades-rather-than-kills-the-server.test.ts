import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CacheEngine } from '../../src/core/cache-engine.js';

/**
 * Issue #307: "MCP server exits before registering tools on Windows" -- no
 * stdout, no tools, exit code 1.
 *
 * `src/server/index.ts` builds its cache at module scope (`const cache = new
 * CacheEngine()`), so a constructor that throws takes the whole process down
 * during module evaluation, before `server.connect()` is ever reached. Any
 * unopenable cache file -- wrong permissions, a stale directory at that path, a
 * locked or corrupt DB -- therefore cost the user every tool in the package,
 * and the only explanation went to a stderr the client discards.
 *
 * A cache is an optimization. Losing it must cost persistence, not the server.
 * These tests hold that line: the engine degrades to an in-memory database, says
 * so, and still answers every call.
 */
describe('an unopenable cache degrades instead of throwing', () => {
  const engines: CacheEngine[] = [];
  let fixture: string;

  /** A cache directory whose cache.db path is occupied by a DIRECTORY. */
  function givenUnopenableCache(): string {
    const dir = join(fixture, 'cache');
    mkdirSync(join(dir, 'cache.db'), { recursive: true });
    return dir;
  }

  function track(engine: CacheEngine): CacheEngine {
    engines.push(engine);
    return engine;
  }

  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), 'cache-degrade-'));
    // The constructor narrates its retries; keep the suite output readable.
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    while (engines.length) {
      try {
        engines.pop()?.close();
      } catch {
        /* already closed */
      }
    }
    jest.restoreAllMocks();
    try {
      rmSync(fixture, { recursive: true, force: true });
    } catch {
      /* Windows may hold the handle briefly; the OS reclaims it */
    }
  });

  it('constructs rather than throwing, so the server still boots', () => {
    expect(() => track(new CacheEngine(givenUnopenableCache()))).not.toThrow();
  });

  it('still stores and returns values', () => {
    const engine = track(new CacheEngine(givenUnopenableCache()));

    engine.set('k', 'v', 100, 10);

    expect(engine.get('k')).toBe('v');
  });

  it('says it is degraded, because a silent in-memory cache is a 0% hit rate nobody can see', () => {
    const engine = track(new CacheEngine(givenUnopenableCache()));

    expect(engine.getDegradedReason()).toContain('Failed to initialize');
    expect(engine.getDbPath()).toBe(':memory:');
  });

  it('names the path it could not open, so the user can fix it', () => {
    const dir = givenUnopenableCache();
    const engine = track(new CacheEngine(dir));

    expect(engine.getDegradedReason()).toContain(join(dir, 'cache.db'));
  });

  it('explains itself on stderr -- never stdout, which is the JSON-RPC channel', () => {
    const errors: string[] = [];
    (console.error as jest.Mock).mockImplementation((...args: unknown[]) => {
      errors.push(args.join(' '));
    });

    track(new CacheEngine(givenUnopenableCache()));

    expect(errors.join('\n')).toContain('IN MEMORY ONLY');
  });

  it('still throws under TOKEN_OPTIMIZER_CACHE_STRICT, for callers that would rather fail', () => {
    const previous = process.env.TOKEN_OPTIMIZER_CACHE_STRICT;
    process.env.TOKEN_OPTIMIZER_CACHE_STRICT = '1';
    try {
      expect(() => track(new CacheEngine(givenUnopenableCache()))).toThrow(/CRITICAL/);
    } finally {
      if (previous === undefined) delete process.env.TOKEN_OPTIMIZER_CACHE_STRICT;
      else process.env.TOKEN_OPTIMIZER_CACHE_STRICT = previous;
    }
  });
});

describe('a healthy cache is not marked degraded', () => {
  let fixture: string;
  let engine: CacheEngine | null = null;

  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), 'cache-healthy-'));
  });

  afterEach(() => {
    try {
      engine?.close();
    } catch {
      /* already closed */
    }
    engine = null;
    try {
      rmSync(fixture, { recursive: true, force: true });
    } catch {
      /* Windows may hold the handle briefly */
    }
  });

  it('reports no reason and a real path', () => {
    engine = new CacheEngine(join(fixture, 'cache.db'));

    expect(engine.getDegradedReason()).toBeNull();
    expect(engine.getDbPath()).toBe(join(fixture, 'cache.db'));
  });
});
