/**
 * Writing harvested findings into the graph -- the missing half of P3.
 *
 * `harvest.mjs` builds a digest, calls a cheap model, and validates what comes
 * back. Nothing consumed it: the module was imported by no hook and no source
 * file, so the semantic layer never ran and the graph accumulated only its
 * structural skeleton. Measured on a real project after a full session of work:
 * 122 file nodes, 132 symbol nodes, 61 task nodes, and ZERO findings.
 *
 * This is deliberately NOT `curate.create()`. That function stamps
 * `origin: ORIGIN_HUMAN` and a `human-` key because it exists for a person
 * asserting something. Routing machine output through it would label a model's
 * guess as a human assertion, which is the exact confusion curate.mjs warns
 * about: "a hand-written assertion and a machine guess look identical three
 * months later, which quietly destroys the reader's ability to calibrate trust".
 *
 * The anchor discipline is copied from `create()` on purpose. A `derived_from`
 * edge pointing at an id nothing created yields a finding that LOOKS anchored to
 * `audit()` while `checkAnchor` can never run on it -- an un-invalidatable
 * claim. So each anchor is indexed first, and a finding whose anchors all fail
 * to resolve is refused rather than stored as permanently-current.
 */

import {
  putNodeWithEdges, load, nodeId, sharedDir, isSharedDir, putNode,
} from './wiki.mjs';
import { indexFile } from './staleness.mjs';
import { symbolKey } from './symbols.mjs';
import { canonicalPath } from './paths.mjs';
import { randomBytes } from 'node:crypto';
import { ORIGIN_HARVESTED, ORIGIN_AGENT, ORIGIN_HUMAN } from './curate.mjs';

/**
 * The types that may cross a project boundary.
 *
 * This is not a new taxonomy: it is the exact complement of the set staleness.mjs
 * already calls CONTENT_DEPENDENT. A `finding` or a `map` is a claim ABOUT the
 * anchor's contents, so it is only true where those contents are; carrying it to
 * another repository would assert something about files that repository does not
 * have. The rest -- what a command does, what failed, what was decided, what the
 * user asked for -- are claims about the WORK, and the work follows the person.
 *
 * Deriving one set from the other keeps them from drifting apart: if a type ever
 * becomes content-dependent, it stops being shareable in the same commit.
 */
export const SHAREABLE_TYPES = new Set(['command', 'failure', 'decision', 'feedback']);

/** Claim text, normalised enough that the same lesson learned twice is one row. */
const claimFingerprint = (claim) =>
  String(claim || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 300);

/**
 * Copies a portable lesson into the machine-wide graph.
 *
 * ANCHORED TO THE PROJECT IT CAME FROM, not to the file that happened to be open.
 * The source file's path means nothing in another checkout, and an unanchored
 * finding is refused everywhere else in this codebase for a good reason -- so the
 * shared copy is anchored to its origin project's root, which is a real path, is
 * never content-checked (these types are not content-dependent), and doubles as
 * the provenance the reader needs to judge whether the lesson transfers.
 *
 * Failures here are swallowed: this runs inside the harvest worker, and the
 * project-local write has already succeeded. A shared tier that cannot be written
 * must not cost the caller the lesson it just learned.
 */
function promoteToShared(finding, { projectRoot, sessionId, provenance, key }) {
  try {
    if (!SHAREABLE_TYPES.has(finding.type)) return false;
    const target = sharedDir();
    if (!projectRoot) return false;

    const root = canonicalPath(projectRoot);
    const rootId = nodeId('file', root);

    // Same claim, already carried up from anywhere: keep the first. Two repos
    // teaching the same lesson is evidence it generalises, not a reason to say
    // it twice on every command.
    const graph = load(target);
    const fp = claimFingerprint(finding.claim);
    for (const node of graph.nodes.values()) {
      if (node.kind !== 'finding' || node.retired) continue;
      if (claimFingerprint(node.claim) === fp) return false;
    }

    // The anchor node must exist before the edge points at it, or the shared
    // graph inherits exactly the orphan-finding problem the local one refuses.
    if (!graph.nodes.has(rootId)) putNode(target, { kind: 'file', key: root });

    return Boolean(
      putNodeWithEdges(
        target,
        {
          kind: 'finding',
          key: `shared-${key}`,
          claim: finding.claim,
          confidence: finding.confidence,
          type: finding.type,
          trigger: typeof finding.trigger === 'string' && finding.trigger ? finding.trigger : undefined,
          origin: provenance,
          quote: typeof finding.quote === 'string' && finding.quote.trim() ? finding.quote : undefined,
          // WHERE IT WAS LEARNED, carried so the reader can discount it. A lesson
          // from another repository is worth surfacing and is not automatically
          // true here; naming its origin is what lets that judgement be made.
          sourceProject: root,
          sessionId,
        },
        [{ edge: 'derived_from', to: rootId }]
      )
    );
  } catch {
    /* the local write already succeeded; the shared tier is best-effort */
    return false;
  }
}

