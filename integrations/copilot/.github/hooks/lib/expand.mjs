// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/expand.mjs. Regenerate with `npm run sync:hooks`.
/**
 * The pointer, and what happens when it is followed.
 *
 * A competitor's pointer is a promise to fetch again: expand re-runs the command
 * or re-reads the file, pays the full cost a second time, and subtracts the
 * bytes from its savings total. For a test suite that second payment is measured
 * in minutes as well as tokens -- re-running a suite to look at output we
 * already had is the exact waste this product exists to stop.
 *
 * Four properties here, and they only work together:
 *
 *   CONTENT-ADDRESSED   The artifact is keyed by the hash of its own bytes, so
 *                       the same output captured from a different path, a
 *                       different session, or a different project resolves to
 *                       one entry.
 *   SERVED, NOT RE-RUN  Expansion reads the store. Nothing is re-earned.
 *   STALENESS-CHECKED   Serving a two-day-old answer about code that has since
 *                       changed is worse than serving nothing, so an expansion
 *                       whose anchor moved is marked, with what moved.
 *   AND STILL REFRESHES A stale artifact that is CHEAP to regenerate should be
 *                       regenerated -- correctness beats a saved second. The
 *                       re-run is not banished, it is made a decision based on
 *                       measured cost instead of the default.
 *
 * And then the part nobody else has any use for. An expansion is the only
 * LABELLED data this system produces: a human or model saying, explicitly, that
 * the preview was wrong and in which direction. So every expansion does two
 * things beyond returning bytes -- it refits the preview policy for that tool
 * and output shape, and it promotes what was expanded into a finding, so the
 * second expansion of the same thing never happens.
 */

import { createHash } from 'node:crypto';
import {
  readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync,
  readdirSync, statSync, unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { record, readMetrics } from './metrics.mjs';
import { putNode, putEdge, nodeId } from './wiki.mjs';
import { canonicalPath } from './paths.mjs';

/** A stale artifact cheaper than this to regenerate is refreshed, not served. */
export const CHEAP_REGEN_MS = 3000;

/** Expansions below this rate mean the preview policy is working. */
export const HEALTHY_HOLD_RATE = 0.85;

/**
 * How long an artifact is kept. STATED, not silent.
 *
 * The store was otherwise write-only: every disclosed tool result landed here forever, while its
 * capture record ages out of the bounded metrics window -- so most files on disk were already
 * unreachable and could not even be resolved usefully, only occupy space. Content addressing
 * dedupes byte-identical bodies but not near-identical ones, so two runs of the same suite
 * differing only in elapsed-ms are two files.
 *
 * A bound nobody can see would be worse than none, so it is exported and documented alongside
 * the rest of the module's stated properties.
 */
export const ARTIFACT_TTL_MS = 30 * 86_400_000;

const digest = (text) => createHash('sha256').update(String(text)).digest('hex').slice(0, 16);

/** Removes artifacts past the TTL. A sweep must never break a capture. */
function sweepArtifacts(path) {
  try {
    const cutoff = Date.now() - ARTIFACT_TTL_MS;
    for (const name of readdirSync(path)) {
      if (!name.endsWith('.txt')) continue;
      const file = join(path, name);
      try {
        if (statSync(file).mtimeMs < cutoff) unlinkSync(file);
      } catch { /* raced with another sweep or a reader */ }
    }
  } catch { /* no store yet, or unreadable -- neither is worth failing a capture over */ }
}

function artifactDir(dir) {
  const path = join(dir, 'artifacts');
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    try { chmodSync(path, 0o700); } catch { /* best effort on filesystems without modes */ }
  }
  return path;
}

/**
 * Stores an output and returns the reference the preview points at.
 *
 * The reference IS the content hash, which is what makes the store converge:
 * the same build log captured in three sessions is one file, and a finding
 * promoted from it in one project is reachable from the others.
 *
 * @param meta { tool, command, anchors, shape, costMs, sessionId }
 */
