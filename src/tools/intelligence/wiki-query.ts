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
  return pathToFileURL(path.join(here, '..', '..', '..', 'hooks-core', name))
    .href;
}

/** Closed set, so a typo cannot compile. */
export enum WikiQueryOperation {
  Get = 'get',
  Search = 'search',
  Node = 'node',
  Audit = 'audit',
  Balance = 'balance',
  Overview = 'overview',
}

/** The operation names as they cross the wire, derived from the enum. */
export const WIKI_QUERY_OPERATIONS: string[] =
  Object.values(WikiQueryOperation);

/** Finding types a search may be restricted to. Mirrors wiki_write's set. */
export const WIKI_QUERY_FINDING_TYPES = [
  'finding',
  'decision',
  'failure',
  'command',
  'map',
  'feedback',
];

export interface WikiQueryOptions {
  operation: WikiQueryOperation | `${WikiQueryOperation}`;
  /** `get`: the finding key. */
  key?: string;
  /** `search`: the search terms. */
  query?: string;
  /** `search`: restrict to one finding type. */
  type?: string;
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
    "Read the project's knowledge graph: fetch a finding by key, search findings by " +
    "terms, inspect a node and its neighbours, or get the graph's audit, token balance " +
    'and overall shape. Use it when the session index mentions a finding you want in ' +
    'full, or to find out what the graph holds at all. NOT for anchored retrieval: to ' +
    'ask what is known about a particular file or symbol, call wiki_read, which does ' +
    'exactly that and is the tool the enforcement layer points at.',
  annotations: {
    title: 'Read project knowledge',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: WIKI_QUERY_OPERATIONS,
        description:
          'get = one finding by key. search = findings matching terms. node = a node ' +
          'and its neighbours. audit = findings needing attention. balance = what the ' +
          "graph has cost and saved. overview = the graph's shape. For findings about a " +
          'particular file or symbol, use wiki_read instead.',
      },
      key: { type: 'string', description: 'Finding key, for operation=get.' },
      query: {
        type: 'string',
        description: 'Search terms, for operation=search.',
      },
      type: {
        type: 'string',
        enum: WIKI_QUERY_FINDING_TYPES,
        description: 'Restrict search to one finding type.',
      },
      nodeId: { type: 'string', description: 'Node id, for operation=node.' },
      limit: {
        type: 'number',
        description: 'Max rows. Default 20, capped at 100.',
      },
      graphDir: {
        type: 'string',
        description: 'Explicit graph directory. Normally omitted.',
      },
      projectRoot: {
        type: 'string',
        description: 'Explicit project root. Normally omitted.',
      },
      sessionId: {
        type: 'string',
        description: 'Session id, recorded with the query event.',
      },
    },
    required: ['operation'],
  },
};

/**
 * A node's `snapshot` is a VERBATIM COPY OF A FILE, and it must never reach a
 * response.
 *
 * The original design of this tool trimmed findings to a fixed shape for exactly
 * this reason, then never called the function that did it -- so the invariant
 * held only because `load()` happens to be called without `{ snapshots: true }`.
 * That is one unrelated edit away from posting a private file into a model's
 * context, and it is not hypothetical from the other direction either: `putNode`
 * spreads whatever fields it is given onto the record, so a `snapshot` written
 * inline is returned by `load()` regardless of that flag.
 *
 * So the guarantee lives at the boundary instead of in a comment. Every response
 * leaves through here, and the walk is structural rather than a field list: a
 * future field nested anywhere inside a served finding, a graph node or a
 * neighbour is stripped without this function having to know it exists.
 */
const SNAPSHOT_FIELDS = new Set(['snapshot', 'snapshots', 'before', 'after']);

function withoutSnapshots<T>(value: T, depth = 0): T {
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) =>
      withoutSnapshots(item, depth + 1)
    ) as unknown as T;
  }
  if (value instanceof Map) {
    // A Map does not survive JSON.stringify anyway, so returning one would be a
    // silent `{}` on the wire. Refusing to carry it here makes that visible.
    return undefined as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SNAPSHOT_FIELDS.has(key)) continue;
    out[key] = withoutSnapshots(item, depth + 1);
  }
  return out as unknown as T;
}

