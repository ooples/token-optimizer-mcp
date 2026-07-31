import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { gzipSync } from 'zlib';
import { CacheEngine } from '../../src/core/cache-engine.js';
import { readCompressedJson } from '../../src/utils/cache-helper.js';

/**
 * A cache must never be able to make a correct answer impossible.
 *
 * Several tools stored gzip with `buffer.toString()` -- no encoding, so utf8,
 * which replaces every invalid byte sequence and cannot be reversed. Measured
 * on real data: 154 gzip bytes come back as 263 different ones.
 *
 * Fixing the WRITE was not enough, and that is the part worth remembering.
 * An installation that had already run the tool kept the poisoned entry; the
 * read path let the exception escape; the tool returned "incorrect header
 * check" on every subsequent call, for ever, because nothing ever replaced the
 * bad value. Upgrading did not help. Only deleting the cache by hand did.
 *
 * It was found by running the tool against a cache that predated the fix --
 * a state no clean-cache test can reach.
 */

let dir: string;
let cache: CacheEngine;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'poison-'));
  cache = new CacheEngine(join(dir, 'cache.db'));
});

afterEach(() => {
  try { cache.close(); } catch { /* */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
});

/** Writes an entry exactly the way the broken version did. */
function poison(key: string, value: unknown): void {
  const gz = gzipSync(Buffer.from(JSON.stringify(value)));
  cache.set(key, gz.toString(), 0, gz.length); // no encoding => utf8 => ruined
}

describe('the encoding itself', () => {
  it('utf8 destroys gzip, and base64 does not', () => {
    // The premise of the whole bug, stated as a fact rather than assumed.
    const gz = gzipSync(Buffer.from(JSON.stringify({ hello: 'world'.repeat(20) })));

    const viaUtf8 = Buffer.from(gz.toString(), 'utf-8');
    expect(viaUtf8.equals(gz)).toBe(false);

    const viaBase64 = Buffer.from(gz.toString('base64'), 'base64');
    expect(viaBase64.equals(gz)).toBe(true);
  });
});

describe('reading a compressed cache entry', () => {
  it('returns the value when the entry is sound', () => {
    const gz = gzipSync(Buffer.from(JSON.stringify({ answer: 42 })));
    cache.set('good', gz.toString('base64'), 0, gz.length);

    expect(readCompressedJson<{ answer: number }>(cache, cache.get('good'), 'good'))
      .toEqual({ answer: 42 });
  });

  it('reports a MISS rather than throwing on an entry the old version wrote', () => {
    poison('poisoned', { answer: 42 });
    // Throwing here is what surfaced "incorrect header check" to the user.
    expect(() =>
      readCompressedJson(cache, cache.get('poisoned'), 'poisoned')
    ).not.toThrow();
    expect(readCompressedJson(cache, cache.get('poisoned'), 'poisoned')).toBeNull();
  });

  it('FORGETS the unreadable entry, so the next write can replace it', () => {
    // Skipping the bad value without removing it leaves the cache permanently
    // unable to serve that key -- correct answers, zero cache, for ever.
    poison('poisoned', { answer: 42 });
    readCompressedJson(cache, cache.get('poisoned'), 'poisoned');
    expect(cache.get('poisoned')).toBeNull();
  });

  it('treats an absent entry as a miss without touching the cache', () => {
    expect(readCompressedJson(cache, null, 'never-set')).toBeNull();
    expect(readCompressedJson(cache, undefined, 'never-set')).toBeNull();
  });

  it('reports a miss for a value that is not compressed at all', () => {
    cache.set('garbage', 'this is not gzip', 0, 16);
    expect(readCompressedJson(cache, cache.get('garbage'), 'garbage')).toBeNull();
  });
});

describe('no tool stringifies a compressed buffer without an encoding', () => {
  it('has no `Compressed.toString()` left in src', () => {
    // The exact shape of the original defect. `decompressed.toString()` is
    // fine -- that is text -- so only *compressed* buffers are matched.
    const offenders: string[] = [];
    const walk = (d: string): void => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.ts')) continue;

        const text = readFileSync(full, 'utf8');
        text.split('\n').forEach((line, i) => {
          if (line.trim().startsWith('//') || line.trim().startsWith('*')) return;
          if (/\bcompress(ionResult)?(\.compressed)?\.toString\(\s*\)/.test(line) ||
              /\b\w*Compressed\.toString\(\s*\)/.test(line)) {
            offenders.push(`${full.replace(process.cwd(), '')}:${i + 1}: ${line.trim()}`);
          }
        });
      }
    };
    walk(join(process.cwd(), 'src'));
    expect(offenders).toEqual([]);
  });
});
