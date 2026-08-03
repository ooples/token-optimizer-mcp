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

import { putNode, putEdge, load, nodeId } from './wiki.mjs';
import { indexFile } from './staleness.mjs';
import { symbolKey } from './symbols.mjs';
import { canonicalPath } from './paths.mjs';
import { ORIGIN_HARVESTED } from './curate.mjs';

/**
 * Resolves an `path` or `path#symbol` anchor to an existing node id.
 * Returns null when the target cannot be created or found.
 */
function resolveAnchor(dir, anchor) {
  const [rawPath, symbol] = String(anchor).split('#');
  if (!rawPath) return null;

  const path = canonicalPath(rawPath);
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
export function writeHarvested(dir, findings, { sessionId = null } = {}) {
  if (!Array.isArray(findings) || !findings.length) return [];

  const written = [];
  for (const finding of findings) {
    const resolved = [];
    for (const anchor of finding.anchors || []) {
      const target = resolveAnchor(dir, anchor);
      if (target && !resolved.includes(target)) resolved.push(target);
    }
    // A claim about files that do not exist cannot be verified against
    // anything, so it is dropped rather than kept as unfalsifiable.
    if (!resolved.length) continue;

    const key = `harvested-${Date.now().toString(36)}-${written.length}`;
    const id = putNode(dir, {
      kind: 'finding',
      key,
      claim: finding.claim,
      confidence: finding.confidence,
      type: finding.type,
      origin: ORIGIN_HARVESTED,
      sessionId,
    });
    for (const target of resolved) putEdge(dir, id, 'derived_from', target);
    written.push(key);
  }

  return written;
}
