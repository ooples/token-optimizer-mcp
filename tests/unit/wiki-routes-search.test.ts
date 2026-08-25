import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { app } from '../../src/server/web-server.js';
import { putNodeWithEdges } from '../../hooks-core/wiki.mjs';
import { registerProject } from '../../hooks-core/projects.mjs';

const lexical = await import(
  pathToFileURL(join(process.cwd(), 'hooks-core', 'lexical.mjs')).href
);

describe('lexical.rank (the primitive the route now calls)', () => {
  it('ranks a specific claim above a repetitive one', () => {
    const findings = [
      { key: 'a', claim: 'the retry backoff is capped at thirty seconds' },
      { key: 'b', claim: 'retry retry retry' },
    ];
    const ranked = lexical.rank('retry backoff', findings);
    expect(ranked[0].finding.key).toBe('a');
  });
});

/**
 * The test above only proves Task 1's `rank` primitive works -- it never
 * touches `src/server/wiki-routes.ts`. A route that still filtered with
 * `.includes()` under the hood would pass it just as well. These tests drive
 * the actual HTTP route so a regression back to the substring filter fails
 * here specifically.
 */
describe('/api/wiki/search (the route itself)', () => {
  let server: Server;
  let baseUrl: string;
  let originalRegistry: string | undefined;
  let tempRoot: string | null = null;
  let tempGraphDir: string | null = null;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  afterEach(() => {
    if (originalRegistry === undefined)
      delete process.env.TOKEN_OPTIMIZER_PROJECT_REGISTRY;
    else process.env.TOKEN_OPTIMIZER_PROJECT_REGISTRY = originalRegistry;
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
    if (tempGraphDir) {
      rmSync(tempGraphDir, { recursive: true, force: true });
      tempGraphDir = null;
    }
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  /**
   * Registers an isolated project (its own fake ".git" root, its own graph
   * directory, and its own project registry file) so the request never reads
   * or writes the real machine-wide registry or the real "current project"
   * graph rooted at this process's cwd.
   */
  function registerIsolatedProject(): string {
    tempRoot = mkdtempSync(join(tmpdir(), 'wiki-routes-search-root-'));
    mkdirSync(join(tempRoot, '.git'));
    tempGraphDir = mkdtempSync(join(tmpdir(), 'wiki-routes-search-graph-'));

    originalRegistry = process.env.TOKEN_OPTIMIZER_PROJECT_REGISTRY;
    process.env.TOKEN_OPTIMIZER_PROJECT_REGISTRY = join(
      mkdtempSync(join(tmpdir(), 'wiki-routes-search-registry-')),
      'projects.jsonl'
    );

    const project = registerProject({
      root: tempRoot,
      graphDir: tempGraphDir,
      client: 'test',
    });
    if (!project) throw new Error('registerProject failed to register the fixture');
    return project.id;
  }

  it('ranks by BM25, not substring order, and orders results by relevance not confidence', async () => {
    const scope = registerIsolatedProject();
    if (!tempGraphDir) throw new Error('fixture graph directory missing');

    // "b" is given a much higher confidence than "a". Under the OLD code the
    // route filtered by substring and then ALWAYS sorted by
    // confidence*origin*pinned, regardless of whether a query was present --
    // so "b" would have outranked "a" once both had passed the substring
    // filter. Under the NEW code, a query present means BM25 relevance
    // decides order and the confidence sort is skipped entirely.
    //
    // The query "retry backoff" also could never match "retry retry retry"
    // under the OLD literal-substring filter (that exact phrase never
    // appears in the claim), whereas BM25 matches on the individual terms
    // "retry" and "backoff" -- so its presence in the results at all is
    // itself proof the route stopped using `.includes()`.
    putNodeWithEdges(tempGraphDir, {
      kind: 'finding',
      key: 'a',
      claim: 'the retry backoff is capped at thirty seconds',
      confidence: 0.4,
    });
    putNodeWithEdges(tempGraphDir, {
      kind: 'finding',
      key: 'b',
      claim: 'retry retry retry',
      confidence: 0.99,
    });

    const response = await fetch(
      `${baseUrl}/api/wiki/search?${new URLSearchParams({
        q: 'retry backoff',
        scope,
        limit: '50',
      })}`
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      total: number;
      offset: number;
      items: Array<{ key: string }>;
    };

    // Both findings score > 0 under BM25 (term-level matching), so both are
    // returned -- the old substring filter would have returned only "a".
    expect(body.items.map((item) => item.key)).toEqual(['a', 'b']);
    expect(body.total).toBe(2);
    expect(body.offset).toBe(0);
  });

  it('keeps the confidence*origin*pinned sort when there is no query', async () => {
    const scope = registerIsolatedProject();
    if (!tempGraphDir) throw new Error('fixture graph directory missing');

    putNodeWithEdges(tempGraphDir, {
      kind: 'finding',
      key: 'low-confidence',
      claim: 'an unrelated finding about caching',
      confidence: 0.3,
    });
    putNodeWithEdges(tempGraphDir, {
      kind: 'finding',
      key: 'high-confidence',
      claim: 'a different finding about retries',
      confidence: 0.95,
    });

    const response = await fetch(
      `${baseUrl}/api/wiki/search?${new URLSearchParams({
        scope,
        limit: '50',
      })}`
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Array<{ key: string }>;
    };

    expect(body.items.map((item) => item.key)).toEqual([
      'high-confidence',
      'low-confidence',
    ]);
  });

  /**
   * Demonstrated regression: `q=%20` is truthy, so `if (query)` alone sent
   * it into the BM25 branch, `tokenize(' ')` produced no terms, and `rank`
   * returned nothing -- a blank search box went from showing (nearly)
   * everything, under the old `.includes(' ')` filter, to showing nothing.
   * A query that tokenizes to zero terms must fall through to the same
   * no-query branch as an actually-empty `q=`, not a distinct "search that
   * matches nothing" branch.
   */
  it.each([
    ['a single space', ' '],
    ['punctuation only', '!!! ,,, ???'],
  ])('treats a query that tokenizes to nothing (%s) the same as no query at all', async (_label, q) => {
    const scope = registerIsolatedProject();
    if (!tempGraphDir) throw new Error('fixture graph directory missing');

    putNodeWithEdges(tempGraphDir, {
      kind: 'finding',
      key: 'low-confidence',
      claim: 'an unrelated finding about caching',
      confidence: 0.3,
    });
    putNodeWithEdges(tempGraphDir, {
      kind: 'finding',
      key: 'high-confidence',
      claim: 'a different finding about retries',
      confidence: 0.95,
    });

    const blankResponse = await fetch(
      `${baseUrl}/api/wiki/search?${new URLSearchParams({ q, scope, limit: '50' })}`
    );
    const noQueryResponse = await fetch(
      `${baseUrl}/api/wiki/search?${new URLSearchParams({ scope, limit: '50' })}`
    );
    expect(blankResponse.status).toBe(200);
    const blankBody = (await blankResponse.json()) as {
      total: number;
      items: Array<{ key: string }>;
    };
    const noQueryBody = (await noQueryResponse.json()) as {
      total: number;
      items: Array<{ key: string }>;
    };

    // Not empty, and identical to the no-query response: both surfaces of
    // "nothing meaningful to search for" must agree.
    expect(blankBody.items.map((item) => item.key)).toEqual([
      'high-confidence',
      'low-confidence',
    ]);
    expect(blankBody).toEqual(noQueryBody);
  });
});
