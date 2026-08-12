/**
 * wiki_read — retrieve what the graph already knows, before doing the work again.
 *
 * The graph has had a deliberate WRITE path since wiki_write, and no read path at all. It is
 * read today only by the hooks, which inject a briefing at SessionStart and on touch. That is
 * enough for the main session and nothing else, and the gap has a concrete cost:
 *
 *   A SUBAGENT NEVER RECEIVES SessionStart. Every subagent starts blind, no matter how much the
 *   graph knows about the files it is about to open. Observed while reviewing one pull request:
 *   eleven reviewer subagents each independently re-derived that a particular base-class method
 *   is a setter rather than a gradient step, and the orchestrator had to hand-write that warning
 *   into every prompt to stop them re-reporting it. The graph held the answer; nothing could ask.
 *
 * That is the case this tool exists for. A knowledge store meant to stand in for RAG, CLAUDE.md
 * and a memory system has to be readable by the agents that most need it, not only by the one
 * process that happens to receive a hook.
 *
 * Retrieval is the same traversal the hooks use — `findingsFor`, anchored on a file or symbol,
 * with the same ranking and the same exclusion of retired findings. Deliberately NOT a second,
 * divergent definition of "what is relevant here": if the ranking is wrong, it should be wrong
 * identically in both places and fixed once.
 */

import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname } from 'path';

const here = dirname(fileURLToPath(import.meta.url));

/** Resolves hooks-core relative to the built output, which lives in dist/tools/intelligence. */
function coreUrl(name: string): string {
  return pathToFileURL(path.join(here, '..', '..', '..', 'hooks-core', name))
    .href;
}

export interface WikiReadOptions {
  /**
   * Files, or `file#symbol`, to retrieve findings for. This is the normal way to ask: an agent
   * about to work on a file asks what is known about that file.
   */
  anchors?: string[];
  /**
   * Read a project's graph without naming an anchor. Returns its standing rules and most
   * relevant findings — the equivalent of the briefing a session receives at start.
   */
  projectRoot?: string;
  /** Maximum findings returned per anchor. Default 10. */
  limit?: number;
  /**
   * Also return the machine-wide lessons that hold in any repository. Default true: a lesson
   * about how to run the tests is exactly what a fresh agent is most likely to get wrong, and
   * it is the tier least likely to be reachable from any anchor it happens to name.
   */
  includeShared?: boolean;
}

export interface WikiFinding {
  type: string;
  claim: string;
  confidence: number;
  origin?: string;
  at?: number;
  anchors?: string[];
  trigger?: string;
}

export interface WikiReadResult {
  success: boolean;
  project?: string;
  findings: WikiFinding[];
  /** Lessons carried from other projects on this machine. */
  shared: WikiFinding[];
  /** Anchors that named nothing in the graph, so could not be traversed from. */
  unresolvedAnchors: string[];
  /** Present when the graph exists but holds nothing for this query — a real, common answer. */
  note?: string;
  error?: string;
}

function toFinding(node: any): WikiFinding {
  return {
    type: node.type ?? 'finding',
    claim: node.claim,
    confidence: typeof node.confidence === 'number' ? node.confidence : 0.5,
    origin: node.origin,
    at: node.at,
    anchors: node.anchors,
    trigger: node.trigger,
  };
}