export function capture(dir, text, meta = {}) {
  const body = String(text || '');
  if (!body) return null;

  const ref = digest(body);
  const path = join(artifactDir(dir), `${ref}.txt`);
  if (!existsSync(path)) {
    writeFileSync(path, body, { mode: 0o600 });
    // Amortised off the digest rather than run on every capture, and deterministic rather than
    // sampled at random: roughly one write in sixty-four pays for a readdir.
    if (parseInt(ref.slice(0, 2), 16) < 4) sweepArtifacts(artifactDir(dir));
  }

  const anchors = (meta.anchors || []).map((a) => canonicalPath(a));
  record(dir, {
    kind: 'capture',
    ref,
    tool: meta.tool || null,
    command: meta.command || null,
    shape: meta.shape || null,
    // What it cost to produce, so a later refresh decision is made on a
    // measurement rather than a guess about whether re-running is "cheap".
    costMs: Number.isFinite(meta.costMs) ? meta.costMs : null,
    bytes: body.length,
    anchors,
    sessionId: meta.sessionId || null,
    // The anchors' state AT CAPTURE TIME, so staleness is answerable later
    // without having kept a copy of the files.
    anchorHashes: anchors.map((a) => {
      try {
        return { anchor: a, hash: digest(readFileSync(a, 'utf8')) };
      } catch {
        return { anchor: a, hash: null };
      }
    }),
  });

  return ref;
}

/**
 * The capture record for a reference, or null.
 *
 * ANCHORS ARE UNIONED ACROSS EVERY CAPTURE OF THIS REF. The ref is the hash of the BODY, which
 * is exactly what makes the store converge -- and it means one ref legitimately spans captures
 * made against DIFFERENT anchors: two byte-identical files, one generated file vendored into six
 * directories (this module is itself vendored six times), the same command output captured
 * against two operands. Taking only the last record checked staleness against whichever copy
 * happened to be captured most recently, so editing the copy the caller actually asked about
 * produced no stale marker at all.
 *
 * The OLDEST hash per anchor wins, which is the conservative direction: any change to any file
 * that ever produced these bytes counts as staleness.
 */
function captureOf(dir, ref) {
  const rows = readMetrics(dir)
    .filter((e) => e.kind === 'capture' && e.ref === ref)
    // SORTED, rather than trusting the reader's order. "Oldest hash per anchor wins" and "the
    // latest capture supplies the rest of the record" are both statements about TIME, and
    // readMetrics returns whatever order the log and its tail slice produce. Relying on write
    // order makes the conservative direction accidental. Ties keep their relative order, since
    // sort is stable and two rows in the same millisecond have no better ordering available.
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  if (!rows.length) return null;
  const byAnchor = new Map();
  for (const row of rows) {
    for (const entry of row.anchorHashes || []) {
      if (!byAnchor.has(entry.anchor)) byAnchor.set(entry.anchor, entry);
    }
  }
  return { ...rows[rows.length - 1], anchorHashes: [...byAnchor.values()] };
}

/**
 * Has the world moved since this was captured?
 *
 * Answered from the anchor hashes recorded at capture time, so it costs one
 * read per anchor and never needs the graph.
 */
export function freshness(dir, ref) {
  const cap = captureOf(dir, ref);
  if (!cap) return { known: false };

  const changed = [];
  for (const { anchor, hash } of cap.anchorHashes || []) {
    let now = null;
    try { now = digest(readFileSync(anchor, 'utf8')); } catch { now = null; }
    if (hash !== now) changed.push(anchor);
  }

  return { known: true, stale: changed.length > 0, changed, costMs: cap.costMs, command: cap.command };
}

/**
 * What to DO about a stale artifact.
 *
 * The three-way answer, which is the whole point of measuring the capture cost:
 * a fresh artifact is served for nothing; a stale one that took a moment to
 * produce is regenerated, because correctness is worth a second; a stale one
 * that took minutes is served with an explicit marker and the list of what
 * changed, so the model can judge for itself rather than being handed a
 * confident answer about code that no longer exists.
 */
export function refreshDecision(state) {
  if (!state.known) return { action: 'unknown', reason: 'no capture record for this reference' };
  if (!state.stale) return { action: 'serve', reason: 'unchanged since capture' };

  if (state.command && Number.isFinite(state.costMs) && state.costMs <= CHEAP_REGEN_MS) {
    return {
      action: 'refresh',
      reason: `changed since capture and cheap to reproduce (${state.costMs}ms)`,
      command: state.command,
    };
  }

  return {
    action: 'serve-stale',
    reason: state.costMs != null
      ? `changed since capture, and reproducing it costs ${Math.round(state.costMs / 1000)}s`
      : 'changed since capture, and there is no recorded way to reproduce it cheaply',
    changed: state.changed,
  };
}