/** The single exit. Nothing returns from wikiQuery except through this. */
function respond(result: WikiQueryResult): WikiQueryResult {
  return withoutSnapshots(result);
}

export async function wikiQuery(
  options: WikiQueryOptions
): Promise<WikiQueryResult> {
  const operation = String(options?.operation ?? '');
  const limit = Math.min(100, Math.max(1, Number(options?.limit) || 20));

  const [wiki, curate, metrics, staleness, lexical, projects] =
    await Promise.all([
      import(coreUrl('wiki.mjs')),
      import(coreUrl('curate.mjs')),
      import(coreUrl('metrics.mjs')),
      import(coreUrl('staleness.mjs')),
      import(coreUrl('lexical.mjs')),
      import(coreUrl('projects.mjs')),
    ]);

  // The graph belongs to the project the ANCHOR is in, not to wherever the
  // session happens to be running -- the same rule wiki_write follows.
  // No anchor to infer from any more -- anchored retrieval belongs to wiki_read.
  // An explicit projectRoot still wins, so a caller that knows better can name it.
  const inferredRoot = options.projectRoot ?? process.cwd();
  const dir = options.graphDir ?? wiki.wikiDir(inferredRoot);
  if (!options.graphDir) {
    projects.registerProject({
      root: inferredRoot,
      graphDir: dir,
      client: 'mcp',
    });
  }

  // Recorded BEFORE the work, so a query that then fails still counts as the
  // model having asked. The metric is about the index leading somewhere, not
  // about whether the answer existed.
  metrics.record(dir, {
    kind: 'query',
    operation,
    key: options.key ?? null,
    sessionId: options.sessionId ?? null,
  });

  const graph = wiki.load(dir);

  if (operation === WikiQueryOperation.Get) {
    const all = curate.activeFindings(graph);
    const match = all.find(
      (f: Record<string, unknown>) => f.key === options.key
    );
    if (!match)
      return respond({
        operation,
        found: false,
        note: 'no finding with that key',
      });
    // Served through `serve` so a stale finding arrives WITH the diff that
    // invalidated it. A stale finding served bare is worse than no graph.
    const [served] = staleness.serve(graph, [match]);
    return respond({ operation, found: true, finding: served });
  }

  if (operation === WikiQueryOperation.Search) {
    let pool = curate.activeFindings(graph);
    if (options.type) {
      pool = pool.filter(
        (f: Record<string, unknown>) => (f.type ?? 'finding') === options.type
      );
    }
    const ranked = lexical.rank(String(options.query ?? ''), pool, { limit });
    const served = staleness.serve(
      graph,
      ranked.map((r: { finding: unknown }) => r.finding)
    );
    return respond({ operation, found: served.length > 0, findings: served });
  }

  if (operation === WikiQueryOperation.Node) {
    const node = graph.nodes.get(String(options.nodeId ?? ''));
    if (!node)
      return respond({ operation, found: false, note: 'no such node' });
    const edges = graph.edges
      .filter(
        (e: { from: string; to: string }) =>
          e.from === node.id || e.to === node.id
      )
      .slice(0, limit);
    const neighbours = edges
      .map((e: { from: string; to: string }) =>
        graph.nodes.get(e.from === node.id ? e.to : e.from)
      )
      .filter(Boolean);
    return respond({ operation, found: true, node, neighbours });
  }

  if (operation === WikiQueryOperation.Audit) {
    return respond({ operation, found: true, audit: curate.audit(graph) });
  }

  if (operation === WikiQueryOperation.Balance) {
    return respond({ operation, found: true, balance: metrics.report(dir) });
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
      if (target)
        perAnchor.set(target.key, (perAnchor.get(target.key) || 0) + 1);
    }
    const densest = [...perAnchor.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([key, findings]) => ({ key, findings }));
    const findings = curate.activeFindings(graph);
    return respond({
      operation,
      found: true,
      overview: {
        counts,
        densest,
        stale: findings.filter((f: Record<string, unknown>) => f.stale).length,
        total: findings.length,
      },
    });
  }

  return respond({
    operation,
    found: false,
    note: `unknown operation: ${operation}`,
  });
}