export async function wikiRead(
  options: WikiReadOptions = {}
): Promise<WikiReadResult> {
  const empty = {
    findings: [] as WikiFinding[],
    shared: [] as WikiFinding[],
    unresolvedAnchors: [] as string[],
  };

  const anchors = Array.isArray(options?.anchors)
    ? options.anchors.filter((a) => typeof a === 'string' && a.trim())
    : [];

  if (!anchors.length && !options?.projectRoot) {
    return {
      success: false,
      ...empty,
      error: 'give either anchors (files the work is about) or projectRoot',
    };
  }

  const limit =
    Number.isFinite(options?.limit) && (options!.limit as number) > 0
      ? Math.min(options!.limit as number, 100)
      : 10;

  try {
    const wiki: any = await import(coreUrl('wiki.mjs'));

    // Same rule as wiki_write: the graph is the ANCHOR's project, not wherever the caller is
    // running. A subagent's cwd is not meaningful, which is precisely why it cannot be trusted
    // to select the graph.
    //
    // ONE GRAPH PER ANCHOR PROJECT, not one graph for the whole request. Resolving the project
    // from anchors[0] and querying it for every anchor meant that a request spanning two
    // repositories -- routine for an agent asked to compare an implementation against its
    // consumer -- reported every anchor outside the first one's repo as unresolved. That reads
    // as "nothing is recorded about this file", which is the reassuring answer, and it would be
    // wrong. Graphs are loaded once each and reused across anchors that share a project.
    const graphs = new Map<string, any>();
    const graphFor = (project: string) => {
      if (!graphs.has(project))
        graphs.set(project, wiki.load(wiki.wikiDir(project)));
      return graphs.get(project);
    };

    const primary =
      options.projectRoot ??
      (anchors.length
        ? wiki.projectRootFor(anchors[0].split('#')[0], process.cwd())
        : process.cwd());

    const seen = new Set<string>();
    const findings: WikiFinding[] = [];
    const unresolvedAnchors: string[] = [];

    for (const a of anchors) {
      const [file, symbol] = a.split('#');
      // An explicit projectRoot pins every anchor to that graph -- the caller has said which
      // project they mean. Otherwise each anchor resolves to its own repository.
      const project =
        options.projectRoot ?? wiki.projectRootFor(file, process.cwd());
      const graph = graphFor(project);

      const id = symbol
        ? wiki.nodeId('symbol', `${file}#${symbol}`)
        : wiki.nodeId('file', wiki.canonicalKey('file', file));

      if (!graph.nodes.has(id)) {
        unresolvedAnchors.push(a);
        continue;
      }
      for (const node of wiki.findingsFor(graph, id, { limit })) {
        // Deduplicated across anchors: two files in one request that share a finding should
        // surface it once, or a caller paying by the token pays twice for the same sentence.
        const key = String(node.claim ?? '');
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push(toFinding(node));
      }
    }

    const project = primary;
    const graph = graphFor(primary);

    // Anchorless: the project's own findings, ranked, as a session-start briefing would give.
    if (!anchors.length) {
      for (const node of graph.nodes.values()) {
        if (node.kind !== 'finding' || node.retired || !node.claim) continue;
        if (seen.has(node.claim)) continue;
        seen.add(node.claim);
        findings.push(toFinding(node));
      }
      findings.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
      findings.length = Math.min(findings.length, limit);
    }

    const shared: WikiFinding[] = [];
    if (options?.includeShared !== false) {
      const sharedGraph = wiki.load(wiki.sharedDir());
      for (const node of sharedGraph.nodes.values()) {
        if (node.kind !== 'finding' || node.retired || !node.claim) continue;
        if (seen.has(node.claim)) continue;
        seen.add(node.claim);
        shared.push(toFinding(node));
      }
      shared.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
      shared.length = Math.min(shared.length, limit);
    }

    return {
      success: true,
      project,
      findings,
      shared,
      unresolvedAnchors,
      // Said plainly rather than left as an empty array. "Nothing is recorded about this yet" and
      // "the lookup failed" are different answers, and a caller that cannot tell them apart will
      // eventually treat silence as reassurance.
      note:
        findings.length === 0 && shared.length === 0
          ? 'Nothing recorded for these anchors yet. This is a normal result for code nobody has drawn a conclusion about; it is not a lookup failure.'
          : undefined,
    };
  } catch (error) {
    return {
      success: false,
      ...empty,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export const WIKI_READ_TOOL_DEFINITION = {
  name: 'wiki_read',
  description:
    "Retrieve what this project's knowledge graph already records about the files you are about " +
    'to work on, so you do not re-derive it. Call it BEFORE reading a file you have not seen: it ' +
    'returns prior conclusions anchored to that file — dead ends and why, decisions and what was ' +
    'rejected, commands that worked — plus lessons carried from other repositories on this ' +
    'machine. Subagents especially: you never receive the session-start briefing, so this is the ' +
    'only way to reach the graph. Costs nothing and sends nothing off the machine.',
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
      anchors: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Files you are about to work on, as absolute paths, or "path#symbol" for one function.',
      },
      projectRoot: {
        type: 'string',
        description:
          "Read a project's findings without naming an anchor. Defaults to the repository " +
          'containing the first anchor.',
      },
      limit: {
        type: 'number',
        description: 'Maximum findings per anchor. Default 10, capped at 100.',
      },
      includeShared: {
        type: 'boolean',
        description:
          'Include machine-wide lessons that hold in any repository. Default true.',
      },
    },
  },
};