/**
 * Follows a pointer.
 *
 * Serves from the store. The only thing that ever re-runs is a stale artifact
 * cheap enough to be worth it, and even then the caller is handed the command
 * rather than having it executed underneath them.
 */
export function resolve(dir, ref, { section } = {}) {
  // The ref reaches this function straight from a model-supplied tool argument -- index.ts
  // dispatches `expand` with request.params.arguments unvalidated, and the tool schema declares
  // ref as a bare string. It is a content digest and nothing else, so anything that is not one
  // is refused rather than joined into a path: `join` resolves `..`, so '../../notes' would read
  // notes.txt from anywhere on disk and return it as the expansion of the pointer the caller was
  // holding. digest() always produces exactly 16 lowercase hex characters, so this is exact.
  if (typeof ref !== 'string' || !/^[0-9a-f]{16}$/.test(ref)) return null;
  const path = join(artifactDir(dir), `${ref}.txt`);
  let body;
  try {
    body = readFileSync(path, 'utf8');
  } catch {
    return null;
  }

  const state = freshness(dir, ref);
  const decision = refreshDecision(state);
  const notes = [];
  if (decision.action === 'unknown') {
    // The artifact outlived its capture record: metrics.jsonl is read as a bounded tail and the
    // artifact store is never pruned, so this is the ordinary steady state rather than an edge
    // case. Staleness is then unanswerable -- and unanswerable must not render as fresh. Serving
    // a month-old build log about a file that has since been rewritten, unmarked, is what the
    // module header calls worse than serving nothing.
    notes.push('! UNVERIFIED -- no capture record survives for this reference, so whether the '
      + 'code it describes has changed since cannot be determined. Treat it as historical.');
  } else if (decision.action === 'serve-stale') {
    notes.push(`! STALE -- ${decision.changed.join(', ')} changed after this was captured. ` +
      'Treat it as historical.');
  } else if (decision.action === 'refresh') {
    notes.push(`! STALE -- cheap to reproduce; re-run: ${decision.command}`);
  }

  return {
    ref,
    text: notes.length ? `${notes.join('\n')}\n${body}` : body,
    stale: Boolean(state.stale),
    // Distinguishes "checked and unchanged" from "could not be checked".
    known: state.known !== false,
    decision: decision.action,
    section: section || null,
    // Nothing was spent producing this a second time. That is the number the
    // panel reports, and it is the one a re-running pointer can never report.
    reEarnedTokens: 0,
  };
}

/**
 * Records that a preview was not enough.
 *
 * THE LABELLED DATA. `asked` is the section the caller went looking for, which
 * is what makes the refit possible: not "previews are 8% wrong" but "previews of
 * xunit output are wrong specifically by dropping the first failing trace".
 */
export function recordExpansion(dir, { ref, tool, shape, asked, sessionId } = {}) {
  // BACKFILLED FROM THE CAPTURE, because the caller of `expand` holds a ref and nothing else.
  // Written without tool and shape, every expand event filed as null/null -- and previewPolicy's
  // per-(tool, shape) filter then matched none of them, pinning holdRate at 1, strength at 0 and
  // boosts permanently {}. The refit was inert in production while the suite passed by supplying
  // a shape the real caller never has.
  const cap = ref ? captureOf(dir, ref) : null;
  record(dir, {
    kind: 'expand',
    ref: ref || null,
    tool: tool || cap?.tool || null,
    shape: shape || cap?.shape || null,
    asked: asked || null,
    sessionId: sessionId || null,
  });
}

/**
 * The refit: what previews of this shape should keep next time.
 *
 * Returns section-label boosts derived from what expansions actually asked for,
 * scaled by how often this shape gets expanded at all. A shape whose previews
 * hold has no boosts and stays as it is; one that is routinely expanded pulls
 * the sections people wanted up the ranking until it stops being.
 */
