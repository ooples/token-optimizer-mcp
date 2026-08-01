import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { TokenCounter } from '../../../src/core/token-counter.js';
import { MetricsCollector } from '../../../src/core/metrics.js';
import { SmartGraphQL } from '../../../src/tools/api-database/smart-graphql.js';

/**
 * The analysis has to be RIGHT, not merely small.
 *
 * smart_graphql's parser ran one regex across the whole query, deduplicated
 * field names globally, and returned every identifier as a top-level
 * selection. There was no tree, so every analysis built on one was guesswork.
 * On the query below it reported:
 *
 *   - `settings` as a high-severity N+1 -- a plain object, flagged because
 *     `isLikelyList` was `name.endsWith('s')`
 *   - no problem at all on `posts(first: 20) { comments(first: 10) }`, which is
 *     the actual N+1 and the reason the query was written
 *   - three fragment suggestions, two of them the SAME field set counted twice,
 *     one named `bodyFragment` for a group containing no `body`
 *   - `reason: "Field group repeated 23 times"` beside `usage: 23`
 *
 * Getting this wrong is worse than returning nothing: a false N+1 sends
 * somebody to optimise a field that was never a problem, while the real one
 * keeps costing 200 round trips.
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

function tool(): SmartGraphQL {
  const dir = mkdtempSync(join(tmpdir(), 'gql-'));
  dirs.push(dir);
  const cache = new CacheEngine(join(dir, 'c.db'));
  caches.push(cache);
  return new SmartGraphQL(cache, new TokenCounter(), new MetricsCollector());
}

/** A list inside a list, and an object that merely ends in 's'. */
const DASHBOARD = `
  query GetUserDashboard($id: ID!) {
    user(id: $id) {
      id name email avatarUrl createdAt
      posts(first: 20) {
        id title body publishedAt
        comments(first: 10) { id body author { id name avatarUrl } }
        tags { id label }
      }
      followers(first: 50) { id name avatarUrl }
      settings { theme locale notifications { email push sms } }
    }
  }`;

describe('smart_graphql finds the real N+1', () => {
  it('flags a list nested inside a list', async () => {
    const r = await tool().run({ query: DASHBOARD, useCache: false });
    const fields = r.optimizations!.n1Problems.map((p) => p.field);
    expect(fields).toContain('user.posts.comments');
  });

  it('quantifies the cost from the pagination arguments', async () => {
    // "There is an N+1 here" is a fact; "up to 200 resolutions" is an argument.
    const r = await tool().run({ query: DASHBOARD, useCache: false });
    const problem = r.optimizations!.n1Problems.find(
      (p) => p.field === 'user.posts.comments'
    )!;
    expect(problem.location).toContain('20 x 10 = 200');
    expect(problem.severity).toBe('high');
  });

  it('does NOT flag an object that merely ends in "s"', async () => {
    // `settings` was reported as high severity by `name.endsWith('s')`.
    const r = await tool().run({ query: DASHBOARD, useCache: false });
    const fields = r.optimizations!.n1Problems.map((p) => p.field);
    expect(fields.some((f) => f.endsWith('settings'))).toBe(false);
  });

  it('reports nothing for a query with no nested list', async () => {
    const r = await tool().run({
      query: '{ user(id: 1) { id name settings { theme locale } } }',
      useCache: false,
    });
    expect(r.optimizations!.n1Problems).toHaveLength(0);
  });

  it('understands a Relay connection', async () => {
    const r = await tool().run({
      query: `{ user { posts(first: 5) { edges { node {
                 id comments(first: 3) { edges { node { id } } } } } } } }`,
      useCache: false,
    });
    expect(r.optimizations!.n1Problems.length).toBeGreaterThan(0);
  });
});

describe('smart_graphql suggests fragments that make sense', () => {
  it('does not report the same field set twice', async () => {
    const r = await tool().run({ query: DASHBOARD, useCache: false });
    const keys = r.optimizations!.fragmentSuggestions.map((f) =>
      [...f.fields].sort().join(',')
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('names a fragment after the fields it contains', async () => {
    // `bodyFragment` described {avatarUrl, id, name}.
    const r = await tool().run({ query: DASHBOARD, useCache: false });
    for (const f of r.optimizations!.fragmentSuggestions) {
      const lower = f.name.toLowerCase();
      expect(
        f.fields.some((field) => lower.includes(field.toLowerCase()))
      ).toBe(true);
    }
  });

  it('only suggests a fragment for a genuinely repeated group', async () => {
    const r = await tool().run({ query: DASHBOARD, useCache: false });
    for (const f of r.optimizations!.fragmentSuggestions) {
      expect(f.usage).toBeGreaterThanOrEqual(2);
    }
  });

  it('drops the prose that restated the count', async () => {
    // `reason: "Field group repeated 23 times"` beside `usage: 23`.
    const r = await tool().run({ query: DASHBOARD, useCache: false });
    for (const f of r.optimizations!.fragmentSuggestions) {
      expect(f).not.toHaveProperty('reason');
    }
  });
});

describe('the parser builds a real tree', () => {
  it('keeps a field that appears in two places', async () => {
    // The old parser had a global `seenFields` set, so a repeated field was
    // recorded once -- erasing the repetition fragments exist to find.
    const r = await tool().run({
      query: '{ a { id name } b { id name } }',
      useCache: false,
    });
    expect(r.optimizations!.fragmentSuggestions[0]?.usage).toBe(2);
  });

  it('does not mistake an alias for the field', async () => {
    const r = await tool().run({
      query: '{ recent: posts(first: 5) { comments(first: 2) { id } } }',
      useCache: false,
    });
    expect(r.optimizations!.n1Problems[0]?.field).toContain('posts.comments');
  });

  it('is not confused by a directive with arguments', async () => {
    const r = await tool().run({
      query:
        '{ posts(first: 4) @include(if: true) { comments(first: 2) { id } } }',
      useCache: false,
    });
    expect(r.optimizations!.n1Problems.length).toBeGreaterThan(0);
  });
});
