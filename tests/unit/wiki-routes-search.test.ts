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
import { putNodeWithEdges, load, nodeId } from '../../hooks-core/wiki.mjs';
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
 * ONE SERVER AND ONE ISOLATED PROJECT FOR THE WHOLE FILE.
 *
 * Hoisted out of the search describe when the curate tests below arrived: they
 * need exactly this harness -- a real Express app on a real port, and a project
 * whose graph is a temp directory rather than this repo's own -- and standing up
 * a second copy of it in a second file is how two harnesses drift apart.
 */

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

/**
 * The test above only proves Task 1's `rank` primitive works -- it never
 * touches `src/server/wiki-routes.ts`. A route that still filtered with
 * `.includes()` under the hood would pass it just as well. These tests drive
 * the actual HTTP route so a regression back to the substring filter fails
 * here specifically.
 */
describe('/api/wiki/search (the route itself)', () => {
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

/**
 * The curate route's contradict action.
 *
 * `contradict` writes the one edge kind the schema declared and nothing could
 * write, and this switch case is its only door: without it the function is
 * correct, tested, and reachable by nothing -- the defect shape this branch
 * exists to close, arriving from the other side. The reachability guard proves
 * the case EXISTS; only a request proves it works.
 */
describe('/api/wiki/curate (contradict)', () => {
  /** The dashboard's own header, which rejectsCrossSite requires of any POST. */
  const curate = (body: Record<string, unknown>, scope: string) =>
    fetch(`${baseUrl}/api/wiki/curate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-token-optimizer': 'dashboard',
      },
      body: JSON.stringify({ ...body, projectId: scope }),
    });

  function seedPair(graphDir: string) {
    putNodeWithEdges(graphDir, {
      kind: 'finding',
      key: 'old',
      claim: 'f returns 1',
      confidence: 0.9,
    });
    putNodeWithEdges(graphDir, {
      kind: 'finding',
      key: 'new',
      claim: 'f returns 2',
      confidence: 0.9,
    });
  }

  it('records the disagreement as an edge in the graph', async () => {
    const scope = registerIsolatedProject();
    if (!tempGraphDir) throw new Error('fixture graph directory missing');
    seedPair(tempGraphDir);

    const response = await curate(
      { action: 'contradict', key: 'old', byKey: 'new', reason: 're-derived' },
      scope
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    // THE GRAPH, not the response body. A route that answered ok and wrote
    // nothing would pass on the status alone, and the direction matters: the
    // contradictOR is the source, so a route that swapped key and byKey would
    // record the established claim disputing the new one.
    const graph = load(tempGraphDir);
    const edges = graph.edges.filter((e: { edge: string }) => e.edge === 'contradicts');
    expect(edges).toHaveLength(1);
    expect(edges[0].from).toBe(nodeId('finding', 'new'));
    expect(edges[0].to).toBe(nodeId('finding', 'old'));
    // Neither claim is retired: the whole point of an edge over an overwrite.
    expect(graph.nodes.get(nodeId('finding', 'old')).retired).toBeFalsy();
    expect(graph.nodes.get(nodeId('finding', 'old')).claim).toBe('f returns 1');
  });

  it('refuses a request with no byKey, and writes nothing', async () => {
    const scope = registerIsolatedProject();
    if (!tempGraphDir) throw new Error('fixture graph directory missing');
    seedPair(tempGraphDir);

    const response = await curate({ action: 'contradict', key: 'old' }, scope);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'byKey required' });
    expect(
      load(tempGraphDir).edges.some((e: { edge: string }) => e.edge === 'contradicts')
    ).toBe(false);
  });

  it('reports 404 when an end of the disagreement does not resolve', async () => {
    const scope = registerIsolatedProject();
    if (!tempGraphDir) throw new Error('fixture graph directory missing');
    seedPair(tempGraphDir);

    const response = await curate(
      { action: 'contradict', key: 'nope', byKey: 'new', reason: 'x' },
      scope
    );
    // An edge to an id nothing created is an un-invalidatable claim, so curate
    // refuses it and the route must not report success for a write it did not do.
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'no such finding' });
    expect(
      load(tempGraphDir).edges.some((e: { edge: string }) => e.edge === 'contradicts')
    ).toBe(false);
  });
});
