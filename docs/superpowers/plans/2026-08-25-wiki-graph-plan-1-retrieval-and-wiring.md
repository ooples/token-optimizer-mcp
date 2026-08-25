# Wiki Graph Plan 1 — Retrieval and Wiring

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the graph readable and its declared wiring live — ship `wiki_query`, real BM25, and connect the five capabilities that are declared, tested, and called by nothing.

**Architecture:** All graph logic lives in `hooks-core/*.mjs` and is vendored into eleven client copies by `npm run sync:hooks`; never edit a copy. MCP tools in `src/tools/**` reach hooks-core through dynamic `import(coreUrl('x.mjs'))`, following `src/tools/intelligence/wiki-write.ts`. Retrieval is traversal plus lexical, no embeddings.

**Tech Stack:** Node 22 ESM (`.mjs`) for hooks-core, TypeScript for `src/`, Jest (`tests/hooks/*.test.mjs`, `tests/unit/*.test.ts`), Express for the dashboard.

**Spec:** `docs/superpowers/specs/2026-08-25-wiki-graph-gap-closure-design.md`

## Global Constraints

- **Never edit a vendored copy.** Edit `hooks-core/<file>.mjs`, then run `npm run sync:hooks`. CI runs `npm run sync:hooks:check`.
- **Fail open.** A defect in the optimizer must never cost the user a tool call. Every hook path wraps its work in try/catch and exits 0.
- **No `GRAPH_VERSION` bump.** It stays at `1`. New record fields must be optional and read with a default.
- **Append-only.** Never mutate a graph record in place; `putNode`/`putEdge`/`putNodeWithEdges` only.
- **Anchor discipline.** A finding whose anchors do not resolve is refused, never stored. Index anchors with `indexFile` before creating the finding.
- **Declare every MCP option.** An option missing from `inputSchema` is silently dropped at dispatch. The schema-completeness ratchet enforces this.
- **No null-forgiving `!`** in TypeScript. Use real narrowing.
- **Enums/closed sets** never typed as bare `string` where the values form a closed set.
- **Branch:** `feat/close-wiki-graph-gaps`. Never commit to `master`.

---

## File Structure

| File | Responsibility |
|---|---|
| `hooks-core/lexical.mjs` **(new)** | BM25 scoring and ranking over findings. Pure, no I/O, no deps. |
| `src/tools/intelligence/wiki-query.ts` **(new)** | The `wiki_query` MCP tool: seven read operations over the graph. |
| `src/validation/tool-schemas.ts` | Add `WikiQuerySchema`; register in the schema map. |
| `src/server/index.ts` | Dispatch `case 'wiki_query'`. |
| `src/server/wiki-routes.ts` | `/api/wiki/search` switches from substring to BM25. |
| `hooks-core/staleness.mjs` | Add `applyPending`; `invalidateOnWrite` gains a caller. |
| `hooks-core/pending.mjs` **(new)** | The pending-invalidation queue written by post-tool, drained at next read. |
| `hooks-core/adapter.mjs` | post-tool records a pending invalidation; pre-tool drains it before serving. |
| `hooks-core/curate.mjs` | `contradict()` writes the `contradicts` edge; confidence gating. |
| `hooks-core/harvest-write.mjs` | Writes the `answers` edge from finding to task. |
| `hooks-core/inject.mjs` | Block assembly routed through `cacheOrdered`. |
| `hooks-core/keepwarm.mjs` | `kind:'lessons'` reader (resolves the dead writer). |
| `tests/hooks/lexical.test.mjs` **(new)** | BM25 ranking behaviour. |
| `tests/hooks/wiki-query-tool.test.mjs` **(new)** | Tool reachable through dispatch; `query` event recorded. |
| `tests/hooks/pending-invalidation.test.mjs` **(new)** | A write marks findings stale through the hook chain. |
| `tests/hooks/contradicts.test.mjs` **(new)** | Contradiction recorded as an edge; confidence not promoted. |

**Task order is dependency order.** Task 2 needs Task 1. Task 4 needs Task 3.

---

## Task 1: BM25 in hooks-core

**Files:**
- Create: `hooks-core/lexical.mjs`
- Test: `tests/hooks/lexical.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `tokenize(text: string) => string[]`
  - `rank(query: string, findings: Array<{key, claim}>, opts?: {limit?: number, k1?: number, b?: number}) => Array<{finding, score}>` — descending by score, zero-score entries omitted.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/hooks/lexical.test.mjs
import { describe, it, expect } from '@jest/globals';
import { tokenize, rank } from '../../hooks-core/lexical.mjs';

const FINDINGS = [
  { key: 'a', claim: 'the retry backoff is capped at thirty seconds' },
  { key: 'b', claim: 'retry retry retry' },
  { key: 'c', claim: 'the parser rejects a trailing comma' },
];

describe('lexical', () => {
  it('splits on non-word characters and lowercases', () => {
    expect(tokenize('Retry-Backoff, capped!')).toEqual(['retry', 'backoff', 'capped']);
  });

  it('ranks a specific match above a repetitive one', () => {
    // This is the whole reason BM25 replaces substring matching: 'b' contains
    // the term more often, 'a' is the better answer. Saturation must win.
    const ranked = rank('retry backoff', FINDINGS);
    expect(ranked[0].finding.key).toBe('a');
  });

  it('omits findings with no matching term rather than scoring them zero', () => {
    const keys = rank('retry backoff', FINDINGS).map((r) => r.finding.key);
    expect(keys).not.toContain('c');
  });

  it('respects limit', () => {
    expect(rank('retry', FINDINGS, { limit: 1 })).toHaveLength(1);
  });

  it('returns nothing for an empty query rather than everything', () => {
    expect(rank('   ', FINDINGS)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/hooks/lexical.test.mjs`
Expected: FAIL — `Cannot find module '../../hooks-core/lexical.mjs'`

- [ ] **Step 3: Write the implementation**

```javascript
// hooks-core/lexical.mjs
/**
 * BM25 over findings. Pure, dependency-free, deterministic.
 *
 * WHY THIS REPLACES `includes()`. The dashboard filtered findings by substring,
 * which cannot RANK -- and every consumer of retrieval here is under a hard
 * token budget, so the budget kept whatever happened to match rather than what
 * matched best. Ranking is the whole value at a budget.
 *
 * WHY BM25 AND NOT EMBEDDINGS. Deliberate, per docs/WIKI_GRAPH.md: deterministic,
 * instant, explainable, and it cannot drift or need a rebuild. The known cost is
 * recall on findings with no lexical overlap; Plan 2's recall probe measures that
 * rather than assuming it away.
 */

/** Non-word split, lowercased. Short tokens are kept: `fs`, `id`, `os` matter here. */
export function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Classic BM25. `k1` controls term-frequency saturation, `b` length normalisation.
 * Defaults are the standard ones and are exposed so the recall probe can sweep them.
 */
export function rank(query, findings, { limit = 20, k1 = 1.2, b = 0.75 } = {}) {
  const terms = tokenize(query);
  if (!terms.length || !Array.isArray(findings) || !findings.length) return [];

  // A finding's searchable text is its claim AND its key: the key is how the
  // session index refers to it, so a model quoting a key must find it.
  const docs = findings.map((finding) => ({
    finding,
    tokens: tokenize(`${finding.key || ''} ${finding.claim || ''}`),
  }));

  const avgLen = docs.reduce((sum, d) => sum + d.tokens.length, 0) / docs.length;
  const N = docs.length;

  const docFreq = new Map();
  for (const { tokens } of docs) {
    for (const term of new Set(tokens)) {
      docFreq.set(term, (docFreq.get(term) || 0) + 1);
    }
  }

  const scored = [];
  for (const { finding, tokens } of docs) {
    const counts = new Map();
    for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);

    let score = 0;
    for (const term of terms) {
      const tf = counts.get(term);
      if (!tf) continue;
      const df = docFreq.get(term) || 0;
      // Standard BM25 IDF, floored at zero so a term present in every document
      // contributes nothing rather than a negative score.
      const idf = Math.max(0, Math.log(1 + (N - df + 0.5) / (df + 0.5)));
      const norm = tf + k1 * (1 - b + (b * tokens.length) / (avgLen || 1));
      score += idf * ((tf * (k1 + 1)) / (norm || 1));
    }

    // Zero means no term matched. Omitted rather than returned, so a caller
    // under a token budget never spends it on an irrelevant finding.
    if (score > 0) scored.push({ finding, score });
  }

  return scored.sort((a, b2) => b2.score - a.score).slice(0, limit);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/hooks/lexical.test.mjs`