/**
 * Back-fills lessons that were learned BEFORE the shared tier existed.
 *
 * Promotion happens at harvest time, so every lesson already in a project graph
 * stays there forever without this -- and on the machine that motivated the
 * feature that was all of them: 35 live lessons, every one filed under the single
 * repository that happened to teach it.
 *
 * IDEMPOTENT, because a migration that cannot be re-run is a migration nobody
 * dares re-run. Promotion dedupes on the claim text, so a second pass over the
 * same graph adds nothing, and a graph that gained findings since the last pass
 * contributes only those.
 *
 * Returns what it did rather than printing, so the caller can report and the
 * tests can assert.
 */
export function promoteExisting(projectDir, projectRoot, { sessionId = 'migration' } = {}) {
  const result = { considered: 0, eligible: 0, promoted: 0, skipped: 0 };
  if (!projectDir || !projectRoot) return result;
  if (isSharedDir(projectDir)) return result;

  let graph;
  try {
    graph = load(projectDir);
  } catch {
    return result;
  }

  for (const node of graph.nodes.values()) {
    if (node.kind !== 'finding' || node.retired || !node.claim) continue;
    result.considered += 1;
    if (!SHAREABLE_TYPES.has(node.type)) continue;
    result.eligible += 1;

    // The stored node already carries everything promotion needs, so it is
    // handed over as-is rather than reconstructed -- a reconstruction would be a
    // second, divergent definition of what a promoted finding looks like.
    const ok = promoteToShared(node, {
      projectRoot,
      sessionId,
      provenance: node.origin,
      key: node.key,
    });
    if (ok) result.promoted += 1;
    else result.skipped += 1;
  }

  return result;
}

/**
 * Resolves an `path` or `path#symbol` anchor to an existing node id.
 * Returns null when the target cannot be created or found.
 */
/** True when a canonical path sits inside the canonical project root. */
function withinProject(path, projectRoot) {
  const root = canonicalPath(projectRoot);
  if (path === root) return true;
  // Compare with a trailing separator so /repo-secrets is not read as inside
  // /repo. Both sides are already canonical, so this is a plain prefix test.
  const prefix = root.endsWith("/") ? root : root + "/";
  return path.startsWith(prefix);
}

function resolveAnchor(dir, anchor, projectRoot) {
  const [rawPath, symbol] = String(anchor).split('#');
  if (!rawPath) return null;

  const path = canonicalPath(rawPath);

  // ANCHORS STAY INSIDE THE PROJECT. indexFile READS the file and stores a
  // snapshot of it in the graph, so an anchor is a read primitive: without this,
  // a claim naming ../../.ssh/id_rsa or C:/Users/x/.aws/credentials would copy
  // that file into .token-optimizer and serve it back on the next touch. The
  // findings come from a model reading a transcript, so the paths are not
  // trusted input.
  if (projectRoot && !withinProject(path, projectRoot)) return null;

  // Indexing creates the file node and its symbols with hashes and spans, which
  // is what makes the claim checkable later.
  indexFile(dir, path);

  const target = symbol
    ? nodeId('symbol', symbolKey(path, symbol))
    : nodeId('file', path);
  return load(dir).nodes.has(target) ? target : null;
}

/**
 * Writes validated findings, returning the keys actually stored.
 *
 * `findings` is the output of `harvest.validate()`, so type/claim/confidence
 * are already checked; what remains is anchor resolution, which needs the graph.
 */
