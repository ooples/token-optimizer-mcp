/**
 * Wiki graph API for the dashboard.
 *
 * SERVER-SIDE BY DESIGN. The browser never receives the whole graph; it asks
 * for a neighbourhood, a search result, or a page. A mature project's graph can
 * hold thousands of nodes, and shipping it wholesale would make every page load
 * a multi-megabyte download for a view that shows twenty things.
 *
 * The graph modules are plain ESM under hooks-core/ because Claude Code and the
 * other clients execute them directly from the installed plugin directory, with
 * no build step. They are imported dynamically here rather than statically so
 * that this TypeScript build has no compile-time dependency on untyped ESM, and
 * so a missing or unreadable graph degrades to an empty dashboard section
 * instead of failing the whole server to start.
 */

import type { Express, Request, Response } from 'express';
import path from 'path';
import { statSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname } from 'path';

const here = dirname(fileURLToPath(import.meta.url));

/** Resolves hooks-core relative to the built output, which lives in dist/server. */
function coreUrl(name: string): string {
  return pathToFileURL(path.join(here, '..', '..', 'hooks-core', name)).href;
}

interface GraphModules {
  wiki: any;
  curate: any;
  metrics: any;
  staleness: any;
}

let cached: GraphModules | null = null;

async function modules(): Promise<GraphModules | null> {
  if (cached) return cached;
  try {
    const [wiki, curate, metrics, staleness] = await Promise.all([
      import(coreUrl('wiki.mjs')),
      import(coreUrl('curate.mjs')),
      import(coreUrl('metrics.mjs')),
      import(coreUrl('staleness.mjs')),
    ]);
    cached = { wiki, curate, metrics, staleness };
    return cached;
  } catch {
    return null;
  }
}

/**
 * The graph directory. Deliberately NOT caller-controlled.
 *
 * This previously honoured a `?project=` query parameter, which flowed straight
 * into wikiDir() -- a plain path join that accepts absolute paths and `..`. On
 * the GET routes that disclosed the graph of any directory on the machine; on
 * POST /api/wiki/curate it reached putNode/putEdge, which mkdir -p and append,
 * making it a directory-creation and file-write primitive at a caller-chosen
 * location. With no auth on a localhost server, any page open in the user's
 * browser could drive it.
 *
 * The dashboard serves exactly one project: the one it was started in. An
 * operator who wants a different graph sets TOKEN_OPTIMIZER_WIKI_DIR, which is
 * a deliberate act on the server side rather than a request parameter.
 */
function graphDir(_req: Request, wiki: any): string {
  return wiki.wikiDir(process.cwd());
}

/**
 * Rejects cross-site requests to the mutating route.
 *
 * The dashboard has no authentication because it binds to localhost, but "no
 * auth" plus "a browser will happily POST to localhost from any origin" is how
 * a local tool becomes remotely drivable. Requiring an explicit header that a
 * cross-origin form cannot set, plus a same-origin check when Origin is
 * present, closes it without introducing a token flow.
 */
function rejectsCrossSite(req: Request, res: Response): boolean {
  const origin = req.get('origin');
  if (origin) {
    const host = req.get('host');
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = null;
    }
    if (!host || originHost !== host) {
      res.status(403).json({ error: 'cross-origin request refused' });
      return true;
    }
  }

  // Simple <form> posts cannot set a custom header, so requiring one blocks the
  // no-CORS-preflight path that origin checking alone would miss.
  if (req.get('x-token-optimizer') !== 'dashboard') {
    res.status(403).json({ error: 'missing x-token-optimizer header' });
    return true;
  }
  return false;
}

interface CachedGraph {
  mtimeMs: number;
  size: number;
  graph: any;
}

let graphCache: CachedGraph | null = null;

/**
 * Loads the graph, reusing the parse when the log has not changed.
 *
 * Every route previously re-read and re-parsed the entire append-only log
 * synchronously, so a single dashboard page load -- status, balance, search,
 * audit, then a node lookup -- parsed a mature project's whole graph five
 * times, on the event loop, blocking every other request.
 *
 * Keyed on the log's mtime AND size rather than mtime alone: the file is
 * append-only and a same-millisecond append is entirely possible, which mtime
 * alone would miss and serve a stale graph.
 */
