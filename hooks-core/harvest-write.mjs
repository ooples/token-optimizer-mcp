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

import { putNodeWithEdges, load, nodeId } from './wiki.mjs';
import { indexFile } from './staleness.mjs';
import { symbolKey } from './symbols.mjs';
import { canonicalPath } from './paths.mjs';
import { randomBytes } from 'node:crypto';
import { ORIGIN_HARVESTED, ORIGIN_AGENT, ORIGIN_HUMAN } from './curate.mjs';

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
  }

  return written;
}
