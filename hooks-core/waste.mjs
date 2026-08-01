/**
 * Behavioural waste detection.
 *
 * A competing tool ships eleven hand-written detectors and prints what each of
 * them cost you. Every token in that report is already spent, the list is the
 * same eleven forever, and a detector that has never once been right stays in
 * the list looking as authoritative as the ones that are.
 *
 * Three things are different here.
 *
 * THE FLOOR IS SHIPPED, THE REST IS DERIVED. Known patterns are hand-written so
 * a fresh install is not blank. But the expensive waste in a real project is
 * project-shaped -- a generated file that every session reads and no session
 * has ever learned anything from, a trio of fixtures that are always opened
 * together -- and no hand-written rule can name those. They come out of the
 * graph, which is the thing a detector-list product does not have.
 *
 * DETECTORS ARE SCORED. Each one carries what it has actually saved, measured
 * against the applied remedy rather than asserted. A detector that has never
 * saved anything is marked WEAK and says so next to its own findings. It is not
 * retired automatically -- that is the user's call, not ours -- but it can no
 * longer masquerade as a finding that matters.
 *
 * ALL THREE UNITS ARE WATCHED, because they catch different things:
 *
 *   COMMAND   the literal repeat. Cheap, certain, and what everyone else sees.
 *   QUESTION  the same thing established three different ways. The commands all
 *             differ, so no log comparison catches it -- but the graph knows
 *             the question was already answered, and this is usually the
 *             single most expensive pattern in a session.
 *   FLOW      cost per turn against this project's own baseline. Weak as a
 *             trigger, but it is what says "this session is going badly" before
 *             any individual call looks wrong.
 */

import { readMetrics } from './metrics.mjs';
import { findingsFor, nodeId } from './wiki.mjs';
import { serve } from './staleness.mjs';
import { canonicalPath } from './paths.mjs';
import { activeRules, remedyLedger } from './remedy.mjs';

/** Sessions an anchor must appear in before "always" means anything. */
const MIN_SESSIONS = 3;

/** Paths whose contents have never been worth a token. The shipped floor. */
const GENERATED = [
  /(^|\/)dist\//i, /(^|\/)build\//i, /(^|\/)out\//i, /(^|\/)coverage\//i,
  /(^|\/)node_modules\//i, /(^|\/)vendor\//i, /(^|\/)\.next\//i,
  /\.min\.(js|css)$/i, /\.bundle\.js$/i, /\.map$/i, /\.lock$/i,
  /(^|\/)package-lock\.json$/i, /(^|\/)yarn\.lock$/i, /(^|\/)pnpm-lock\.yaml$/i,
  /\.d\.ts$/i, /\.(png|jpe?g|gif|ico|pdf|zip|tar|gz|exe|dll|so|dylib|wasm)$/i,
];

const isGenerated = (path) => GENERATED.some((re) => re.test(path.replace(/\\/g, '/')));

/** Groups events into sessions, preserving order within each. */
function bySession(events) {
  const sessions = new Map();
  for (const event of events) {
    const key = event.sessionId || 'unknown';
    if (!sessions.has(key)) sessions.set(key, []);
    sessions.get(key).push(event);
  }
  return sessions;
}

const finding = (fields) => ({ evidence: [], costPerSession: 0, ...fields });

/* ------------------------------------------------------------------ COMMAND */

/**
 * The same file, read again, with nothing written in between.
 *
 * The one case certain enough to justify refusing rather than advising: there
 * is no interpretation under which the second identical read of an unchanged
 * file was necessary.
 */
function reRead(events) {
  const out = [];
  for (const [sessionId, rows] of bySession(events)) {
    const counts = new Map();
    for (const row of rows) {
      if (row.kind !== 'read' || !row.anchor) continue;
      if (!counts.has(row.anchor)) counts.set(row.anchor, []);
      counts.get(row.anchor).push(row.tokens || 0);
    }
    for (const [anchor, tokens] of counts) {
      if (tokens.length < 2) continue;
      // The first read was necessary; everything after it is the waste.
      const wasted = tokens.slice(1).reduce((a, b) => a + b, 0);
      if (!wasted) continue;
      out.push(finding({
        id: 're-read',
        unit: 'command',
        title: `${anchor} read ${tokens.length} times in one session`,
        anchor,
        sessionId,
        costPerSession: wasted,
        evidence: [`${tokens.length} reads, ${wasted.toLocaleString()} tokens after the first`],
        remedy: { kind: 'ours', type: 'diff-on-repeat', anchor },
      }));
    }
  }
  return out;
}

