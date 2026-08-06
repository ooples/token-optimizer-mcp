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
  openSync, closeSync, unlinkSync, statSync, writeFileSync, renameSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalPath, isFsSafePath } from './paths.mjs';

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
  // This walks UP the path calling existsSync at every level, so one character
  // that aborts libuv would do it up to forty times over. Refused before the
  // first stat rather than defended at each one.
  if (!isFsSafePath(filePath)) return fallback ? canonicalPath(fallback) : null;
  // VCS markers ONLY, and the whole tree is walked before falling back.
  //
  // `package.json` was in this list and it is the wrong marker: in a monorepo
  // every workspace has one, so a file under packages/foo routed to that
  // package instead of the repository, splitting one project's graph into as
  // many graphs as it has manifests. A repository marker has to be something
  // only the repository root has.
  //
  // `.git` is matched whether it is a directory or a FILE, because a submodule
  // and a `git worktree` checkout both write a `.git` file pointing elsewhere --
  // and those are exactly the layouts where getting the root wrong is easiest.
  const MARKERS = ['.git', '.hg', '.svn'];

  let dir = dirname(canonicalPath(filePath));
  // Bounded so a pathological path on a deep filesystem cannot turn one hook
  // call into an unbounded walk.
  for (let depth = 0; depth < 40 && dir; depth += 1) {
    for (const marker of MARKERS) {
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

/**
 * Content hash of a file, or null when unreadable. Drives staleness in P2.
 *
 * `text` lets a caller that already holds the contents hash them without a
 * second read from disk -- the hook touches every file on the critical path of
 * an allowed tool call, so one avoidable read per file is one too many.
 */
export function contentHash(path, text) {
  // Checked BEFORE the read, because an unsafe path aborts the process instead
  // of throwing and there would be nothing for the catch below to handle.
  // `text` supplied means no read happens, so the path is only a key then.
  if (text === undefined && !isFsSafePath(path)) return null;
  try {
    return createHash('sha256')
      .update(text === undefined ? readFileSync(path) : text)
      .digest('hex')
      .slice(0, 16);
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

/**
 * Makes the store ignore itself, once.
 *
 * The design says this directory is gitignored by default, precisely because
 * findings are unreviewed agent output and committing them puts unreviewed
 * analysis into git history. Nothing enforced it: measured on two real
 * checkouts, `.token-optimizer/` showed up as untracked in `git status`, so a
 * single `git add -A` would have committed tens of megabytes of it.
 *
 * A `.gitignore` containing `*` INSIDE the store is used rather than editing
 * the project's own .gitignore. Writing to a file the user owns and reviews is
 * not this tool's business.
 *
 * STRICTLY INSIDE, and that is not a detail. Writing the marker to the PARENT
 * covers `.token-optimizer/` in the default layout, but TOKEN_OPTIMIZER_WIKI_DIR
 * can point anywhere -- and when it points at a directory the user owns, the
 * parent is their project root and `*` ignores their entire repository. That is
 * not hypothetical: it took the skeleton suite's git fixture down, where
 * `git add auth.ts` began refusing a file the test had just written. Ignoring
 * only what we create cannot reach outside the store.
 */
function ignoreSelf(dir) {
  const marker = join(dir, '.gitignore');
  try {
    if (existsSync(marker)) return;
    appendFileSync(
      marker,
      '# Written by token-optimizer. Findings are unreviewed agent output;\n' +
        '# keeping them out of git history is the default. Delete this file to\n' +
        '# opt in to committing them.\n*\n'
    );
  } catch {
    // Best effort. Failing to write the marker must not fail the graph write.
  }
}

/**
 * The log is append-only, and nothing was ever reclaiming it.
 *
 * MEASURED on this repository's own graph: 206.6 MB, 41,810 records, 6,125
 * unique ids. 85.4% of every record in the file was superseded by a later one,
 * and 97.5 MB was reclaimable. `load()` parses the whole thing on EVERY hook
 * invocation -- so every tool call paid 1.2-1.6 seconds, against a 118 ms
 * median when the graph is small.
 *
 * That is the optimizer becoming its own cost, in latency instead of tokens.
 * It also surfaced as a flaky test: a 20 s spawn budget that a loaded machine
 * could exceed, which is the sort of failure that gets re-run rather than read.
 *
 * AMORTISED TRIGGER, not a size threshold. A fixed cap would compact on every
 * append once the live set alone exceeded it -- here the live set is 109 MB, so
 * any cap below that would rewrite the file continuously. Instead the size
 * after each compaction is recorded, and the next one waits until the file has
 * doubled again: each compaction therefore does at least as much good as the
 * work it costs, and the amortised cost per append stays constant.
 */
// READ PER CALL, not once at module load -- the same rule the holdout
// fraction already follows in metrics.mjs. Reading it once meant a process
// started before a config change honoured the old value forever, and it also
// made the setting untestable: a suite that sets the variable in `beforeEach`
// runs after the import, so the module had already captured the default.
const compactFloorBytes = () =>
  Number(process.env.TOKEN_OPTIMIZER_GRAPH_COMPACT_BYTES) || 8_000_000;
const markerPath = (dir) => join(dir, 'graph.compact.json');

/** Finding types whose evidence is a diff, and so need the snapshot kept. */
const SNAPSHOT_DEPENDENT = new Set(['finding', 'map']);

/** Read per call, for the reason documented on the compaction floor above. */
const snapshotBudgetBytes = () =>
  Number(process.env.TOKEN_OPTIMIZER_GRAPH_SNAPSHOT_BYTES) || 8_000_000;

function compactionBaseline(dir) {
  try {
    const raw = JSON.parse(readFileSync(markerPath(dir), 'utf8'));
    const n = Number(raw.sizeAfter);
    return Number.isFinite(n) && n > 0 ? n : compactFloorBytes();
  } catch {
    return compactFloorBytes();
  }
}

/**
 * Rewrites the log keeping only the surviving version of each record.
 *
 * CALLED INSIDE THE LOCK, so no writer can append between the read and the
 * rename. Written to a temporary file and renamed, which is atomic on the same
 * volume: a crash mid-compaction leaves the original log untouched rather than
 * a half-written graph.
 */
function compactIfWasteful(dir) {
  const path = logPath(dir);
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return;
  }
  if (size < compactFloorBytes() || size < compactionBaseline(dir) * 2) return;

  try {
    const nodes = new Map();
    const edges = new Map();
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      // A record from another schema is KEPT VERBATIM rather than reinterpreted.
      // load() skips it, but discarding it here would make compaction a silent
      // migration that deletes data a future version might understand.
      if ((record.v ?? 0) !== GRAPH_VERSION) {
        edges.set('raw:' + edges.size, line);
        continue;
      }
      if (record.t === 'n') nodes.set(record.id, line);
      else if (record.t === 'e') edges.set(`${record.from}|${record.edge}|${record.to}`, line);
      else edges.set('raw:' + edges.size, line);
    }

    // SNAPSHOTS ARE BOUNDED, and they are the whole file.
    //
    // MEASURED after compaction on this repository: 109.5 MB, of which `file`
    // records are 105.3 MB. The raw snapshot text is 34.8 MB; JSON escaping
    // triples it. Compaction alone cannot touch this, because every one of
    // those records is live.
    //
    // A snapshot earns its place two ways: it lets a content-dependent finding
    // show what changed, and it lets a re-read be answered with a diff instead
    // of the file. The first is rare and identifiable -- 1 of 1,020 file nodes
    // on this graph had such a finding anchored. The second only pays while the
    // snapshot is recent: against a weeks-old snapshot the diff approaches the
    // size of the file and the caller rejects it anyway.
    //
    // So: keep every snapshot something depends on, then keep the newest until
    // the budget runs out, and drop the rest. The NODE always survives -- only
    // the snapshot field goes, so hashes, staleness and traversal are
    // unaffected and a dropped snapshot degrades to the ordinary redirect.
    const needed = new Set();
    for (const line of edges.values()) {
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.t !== 'e' || e.edge !== 'derived_from') continue;
      const from = nodes.get(e.from);
      if (!from) continue;
      let f;
      try {
        f = JSON.parse(from);
      } catch {
        continue;
      }
      if (f.kind === 'finding' && SNAPSHOT_DEPENDENT.has(f.type || 'finding')) needed.add(e.to);
    }

    const carriers = [];
    for (const [id, line] of nodes) {
      let n;
      try {
        n = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof n.snapshot !== 'string' || !n.snapshot) continue;
      carriers.push({ id, at: n.at || 0, size: n.snapshot.length, node: n });
    }
    carriers.sort((a, b) => b.at - a.at);

    let spent = 0;
    const budget = snapshotBudgetBytes();
    for (const c of carriers) {
      if (needed.has(c.id)) {
        spent += c.size;
        continue;
      }
      if (spent + c.size <= budget) {
        spent += c.size;
        continue;
      }
      const { snapshot, ...rest } = c.node;
      nodes.set(c.id, JSON.stringify(rest));
    }

    // EDGES BEFORE NODES, matching putNodeWithEdges: a torn write can then only
    // lose a finding, never leave one anchored to nothing.
    const out = [...edges.values(), ...nodes.values()].join('\n') + '\n';
    const tmp = path + '.compact';
    writeFileSync(tmp, out, { mode: 0o600 });
    renameSync(tmp, path);
    writeFileSync(markerPath(dir), JSON.stringify({ sizeAfter: out.length, at: Date.now() }), { mode: 0o600 });
  } catch {
    // Compaction is an optimization. A failure leaves the log exactly as it
    // was, which is correct if larger than it needs to be.
  }
}

function appendAll(dir, records) {
  if (!records.length) return true;
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
    ignoreSelf(dir);
    // ONE appendFileSync for the whole group, inside ONE lock: a caller that
    // needs several records to be observed together cannot get that by looping,
    // because every iteration is a separate crash point.
    const payload = records.map((record) => JSON.stringify(record) + '\n').join('');
    withLock(dir, () => {
      appendFileSync(logPath(dir), payload);
      compactIfWasteful(dir);
    });
    return true;
  } catch {
    // The graph is an optimization. Failing to write one must never fail the
    // user's tool call, so this is swallowed and reported only via metrics.
    return false;
  }
}

