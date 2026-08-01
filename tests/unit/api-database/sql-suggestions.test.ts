import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { TokenCounter } from '../../../src/core/token-counter.js';
import { MetricsCollector } from '../../../src/core/metrics.js';
import { SmartSql } from '../../../src/tools/api-database/smart-sql.js';

/**
 * A tool for finding slow queries has to find the common ones.
 *
 * smart_sql had five rules -- SELECT *, a WHERE-less UPDATE/DELETE, DISTINCT,
 * OR in a predicate, and a function on a column. All real, and all of them
 * left out the three cheapest wins there are. Measured against queries whose
 * problem was stated in advance, it returned NO suggestions at all for:
 *
 *   SELECT id, name FROM users                       -- reads every row
 *   ... WHERE name LIKE '%smith'                     -- cannot use the index
 *   SELECT id FROM events ORDER BY created_at DESC   -- sorts the whole table
 *
 * A false negative in an advisor is quieter than a false positive and worse:
 * the query stays slow and the tool says it looked.
 *
 * The trailing-wildcard case below is the one that keeps the new LIKE rule
 * honest. `LIKE 'smith%'` uses an index perfectly well, and flagging it would
 * trade three false negatives for a false positive.
 */

const dirs: string[] = [];
const caches: CacheEngine[] = [];

afterEach(() => {
  while (caches.length) {
    try {
      caches.pop()?.close();
    } catch {
      /* already closed */
    }
  }
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

function tool(): SmartSql {
  const dir = mkdtempSync(join(tmpdir(), 'sql-'));
  dirs.push(dir);
  const cache = new CacheEngine(join(dir, 'c.db'));
  caches.push(cache);
  return new SmartSql(cache, new TokenCounter(), new MetricsCollector());
}

/** Every suggestion message for a query, lower-cased. */
async function advice(query: string): Promise<string[]> {
  // force: true, because a tool's cache holds answers computed by the OLD
  // rules -- which is exactly how the first run of this check reported the
  // fix as ineffective.
  const r = await tool().run({ query, operation: 'optimize', force: true });
  return (r.optimization?.suggestions ?? []).map((s) =>
    s.message.toLowerCase()
  );
}

const mentions = (msgs: string[], re: RegExp): boolean =>
  msgs.some((m) => re.test(m));

describe('smart_sql finds the common causes of a slow query', () => {
  it('flags a SELECT with no WHERE and no LIMIT', async () => {
    expect(
      mentions(
        await advice('SELECT id, name FROM users'),
        /where|limit|every row/
      )
    ).toBe(true);
  });

  it('flags a leading wildcard in LIKE', async () => {
    expect(
      mentions(
        await advice("SELECT id FROM users WHERE name LIKE '%smith'"),
        /wildcard|index/
      )
    ).toBe(true);
  });

  it('flags ORDER BY without LIMIT', async () => {
    expect(
      mentions(
        await advice('SELECT id FROM events ORDER BY created_at DESC'),
        /order by|limit/
      )
    ).toBe(true);
  });

  it('still flags what it always flagged', async () => {
    expect(
      mentions(await advice('SELECT * FROM users WHERE id = 1'), /select \*/)
    ).toBe(true);
    expect(
      mentions(
        await advice("SELECT id FROM users WHERE LOWER(email) = 'a@b.c'"),
        /function/
      )
    ).toBe(true);
  });
});

describe('smart_sql does not invent problems', () => {
  it('says nothing about a bounded, indexed query', async () => {
    const msgs = await advice(
      'SELECT id, name FROM users WHERE id = 1 LIMIT 1'
    );
    expect(mentions(msgs, /select \*|every row|wildcard/)).toBe(false);
  });

  it('does not flag a TRAILING wildcard, which uses an index', async () => {
    // The false positive that would undo the new LIKE rule's value.
    const msgs = await advice(
      "SELECT id FROM users WHERE name LIKE 'smith%' LIMIT 10"
    );
    expect(mentions(msgs, /wildcard/)).toBe(false);
  });

  it('does not demand a WHERE on an aggregate', async () => {
    // `SELECT COUNT(*) FROM users` reads every row by definition, and saying
    // so is noise rather than advice.
    const msgs = await advice('SELECT COUNT(*) FROM users');
    expect(mentions(msgs, /every row/)).toBe(false);
  });

  it('does not demand a LIMIT on a query that has one', async () => {
    const msgs = await advice(
      'SELECT id FROM events ORDER BY created_at DESC LIMIT 10'
    );
    expect(mentions(msgs, /order by without limit|sorts every/)).toBe(false);
  });
});