export function writeHarvested(
  dir,
  findings,
  { sessionId = null, origin = ORIGIN_HARVESTED, projectRoot = null } = {}
) {
  if (!Array.isArray(findings) || !findings.length) return [];

  // The batch default. A caller asking for anything else -- notably
  // ORIGIN_HUMAN -- would be labelling machine output as a person's assertion,
  // which is the confusion the field exists to prevent.
  const batch = origin === ORIGIN_AGENT ? ORIGIN_AGENT : ORIGIN_HARVESTED;

  /**
   * ORIGIN_HUMAN IS EARNED PER FINDING, BY EVIDENCE.
   *
   * A batch-wide origin was the whole story here, and it silently discarded
   * the per-lesson provenance `validateLessons` had just computed: a
   * correction whose quote was verified word-for-word in the user's own turn
   * was stored as ORIGIN_HARVESTED like any model paraphrase. The standing-
   * rules layer selects on human origin, so it matched nothing this pipeline
   * wrote, and the verbatim check had no observable effect at all.
   *
   * The original rule still holds -- a caller cannot simply DECLARE machine
   * output human. It is the verified quote that promotes it, and the quote is
   * stored alongside so the claim carries its own evidence.
   */
  const provenanceFor = (finding) =>
    finding.origin === ORIGIN_HUMAN &&
    typeof finding.quote === 'string' &&
    finding.quote.trim()
      ? ORIGIN_HUMAN
      : batch;
  const prefixFor = (p) =>
    p === ORIGIN_AGENT ? 'agent' : p === ORIGIN_HUMAN ? 'human' : 'harvested';

  const written = [];
  for (const finding of findings) {
    const resolved = [];
    for (const anchor of finding.anchors || []) {
      const target = resolveAnchor(dir, anchor, projectRoot);
      if (target && !resolved.includes(target)) resolved.push(target);
    }
    // A claim about files that do not exist cannot be verified against
    // anything, so it is dropped rather than kept as unfalsifiable.
    if (!resolved.length) continue;

    // Date.now() plus an index is not unique across CONCURRENT detached
    // workers: two Stop hooks finishing in the same millisecond produce the
    // same key, and putNode keeps the last write for an id -- so one session's
    // finding silently replaces another's. A random suffix makes that
    // collision vanishingly unlikely while keeping the timestamp readable.
    const provenance = provenanceFor(finding);
    const key = `${prefixFor(provenance)}-${Date.now().toString(36)}-${written.length}-${randomBytes(4).toString("hex")}`;
    // ONE APPEND for the finding and every anchor it resolved. This runs in a
    // detached worker, so "the process survives to finish the loop" is not a
    // safe assumption: a node written without its edges is an active finding
    // anchored to nothing, which can never be invalidated and is therefore
    // served as current forever -- the precise record the anchor discipline
    // above exists to refuse.
    const id = putNodeWithEdges(
      dir,
      {
        kind: 'finding',
        key,
        claim: finding.claim,
        confidence: finding.confidence,
        type: finding.type,
        // WHEN this finding is relevant, not just what it is about. Anchors
        // answer "which file", which is the wrong question for a claim about
        // running something: the agent that needs "use npm test, not npx jest"
        // is executing a command, not reading the file the claim is anchored
        // to. Optional, so nothing that omits it changes behaviour.
        trigger: typeof finding.trigger === 'string' && finding.trigger
          ? finding.trigger
          : undefined,
        origin: provenance,
        // THE EVIDENCE TRAVELS WITH THE CLAIM. Without it a human-origin
        // finding asserts its own provenance and nothing can check it.
        quote: typeof finding.quote === 'string' && finding.quote.trim()
          ? finding.quote
          : undefined,
        sessionId,
      },
      resolved.map((target) => ({ edge: 'derived_from', to: target }))
    );
    // A failed write returns null. Reporting the key anyway would tell the
    // caller a claim was stored that no later session can retrieve.
    if (id) written.push(key);

    // AFTER the project write, and never instead of it. The project graph is the
    // record of what happened here; the shared tier is a copy for the lessons
    // that are not about here. Skipped when the two are the same directory,
    // which is the suite's usual arrangement.
    if (id && !isSharedDir(dir)) {
      promoteToShared(finding, { projectRoot, sessionId, provenance, key });
    }
  }

  return written;
}