export function previewPolicy(dir, { tool, shape } = {}) {
  const events = readMetrics(dir);
  const captures = events.filter((e) => e.kind === 'capture'
    && (!shape || e.shape === shape) && (!tool || e.tool === tool));
  const expansions = events.filter((e) => e.kind === 'expand'
    && (!shape || e.shape === shape) && (!tool || e.tool === tool));

  if (!captures.length) return { boosts: {}, holdRate: null, served: 0, expanded: 0 };

  const holdRate = Math.max(0, 1 - expansions.length / captures.length);
  const boosts = {};

  // Weight the correction by how badly this shape is doing. A shape at a 95%
  // hold rate gets a nudge; one at 40% gets shoved.
  const strength = (1 - holdRate) * 20;
  const counts = new Map();
  for (const e of expansions) {
    if (!e.asked) continue;
    counts.set(e.asked, (counts.get(e.asked) || 0) + 1);
  }
  const most = Math.max(1, ...counts.values());
  for (const [label, count] of counts) boosts[label] = (count / most) * strength;

  return { boosts, holdRate, served: captures.length, expanded: expansions.length };
}

/**
 * Promotes expanded content into the graph.
 *
 * The reason the same expansion never happens twice. What somebody had to ask
 * for once is, by demonstration, worth carrying -- so it becomes a finding
 * anchored to the file it concerns and is surfaced on the next touch of that
 * file, without anybody asking at all.
 */
export function promote(dir, { ref, claim, anchor, section, derivedCost, confidence = 0.7 } = {}) {
  if (!claim || !anchor) return null;

  const key = `expand:${ref || digest(claim)}${section ? `#${section}` : ''}`;
  const finding = putNode(dir, {
    kind: 'finding',
    key,
    claim: String(claim).slice(0, 600),
    confidence,
    // What it cost to have this in hand, so the consolidation ratio and the
    // selection ranking both see it at its true value.
    derivedCost: Number.isFinite(derivedCost) ? derivedCost : null,
    source: 'expansion',
    ref: ref || null,
  });

  putEdge(dir, finding, 'derived_from', nodeId('file', canonicalPath(anchor)));
  return finding;
}

/**
 * How well previews are holding, for the forecast panel.
 *
 * Reported rather than buried, because the expansion rate is the honest quality
 * metric for this feature and a tool that hides it is asking to be trusted on
 * the strength of a number it will not show. Worst shape is named, since that
 * is the one worth fixing.
 */
export function previewQuality(dir) {
  const events = readMetrics(dir);
  const captures = events.filter((e) => e.kind === 'capture');
  if (!captures.length) return null;

  const expansions = events.filter((e) => e.kind === 'expand');
  const shapes = new Map();

  for (const cap of captures) {
    const shape = cap.shape || 'plain';
    if (!shapes.has(shape)) shapes.set(shape, { served: 0, expanded: 0 });
    shapes.get(shape).served += 1;
  }
  for (const exp of expansions) {
    // NOT `|| 'plain'`. 'plain' is a REAL shape parseShape returns, so folding shapeless events
    // into it charges expansions to a shape that was never expanded -- and that is then the
    // shape the panel names as the worst one. An 'unknown' bucket has served 0 and is skipped by
    // the served < 3 guard below, which is the right treatment for an unattributable event.
    const shape = exp.shape || 'unknown';
    if (!shapes.has(shape)) shapes.set(shape, { served: 0, expanded: 0 });
    shapes.get(shape).expanded += 1;
  }

  let worst = null;
  for (const [shape, counts] of shapes) {
    if (counts.served < 3) continue;
    const rate = Math.max(0, 1 - counts.expanded / counts.served);
    if (!worst || rate < worst.holdRate) worst = { shape, holdRate: rate, ...counts };
  }

  const holdRate = Math.max(0, 1 - expansions.length / captures.length);

  return {
    holdRate,
    served: captures.length,
    expanded: expansions.length,
    worst,
    healthy: holdRate >= HEALTHY_HOLD_RATE,
    text: `previews held ${Math.round(holdRate * 100)}% of the time ` +
      `(${captures.length} served, ${expansions.length} expanded)` +
      (worst && worst.holdRate < HEALTHY_HOLD_RATE
        ? `; worst shape: ${worst.shape} at ${Math.round(worst.holdRate * 100)}%`
        : ''),
  };
}