/** Records one line. The overwhelmingly common case, and unchanged. */
function append(dir, record) {
  return appendAll(dir, [record]);
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
 * Writes a node together with its outgoing edges as a SINGLE append.
 *
 * A finding is only meaningful with its `derived_from` anchors: the anchors are
 * what let it be invalidated when the code moves, and `writeHarvested` refuses
 * to store one that resolved none. Writing the node and then looping `putEdge`
 * left a window -- one append per edge, in a DETACHED worker that a session end
 * or a sleeping machine can kill at any instant -- where the node landed and its
 * edges did not. The result is exactly the record this store promises never to
 * create: an active finding anchored to nothing, unfalsifiable, served as
 * current forever.
 *
 * THE NODE IS WRITTEN LAST, and that ordering is the actual guarantee. One
 * `appendFileSync` can still tear if the process dies mid-write, so ordering is
 * what makes the surviving prefix safe: a tear leaves edges whose `from` names
 * no node, and every consumer already dereferences that through a
 * `nodes.get(...)` guard (`findingsFor`, `audit`, `sweep`), so a dangling edge
 * is inert. The reverse order has no such property. A torn final line is
 * discarded by `load()`, which skips unparseable records by design.
 */
export function putNodeWithEdges(dir, { kind, key, ...rest }, edges = []) {
  if (!NODE_KINDS.includes(kind)) throw new Error(`unknown node kind: ${kind}`);

  const id = nodeId(kind, key);
  // One timestamp for the whole group: the node and its anchors were decided
  // together, so a reader comparing `at` should see them as one event.
  const at = Date.now();

  const records = [];
  for (const { edge, to } of edges) {
    if (!EDGE_KINDS.includes(edge)) throw new Error(`unknown edge kind: ${edge}`);
    records.push({ t: 'e', v: GRAPH_VERSION, from: id, edge, to, at });
  }
  // `rest` first, for the same reason as putNode: it can never override the
  // bookkeeping fields.
  records.push({ ...rest, t: 'n', v: GRAPH_VERSION, id, kind, key: canonicalKey(kind, key), at });

  return appendAll(dir, records) ? id : null;
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

/**
 * Provenance multipliers, applied here because this is the only ranking.
 *
 * curate.mjs has declared HUMAN_WEIGHT since it was written and nothing ever
 * consumed it, so a person's correction ranked exactly level with a machine
 * guess of equal confidence -- the one thing the origin field exists to prevent.
 * Kept as a local table rather than imported to avoid a cycle: curate.mjs
 * already imports from this module.
 */
const ORIGIN_WEIGHT = { human: 1.5, agent: 1.2, harvested: 1 };

function score(node, now, DAY) {
  const confidence = typeof node.confidence === 'number' ? node.confidence : 0.5;
  // Half-life of 30 days: a finding stays useful for a long time but a fresh
  // one outranks a stale one of equal confidence.
  const ageDays = (now - (node.at || now)) / DAY;
  const weight = ORIGIN_WEIGHT[node.origin] ?? 1;
  return confidence * weight * Math.pow(0.5, ageDays / 30);
}

/**
 * Structural harvest from one observed tool call. Free, and cannot be wrong.
 *
 * It records only what demonstrably happened -- this file was touched, at this
 * content hash, by this task. No claims, no inference. The semantic layer that
 * extracts findings arrives in P3 and runs out-of-band.
 */
export function harvest(dir, { filePath, sessionId, action, hash: precomputed }) {
  if (!filePath) return null;

  // The caller may already hold the file's hash. Recomputing it here meant the
  // hook read every touched file TWICE -- once for this hash and once for
  // indexFile -- on the critical path of every allowed tool call.
  const hash = precomputed ?? contentHash(filePath);
  if (hash === null) return null;

  const fileNode = putNode(dir, { kind: 'file', key: filePath, hash, lastAction: action });

  if (sessionId) {
    const taskNode = putNode(dir, { kind: 'task', key: sessionId });
    putEdge(dir, taskNode, 'derived_from', fileNode);
  }
  return fileNode;
}