/** Reading something whose contents were never going to help. */
function generatedRead(events) {
  const seen = new Map();
  for (const row of events) {
    if (row.kind !== 'read' || !row.anchor || !isGenerated(row.anchor)) continue;
    if (!seen.has(row.anchor)) seen.set(row.anchor, { tokens: 0, sessions: new Set() });
    const entry = seen.get(row.anchor);
    entry.tokens += row.tokens || 0;
    entry.sessions.add(row.sessionId || 'unknown');
  }

  return [...seen.entries()].map(([anchor, entry]) => finding({
    id: 'generated-read',
    unit: 'command',
    title: `${anchor} is generated or binary, and was read anyway`,
    anchor,
    costPerSession: Math.round(entry.tokens / Math.max(1, entry.sessions.size)),
    evidence: [`${entry.tokens.toLocaleString()} tokens across ${entry.sessions.size} session(s)`],
    remedy: { kind: 'ours', type: 'skip', anchor, why: 'generated or binary' },
  }));
}

/* ----------------------------------------------------------------- QUESTION */

/**
 * Re-establishing something the graph already holds.
 *
 * THE PATTERN NOBODY ELSE CAN SEE. Four different commands asking one question
 * share no string, so a command log finds nothing; the graph knows the question
 * was answered at turn six with a confident, fresh finding, and that everything
 * after it was re-derivation.
 */
function reDerivation(events, graph) {
  if (!graph) return [];
  const out = [];

  for (const [sessionId, rows] of bySession(events)) {
    // When a finding was already available and fresh, a full read of its anchor
    // is re-derivation regardless of what command performed it.
    const answered = new Set();
    for (const row of rows) {
      if (row.kind !== 'read' || !row.anchor) continue;
      const id = nodeId('file', canonicalPath(row.anchor));
      if (!graph.nodes.has(id)) continue;

      const findings = serve(graph, findingsFor(graph, id, { limit: 3 }))
        .filter((f) => !f.stale && (f.confidence ?? 0) >= 0.7);
      if (!findings.length) continue;

      const key = `${sessionId}|${row.anchor}`;
      if (answered.has(key)) continue;
      answered.add(key);

      out.push(finding({
        id: 're-derivation',
        unit: 'question',
        title: `${row.anchor} was read whole, but the answer was already established`,
        anchor: row.anchor,
        sessionId,
        costPerSession: row.tokens || 0,
        evidence: findings.slice(0, 2).map((f) => `already known: ${String(f.claim).slice(0, 120)}`),
        remedy: { kind: 'ours', type: 'inject-first', anchor: row.anchor },
      }));
    }
  }
  return out;
}

/* --------------------------------------------------------------------- FLOW */

/** Sessions burning well above this project's own baseline. */
function flowAnomaly(events) {
  const perSession = new Map();
  for (const row of events) {
    if (!row.tokens) continue;
    const key = row.sessionId || 'unknown';
    perSession.set(key, (perSession.get(key) || 0) + row.tokens);
  }
  if (perSession.size < 4) return [];

  const totals = [...perSession.values()].sort((a, b) => a - b);
  const median = totals[Math.floor(totals.length / 2)];
  if (!median) return [];

  return [...perSession.entries()]
    .filter(([, total]) => total > median * 3)
    .map(([sessionId, total]) => finding({
      id: 'flow-anomaly',
      unit: 'flow',
      title: `session ${sessionId} spent ${Math.round(total / median)}x this project's median`,
      sessionId,
      costPerSession: total - median,
      evidence: [`${total.toLocaleString()} tokens against a median of ${median.toLocaleString()}`],
      // Deliberately no remedy: a spike names an amount, not a thing to stop
      // doing. Inventing a fix for it would be the false confidence this
      // project criticises everywhere else.
      remedy: null,
    }));
}

/* ------------------------------------------------------------------ DERIVED */

/**
 * Patterns that come out of THIS project rather than out of a list.
 *
 * A file read in every session that has never once produced a finding is waste
 * no hand-written rule names, because the rule would have to know the project.
 */
