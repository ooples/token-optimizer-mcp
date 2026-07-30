// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/wiki.mjs. Regenerate with `npm run sync:hooks`.
/**
 * The wiki graph store. Phase 1: skeleton, structural only.
 *
 * See docs/WIKI_GRAPH.md for the design. This file is the persistence layer and
 * nothing else -- no semantics, no model calls, no injection. That split is
 * deliberate: the structural layer is free and cannot be wrong, so it should be
 * provable on its own before anything that costs tokens is built on top.
 *
 * APPEND-ONLY, AND WHY. Sessions run concurrently -- several agents in several
 * terminals against one repository is normal. A read-modify-write store loses
 * writes under that, silently, and a knowledge graph that silently drops
 * findings is worse than none. Appending a line is atomic enough for this
 * purpose on every platform we target, and the whole graph is a fold over the
 * log, so it can always be rebuilt from scratch.
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Schema version, bumped whenever node ids or anchor hashes change meaning.
 *
 * Node ids and content hashes are DERIVED from a hash algorithm, so changing
 * that algorithm silently rewrites every identity in the graph: old edges point
 * at ids nothing will ever produce again, and every anchor compares unequal and
 * reports stale. Records carry the version they were written under, and `load`
 * ignores older ones, so an algorithm change degrades to "the graph rebuilds
 * itself from use" instead of "every finding is wrong and says so confidently".
 *
 * v2: sha256 identities and hashes (v1 was sha1).
 */
export const GRAPH_VERSION = 2;

/** Node kinds. `file` and `symbol` are first-class so staleness can propagate. */
export const NODE_KINDS = ['file', 'symbol', 'task', 'finding'];

/**
 * `contradicts` is an edge rather than an overwrite on purpose: when a belief
 * changes, the graph should record THAT it changed and why, not quietly present
 * the new one as though it had always been true.
 */
export const EDGE_KINDS = [
  'derived_from', 'contains', 'imports', 'calls',
  'supersedes', 'contradicts', 'answers',
  // Weak, behaviour-derived: files worked on together. This is what gives
  // traversal-only retrieval a semantic neighbourhood without an embedding model.
  'related',
];

/** Resolves the graph directory for a project. Configurable, per the design. */
export function wikiDir(cwd) {
  return process.env.TOKEN_OPTIMIZER_WIKI_DIR || join(cwd || process.cwd(), '.token-optimizer', 'wiki');
}

const logPath = (dir) => join(dir, 'graph.jsonl');

/**
 * Stable id for a node, so the same file seen twice is one node, not two.
 *
 * SHA-256 rather than SHA-1. These digests are identifiers, not signatures, so
 * collision resistance is not load-bearing -- but static analysis flags SHA-1 as
 * a broken algorithm wherever it touches session-derived input, and arguing
 * about intent in a security review costs more than using the stronger hash.
 * The digest is truncated either way, so nothing gets larger.
 */
export function nodeId(kind, key) {
  return `${kind}:${createHash('sha256').update(String(key)).digest('hex').slice(0, 16)}`;
}

/** Content hash of a file, or null when unreadable. Drives staleness in P2. */
export function contentHash(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

function append(dir, record) {
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(logPath(dir), JSON.stringify(record) + '\n');
    return true;
  } catch {
    // The graph is an optimization. Failing to write one must never fail the
    // user's tool call, so this is swallowed and reported only via metrics.
    return false;
  }
}

/**
 * Records a node. Repeat writes are expected and cheap -- the fold keeps the
 * LAST record for an id, so re-observing a file with a new hash is how an
 * update is expressed. There is no in-place mutation anywhere in this store.
 */