function loadGraph(dir: string, wiki: any): any {
  const logPath = path.join(dir, 'graph.jsonl');
  let stamp: { mtimeMs: number; size: number };
  try {
    const stat = statSync(logPath);
    stamp = { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    // No log yet: nothing to cache, and load() returns an empty graph.
    return wiki.load(dir);
  }

  if (
    graphCache &&
    graphCache.mtimeMs === stamp.mtimeMs &&
    graphCache.size === stamp.size
  ) {
    return graphCache.graph;
  }

  const graph = wiki.load(dir);
  graphCache = { ...stamp, graph };
  return graph;
}

/**
 * Trims a node for transport.
 *
 * Snapshots are deliberately dropped: a symbol snapshot can be thousands of
 * characters and the list views never render it. Detail views fetch it
 * explicitly.
 */
function summarise(node: any) {
  return {
    id: node.id,
    kind: node.kind,
    key: node.key,
    claim: node.claim,
    type: node.type,
    confidence: node.confidence,
    origin: node.origin || 'harvested',
    stale: Boolean(node.stale),
    pinned: Boolean(node.pinned),
    // Retired nodes stay REACHABLE -- a `supersedes` edge pointing at one is
    // how the history of a claim stays legible -- but they must never look
    // identical to a live finding. The flag is what lets the UI say so.
    retired: Boolean(node.retired),
    at: node.at,
    ...(node.kind === 'symbol' ? { name: node.name, file: node.file } : {}),
  };
}

export function registerWikiRoutes(app: Express): void {
  /** Is there a graph at all? Lets the UI hide the section rather than error. */
  app.get('/api/wiki/status', async (req: Request, res: Response) => {
    const mods = await modules();
    if (!mods)
      return res.json({ available: false, reason: 'graph modules not found' });

    try {
      const graph = loadGraph(graphDir(req, mods.wiki), mods.wiki);
      const findings = mods.curate.activeFindings(graph);
      return res.json({
        available: true,
        nodes: graph.nodes.size,
        edges: graph.edges.length,
        findings: findings.length,
        dir: graphDir(req, mods.wiki),
      });
    } catch {
      return res.json({ available: false, reason: 'graph unreadable' });
    }
  });

  /** Paginated, filterable finding search. */
  app.get('/api/wiki/search', async (req: Request, res: Response) => {
    const mods = await modules();
    if (!mods) return res.status(503).json({ error: 'graph unavailable' });

    const query = String(req.query.q || '').toLowerCase();
    const kind = String(req.query.type || '');
    const limit = Math.min(200, Number(req.query.limit) || 50);
    const offset = Math.max(0, Number(req.query.offset) || 0);

    try {
      const graph = loadGraph(graphDir(req, mods.wiki), mods.wiki);
      let findings = mods.curate.activeFindings(graph);

      // Lexical filter, per the design's traversal-plus-lexical retrieval --
      // there is no embedding index to consult and deliberately so.
      if (query) {
        findings = findings.filter(
          (f: any) =>
            String(f.claim || '')
              .toLowerCase()
              .includes(query) ||
            String(f.key || '')
              .toLowerCase()
              .includes(query)
        );
      }
      if (kind)
        findings = findings.filter((f: any) => (f.type || 'finding') === kind);

      findings.sort((a: any, b: any) => {
        const weight = (f: any) =>
          (f.confidence ?? 0.5) *
          // originWeight, not a human-only ternary: the `: 1` branch ranked an
          // agent finding level with a post-hoc harvested guess, so this sort
          // and findingsFor disagreed about provenance.
          mods.curate.originWeight(f.origin) *
          (f.pinned ? 2 : 1);
        return weight(b) - weight(a);
      });

      return res.json({
        total: findings.length,
        offset,
        items: findings.slice(offset, offset + limit).map(summarise),
      });
    } catch {
      return res.status(500).json({ error: 'search failed' });
    }
  });

  /**
   * A node and its immediate neighbourhood -- the unit the focus view renders.
   * Bounded so a hub node with 900 edges cannot stall the browser.
   */
  app.get('/api/wiki/node/:id', async (req: Request, res: Response) => {
    const mods = await modules();
    if (!mods) return res.status(503).json({ error: 'graph unavailable' });

    try {
      const graph = loadGraph(graphDir(req, mods.wiki), mods.wiki);
      const node = graph.nodes.get(req.params.id);
      if (!node) return res.status(404).json({ error: 'no such node' });

      const cap = Math.min(120, Number(req.query.cap) || 40);
      const edges = graph.edges
        .filter((e: any) => e.from === node.id || e.to === node.id)
        .slice(0, cap);

      const neighbours = new Map<string, any>();
      for (const edge of edges) {
        const otherId = edge.from === node.id ? edge.to : edge.from;
        const other = graph.nodes.get(otherId);
        if (other) neighbours.set(otherId, summarise(other));
      }

      // Provenance: which task established this, and from what. "Why do you
      // believe this?" is the question a knowledge graph has to answer.
      return res.json({
        node: {
          ...summarise(node),
          snapshot: node.snapshot ? node.snapshot.slice(0, 4000) : undefined,
        },
        edges: edges.map((e: any) => ({
          from: e.from,
          to: e.to,
          edge: e.edge,
        })),
        neighbours: [...neighbours.values()],
        truncated: edges.length === cap,
      });
    } catch {
      return res.status(500).json({ error: 'node lookup failed' });
    }
  });

  /**
   * A bounded subgraph for the constellation view.
   *
   * Capped hard: force-directed layout over an unbounded graph produces an
   * unreadable hairball and a busy CPU. The cap is what makes the overview a
   * navigation aid rather than a demo.
   */
  app.get('/api/wiki/constellation', async (req: Request, res: Response) => {
    const mods = await modules();
    if (!mods) return res.status(503).json({ error: 'graph unavailable' });

    const cap = Math.min(300, Number(req.query.cap) || 150);
    try {
      const graph = loadGraph(graphDir(req, mods.wiki), mods.wiki);
      const findings = mods.curate
        .activeFindings(graph)
        .sort((a: any, b: any) => (b.confidence ?? 0) - (a.confidence ?? 0))
        .slice(0, cap);

      const keep = new Set(findings.map((f: any) => f.id));
      // Pull in the anchors those findings hang from, so the picture shows
      // structure rather than a cloud of disconnected points.
      for (const edge of graph.edges) {
        if (edge.edge === 'derived_from' && keep.has(edge.from))
          keep.add(edge.to);
      }

      return res.json({
        nodes: [...keep]
          .map((id) => graph.nodes.get(id))
          .filter(Boolean)
          .map(summarise),
        edges: graph.edges
          .filter((e: any) => keep.has(e.from) && keep.has(e.to))
          .map((e: any) => ({ from: e.from, to: e.to, edge: e.edge })),
        capped: findings.length === cap,
      });
    } catch {
      return res.status(500).json({ error: 'constellation failed' });
    }
  });

  /** The audit view: what a person needs to look at. */
  app.get('/api/wiki/audit', async (req: Request, res: Response) => {
    const mods = await modules();
    if (!mods) return res.status(503).json({ error: 'graph unavailable' });

    try {
      const result = mods.curate.audit(
        loadGraph(graphDir(req, mods.wiki), mods.wiki)
      );
      return res.json({
        contradicted: result.contradicted.map(summarise),
        orphaned: result.orphaned.map(summarise),
        lowConfidence: result.lowConfidence.map(summarise),
        stale: result.stale.map(summarise),
        total:
          result.contradicted.length +
          result.orphaned.length +
          result.lowConfidence.length +
          result.stale.length,
      });
    } catch {
      return res.status(500).json({ error: 'audit failed' });
    }
  });

  /**
   * The token balance.
   *
   * This is the number competitors cannot produce: it comes from a withheld
   * CONTROL ARM rather than from the tool's own assumptions about what it
   * saved. The response carries `sufficientData` so the UI can refuse to draw a
   * headline figure before the experiment can support one.
   */
  app.get('/api/wiki/balance', async (req: Request, res: Response) => {
    const mods = await modules();
    if (!mods) return res.status(503).json({ error: 'graph unavailable' });

    try {
      return res.json(mods.metrics.report(graphDir(req, mods.wiki)));
    } catch {
      return res.status(500).json({ error: 'balance failed' });
    }
  });

  /** Markdown export -- the graph as reviewable, committable documentation. */
  app.get('/api/wiki/export', async (req: Request, res: Response) => {
    const mods = await modules();
    if (!mods) return res.status(503).json({ error: 'graph unavailable' });

    try {
      const markdown = mods.curate.exportMarkdown(
        loadGraph(graphDir(req, mods.wiki), mods.wiki)
      );
      return res.type('text/markdown').send(markdown);
    } catch {
      return res.status(500).json({ error: 'export failed' });
    }
  });

  /**
   * Curation. Every action APPENDS -- nothing here mutates a record in place,
   * so the log remains the full history of what was believed and when.
   */
  app.post('/api/wiki/curate', async (req: Request, res: Response) => {
    if (rejectsCrossSite(req, res)) return undefined;

    const mods = await modules();
    if (!mods) return res.status(503).json({ error: 'graph unavailable' });

    const { action, key, claim, anchors, confidence, pinned } = req.body || {};
    const dir = graphDir(req, mods.wiki);
    // Any curation appends to the log, so the cached parse is stale the moment
    // it succeeds. Dropping it here is cheaper and more obviously correct than
    // trying to patch the cached graph in place.
    graphCache = null;

    try {
      switch (action) {
        case 'pin':
          return res.json({ ok: mods.curate.pin(dir, key, pinned !== false) });
        case 'retire':
          return res.json({ ok: mods.curate.retire(dir, key) });
        case 'correct': {
          if (!claim) return res.status(400).json({ error: 'claim required' });
          const replacement = mods.curate.correct(dir, key, claim, {
            confidence,
          });
          return replacement
            ? res.json({ ok: true, key: replacement })
            : res.status(404).json({ error: 'no such finding' });
        }
        case 'create': {
          const created = mods.curate.create(dir, {
            claim,
            anchors,
            confidence,
          });
          // Anchors are required of humans for the same reason they are
          // required of the harvester: an unanchored claim can never be
          // re-checked against the code.
          return created
            ? res.json({ ok: true, key: created })
            : res
                .status(400)
                .json({ error: 'claim and at least one anchor are required' });
        }
        default:
          return res.status(400).json({ error: 'unknown action' });
      }
    } catch {
      return res.status(500).json({ error: 'curate failed' });
    }
  });
}
