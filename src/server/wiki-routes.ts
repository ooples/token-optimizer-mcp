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
  capabilities: any;
  projects: any;
  lexical: any;
}

let cached: GraphModules | null = null;

async function modules(): Promise<GraphModules | null> {
  if (cached) return cached;
  try {
    const [wiki, curate, metrics, staleness, capabilities, projects, lexical] =
      await Promise.all([
        import(coreUrl('wiki.mjs')),
        import(coreUrl('curate.mjs')),
        import(coreUrl('metrics.mjs')),
        import(coreUrl('staleness.mjs')),
        import(coreUrl('capabilities.mjs')),
        import(coreUrl('projects.mjs')),
        import(coreUrl('lexical.mjs')),
      ]);
    cached = {
      wiki,
      curate,
      metrics,
      staleness,
      capabilities,
      projects,
      lexical,
    };
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
 * Cross-project access is restored through an opaque, server-owned registry.
 * A request may choose a registry id, but it can never supply a filesystem path.
 */
function graphDir(_req: Request, wiki: any): string {
  return wiki.wikiDir(process.cwd());
}

interface GraphSource {
  id: string;
  name: string;
  dir: string;
  current: boolean;
  shared: boolean;
  clients: string[];
  lastSeenAt: number;
}

function pathKey(value: string): string {
  return path.resolve(value).replaceAll('\\', '/').toLowerCase();
}

function inferredProjectName(dir: string): string {
  const parent = path.dirname(dir);
  return path.basename(parent) === '.token-optimizer'
    ? path.basename(path.dirname(parent))
    : path.basename(process.cwd());
}

function graphSources(mods: GraphModules): GraphSource[] {
  const currentDir = graphDir({} as Request, mods.wiki);
  const registered = mods.projects.registeredProjects();
  const currentMatch = registered.find(
    (project: any) => pathKey(project.graphDir) === pathKey(currentDir)
  );
  const current: GraphSource = currentMatch
    ? {
        id: currentMatch.id,
        name: currentMatch.name,
        dir: currentMatch.graphDir,
        current: true,
        shared: false,
        clients: currentMatch.clients || [],
        lastSeenAt: currentMatch.lastSeenAt || 0,
      }
    : {
        id: 'current',
        name: inferredProjectName(currentDir) || 'Current project',
        dir: currentDir,
        current: true,
        shared: false,
        clients: [],
        lastSeenAt: 0,
      };

  const candidates: GraphSource[] = [
    current,
    ...registered.map((project: any) => ({
      id: project.id,
      name: project.name,
      dir: project.graphDir,
      current: pathKey(project.graphDir) === pathKey(currentDir),
      shared: false,
      clients: project.clients || [],
      lastSeenAt: project.lastSeenAt || 0,
    })),
    {
      id: 'shared',
      name: 'Shared lessons',
      dir: mods.wiki.sharedDir(),
      current: pathKey(mods.wiki.sharedDir()) === pathKey(currentDir),
      shared: true,
      clients: [],
      lastSeenAt: 0,
    },
  ];

  // A worktree can be rediscovered through overlapping roots. The graph store,
  // not the spelling of the path used to find it, is the unique source.
  const byDirectory = new Map<string, GraphSource>();
  for (const source of candidates) {
    const key = pathKey(source.dir);
    const previous = byDirectory.get(key);
    if (!previous || source.current || source.lastSeenAt > previous.lastSeenAt)
      byDirectory.set(key, source);
  }
  return [...byDirectory.values()].sort(
    (a, b) =>
      Number(b.current) - Number(a.current) ||
      Number(a.shared) - Number(b.shared) ||
      b.lastSeenAt - a.lastSeenAt ||
      a.name.localeCompare(b.name)
  );
}

class ScopeError extends Error {}

function sourcesFor(req: Request, mods: GraphModules): GraphSource[] {
  const sources = graphSources(mods);
  const scope = String(req.query.scope || 'current');
  if (scope === 'all') return sources;
  if (scope === 'current')
    return sources.filter((source) => source.current).slice(0, 1);
  const source = sources.find((candidate) => candidate.id === scope);
  if (!source) throw new ScopeError('unknown project scope');
  return [source];
}

function sourceById(id: string, mods: GraphModules): GraphSource | null {
  return graphSources(mods).find((source) => source.id === id) || null;
}

function selectedSource(req: Request, mods: GraphModules): GraphSource {
  const requested = String(
    (req.body && req.body.projectId) || req.query.scope || 'current'
  );
  if (requested === 'all') {
    const current = graphSources(mods).find((source) => source.current);
    if (current) return current;
    throw new ScopeError('current project unavailable');
  }
  if (requested === 'current') {
    const current = graphSources(mods).find((source) => source.current);
    if (current) return current;
  }
  const source = sourceById(requested, mods);
  if (!source) throw new ScopeError('unknown project scope');
  return source;
}

function qualifiedId(source: GraphSource, nodeId: string): string {
  return `${source.id}~${nodeId}`;
}

function splitQualifiedId(
  value: string
): { sourceId: string; nodeId: string } | null {
  const split = value.indexOf('~');
  if (split < 1) return null;
  return { sourceId: value.slice(0, split), nodeId: value.slice(split + 1) };
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

const graphCache = new Map<string, CachedGraph>();

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
    graphCache.get(pathKey(dir))?.mtimeMs === stamp.mtimeMs &&
    graphCache.get(pathKey(dir))?.size === stamp.size
  ) {
    return graphCache.get(pathKey(dir))!.graph;
  }

  const graph = wiki.load(dir);
  graphCache.set(pathKey(dir), { ...stamp, graph });
  return graph;
}

/**
 * Trims a node for transport.
 *
 * Snapshots are deliberately dropped: a symbol snapshot can be thousands of
 * characters and the list views never render it. Detail views fetch it
 * explicitly.
 */
function summarise(node: any, source?: GraphSource) {
  return {
    id: source ? qualifiedId(source, node.id) : node.id,
    projectId: source?.id,
    projectName: source?.name,
    kind: node.kind,
    key: node.key,
    claim: node.claim,
    type: node.type,
    confidence: node.confidence,
    confidenceLabel: node.confidenceLabel,
    evidence: node.evidence,
    applicability: node.applicability,
    scope: node.scope || 'project',
    invalidators: Array.isArray(node.invalidators) ? node.invalidators : [],
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
  /** Safe project inventory. Filesystem paths intentionally stay server-side. */
  app.get('/api/wiki/projects', async (_req: Request, res: Response) => {
    const mods = await modules();
    if (!mods) return res.status(503).json({ error: 'graph unavailable' });
    try {
      const projects = graphSources(mods).map((source) => {
        const graph = loadGraph(source.dir, mods.wiki);
        return {
          id: source.id,
          name: source.name,
          current: source.current,
          shared: source.shared,
          clients: source.clients,
          lastSeenAt: source.lastSeenAt || null,
          captured: graph.nodes.size > 0,
          nodes: graph.nodes.size,
          edges: graph.edges.length,
          findings: mods.curate.activeFindings(graph).length,
        };
      });
      return res.json({
        projects,
        captured: projects.filter((project) => project.captured).length,
        missing: projects.filter((project) => !project.captured).length,
      });
    } catch {
      return res.status(500).json({ error: 'project inventory failed' });
    }
  });

  /** Is there a graph at all? Lets the UI hide the section rather than error. */
  app.get('/api/wiki/status', async (req: Request, res: Response) => {
    const mods = await modules();
    if (!mods)
      return res.json({ available: false, reason: 'graph modules not found' });

    try {
      const sources = sourcesFor(req, mods);
      const reports = sources.map((source) => {
        const graph = loadGraph(source.dir, mods.wiki);
        return {
          source,
          nodes: graph.nodes.size,
          edges: graph.edges.length,
          findings: mods.curate.activeFindings(graph).length,
        };
      });
      return res.json({
        available: true,
        nodes: reports.reduce((sum, report) => sum + report.nodes, 0),
        edges: reports.reduce((sum, report) => sum + report.edges, 0),
        findings: reports.reduce((sum, report) => sum + report.findings, 0),
        projects: reports.length,
        capturedProjects: reports.filter((report) => report.nodes > 0).length,
        scope: String(req.query.scope || 'current'),
        // Kept for current-scope compatibility with diagnostics. Aggregate
        // responses never disclose the source directories.
        ...(String(req.query.scope || 'current') === 'current'
          ? { dir: reports[0]?.source.dir || graphDir(req, mods.wiki) }
          : {}),
      });
    } catch (error) {
      if (error instanceof ScopeError)
        return res.status(400).json({ error: error.message });
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
      let findings = sourcesFor(req, mods).flatMap((source) => {
        const graph = loadGraph(source.dir, mods.wiki);
        return mods.curate
          .activeFindings(graph)
          .map((node: any) => ({ node, source }));
      });

      if (kind)
        findings = findings.filter(
          (entry: any) => (entry.node.type || 'finding') === kind
        );

      // Lexical retrieval per the design -- now actually ranked by BM25
      // (hooks-core/lexical.mjs), the same primitive the wiki_query tool
      // uses for its `search` operation. The previous substring filter
      // could not order results, so the caller kept whatever matched rather
      // than what matched best.
      //
      // `rank` scores plain objects by their own `key`/`claim` fields, but
      // this route's pool is `{ node, source }` wrappers (findings are
      // aggregated across every source directory), so each entry is exposed
      // under `key`/`claim` for scoring and unwrapped back to its original
      // `{ node, source }` shape afterward. The limit passed to `rank` is
      // the whole (kind-filtered) pool, not `offset + limit`, so pagination
      // over the RANKED set is exact -- `?offset=` and `?limit=` slice the
      // same full ranking on every page, not a truncated one.
      //
      // `total` is NOT the old filter's match count, and does not claim to
      // be: `rank` omits zero-score findings (a query term must actually
      // match, exactly or by prefix -- see lexical.mjs), so `total` here is
      // the count of findings BM25 considers relevant, which can be smaller
      // than what `.includes()` would have counted for the same query.
      //
      // Only reached when the query actually tokenizes to at least one term
      // (`hasQueryTerms` below) -- `tokenize` strips everything but
      // alphanumeric runs, so a blank, whitespace-only, or punctuation-only
      // `q=` yields no terms and falls through to the no-query branch below
      // instead of asking `rank` to score against nothing (which would
      // return zero results, not "everything," for what a user typing a
      // stray space in the search box expects to behave like no filter).
      const hasQueryTerms = query.length > 0 && mods.lexical.tokenize(query).length > 0;
      if (hasQueryTerms) {
        const scored = mods.lexical.rank(
          query,
          findings.map((entry: any) => ({
            key: entry.node.key,
            claim: entry.node.claim,
            entry,
          })),
          { limit: findings.length }
        );
        findings = scored.map(
          (row: { finding: { entry: unknown } }) => row.finding.entry
        );
      } else {
        findings.sort((a: any, b: any) => {
          const weight = (entry: any) => {
            const f = entry.node;
            return (
              (f.confidence ?? 0.5) *
              // originWeight, not a human-only ternary: the `: 1` branch ranked an
              // agent finding level with a post-hoc harvested guess, so this sort
              // and findingsFor disagreed about provenance.
              mods.curate.originWeight(f.origin) *
              (f.pinned ? 2 : 1)
            );
          };
          return weight(b) - weight(a);
        });
      }

      return res.json({
        total: findings.length,
        offset,
        items: findings
          .slice(offset, offset + limit)
          .map((entry: any) => summarise(entry.node, entry.source)),
      });
    } catch (error) {
      if (error instanceof ScopeError)
        return res.status(400).json({ error: error.message });
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
      const qualified = splitQualifiedId(req.params.id);
      let source: GraphSource | null;
      let nodeId: string;
      if (qualified) {
        source = sourceById(qualified.sourceId, mods);
        nodeId = qualified.nodeId;
      } else {
        source = sourcesFor(req, mods)[0] || null;
        nodeId = req.params.id;
      }
      if (!source) return res.status(404).json({ error: 'no such project' });
      const graph = loadGraph(source.dir, mods.wiki);
      const node = graph.nodes.get(nodeId);
      if (!node) return res.status(404).json({ error: 'no such node' });

      const cap = Math.min(120, Number(req.query.cap) || 40);
      const edges = graph.edges
        .filter((e: any) => e.from === node.id || e.to === node.id)
        .slice(0, cap);

      const neighbours = new Map<string, any>();
      for (const edge of edges) {
        const otherId = edge.from === node.id ? edge.to : edge.from;
        const other = graph.nodes.get(otherId);
        if (other) neighbours.set(otherId, summarise(other, source));
      }

      // Provenance: which task established this, and from what. "Why do you
      // believe this?" is the question a knowledge graph has to answer.
      return res.json({
        node: {
          ...summarise(node, source),
          snapshot: node.snapshot ? node.snapshot.slice(0, 4000) : undefined,
        },
        edges: edges.map((e: any) => ({
          from: qualifiedId(source, e.from),
          to: qualifiedId(source, e.to),
          edge: e.edge,
        })),
        neighbours: [...neighbours.values()],
        truncated: edges.length === cap,
      });
    } catch (error) {
      if (error instanceof ScopeError)
        return res.status(400).json({ error: error.message });
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
      const sources = sourcesFor(req, mods);
      const graphs = new Map(
        sources.map((source) => [source.id, loadGraph(source.dir, mods.wiki)])
      );
      const allFindings = sources.flatMap((source) =>
        mods.curate
          .activeFindings(graphs.get(source.id))
          .map((node: any) => ({ node, source }))
      );
      const findings = allFindings
        .sort(
          (a: any, b: any) =>
            (b.node.confidence ?? 0) - (a.node.confidence ?? 0)
        )
        .slice(0, cap);

      const keep = new Map<string, Set<string>>();
      for (const { node, source } of findings) {
        if (!keep.has(source.id)) keep.set(source.id, new Set());
        keep.get(source.id)!.add(node.id);
      }
      // Pull in the anchors those findings hang from, so the picture shows
      // structure rather than a cloud of disconnected points.
      for (const source of sources) {
        const sourceKeep = keep.get(source.id);
        if (!sourceKeep) continue;
        for (const edge of graphs.get(source.id).edges) {
          if (edge.edge === 'derived_from' && sourceKeep.has(edge.from))
            sourceKeep.add(edge.to);
        }
      }

      return res.json({
        nodes: sources.flatMap((source) =>
          [...(keep.get(source.id) || [])]
            .map((id) => graphs.get(source.id).nodes.get(id))
            .filter(Boolean)
            .map((node) => summarise(node, source))
        ),
        edges: sources.flatMap((source) => {
          const sourceKeep = keep.get(source.id) || new Set();
          return graphs
            .get(source.id)
            .edges.filter(
              (edge: any) =>
                sourceKeep.has(edge.from) && sourceKeep.has(edge.to)
            )
            .map((edge: any) => ({
              from: qualifiedId(source, edge.from),
              to: qualifiedId(source, edge.to),
              edge: edge.edge,
            }));
        }),
        projects: sources.length,
        findings: allFindings.length,
        renderedFindings: findings.length,
        capped: allFindings.length > cap,
      });
    } catch (error) {
      if (error instanceof ScopeError)
        return res.status(400).json({ error: error.message });
      return res.status(500).json({ error: 'constellation failed' });
    }
  });

  /** The audit view: what a person needs to look at. */
  app.get('/api/wiki/audit', async (req: Request, res: Response) => {
    const mods = await modules();
    if (!mods) return res.status(503).json({ error: 'graph unavailable' });

    try {
      const results = sourcesFor(req, mods).map((source) => ({
        source,
        result: mods.curate.audit(loadGraph(source.dir, mods.wiki)),
      }));
      const collect = (key: string) =>
        results.flatMap(({ source, result }) =>
          result[key].map((node: any) => summarise(node, source))
        );
      const contradicted = collect('contradicted');
      const orphaned = collect('orphaned');
      const lowConfidence = collect('lowConfidence');
      const stale = collect('stale');
      return res.json({
        contradicted,
        orphaned,
        lowConfidence,
        stale,
        total:
          contradicted.length +
          orphaned.length +
          lowConfidence.length +
          stale.length,
      });
    } catch (error) {
      if (error instanceof ScopeError)
        return res.status(400).json({ error: error.message });
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
      const selected = sourcesFor(req, mods);
      return res.json(
        selected.length > 1
          ? mods.metrics.reportMany(selected.map((source) => source.dir))
          : mods.metrics.report(
              selected[0]?.dir || selectedSource(req, mods).dir
            )
      );
    } catch (error) {
      if (error instanceof ScopeError)
        return res.status(400).json({ error: error.message });
      return res.status(500).json({ error: 'balance failed' });
    }
  });

  /**
   * Causal evidence, with cohort filters and honest capability tiers.  This is
   * separate from /balance because randomized eval runs and passive file
   * holdouts are different strengths of evidence and must not be blended.
   */
  app.get('/api/wiki/evidence', async (req: Request, res: Response) => {
    const mods = await modules();
    if (!mods) return res.status(503).json({ error: 'graph unavailable' });

    const filters: Record<string, string> = {};
    for (const key of [
      'client',
      'clientVersion',
      'model',
      'modelVersion',
      'taskId',
      'arm',
    ]) {
      const value = req.query[key];
      if (typeof value === 'string' && value.trim())
        filters[key] = value.trim().slice(0, 200);
    }
    const requestedLimit = Number(req.query.limit);
    const episodeLimit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(500, requestedLimit))
      : 100;

    try {
      const selected = sourcesFor(req, mods);
      const evidence =
        selected.length > 1
          ? mods.metrics.evidenceReportMany(
              selected.map((source) => source.dir),
              {
                filters,
                episodeLimit,
              }
            )
          : mods.metrics.evidenceReport(
              selected[0]?.dir || selectedSource(req, mods).dir,
              {
                filters,
                episodeLimit,
              }
            );
      return res.json({
        ...evidence,
        scope: String(req.query.scope || 'current'),
        capabilities: mods.capabilities.capabilitySummary(),
      });
    } catch (error) {
      if (error instanceof ScopeError)
        return res.status(400).json({ error: error.message });
      return res.status(500).json({ error: 'evidence report failed' });
    }
  });

  /** Human outcome feedback drives utility ranking and harmful-finding quarantine. */
  app.post(
    '/api/wiki/evidence/feedback',
    async (req: Request, res: Response) => {
      if (rejectsCrossSite(req, res)) return undefined;
      const mods = await modules();
      if (!mods) return res.status(503).json({ error: 'graph unavailable' });

      const { findingId, rating, reason, episodeId, injectionId } =
        req.body || {};
      if (typeof findingId !== 'string' || !findingId.trim())
        return res.status(400).json({ error: 'findingId required' });
      if (!['helpful', 'neutral', 'harmful'].includes(rating))
        return res
          .status(400)
          .json({ error: 'rating must be helpful, neutral, or harmful' });

      const recorded = mods.metrics.recordFindingFeedback(
        selectedSource(req, mods).dir,
        {
          findingId: findingId.trim().slice(0, 300),
          rating,
          reason:
            typeof reason === 'string' ? reason.trim().slice(0, 1000) : null,
          episodeId:
            typeof episodeId === 'string' ? episodeId.slice(0, 300) : null,
          injectionId:
            typeof injectionId === 'string' ? injectionId.slice(0, 300) : null,
        }
      );
      return recorded
        ? res.json({ ok: true, id: recorded.id })
        : res.status(500).json({ error: 'feedback write failed' });
    }
  );

  /** Markdown export -- the graph as reviewable, committable documentation. */
  app.get('/api/wiki/export', async (req: Request, res: Response) => {
    const mods = await modules();
    if (!mods) return res.status(503).json({ error: 'graph unavailable' });

    try {
      const sources = sourcesFor(req, mods);
      const markdown = sources
        .map(
          (source) =>
            `# ${source.name}\n\n${mods.curate.exportMarkdown(
              loadGraph(source.dir, mods.wiki)
            )}`
        )
        .join('\n\n---\n\n');
      return res.type('text/markdown').send(markdown);
    } catch (error) {
      if (error instanceof ScopeError)
        return res.status(400).json({ error: error.message });
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

    const { action, key, claim, anchors, confidence, pinned, byKey, reason } =
      req.body || {};
    let dir: string;
    try {
      dir = selectedSource(req, mods).dir;
    } catch (error) {
      if (error instanceof ScopeError)
        return res.status(400).json({ error: error.message });
      throw error;
    }
    // Any curation appends to the log, so the cached parse is stale the moment
    // it succeeds. Dropping it here is cheaper and more obviously correct than
    // trying to patch the cached graph in place.
    graphCache.delete(pathKey(dir));

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
        case 'contradict': {
          // AN EDGE, NOT AN OVERWRITE, and this is the only door it has: the
          // schema declared `contradicts` from the start, `audit` read it, and
          // nothing could write it -- so a belief change could only be recorded
          // by `correct`, which retires the old claim and picks a winner.
          // Recording a disagreement is the case where nobody has picked yet.
          if (!byKey) return res.status(400).json({ error: 'byKey required' });
          // Both ends must resolve to findings that exist, or the edge points at
          // nothing and the disagreement is recorded against an id no reader can
          // follow. curate returns false for that, and for a claim disagreeing
          // with itself.
          return mods.curate.contradict(dir, { key, byKey, reason })
            ? res.json({ ok: true })
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