Expected: PASS (5 tests)

- [ ] **Step 5: Sync the vendored copies**

Run: `npm run sync:hooks`
Expected: `lexical.mjs` written into all seven target directories.

- [ ] **Step 6: Commit**

```bash
git add hooks-core/lexical.mjs tests/hooks/lexical.test.mjs plugin/hooks/lib/lexical.mjs integrations
git commit -m "feat(wiki): BM25 ranking for findings, replacing substring matching

WIKI_GRAPH.md has claimed traversal-plus-BM25 since it was written; retrieval
was a substring includes() filter. Substring cannot rank, and every consumer
is under a hard token budget, so the budget kept whatever matched rather than
what matched best."
```

---

## Task 2: The `wiki_query` MCP tool

**Files:**
- Create: `src/tools/intelligence/wiki-query.ts`
- Modify: `src/validation/tool-schemas.ts`, `src/server/index.ts`
- Test: `tests/hooks/wiki-query-tool.test.mjs`

**Interfaces:**
- Consumes: `rank()` from Task 1; `wiki.mjs` (`load`, `wikiDir`, `projectRootFor`, `findingsFor`, `nodeId`), `curate.mjs` (`activeFindings`, `audit`), `metrics.mjs` (`record`, `report`), `staleness.mjs` (`serve`), `projects.mjs` (`registerProject`).
- Produces:
  - `WIKI_QUERY_TOOL_DEFINITION` — MCP tool definition object
  - `wikiQuery(options: WikiQueryOptions) => Promise<WikiQueryResult>`
  - `WikiQueryOperation` — enum, **not** a bare string union of magic strings

**Why this task matters:** `wiki_query` is named in injected prompt text in twelve shipped copies and in `docs/WIKI_GRAPH.md`, and it does not exist. The SessionStart index tells the model to call a tool that is not there, and the hard per-touch budget has no escape hatch. Recording a `query` event also resurrects `indexBudget`, which is currently pinned to its 150-token floor for every project once five index injections have occurred.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/hooks/wiki-query-tool.test.mjs
import { describe, it, expect, beforeEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { putNodeWithEdges, load, nodeId, wikiDir } from '../../hooks-core/wiki.mjs';
import { readAll } from '../../hooks-core/metrics.mjs';
import { wikiQuery } from '../../dist/tools/intelligence/wiki-query.js';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wq-'));
  putNodeWithEdges(dir, { kind: 'file', key: join(dir, 'auth.ts'), hash: 'abc' });
  putNodeWithEdges(
    dir,
    { kind: 'finding', key: 'retry-cap', claim: 'the retry backoff is capped at thirty seconds', confidence: 0.9 },
    [{ edge: 'derived_from', to: nodeId('file', join(dir, 'auth.ts')) }]
  );
});

describe('wiki_query', () => {
  it('returns a finding by key', async () => {
    const result = await wikiQuery({ operation: 'get', key: 'retry-cap', graphDir: dir });
    expect(result.finding.claim).toContain('thirty seconds');
  });

  it('finds a finding by search term', async () => {
    const result = await wikiQuery({ operation: 'search', query: 'retry backoff', graphDir: dir });
    expect(result.findings.map((f) => f.key)).toContain('retry-cap');
  });

  it('traverses from a file anchor to its findings', async () => {
    const result = await wikiQuery({ operation: 'anchor', anchor: join(dir, 'auth.ts'), graphDir: dir });
    expect(result.findings.map((f) => f.key)).toContain('retry-cap');
  });

  it('records a query event, which is what earns the session index its budget', async () => {
    await wikiQuery({ operation: 'get', key: 'retry-cap', graphDir: dir });
    const events = readAll(dir).filter((e) => e.kind === 'query');
    expect(events).toHaveLength(1);
    expect(events[0].operation).toBe('get');
  });

  it('reports a missing key rather than throwing', async () => {
    const result = await wikiQuery({ operation: 'get', key: 'nope', graphDir: dir });
    expect(result.found).toBe(false);
  });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && npx jest tests/hooks/wiki-query-tool.test.mjs`
Expected: FAIL — cannot find `dist/tools/intelligence/wiki-query.js`

- [ ] **Step 3: Write the tool**

```typescript
// src/tools/intelligence/wiki-query.ts
/**
 * wiki_query — reading the graph, which nothing could do.
 *
 * The SessionStart index has told the model to "call wiki_query with a key for
 * detail" in twelve shipped copies of the injected text since injection landed.
 * The tool did not exist. So the design's escape hatch for the hard per-touch
 * budget -- "everything else reachable through wiki_query" -- was not reachable
 * at all, and anything the 500-token cap dropped was simply gone.
 *
 * IT ALSO FIXES A DEAD METRIC. `indexBudget` earns the session index its token
 * allowance from `queries / listed`, and nothing in the product had ever written
 * a `query` event -- only the test suite. So the ratio was 0 for every project
 * on earth, and the budget ratcheted to its floor and stayed there. Recording
 * the event here is the numerator.
 */

import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname } from 'path';

const here = dirname(fileURLToPath(import.meta.url));

function coreUrl(name: string): string {
  return pathToFileURL(path.join(here, '..', '..', '..', 'hooks-core', name)).href;
}

/** Closed set, so a typo cannot compile. */
export enum WikiQueryOperation {
  Get = 'get',
  Search = 'search',
  Anchor = 'anchor',
  Node = 'node',
  Audit = 'audit',
  Balance = 'balance',
  Overview = 'overview',
}

export interface WikiQueryOptions {
  operation: WikiQueryOperation | `${WikiQueryOperation}`;
  /** `get`: the finding key. */
  key?: string;
  /** `search`: the search terms. */
  query?: string;
  /** `search`: restrict to one finding type. */
  type?: string;
  /** `anchor`: a file path or `file#symbol`. */
  anchor?: string;
  /** `node`: a node id. */
  nodeId?: string;
  /** Max rows returned. Default 20, capped at 100. */
  limit?: number;
  /** Explicit graph directory. Tests use it; callers normally omit it. */
  graphDir?: string;
  /** Explicit project root, when the caller knows better than inference. */
  projectRoot?: string;
  /** Recorded with the query event so hit rate can be attributed to a session. */
  sessionId?: string;
}

export interface WikiQueryResult {
  operation: string;
  found: boolean;
  finding?: unknown;
  findings?: unknown[];
  node?: unknown;
  neighbours?: unknown[];
  audit?: unknown;
  balance?: unknown;
  overview?: unknown;
  note?: string;
}

export const WIKI_QUERY_TOOL_DEFINITION = {
  name: 'wiki_query',
  description:
    "Read the project's knowledge graph: fetch a finding by key, search findings, list what is known about a file or symbol, inspect a node, or get the graph's audit, token balance and overall shape. Use this when the session index mentions a finding you want in full, or before re-deriving something about a file you are about to work on.",
  inputSchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['get', 'search', 'anchor', 'node', 'audit', 'balance', 'overview'],
        description:
          "get = one finding by key. search = findings matching terms. anchor = everything known about a file or 'file#symbol'. node = a node and its neighbours. audit = findings needing attention. balance = what the graph has cost and saved. overview = the graph's shape.",
      },
      key: { type: 'string', description: 'Finding key, for operation=get.' },
      query: { type: 'string', description: 'Search terms, for operation=search.' },
      type: {
        type: 'string',
        enum: ['finding', 'decision', 'failure', 'command', 'map', 'feedback'],
        description: 'Restrict search to one finding type.',
      },
      anchor: { type: 'string', description: "File path or 'file#symbol', for operation=anchor." },
      nodeId: { type: 'string', description: 'Node id, for operation=node.' },
      limit: { type: 'number', description: 'Max rows. Default 20, capped at 100.' },
      graphDir: { type: 'string', description: 'Explicit graph directory. Normally omitted.' },
      projectRoot: { type: 'string', description: 'Explicit project root. Normally omitted.' },
      sessionId: { type: 'string', description: 'Session id, recorded with the query event.' },
    },
    required: ['operation'],
  },
} as const;