export function derivedDetections(dir, graph, events = readMetrics(dir)) {
  const out = [];
  const reads = events.filter((e) => e.kind === 'read' && e.anchor);
  const sessions = new Set(reads.map((r) => r.sessionId || 'unknown'));
  if (sessions.size < MIN_SESSIONS) return out;

  // BARREN ANCHORS -- read again and again, never the source of anything.
  const perAnchor = new Map();
  for (const row of reads) {
    if (!perAnchor.has(row.anchor)) perAnchor.set(row.anchor, { sessions: new Set(), tokens: 0 });
    const entry = perAnchor.get(row.anchor);
    entry.sessions.add(row.sessionId || 'unknown');
    entry.tokens += row.tokens || 0;
  }

  for (const [anchor, entry] of perAnchor) {
    if (entry.sessions.size < MIN_SESSIONS) continue;
    if (isGenerated(anchor)) continue; // the shipped floor already has it
    const id = nodeId('file', canonicalPath(anchor));
    const yielded = graph && graph.nodes.has(id) ? findingsFor(graph, id, { limit: 1 }).length : 0;
    if (yielded) continue;

    out.push(finding({
      id: 'barren-anchor',
      unit: 'command',
      derived: true,
      title: `${anchor}: read in ${entry.sessions.size} sessions, never the source of a finding`,
      anchor,
      costPerSession: Math.round(entry.tokens / entry.sessions.size),
      evidence: [`${entry.tokens.toLocaleString()} tokens across ${entry.sessions.size} sessions, 0 findings derived`],
      remedy: { kind: 'ours', type: 'skeleton-only', anchor, why: 'no finding has ever come from it' },
    }));
  }

  // CO-TOUCHED CLUSTERS -- files that are never opened alone.
  const perSession = new Map();
  for (const row of reads) {
    const key = row.sessionId || 'unknown';
    if (!perSession.has(key)) perSession.set(key, new Set());
    perSession.get(key).add(row.anchor);
  }

  const pairs = new Map();
  for (const set of perSession.values()) {
    const list = [...set].sort();
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const key = `${list[i]}\0${list[j]}`;
        pairs.set(key, (pairs.get(key) || 0) + 1);
      }
    }
  }

  for (const [key, count] of pairs) {
    if (count < MIN_SESSIONS) continue;
    const [a, b] = key.split('\0');
    const aSessions = perAnchor.get(a)?.sessions.size || 0;
    const bSessions = perAnchor.get(b)?.sessions.size || 0;
    // Only a cluster if they are essentially never opened apart.
    if (count < Math.max(aSessions, bSessions)) continue;

    out.push(finding({
      id: 'co-touched',
      unit: 'command',
      derived: true,
      title: `${a} and ${b} are always opened together`,
      anchors: [a, b],
      costPerSession: 0,
      evidence: [`opened together in ${count} of ${Math.max(aSessions, bSessions)} sessions each`],
      remedy: { kind: 'ours', type: 'composite', anchors: [a, b] },
    }));
  }

  return out;
}

/* ------------------------------------------------------------------ SCORING */

/**
 * What each detector has actually saved.
 *
 * Measured from applied remedies rather than asserted, and NOT used to retire
 * anything -- a detector that has never paid is marked weak and keeps
 * reporting, because removing it is the user's decision and a silent removal
 * would be the same overreach as a silent fix.
 */
export function detectorScores(dir) {
  const ledger = remedyLedger(dir);
  const scores = new Map();

  for (const entry of ledger) {
    const id = entry.detector || 'unknown';
    if (!scores.has(id)) scores.set(id, { applied: 0, saved: 0, measured: 0 });
    const score = scores.get(id);
    score.applied += 1;
    if (Number.isFinite(entry.savedPerSession)) {
      score.saved += entry.savedPerSession;
      score.measured += 1;
    }
  }

  const out = {};
  for (const [id, score] of scores) {
    out[id] = {
      ...score,
      savedPerSession: score.measured ? Math.round(score.saved / score.measured) : null,
      // Weak means measured and found wanting -- never merely unmeasured, which
      // would brand every new detector a failure on its first day.
      weak: score.measured >= 2 && score.saved <= 0,
    };
  }
  return out;
}

/* ---------------------------------------------------------------- ASSEMBLY */

/**
 * Every detection, ranked by what it costs per session.
 *
 * Findings whose remedy is already in force are dropped rather than repeated:
 * a fix that has been applied is not a problem, and continuing to report it is
 * how a waste report becomes noise nobody reads.
 */
export function detect(dir, graph, { events = readMetrics(dir) } = {}) {
  const rules = activeRules(dir);
  const suppressed = new Set(rules.map((r) => `${r.type}:${r.anchor || (r.anchors || []).join(',')}`));
  const scores = detectorScores(dir);

  const all = [
    ...reRead(events),
    ...generatedRead(events),
    ...reDerivation(events, graph),
    ...flowAnomaly(events),
    ...derivedDetections(dir, graph, events),
  ];

  return all
    .filter((f) => {
      if (!f.remedy) return true;
      const key = `${f.remedy.type}:${f.remedy.anchor || (f.remedy.anchors || []).join(',')}`;
      return !suppressed.has(key);
    })
    .map((f) => ({ ...f, detector: scores[f.id] || null, weak: Boolean(scores[f.id]?.weak) }))
    .sort((a, b) => b.costPerSession - a.costPerSession);
}