export function putNode(dir, { kind, key, ...rest }) {
  if (!NODE_KINDS.includes(kind)) throw new Error(`unknown node kind: ${kind}`);
  const id = nodeId(kind, key);
  // `rest` is spread FIRST so it can never override the bookkeeping fields.
  // Spreading it after `id` let a caller passing a whole existing node back in
  // -- which curate.mjs does on every pin, retire and correct -- carry a stale
  // `id` or `t` through and write a record that no longer matches its own key.
  append(dir, { ...rest, t: 'n', v: GRAPH_VERSION, id, kind, key, at: Date.now() });
  return id;
}

/** Records an edge. */
export function putEdge(dir, from, edge, to) {
  if (!EDGE_KINDS.includes(edge)) throw new Error(`unknown edge kind: ${edge}`);
  append(dir, { t: 'e', v: GRAPH_VERSION, from, edge, to, at: Date.now() });
}

/**
 * Folds the log into a graph.
 *
 * A corrupt line is SKIPPED rather than thrown on. A partially written final
 * line is the normal consequence of a process being killed mid-append, and one
 * bad line must not make the entire accumulated graph unreadable.
 */
export function load(dir) {
  const nodes = new Map();
  const edges = [];
  const path = logPath(dir);
  if (!existsSync(path)) return { nodes, edges };

  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    // Records from an older schema are skipped rather than mixed in: their ids
    // and hashes were derived differently, so honouring them produces confident
    // nonsense rather than a visible error.
    if ((record.v ?? 1) !== GRAPH_VERSION) continue;
    if (record.t === 'n') nodes.set(record.id, record);
    else if (record.t === 'e') edges.push(record);
  }
  return { nodes, edges };
}

/**
 * Findings reachable from a file or symbol, by traversal.
 *
 * This is the retrieval primitive the whole design rests on -- no embeddings,
 * no vector index. It follows `derived_from` edges backwards from an anchor to
 * the findings that depend on it, then one hop further through `contains` so
 * that touching a file also surfaces findings about the symbols inside it.
 */
export function findingsFor(graph, anchorId, { limit = 20 } = {}) {
  const anchors = new Set([anchorId]);
  for (const edge of graph.edges) {
    if (edge.edge === 'contains' && edge.from === anchorId) anchors.add(edge.to);
  }

  const found = [];
  for (const edge of graph.edges) {
    if (edge.edge !== 'derived_from' || !anchors.has(edge.to)) continue;
    const node = graph.nodes.get(edge.from);
    // Retired findings are excluded at the SOURCE so no consumer has to
    // remember to filter them. A withdrawn claim reaching a model through some
    // path that forgot is the failure this centralisation prevents.
    if (node && node.kind === 'finding' && !node.retired) found.push(node);
  }

  // Ranked by confidence x recency, per the design. The hard token budget that
  // consumes this ranking arrives in P4; ordering correctly is P1's job.
  const now = Date.now();
  const DAY = 86_400_000;
  return found
    .sort((a, b) => score(b, now, DAY) - score(a, now, DAY))
    .slice(0, limit);
}

function score(node, now, DAY) {
  const confidence = typeof node.confidence === 'number' ? node.confidence : 0.5;
  // Half-life of 30 days: a finding stays useful for a long time but a fresh
  // one outranks a stale one of equal confidence.
  const ageDays = (now - (node.at || now)) / DAY;
  return confidence * Math.pow(0.5, ageDays / 30);
}

/**
 * Structural harvest from one observed tool call. Free, and cannot be wrong.
 *
 * It records only what demonstrably happened -- this file was touched, at this
 * content hash, by this task. No claims, no inference. The semantic layer that
 * extracts findings arrives in P3 and runs out-of-band.
 */
export function harvest(dir, { filePath, sessionId, action }) {
  if (!filePath) return null;

  const hash = contentHash(filePath);
  if (hash === null) return null;

  const fileNode = putNode(dir, { kind: 'file', key: filePath, hash, lastAction: action });

  if (sessionId) {
    const taskNode = putNode(dir, { kind: 'task', key: sessionId });
    putEdge(dir, taskNode, 'derived_from', fileNode);
  }
  return fileNode;
}