/** Trimmed shape for a finding, so a response cannot carry a snapshot. */
function summariseFinding(node: Record<string, unknown>): Record<string, unknown> {
  return {
    key: node.key,
    claim: node.claim,
    type: node.type ?? 'finding',
    confidence: node.confidence,
    origin: node.origin,
    pinned: node.pinned ?? false,
    stale: node.stale ?? false,
    at: node.at,
  };
}

export async function wikiQuery(options: WikiQueryOptions): Promise<WikiQueryResult> {
  const operation = String(options?.operation ?? '');
  const limit = Math.min(100, Math.max(1, Number(options?.limit) || 20));

  const [wiki, curate, metrics, staleness, lexical, projects] = await Promise.all([
    import(coreUrl('wiki.mjs')),
    import(coreUrl('curate.mjs')),
    import(coreUrl('metrics.mjs')),
    import(coreUrl('staleness.mjs')),
    import(coreUrl('lexical.mjs')),
    import(coreUrl('projects.mjs')),
  ]);

  // The graph belongs to the project the ANCHOR is in, not to wherever the
  // session happens to be running -- the same rule wiki_write follows.
  const inferredRoot =
    options.projectRoot ??
    (options.anchor
      ? wiki.projectRootFor(String(options.anchor).split('#')[0], process.cwd())
      : process.cwd());
  const dir = options.graphDir ?? wiki.wikiDir(inferredRoot);
  if (!options.graphDir) {
    projects.registerProject({ root: inferredRoot, graphDir: dir, client: 'mcp' });
  }

  // Recorded BEFORE the work, so a query that then fails still counts as the
  // model having asked. The metric is about the index leading somewhere, not
  // about whether the answer existed.
  metrics.record(dir, {
    kind: 'query',
    operation,
    key: options.key ?? options.anchor ?? null,
    sessionId: options.sessionId ?? null,
  });

  const graph = wiki.load(dir);

  if (operation === WikiQueryOperation.Get) {
    const all = curate.activeFindings(graph);
    const match = all.find((f: Record<string, unknown>) => f.key === options.key);
    if (!match) return { operation, found: false, note: 'no finding with that key' };
    // Served through `serve` so a stale finding arrives WITH the diff that
    // invalidated it. A stale finding served bare is worse than no graph.
    const [served] = staleness.serve(graph, [match]);
    return { operation, found: true, finding: served };
  }

  if (operation === WikiQueryOperation.Search) {
    let pool = curate.activeFindings(graph);
    if (options.type) {
      pool = pool.filter((f: Record<string, unknown>) => (f.type ?? 'finding') === options.type);
    }
    const ranked = lexical.rank(String(options.query ?? ''), pool, { limit });
    const served = staleness.serve(graph, ranked.map((r: { finding: unknown }) => r.finding));
    return { operation, found: served.length > 0, findings: served };
  }

  if (operation === WikiQueryOperation.Anchor) {
    const anchor = String(options.anchor ?? '');
    const id = anchor.includes('#')
      ? wiki.nodeId('symbol', anchor)
      : wiki.nodeId('file', anchor);
    const found = wiki.findingsFor(graph, id, { limit });
    const served = staleness.serve(graph, found);
    return { operation, found: served.length > 0, findings: served };
  }

  if (operation === WikiQueryOperation.Node) {
    const node = graph.nodes.get(String(options.nodeId ?? ''));
    if (!node) return { operation, found: false, note: 'no such node' };
    const edges = graph.edges
      .filter((e: { from: string; to: string }) => e.from === node.id || e.to === node.id)
      .slice(0, limit);
    const neighbours = edges
      .map((e: { from: string; to: string }) =>
        graph.nodes.get(e.from === node.id ? e.to : e.from)
      )
      .filter(Boolean);
    return { operation, found: true, node, neighbours };
  }

  if (operation === WikiQueryOperation.Audit) {
    return { operation, found: true, audit: curate.audit(graph) };
  }

  if (operation === WikiQueryOperation.Balance) {
    return { operation, found: true, balance: metrics.report(dir) };
  }

  if (operation === WikiQueryOperation.Overview) {
    const counts: Record<string, number> = {};
    for (const node of graph.nodes.values()) {
      counts[node.kind] = (counts[node.kind] || 0) + 1;
    }
    // Densest anchors: the files carrying the most findings. This is the part a
    // constellation of coordinates could never tell a model.
    const perAnchor = new Map<string, number>();
    for (const edge of graph.edges) {
      if (edge.edge !== 'derived_from') continue;
      const target = graph.nodes.get(edge.to);
      if (target) perAnchor.set(target.key, (perAnchor.get(target.key) || 0) + 1);
    }
    const densest = [...perAnchor.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([key, findings]) => ({ key, findings }));
    const findings = curate.activeFindings(graph);
    return {
      operation,
      found: true,
      overview: {
        counts,
        densest,
        stale: findings.filter((f: Record<string, unknown>) => f.stale).length,
        total: findings.length,
      },
    };
  }

  return { operation, found: false, note: `unknown operation: ${operation}` };
}
```

- [ ] **Step 4: Add the schema**

In `src/validation/tool-schemas.ts`, beside the existing `WikiWriteSchema`:

```typescript
// wiki_query: reading the knowledge graph. EVERY option must be declared --
// an option missing here is spread into the handler and silently dropped.
export const WikiQuerySchema = z.object({
  operation: z.enum(['get', 'search', 'anchor', 'node', 'audit', 'balance', 'overview']),
  key: z.string().optional(),
  query: z.string().optional(),
  type: z.enum(['finding', 'decision', 'failure', 'command', 'map', 'feedback']).optional(),
  anchor: z.string().optional(),
  nodeId: z.string().optional(),
  limit: z.number().int().positive().max(100).optional(),
  graphDir: z.string().optional(),
  projectRoot: z.string().optional(),
  sessionId: z.string().optional(),
});
```

And in the schema map beside `wiki_write: WikiWriteSchema,`:

```typescript
  wiki_query: WikiQuerySchema,
