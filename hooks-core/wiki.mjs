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

import {
  appendFileSync, readFileSync, existsSync, mkdirSync, chmodSync,
  openSync, closeSync, unlinkSync, statSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalPath } from './paths.mjs';

/**
 * Schema version stamped on every record.
 *
 * There is exactly ONE version and no migration code, because nothing has been
 * released: a graph written by an older commit of an unreleased branch is a
 * development artifact, not user data, and carrying migration paths for it costs
 * real complexity to protect something nobody has. A record from any other
 * version is skipped rather than interpreted, so a stale dev graph degrades to
 * "rebuilds from use" instead of silently mixing incompatible identities.
 *
 * When this does ship, a bump here is where migration would be added -- with
 * users to protect, that trade reverses.
 */
export const GRAPH_VERSION = 1;

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


/**
 * The project a FILE belongs to, which is not always the session's project.
 *
 * `wikiDir(cwd)` keys the graph on where the client happens to be running. That
 * is wrong the moment a session touches a second repository -- the findings
 * land in the wrong project's graph, or in none, and the per-project promise
 * quietly breaks. Observed live: work in another checkout recorded nothing.
 *
 * Walks up for a repository marker and falls back to the session cwd when the
 * file is not inside one, which is the honest answer for a scratch file.
 */
export function projectRootFor(filePath, fallback) {
  let dir = dirname(canonicalPath(filePath));
  for (let depth = 0; depth < 40 && dir; depth += 1) {
    for (const marker of ['.git', 'package.json', '.hg', 'go.mod', 'Cargo.toml']) {
      if (existsSync(join(dir, marker))) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return fallback ? canonicalPath(fallback) : null;
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
  return `${kind}:${createHash('sha256').update(canonicalKey(kind, key)).digest('hex').slice(0, 16)}`;
}

/**
 * The canonical form of a node key.
 *
 * Path canonicalisation lives HERE, in the identity function, rather than at
 * each call site. Doing it at call sites left `nodeId('file', rawPath)` correct
 * only if the caller remembered -- and a caller that forgot produced a second
 * node for a file that already existed, splitting its findings silently. There
 * is no way to misuse it from here: `C:\x`, `/c/x` and `C:/x` are one node
 * because they are one file.
 */
export function canonicalKey(kind, key) {
  const raw = String(key);
  if (kind === 'file') return canonicalPath(raw);
  if (kind === 'symbol') {
    const hash = raw.indexOf('#');
    return hash === -1 ? canonicalPath(raw) : `${canonicalPath(raw.slice(0, hash))}#${raw.slice(hash + 1)}`;
  }
  return raw;
}

/** Content hash of a file, or null when unreadable. Drives staleness in P2. */
export function contentHash(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

/**
 * Appends one record under an exclusive lock.
 *
 * APPEND IS NOT ATOMIC ENOUGH TO RELY ON. POSIX guarantees atomicity only up to
 * PIPE_BUF (often 4 KB), and Windows gives no such guarantee at all -- while a
 * single record here can carry a 256 KB file snapshot. Two concurrent hook
 * processes can therefore interleave mid-line and corrupt both records.
 *
 * `load` already skips unparseable lines, so corruption costs a record rather
 * than the graph, but "we tolerate it" is a weaker property than "it does not
 * happen". The lock is the same bounded, stale-tolerant one the session state
 * uses: if it cannot be taken quickly the write proceeds anyway, because a
 * stale lock from a killed process must never stop the graph being written.
 */
function withLock(dir, write) {
  const lockPath = join(dir, '.graph.lock');
  let held = false;

  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      closeSync(openSync(lockPath, 'wx', 0o600));
      held = true;
      break;
    } catch {
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 5000) unlinkSync(lockPath);
      } catch {
        // Raced with the holder releasing it; retry.
      }
    }
  }

  try {
    write();
  } finally {
    if (held) {
      try {
        unlinkSync(lockPath);
      } catch {
        // Already released.
      }
    }
  }
}

function append(dir, record) {
  try {
    // 0o700 AND an explicit chmod. `recursive: true` applies the mode only to
    // directories it actually creates, and the process umask masks it further,
    // so the mode argument alone does not guarantee the result -- which is how
    // this shipped group- and world-readable while a test claimed otherwise.
    // (That test asserted on POSIX bits and was skipped on Windows, so it never
    // ran where it would have failed.)
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Not POSIX, or not ours to chmod. The mkdir mode above still applies
      // where it can, and failing here must not stop the write.
    }
    withLock(dir, () => appendFileSync(logPath(dir), JSON.stringify(record) + '\n'));
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
  append(dir, { ...rest, t: 'n', v: GRAPH_VERSION, id, kind, key: canonicalKey(kind, key), at: Date.now() });
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
    // A record from another schema is skipped, not interpreted: its ids and
    // hashes were derived differently, so honouring it produces confident
    // nonsense rather than a visible error.
    if ((record.v ?? 0) !== GRAPH_VERSION) continue;
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