```

- [ ] **Step 5: Dispatch it**

In `src/server/index.ts`, add the import beside `wikiWrite`:

```typescript
import { wikiQuery, WIKI_QUERY_TOOL_DEFINITION } from '../tools/intelligence/wiki-query.js';
```

And beside `case 'wiki_write':`:

```typescript
      case 'wiki_query': {
        const result = await wikiQuery(args as never);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
```

Register `WIKI_QUERY_TOOL_DEFINITION` wherever `WIKI_WRITE_TOOL_DEFINITION` is listed in the tool inventory.

- [ ] **Step 6: Declare it in the bundled capability list**

`wiki_query` must appear in `TOKEN_OPTIMIZER_MCP_CAPABILITIES`, which is generated. Edit the generator, not the entries:

```bash
grep -rn "TOKEN_OPTIMIZER_MCP_CAPABILITIES" scripts/generate-client-entries.mjs
```

Add `wiki_query` to that list, then `npm run sync:hooks`.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm run build && npx jest tests/hooks/wiki-query-tool.test.mjs`
Expected: PASS (5 tests)

- [ ] **Step 8: Verify the schema ratchet still passes**

Run: `npx jest tests/hooks/ucr-guard.test.mjs tests/unit --silent`
Expected: PASS. If the schema-completeness ratchet fails, an option is missing from `inputSchema` — add it rather than allowlisting it.

- [ ] **Step 9: Commit**

```bash
git add src/tools/intelligence/wiki-query.ts src/validation/tool-schemas.ts src/server/index.ts scripts/generate-client-entries.mjs tests/hooks/wiki-query-tool.test.mjs plugin integrations
git commit -m "feat(wiki): wiki_query, the tool the injected text already promised

The SessionStart index has told the model to 'call wiki_query with a key for
detail' in twelve shipped copies since injection landed, and the tool did not
exist -- so the hard per-touch budget had no escape hatch and anything it
dropped was unreachable.

It also resurrects indexBudget. That budget earns the session index its
allowance from queries/listed, and nothing in the product had ever written a
query event -- only the test suite. The ratio was 0 everywhere, so the budget
sat at its 150-token floor for every project on earth."
```

---

## Task 3: Dashboard search uses BM25

**Files:**
- Modify: `src/server/wiki-routes.ts` (the `/api/wiki/search` handler)
- Test: `tests/unit/wiki-routes-search.test.ts` **(new)**

**Interfaces:**
- Consumes: `rank()` from Task 1.
- Produces: no new exports; `/api/wiki/search` response shape is unchanged (`{ total, offset, items }`).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/wiki-routes-search.test.ts
import { describe, it, expect } from '@jest/globals';
import { pathToFileURL } from 'url';
import path from 'path';

const lexical = await import(
  pathToFileURL(path.join(process.cwd(), 'hooks-core', 'lexical.mjs')).href
);

describe('/api/wiki/search ranking', () => {
  it('ranks a specific claim above a repetitive one', () => {
    const findings = [
      { key: 'a', claim: 'the retry backoff is capped at thirty seconds' },
      { key: 'b', claim: 'retry retry retry' },
    ];
    const ranked = lexical.rank('retry backoff', findings);
    expect(ranked[0].finding.key).toBe('a');
  });
});
```

- [ ] **Step 2: Run it to confirm the ranking primitive is available**

Run: `npx jest tests/unit/wiki-routes-search.test.ts`
Expected: PASS (Task 1 supplies `rank`). This test guards the property the route must preserve.

- [ ] **Step 3: Replace the substring filter**

In `src/server/wiki-routes.ts`, add `lexical` to the `modules()` import list, then replace the `if (query) { findings = findings.filter(...) }` block with:

```typescript
      // Lexical retrieval per the design -- now actually ranked. The previous
      // substring filter could not order results, so the caller kept whatever
      // matched rather than what matched best.
      if (query) {
        findings = mods.lexical
          .rank(query, findings, { limit: offset + limit })
          .map((row: { finding: unknown }) => row.finding);
      } else {
        findings.sort((a: any, b: any) => {
          const weight = (f: any) =>
            (f.confidence ?? 0.5) *
            (f.origin === 'human' ? mods.curate.HUMAN_WEIGHT : 1) *
            (f.pinned ? 2 : 1);
          return weight(b) - weight(a);
        });
      }
```

Note the sort now applies only to the unfiltered case: when a query is present, BM25 relevance decides the order.

- [ ] **Step 4: Run the dashboard tests**

Run: `npm run build && npx jest tests/unit/wiki-routes-search.test.ts tests/unit/dashboard-web-server.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/wiki-routes.ts tests/unit/wiki-routes-search.test.ts
git commit -m "fix(dashboard): rank wiki search by BM25 instead of substring"
```

---

## Task 4: Wire `invalidateOnWrite` through the post-tool path

**Files:**
- Create: `hooks-core/pending.mjs`
- Modify: `hooks-core/adapter.mjs` (post-tool branch; pre-tool serve path)
- Modify: `tests/hooks/reachability.test.mjs` (remove the `invalidateOnWrite` allowlist entry)
- Test: `tests/hooks/pending-invalidation.test.mjs`

**Interfaces:**
- Consumes: `invalidateOnWrite(dir, graph, rawPath, beforeText, afterText)` from `staleness.mjs`.
- Produces:
  - `queueInvalidation(dir, { path, before, after, at })` — appends one pending record
  - `drainInvalidations(dir, graph) => number` — applies and clears; returns findings marked

**Why:** `staleness.mjs`'s header describes two invalidation paths and says eager exists because lazy "would silently serve stale findings as fresh whenever a change came from outside the agent." `invalidateOnWrite` has **1 raw reference and 0 code references** — the reference is a comment in `pretooluse-router.mjs:153`. Staleness is lazy-only in production.

The hook does **not** load the graph. It queues; the next graph read drains. Correctness is unchanged because the property that matters is that a stale finding is never *served* fresh, and serve time is where that is enforced.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/hooks/pending-invalidation.test.mjs
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { putNodeWithEdges, load, nodeId } from '../../hooks-core/wiki.mjs';
import { indexFile } from '../../hooks-core/staleness.mjs';
import { queueInvalidation, drainInvalidations } from '../../hooks-core/pending.mjs';

let dir, file;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pend-'));
  file = join(dir, 'auth.ts');
  writeFileSync(file, 'export function f() { return 1; }');
  indexFile(dir, file, 'export function f() { return 1; }');
  putNodeWithEdges(
    dir,
    { kind: 'finding', key: 'f-returns-one', claim: 'f returns 1', confidence: 0.9 },
    [{ edge: 'derived_from', to: nodeId('file', file) }]
  );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('pending invalidation', () => {
  it('marks a finding stale when a queued write is drained', () => {
    queueInvalidation(dir, {
      path: file,
      before: 'export function f() { return 1; }',
      after: 'export function f() { return 2; }',
      at: 1,
    });

    const marked = drainInvalidations(dir, load(dir));
    expect(marked).toBeGreaterThan(0);

    const finding = [...load(dir).nodes.values()].find((n) => n.key === 'f-returns-one');
    expect(finding.stale).toBe(true);
  });

  it('is idempotent -- draining twice does not re-apply', () => {
    queueInvalidation(dir, { path: file, before: 'a', after: 'b', at: 1 });
    drainInvalidations(dir, load(dir));
    expect(drainInvalidations(dir, load(dir))).toBe(0);
  });

  it('never throws on a malformed record, because it runs on a hook path', () => {
    queueInvalidation(dir, { path: null, before: null, after: null, at: 1 });
    expect(() => drainInvalidations(dir, load(dir))).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/hooks/pending-invalidation.test.mjs`
Expected: FAIL — cannot find `hooks-core/pending.mjs`

- [ ] **Step 3: Write `pending.mjs`**

```javascript
// hooks-core/pending.mjs
/**
 * The eager-invalidation queue.
 *
 * WHY A QUEUE AND NOT A DIRECT CALL. `invalidateOnWrite` needs the graph, and
 * the graph is a megabyte of JSONL. Loading it inside the post-tool hook would
 * put that read on the return path of every write. So the hook, which already
 * holds the before and after text, appends one record here and exits; the next
 * graph read -- the pre-tool injection path, which loads the graph anyway --
 * drains it before serving anything.
 *
 * The guarantee is unchanged. What must never happen is SERVING a stale finding
 * as fresh, and serve time is where that is enforced.
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { invalidateOnWrite } from './staleness.mjs';

const queuePath = (dir) => join(dir, 'pending-invalidation.jsonl');

/** Appends one pending write. Never throws: a hook path must not fail. */
export function queueInvalidation(dir, { path, before, after, at }) {
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      queuePath(dir),
      `${JSON.stringify({ path, before, after, at: at ?? Date.now() })}\n`,
      'utf8'
    );
  } catch {
    // A queue we cannot write degrades to the lazy path, which still catches
    // the change at the next retrieval. Silence is correct here.
  }
}

/**
 * Applies every queued invalidation and clears the queue.
 *
 * Returns the number of findings marked, so a caller can log it and the test
 * can assert idempotence. Clearing AFTER applying, and unconditionally, because
 * a record that cannot be applied must not be retried forever.
 */
export function drainInvalidations(dir, graph) {
  let records;
  try {
    if (!existsSync(queuePath(dir))) return 0;
    records = readFileSync(queuePath(dir), 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return 0;
  }

  let marked = 0;
  for (const record of records) {
    if (!record.path) continue;
    try {
      const result = invalidateOnWrite(dir, graph, record.path, record.before, record.after);
      marked += Array.isArray(result) ? result.length : Number(result) || 0;
    } catch {
      // One bad record must not stop the rest.
    }
  }

  try {
    unlinkSync(queuePath(dir));
  } catch {
    // Already gone, or held. The next drain will retry.
  }

  return marked;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/hooks/pending-invalidation.test.mjs`
Expected: PASS (3 tests)

- [ ] **Step 5: Call it from the hook path**

In `hooks-core/adapter.mjs`, in the `event === 'post-tool'` branch, after the existing bookkeeping, queue the invalidation using the before/after text the write already provides:

```javascript
  // EAGER INVALIDATION, finally connected. `invalidateOnWrite` has existed and
  // been tested since staleness landed, and its only reference in shipped code
  // was a COMMENT -- so the path the module's own header calls load-bearing has
  // never run. Queued rather than applied, so no graph load lands here.
  try {
    const { queueInvalidation } = await import('./pending.mjs');
    queueInvalidation(dir, { path: writtenPath, before: beforeText, after: afterText });
  } catch {
    /* never let bookkeeping break a completed call */
  }
```

And in the pre-tool path, immediately after the graph is loaded and **before** anything is served:

```javascript
  // Drain BEFORE serving. This is the whole point: a write the hook observed
  // must not be served as fresh on the next touch.
  try {
    const { drainInvalidations } = await import('./pending.mjs');
    drainInvalidations(dir, graph);
  } catch {
    /* lazy staleness still covers this */
  }
```

- [ ] **Step 6: Remove the allowlist entry**

In `tests/hooks/reachability.test.mjs`, delete the line:

```javascript
  ['invalidateOnWrite', 'UNWIRED: the eager staleness path; invalidation currently happens only lazily, on the next touch.'],
```

- [ ] **Step 7: Verify the detector now passes without the entry**

Run: `npx jest tests/hooks/reachability.test.mjs tests/hooks/staleness.test.mjs tests/hooks/stale-before-reindex.test.mjs`
Expected: PASS. If reachability fails, `invalidateOnWrite` is still only referenced from `pending.mjs` — confirm `pending.mjs` itself has a caller in `adapter.mjs`.

- [ ] **Step 8: Sync and commit**

```bash
npm run sync:hooks
git add hooks-core/pending.mjs hooks-core/adapter.mjs tests/hooks/pending-invalidation.test.mjs tests/hooks/reachability.test.mjs plugin integrations
git commit -m "fix(staleness): connect eager invalidation, which was prose only

staleness.mjs documents two invalidation paths and says eager exists because
lazy 'would silently serve stale findings as fresh whenever a change came from
outside the agent'. invalidateOnWrite had 1 raw reference and 0 code
references: the reference was a comment. Staleness was lazy-only in production.

Queued at post-tool and drained at the next graph read, so no graph load lands
on the return path of a write. The guarantee is unchanged -- what must never
happen is SERVING a stale finding as fresh."
```

---

## Task 5: Write the `contradicts` edge, and gate confidence on it

**Files:**
- Modify: `hooks-core/curate.mjs`
- Test: `tests/hooks/contradicts.test.mjs`

**Interfaces:**
- Consumes: `putEdge`, `nodeId`, `load` from `wiki.mjs`.
- Produces:
  - `contradict(dir, { key, byKey, reason }) => boolean` — records that `byKey` disagrees with `key`
  - `hasOutstandingContradiction(graph, key) => boolean` — used to gate confidence promotion

**Why:** `EDGE_KINDS` declares `contradicts`, `WIKI_GRAPH.md` gives it a paragraph as the design's departure from RAG ("when a belief changes, the graph should record THAT it changed and why"), and `curate.mjs:264` now *reads* it. Nothing writes it. It is simultaneously an unwritten edge kind and a reader with no producer.

It is also the guard against Plan 2's Layer 2 rewarding falsehoods: that metric measures read suppression, and a confidently wrong finding suppresses reads better than a hedged true one.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/hooks/contradicts.test.mjs
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { putNodeWithEdges, load, nodeId } from '../../hooks-core/wiki.mjs';
import { contradict, hasOutstandingContradiction } from '../../hooks-core/curate.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'contra-'));
  putNodeWithEdges(dir, { kind: 'finding', key: 'old', claim: 'f returns 1', confidence: 0.9 });
  putNodeWithEdges(dir, { kind: 'finding', key: 'new', claim: 'f returns 2', confidence: 0.9 });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('contradicts', () => {
  it('records a disagreement as an edge rather than an overwrite', () => {
    expect(contradict(dir, { key: 'old', byKey: 'new', reason: 're-derived' })).toBe(true);

    const graph = load(dir);
    const edge = graph.edges.find((e) => e.edge === 'contradicts');
    expect(edge).toBeDefined();
    expect(edge.from).toBe(nodeId('finding', 'new'));
    expect(edge.to).toBe(nodeId('finding', 'old'));
  });

  it('leaves the contradicted finding present, not retired', () => {
    contradict(dir, { key: 'old', byKey: 'new', reason: 're-derived' });
    const old = [...load(dir).nodes.values()].find((n) => n.key === 'old');
    expect(old.retired).toBeFalsy();
  });

  it('reports an outstanding contradiction, which blocks confidence promotion', () => {
    contradict(dir, { key: 'old', byKey: 'new', reason: 're-derived' });
    const graph = load(dir);
    expect(hasOutstandingContradiction(graph, 'old')).toBe(true);
    expect(hasOutstandingContradiction(graph, 'new')).toBe(false);
  });

  it('refuses a contradiction against a key that does not exist', () => {
    expect(contradict(dir, { key: 'nope', byKey: 'new', reason: 'x' })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/hooks/contradicts.test.mjs`
Expected: FAIL — `contradict is not a function`

- [ ] **Step 3: Implement in `curate.mjs`**

```javascript
/**
 * Records that one finding disagrees with another.
 *
 * AN EDGE, NOT AN OVERWRITE -- the design is explicit about why: "when a belief
 * changes, the graph should record THAT it changed and why, not quietly present
 * the new one as though it had always been true." `contradicts` has been in
 * EDGE_KINDS since the schema existed and was written by nothing, while
 * `audit()` already READ it.
 *
 * The contradicted finding is deliberately NOT retired. A reader needs to see
 * both claims and the disagreement between them; retiring one silently picks a
 * winner, which is the overwrite this edge exists to avoid.
 */
export function contradict(dir, { key, byKey, reason }) {
  const graph = load(dir);
  const target = [...graph.nodes.values()].find((n) => n.kind === 'finding' && n.key === key);
  const source = [...graph.nodes.values()].find((n) => n.kind === 'finding' && n.key === byKey);
  // Both ends must exist, or the edge is unresolvable and the disagreement is
  // recorded against nothing -- the same un-invalidatable shape anchors prevent.
  if (!target || !source) return false;

  putEdge(dir, source.id, 'contradicts', target.id);
  putNode(dir, {
    kind: 'finding',
    key,
    contradictedAt: Date.now(),
    contradictionReason: String(reason || '').slice(0, 400),
  });
  return true;
}

/**
 * Whether anything currently disagrees with this finding.
 *
 * Gates confidence promotion. Plan 2's per-finding utility measures whether a
 * finding SUPPRESSES READS, and a confidently wrong finding suppresses reads
 * better than a hedged true one -- so utility must never raise confidence on
 * its own, and this is the check that stops it.
 */
export function hasOutstandingContradiction(graph, key) {
  const node = [...graph.nodes.values()].find((n) => n.kind === 'finding' && n.key === key);
  if (!node) return false;
  return graph.edges.some((e) => e.edge === 'contradicts' && e.to === node.id);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/hooks/contradicts.test.mjs`
Expected: PASS (4 tests)

- [ ] **Step 5: Sync and commit**

```bash
npm run sync:hooks
git add hooks-core/curate.mjs tests/hooks/contradicts.test.mjs plugin integrations
git commit -m "feat(wiki): write the contradicts edge, declared since the schema existed

EDGE_KINDS declared it, WIKI_GRAPH.md gives it a paragraph as the design's
departure from RAG, and curate.mjs:264 already read it. Nothing wrote it.

hasOutstandingContradiction gates confidence promotion, because per-finding
utility measures read suppression and a confidently wrong finding suppresses
reads better than a hedged true one."
```

---

## Task 6: Write the `answers` edge

**Files:**
- Modify: `hooks-core/harvest-write.mjs`
- Test: `tests/hooks/contradicts.test.mjs` (add a describe block — same subsystem, same file)

**Interfaces:**
- Consumes: `putEdge`, `nodeId` from `wiki.mjs`.
- Produces: no new export; `writeHarvested` gains an `answers` edge from each finding to the task that produced it, when a `taskId` is supplied.

- [ ] **Step 1: Write the failing test**

```javascript
// append to tests/hooks/contradicts.test.mjs
describe('answers', () => {
  it('links a finding to the task that produced it', () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'ans-'));
    const file = join(dir2, 'x.ts');
    writeFileSync(file, 'export const x = 1;');
    indexFile(dir2, file, 'export const x = 1;');
    putNodeWithEdges(dir2, { kind: 'task', key: 'task-1', prompt: 'why is x 1' });

    writeHarvested(
      dir2,
      [{ type: 'finding', claim: 'x is 1 by default', anchors: [file], confidence: 0.8 }],
      { sessionId: 's1', taskId: 'task-1', projectRoot: dir2 }
    );

    const graph = load(dir2);
    const edge = graph.edges.find((e) => e.edge === 'answers');
    expect(edge).toBeDefined();
    expect(edge.to).toBe(nodeId('task', 'task-1'));
    rmSync(dir2, { recursive: true, force: true });
  });
});
```

Add these imports at the top of the file: `writeFileSync` from `node:fs`, `indexFile` from `../../hooks-core/staleness.mjs`, `writeHarvested` from `../../hooks-core/harvest-write.mjs`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/hooks/contradicts.test.mjs -t answers`
Expected: FAIL — `edge` is undefined

- [ ] **Step 3: Add the edge in `writeHarvested`**

Where the finding's edge list is assembled beside its `derived_from` anchors:

```javascript
    // `answers` closes the loop back to the task that produced the finding, so
    // provenance can be traversed rather than inferred: "which session
    // established this, and from what". Declared in EDGE_KINDS and written by
    // nothing until now.
    if (options.taskId) {
      edges.push({ edge: 'answers', to: nodeId('task', options.taskId) });
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/hooks/contradicts.test.mjs`
Expected: PASS

- [ ] **Step 5: Sync and commit**

```bash
npm run sync:hooks
git add hooks-core/harvest-write.mjs tests/hooks/contradicts.test.mjs plugin integrations
git commit -m "feat(wiki): write the answers edge from finding to task

The last declared edge kind with no write site. Provenance is now traversable
rather than inferred."
```

---

## Task 7: Resolve the `lessons` dead writer

**Files:**
- Modify: `hooks-core/keepwarm.mjs` **or** `plugin/hooks/harvest-worker.mjs` (see step 1)
- Test: `tests/hooks/lessons.test.mjs`

**Interfaces:**
- Consumes: `readAll` from `metrics.mjs`.
- Produces: `lessonStats(dir) => { count: number, recent: Array<{claim, at}> }` if wired; otherwise the writer is removed.

**Why:** `harvest-worker.mjs:113` writes `kind: 'lessons'`. Nothing reads it. That is the inverse of the `query` defect and the same class as the already-fixed `tokensFullFile`.

- [ ] **Step 1: Determine which resolution applies**

Run:
```bash
grep -rn "kind: 'lessons'" hooks-core plugin/hooks --include=*.mjs
grep -rn "'lessons'" hooks-core/lessons.mjs | head -20
```

If `lessons.mjs` has a consumer that *should* be reading these events, wire it (step 2). If the event duplicates what `lessons.mjs` already derives from another source, delete the write (step 3). **Record which you chose and why in the commit message** — this is the decision the next reader will want.

- [ ] **Step 2 (if wiring): add the reader**

```javascript
/**
 * What the harvest recorded as lessons, for the audit surface.
 *
 * The `lessons` event was written by harvest-worker and read by nothing --
 * the inverse of the `query` defect, and the same shape as `tokensFullFile`
 * before it. A produced-and-never-consumed event is not telemetry.
 */
export function lessonStats(dir) {
  const events = readAll(dir).filter((e) => e.kind === 'lessons');
  return {
    count: events.length,
    recent: events.slice(-10).map((e) => ({ claim: e.claim ?? null, at: e.at ?? null })),
  };
}
```

Then call it from the audit render so it reaches a human.

- [ ] **Step 3 (if deleting): remove the write**

Delete the `record(dir, { kind: 'lessons', ... })` call in `plugin/hooks/harvest-worker.mjs` and any now-unused locals.

- [ ] **Step 4: Test whichever path you took**

If wired:
```javascript
it('reports lessons the harvest recorded', () => {
  record(dir, { kind: 'lessons', claim: 'prefer smart_read' });
  expect(lessonStats(dir).count).toBe(1);
});
```
If deleted:
```javascript
it('writes no event kind that nothing reads', () => {
  const written = readAll(dir).map((e) => e.kind);
  expect(written).not.toContain('lessons');
});
```

Run: `npx jest tests/hooks/lessons.test.mjs`
Expected: PASS

- [ ] **Step 5: Sync and commit**

```bash
npm run sync:hooks
git add hooks-core plugin tests/hooks/lessons.test.mjs integrations
git commit -m "fix(harvest): resolve the lessons event, which nothing read

Written by harvest-worker.mjs:113 and consumed by nothing -- the inverse of
the query defect and the same shape as tokensFullFile before it."
```

---

## Task 8: Wire `cacheOrdered` into injection assembly

**Files:**
- Modify: `hooks-core/inject.mjs`
- Modify: `tests/hooks/reachability.test.mjs` (remove the `cacheOrdered` allowlist entry)
- Test: `tests/hooks/cache.test.mjs` (add a describe block)

**Interfaces:**
- Consumes: `cacheOrdered(items)` from `cache.mjs`.
- Produces: no new export. Injected blocks are emitted stable-first, volatile-last.

**Why:** `cacheOrdered` assembles injections so a changed line invalidates only the tail of the prompt cache. Prompt-cache economics already ships; this is the ordering that makes it bite. It has zero call sites.

- [ ] **Step 1: Write the failing test**

```javascript
// append to tests/hooks/cache.test.mjs
import { cacheOrdered } from '../../hooks-core/cache.mjs';

describe('cache ordering is applied to injection', () => {
  it('puts stable blocks before volatile ones', () => {
    // VERIFIED CONTRACT (hooks-core/cache.mjs:430): `volatility` is a NUMBER,
    // sorted ascending so lower is more stable, falling back to `fresh ? 1 : 0`.
    // An earlier draft of this plan used 'high'/'low' strings, which subtract to
    // NaN -- the sort would have been a no-op and the test would have passed by
    // accident on insertion order.
    const ordered = cacheOrdered([
      { id: 'findings', volatility: 2, text: 'a' },
      { id: 'standing', volatility: 0, text: 'b' },
    ]);
    expect(ordered.map((o) => o.id)).toEqual(['standing', 'findings']);
  });
});
```

The contract is already verified, so no guessing is required:

```javascript
export function cacheOrdered(items) {
  return [...items].sort((a, b) => {
    const stability = (item) => item.volatility ?? (item.fresh ? 1 : 0);
    return stability(a) - stability(b);
  });
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/hooks/cache.test.mjs -t "cache ordering"`
Expected: PASS for the helper itself (it already sorts correctly) — the point of
this task is that **nothing calls it**. The failing assertion is the reachability
one in Step 5; treat that as the red test for this task.

- [ ] **Step 3: Route assembly through it**

In `hooks-core/inject.mjs`, where the injected blocks are concatenated for a session, collect them as items with their volatility and emit `cacheOrdered(items)`:

```javascript
  // CACHE ORDER, stable first. A later session re-emitting the same block with
  // one changed line invalidates the prompt cache from that line onward, so the
  // parts that rarely change belong at the top and the freshest at the bottom.
  // `cacheOrdered` has existed for exactly this and had no caller.
  // Numeric volatility, ascending: standing rules change least, findings most.
  const blocks = cacheOrdered([
    { id: 'standing', volatility: 0, text: standingBlock },
    { id: 'index', volatility: 1, text: indexBlock },
    { id: 'findings', volatility: 2, text: findingsBlock },
  ].filter((b) => b.text));
```

- [ ] **Step 4: Run the injection suite**

Run: `npx jest tests/hooks/injection.test.mjs tests/hooks/injection-e2e.test.mjs tests/hooks/cache.test.mjs tests/hooks/standing-rules.test.mjs`
Expected: PASS. Injection tests assert on emitted text; if ordering assertions fail, update them to the new order and note in the commit that the order changed deliberately.

- [ ] **Step 5: Remove the allowlist entry and verify**

Delete `['cacheOrdered', ...]` from `tests/hooks/reachability.test.mjs`, then:

Run: `npx jest tests/hooks/reachability.test.mjs`
Expected: PASS

- [ ] **Step 6: Sync and commit**

```bash
npm run sync:hooks
git add hooks-core/inject.mjs tests/hooks/cache.test.mjs tests/hooks/reachability.test.mjs plugin integrations
git commit -m "perf(inject): assemble injections in cache order, stable first

cacheOrdered confines prompt-cache invalidation to the tail of our injected
blocks and had zero call sites. Prompt-cache economics already ships; this is
the ordering that makes it bite."
```

---

## Task 9: Documentation and the full suite

**Files:**
- Modify: `docs/WIKI_GRAPH.md`
- Modify: `docs/TOOLS.md`

- [ ] **Step 1: Correct `WIKI_GRAPH.md`**

Three statements to change:
1. Retrieval: BM25 is now true rather than aspirational — say it is implemented in `hooks-core/lexical.mjs` and shared with the dashboard.
2. Invalidation: describe the real mechanism — queued at post-tool, drained at the next graph read, with lazy comparison still covering changes the hooks never observed.
3. `wiki_query` exists; state its seven operations.

- [ ] **Step 2: Document `wiki_query` in `docs/TOOLS.md`** beside `wiki_write`, with one example per operation.

- [ ] **Step 3: Run the whole suite and the sync check**

Run: `npm run build && npx jest && npm run sync:hooks:check`
Expected: PASS, PASS, no drift.

- [ ] **Step 4: Commit**

```bash
git add docs/WIKI_GRAPH.md docs/TOOLS.md
git commit -m "docs(wiki): describe wiki_query, real BM25, and the actual invalidation path"
```

---

## Task 10: The schema safety net (independent — may run first)

**Files:**
- Modify: `hooks-core/wiki.mjs` (`load`, `compactIfWasteful`, the header comment)
- Test: `tests/hooks/schema-compat.test.mjs` **(new)**

**Interfaces:**
- Produces:
  - `SUPPORTED_VERSIONS: number[]` — the range `load` accepts
  - `upcast(record) => record` — pure, per-version step; identity for the current version

**Why, and why the bump is deliberately NOT taken:** `load()` skips any record whose `v !== GRAPH_VERSION` (`wiki.mjs:640`), justified by a header comment saying "nothing has been released". It ships on npm as v5.7.0, so that comment is false and load-bearing: a future bump would silently zero every existing user graph. Worse, `compactIfWasteful` carries the **same filter**, so a bump would also **drop v1 records while compacting** — a second route to the same data loss.

Nothing in this work changes a graph record's shape (utility lives in metrics, `contradicts`/`answers` use the existing edge record, extractor fields are additive), so `GRAPH_VERSION` **stays at 1**. This task builds the net for the first change that does need it.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/hooks/schema-compat.test.mjs
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load, SUPPORTED_VERSIONS, upcast, GRAPH_VERSION } from '../../hooks-core/wiki.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'schema-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('schema compatibility', () => {
  it('loads a v1 log with every node intact -- the regression that would have caught silent zeroing', () => {
    writeFileSync(
      join(dir, 'graph.jsonl'),
      [
        JSON.stringify({ t: 'n', v: 1, id: 'file:aaa', kind: 'file', key: '/x/a.ts', at: 1 }),
        JSON.stringify({ t: 'n', v: 1, id: 'finding:bbb', kind: 'finding', key: 'k1', claim: 'c', at: 2 }),
        JSON.stringify({ t: 'e', v: 1, from: 'finding:bbb', edge: 'derived_from', to: 'file:aaa', at: 3 }),
      ].join('\n') + '\n'
    );
    const graph = load(dir);
    expect(graph.nodes.size).toBe(2);
    expect(graph.edges).toHaveLength(1);
  });

  it('still skips a record from a FUTURE version, because ignoring the future is safe', () => {
    writeFileSync(
      join(dir, 'graph.jsonl'),
      JSON.stringify({ t: 'n', v: 9999, id: 'file:zzz', kind: 'file', key: '/x/z.ts', at: 1 }) + '\n'
    );
    expect(load(dir).nodes.size).toBe(0);
  });

  it('does not bump the version, because no record shape changed in this work', () => {
    expect(GRAPH_VERSION).toBe(1);
    expect(SUPPORTED_VERSIONS).toContain(1);
  });

  it('upcast is identity for a current-version record', () => {
    const record = { t: 'n', v: GRAPH_VERSION, id: 'x', kind: 'file', key: '/a', at: 1 };
    expect(upcast(record)).toEqual(record);
  });

  it('compaction preserves records of every supported version', () => {
    // The second data-loss route: compactIfWasteful carries the same version
    // filter as load, so a bump would drop old records while compacting.
    writeFileSync(
      join(dir, 'graph.jsonl'),
      Array.from({ length: 50 }, (_, i) =>
        JSON.stringify({ t: 'n', v: 1, id: `file:${i}`, kind: 'file', key: `/x/${i}.ts`, at: i })
      ).join('\n') + '\n'
    );
    const before = load(dir).nodes.size;
    load(dir, { snapshots: true });   // triggers the compaction path
    expect(load(dir).nodes.size).toBe(before);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest tests/hooks/schema-compat.test.mjs`
Expected: FAIL — `SUPPORTED_VERSIONS` and `upcast` are not exported.

- [ ] **Step 3: Implement the range reader and upcaster**

```javascript
/**
 * Versions this reader accepts, oldest first.
 *
 * A RANGE, NOT AN EQUALITY. The equality check this replaces would have
 * discarded every existing graph the moment anyone bumped the version -- and the
 * header once justified that with "nothing has been released", which stopped
 * being true at v5.7.0 on npm.
 *
 * Nothing on disk is ever rewritten to migrate: `upcast` runs in memory during
 * the fold, so there is no migration pass to fail halfway and no race with the
 * concurrent sessions this store is designed for. A mixed-version log is safe
 * precisely because the original records are never mutated, and the existing
 * compaction retires old ones naturally as it rewrites snapshots.
 */
export const SUPPORTED_VERSIONS = [1];

/**
 * Brings one record up to the current version. Pure, and one step per version.
 *
 * Identity today because GRAPH_VERSION is 1 and no shape has changed. It exists
 * now so the first change that DOES need it has somewhere to go other than an
 * equality check that silently deletes user data.
 */
export function upcast(record) {
  return record;
}

/** True when this reader can interpret the record at all. */
function readable(record) {
  const version = record.v ?? 0;
  // Forward-incompatible records are skipped: a v-from-the-future was written by
  // a newer client and we cannot know its shape. Ignoring the future is safe;
  // ignoring the past is data loss.
  return SUPPORTED_VERSIONS.includes(version);
}
```

Replace **both** version checks — in `load` (around line 640) and in `compactIfWasteful` (around line 346) — with `if (!readable(record)) continue;` followed by `record = upcast(record);`.

- [ ] **Step 4: Correct the false header comment**

The block above `GRAPH_VERSION` claims "nothing has been released" and uses that to justify having no migration path. Replace that justification: the package ships on npm, the reader now accepts a range, and a bump is taken only when a record shape actually changes.

- [ ] **Step 5: Run to verify it passes**

Run: `npx jest tests/hooks/schema-compat.test.mjs tests/hooks/graph-compaction.test.mjs tests/hooks/concurrency.test.mjs`
Expected: PASS

- [ ] **Step 6: Sync and commit**

```bash
npm run sync:hooks
git add hooks-core/wiki.mjs tests/hooks/schema-compat.test.mjs plugin integrations
git commit -m "fix(wiki): accept a version range, so a future bump cannot zero a graph

load() skipped any record whose v != GRAPH_VERSION, justified by a header
comment saying nothing had been released. It ships on npm as 5.7.0. A bump
would have silently discarded every existing graph -- and compactIfWasteful
carries the same filter, so it would also drop old records while compacting.

Read-time upcasting, nothing rewritten on disk: no migration pass to fail
halfway and no race with concurrent sessions. GRAPH_VERSION deliberately stays
at 1, because no record shape changed here."
```

---

## Definition of done for Plan 1

Measured, not asserted — run against a real project graph after one working session:

| Check | Command | Expected |
|---|---|---|
| `query` events exist | `grep -c '"kind":"query"' .token-optimizer/wiki/metrics.jsonl` | > 0 |
| `contradicts` writable | `npx jest tests/hooks/contradicts.test.mjs` | PASS |
| No dead edge kinds | every member of `EDGE_KINDS` has a write site | true |
| Eager invalidation live | `grep -rn "queueInvalidation" hooks-core/adapter.mjs` | a call, not a comment |
| Allowlist shrunk | `grep -c "^  \['" tests/hooks/reachability.test.mjs` | 9 (from 11) |
| No drift | `npm run sync:hooks:check` | clean |

---

## Task 11: Nothing clears a stale flag

**Added mid-plan.** Task 4 turned eager invalidation from dead code into a live
mechanism. Nothing in the codebase ever clears a `stale` flag, so every finding on
an edited file now becomes permanently stale and the graph degrades toward
all-stale. That was harmless while the mechanism never fired; it is a rot path now.

**Files:**
- Modify: `hooks-core/staleness.mjs`, `hooks-core/curate.mjs`
- Test: `tests/hooks/stale-clearing.test.mjs` **(new)**

**Interfaces:**
- Consumes: `putNode`, `load` (`wiki.mjs`); `checkAnchor` (`staleness.mjs`).
- Produces:
  - `clearStale(dir, key) => boolean` — rewrites the finding without `stale`, `staleReason` or `diff`
  - `reverify(dir, key) => 'cleared' | 'still-stale' | 'unknown'` — clears the flag when the evidence for it is gone

**The mechanics, already established — do not re-derive them.** `putNode` does NOT
merge: it writes a full record from what the caller passes, and `load` replaces the
node wholesale, last write wins. The stale write at `staleness.mjs:629` spreads
`...finding` and adds `stale: true`, `staleReason` and `diff`. So clearing is
writing the node back with those three fields destructured away — no deletion
primitive is needed, and the append-only rule is respected.

- [ ] **Step 1: Write the failing tests**

```javascript
// tests/hooks/stale-clearing.test.mjs
it('clears the flag when the anchor returns to its recorded content', () => {
  // A revert, or a change elsewhere in the file that leaves the anchored symbol
  // untouched. The finding was never actually invalidated by this edit.
  writeFileSync(file, ORIGINAL);
  indexFile(dir, file, ORIGINAL);
  const key = seedFinding(dir, file);
  markStale(dir, file, ORIGINAL, CHANGED);
  expect(findingByKey(dir, key).stale).toBe(true);

  writeFileSync(file, ORIGINAL);            // reverted
  expect(reverify(dir, key)).toBe('cleared');
  const after = findingByKey(dir, key);
  expect(after.stale).toBeFalsy();
  expect(after.diff).toBeFalsy();
  expect(after.staleReason).toBeFalsy();
});

it('leaves the flag set when the content genuinely still differs', () => {
  // reverify must not be a way to launder a stale finding back to fresh.
  writeFileSync(file, CHANGED);
  expect(reverify(dir, key)).toBe('still-stale');
  expect(findingByKey(dir, key).stale).toBe(true);
});

it('does not let a correction inherit its predecessor stale flag', () => {
  // curate.correct spreads the original node, which carries stale: true, so a
  // correction would be born stale -- asserting the fix, not the current bug.
  markStale(dir, file, ORIGINAL, CHANGED);
  const corrected = correct(dir, { key, claim: 're-derived against the new code' });
  expect(findingByKey(dir, corrected).stale).toBeFalsy();
});

it('preserves every other field when clearing', () => {
  // The clear path rewrites the whole node, so a dropped claim or confidence
  // would be silent data loss.
  const before = findingByKey(dir, key);
  clearStale(dir, key);
  const after = findingByKey(dir, key);
  expect(after.claim).toBe(before.claim);
  expect(after.confidence).toBe(before.confidence);
  expect(after.origin).toBe(before.origin);
});
```

- [ ] **Step 2: Run to verify they fail** — `npm test -- tests/hooks/stale-clearing.test.mjs`

- [ ] **Step 3: Implement `clearStale` and `reverify`**

`clearStale` destructures `stale`, `staleReason` and `diff` off the node and calls
`putNode` with the remainder. `reverify` compares every anchor against disk via
`checkAnchor`: if all match the hashes recorded at claim time, clear; otherwise
report `still-stale` and change nothing.

**`reverify` must not be a laundering route.** It clears only on evidence that the
content matches what the claim was made against. A finding whose anchor genuinely
changed stays stale until someone re-records the claim against the new content.

- [ ] **Step 4: Fix the correction-inherits-stale bug** in `curate.mjs`, where
`correct()` spreads the original node (see the comment at `curate.mjs:125` — the
correction inherits anchors, and currently the flag too).

- [ ] **Step 5: Run the suite** — `npm test -- tests/hooks` and `npm run sync:hooks:check`

- [ ] **Step 6: Commit** with a message stating that nothing ever cleared one, that
it was harmless while eager invalidation was dead code, and that `reverify` clears
only on evidence so it is not a laundering route.

---

## Task 12: The post-tool matcher advertises tools the normaliser discards

**Added mid-plan.** `plugin/hooks/hooks.json`'s PostToolUse matcher explicitly lists
`mcp__.*__(?:smart_edit|smart_write)`, but `normalizeTool` (`decide.mjs:547`)
returns a name only for seven built-ins or a `TOOL_ALIASES` hit, so an MCP-prefixed
name maps to `null` and `runHook` exits before any logic runs. `NotebookEdit` is
dropped the same way. The consequence: when enforcement successfully redirects an
edit to the project's OWN tool, the post-tool accounting for that edit is discarded
— staleness, mutation accounting and harvest pressure all blind, on the exact path
the optimizer pushes the model toward.

This is the same declared-but-not-wired shape as the rest of this plan: a matcher
advertising coverage a normaliser drops.

**Files:**
- Modify: `hooks-core/decide.mjs`
- Test: `tests/hooks/tool-normalisation.test.mjs` **(new)**

**Interfaces:**
- Produces: `normalizeTool` resolves MCP-prefixed names by their trailing segment; `TOOL_ALIASES` gains the `smart_*` family and `notebookedit`.

- [ ] **Step 1: Write the failing tests**

```javascript
it('resolves an MCP-prefixed tool name by its trailing segment', () => {
  expect(normalizeTool('mcp__plugin_token-optimizer_token-optimizer__smart_edit')).toBe('Edit');
  expect(normalizeTool('mcp__whatever__smart_write')).toBe('Write');
  expect(normalizeTool('NotebookEdit')).toBe('Edit');
});

it('still returns null for a tool it genuinely does not know', () => {
  // The permissive direction matters: an unknown tool must stay unknown rather
  // than being coerced into a built-in that changes a routing verdict.
  expect(normalizeTool('mcp__vendor__deploy_to_prod')).toBeNull();
});

it('does not make the router redirect a tool that is already the replacement', () => {
  // THE LOOP HAZARD. smart_edit normalising to Edit must not cause the router to
  // deny smart_edit and redirect it to smart_edit.
  const verdict = decide(payloadFor('mcp__x__smart_edit', { file_path: file }), state);
  expect(verdict.deny).toBeFalsy();
});
```

- [ ] **Step 2: Run to verify they fail**

- [ ] **Step 3: Implement.** Strip an `mcp__<server>__` prefix before the alias
lookup, and add `smart_edit`, `smart_write`, `smart_read`, `smart_grep`,
`smart_glob` and `notebookedit`.

- [ ] **Step 4: Prove the routing verdicts did not regress — this is the whole risk.**

The reason this was not folded into Task 4 is that it changes what the router
decides, for all eleven clients. So measure it rather than assert it:

```bash
npm test -- tests/hooks/enforcement.test.mjs tests/hooks/clients.test.mjs tests/hooks/routing.test.mjs tests/hooks/policy-asks-for-findings.test.mjs
```

Report, per client, whether any verdict changed. A changed verdict is not
automatically wrong — but it must be named and justified, not discovered later.
If any `smart_*` call now gets denied, that is the loop hazard and it blocks.

- [ ] **Step 5: Full suite and sync check**

- [ ] **Step 6: Commit** with a message stating that the matcher advertised names
the normaliser mapped to null, so the optimizer was blind to its own preferred
tools on the path enforcement pushes the model toward.
