// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/remedy.mjs. Regenerate with `npm run sync:hooks`.
/**
 * What a detection turns into.
 *
 * A report is read once and forgotten; an interruption fires at the wrong
 * moment. Neither compounds. So the deliverable here is a change to the
 * ENVIRONMENT -- a skip rule, a composite touch, an injection preference --
 * which makes the waste structurally impossible and every later session cheaper
 * without anyone reading anything. Detection stops being a genre of report and
 * becomes a ratchet.
 *
 * Four surfaces, ordered by how certain the detection is:
 *
 *   FIX       the ratchet. Applied, measured, reversible.
 *   BRIEFING  ~50 tokens at session start, so the waste never starts. This is
 *             intervention without interruption, and it is the cheapest of the
 *             four by an order of magnitude.
 *   VETO      only where the case is provable rather than probabilistic.
 *   REPORT    the human surface: what changed since last week, ranked by cost,
 *             each line carrying the fix that answers it.
 *
 * WHO APPLIES WHAT is decided by whose thing it is. A skip rule lives in our
 * own directory, is reversible with one command, and is measured -- so applying
 * it and reporting the delta is strictly better than asking. Anything that
 * edits the USER's files is proposed with a diff and never touched without a
 * yes; silently editing somebody's CLAUDE.md is how a tool gets uninstalled.
 *
 * Nothing is ever silent either way: an auto-applied fix is announced, ledgered
 * and revertible, so it can be wrong and visible rather than wrong and
 * permanent.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { record, readMetrics } from './metrics.mjs';
import { canonicalPath } from './paths.mjs';

/** Remedy types we may apply ourselves: our directory, reversible, measured. */
const OURS = new Set(['skip', 'skeleton-only', 'composite', 'diff-on-repeat', 'inject-first']);

function rulesPath(dir) {
  return join(dir, 'rules.json');
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* not POSIX, or not ours */ }
}

/** Every rule in force. Never throws: a corrupt rules file must not break a hook. */
export function activeRules(dir) {
  try {
    const parsed = JSON.parse(readFileSync(rulesPath(dir), 'utf8'));
    return Array.isArray(parsed?.rules) ? parsed.rules.filter((r) => !r.revertedAt) : [];
  } catch {
    return [];
  }
}

function writeRules(dir, rules) {
  ensureDir(dir);
  writeFileSync(rulesPath(dir), `${JSON.stringify({ version: 1, rules }, null, 2)}\n`, { mode: 0o600 });
}

function allRules(dir) {
  try {
    const parsed = JSON.parse(readFileSync(rulesPath(dir), 'utf8'));
    return Array.isArray(parsed?.rules) ? parsed.rules : [];
  } catch {
    return [];
  }
}

const ruleId = (remedy) => `${remedy.type}:${remedy.anchor || (remedy.anchors || []).join(',')}`;

/**
 * Applies a remedy that is ours to apply.
 *
 * Returns null for anything touching the user's own files -- those go through
 * `proposal` instead. The baseline is captured at application time, because a
 * saving that cannot be compared against what came before is an assertion.
 */
export function applyRemedy(dir, detection) {
  const remedy = detection?.remedy;
  if (!remedy || remedy.kind !== 'ours' || !OURS.has(remedy.type)) return null;

  const id = ruleId(remedy);
  const rules = allRules(dir).filter((r) => r.id !== id);
  const rule = {
    id,
    type: remedy.type,
    anchor: remedy.anchor ? canonicalPath(remedy.anchor) : undefined,
    anchors: remedy.anchors ? remedy.anchors.map((a) => canonicalPath(a)) : undefined,
    why: remedy.why || detection.title,
    detector: detection.id,
    appliedAt: Date.now(),
    // What it was costing when we applied it. Everything the report says later
    // about this fix is measured against this number.
    baselinePerSession: detection.costPerSession || 0,
  };

  rules.push(rule);
  writeRules(dir, rules);

  record(dir, {
    kind: 'remedy',
    action: 'applied',
    id,
    detector: detection.id,
    baselinePerSession: rule.baselinePerSession,
  });

  return { ...rule, revert: `revert ${id}` };
}

/** Undoes a fix. One command, because an unrevertible auto-fix is a trap. */
export function revertRemedy(dir, id) {
  const rules = allRules(dir);
  const rule = rules.find((r) => r.id === id && !r.revertedAt);
  if (!rule) return false;

  rule.revertedAt = Date.now();
  writeRules(dir, rules);
  record(dir, { kind: 'remedy', action: 'reverted', id, detector: rule.detector });
  return true;
}

/**
 * A change to the user's own files: described, diffed, never applied.
 *
 * Returned rather than executed no matter how confident the detection is.
 */
export function proposal(detection) {
  const remedy = detection?.remedy;
  if (!remedy || remedy.kind !== 'yours') return null;
  return {
    id: ruleId(remedy),
    detector: detection.id,
    title: detection.title,
    file: remedy.file,
    diff: remedy.diff,
    why: remedy.why || detection.title,
    apply: 'requires your confirmation -- nothing has been changed',
  };
}

/**
 * What a fix has actually saved since it was applied.
 *
 * Compares the anchor's per-session cost after application against the baseline
 * recorded at the time. Returns null rather than zero when there is not yet
 * enough afterwards to compare: an unmeasured fix must not report success.
 */
export function measureRemedy(dir, id) {
  const rule = allRules(dir).find((r) => r.id === id);
  if (!rule) return null;

  const anchors = new Set([rule.anchor, ...(rule.anchors || [])].filter(Boolean));
  const after = new Map();

  for (const event of readMetrics(dir)) {
    if (event.kind !== 'read' || !event.anchor || (event.at ?? 0) < rule.appliedAt) continue;
    if (anchors.size && !anchors.has(canonicalPath(event.anchor))) continue;
    const key = event.sessionId || 'unknown';
    after.set(key, (after.get(key) || 0) + (event.tokens || 0));
  }

  if (after.size < 2) {
    return { id, sessions: after.size, savedPerSession: null, reason: 'not enough sessions since it was applied' };
  }

  const mean = [...after.values()].reduce((a, b) => a + b, 0) / after.size;
  return {
    id,
    sessions: after.size,
    baselinePerSession: rule.baselinePerSession,
    nowPerSession: Math.round(mean),
    savedPerSession: Math.round(rule.baselinePerSession - mean),
  };
}

/** Every applied remedy with its measured outcome. Feeds the detector scores. */
export function remedyLedger(dir) {
  return allRules(dir).map((rule) => {
    const measured = measureRemedy(dir, rule.id);
    return {
      ...rule,
      savedPerSession: measured?.savedPerSession ?? null,
      sessionsSince: measured?.sessions ?? 0,
    };
  });
}

/**
 * The session-start briefing.
 *
 * Waste that never starts costs nothing to stop, and this is the cheapest of
 * the four surfaces by an order of magnitude -- a few dozen tokens that change
 * what the model reaches for, with no call to intercept and no turn to spend.
 *
 * Deliberately tiny and deliberately concrete. A general exhortation to be
 * efficient is worth nothing; "schema.d.ts has never yielded a finding here" is
 * a fact about this project that changes a decision.
 */
export function briefing(dir, { limit = 4 } = {}) {
  const rules = activeRules(dir);
  if (!rules.length) return null;

  const lines = [];
  const skips = rules.filter((r) => r.type === 'skip' || r.type === 'skeleton-only');
  const clusters = rules.filter((r) => r.type === 'composite');

  if (skips.length) {
    const named = skips.slice(0, limit).map((r) => r.anchor).filter(Boolean);
    if (named.length) {
      lines.push(`In this project these have never repaid a read: ${named.join(', ')}` +
        (skips.length > named.length ? ` (+${skips.length - named.length} more)` : '') +
        '. Structure is served instead of contents.');
    }
  }

  for (const cluster of clusters.slice(0, 2)) {
    if (cluster.anchors?.length) lines.push(`${cluster.anchors.join(' + ')} are always needed together; one touch serves all of them.`);
  }

  return lines.length ? lines.join('\n') : null;
}

/**
 * The human surface: what is costing the most, what changed, and the fix.
 *
 * Ranked by cost rather than by severity word, because a ranking by cost is
 * actionable and a ranking by "high/medium/low" is an opinion. The trend is
 * against the previous window of the same length, so "worse than last week" is
 * a comparison rather than a feeling.
 */
export function wasteReport(dir, detections, { windowMs = 7 * 24 * 60 * 60 * 1000, now = null } = {}) {
  const at = now ?? Math.max(0, ...readMetrics(dir).map((e) => e.at ?? 0));
  const events = readMetrics(dir);

  const spend = (from, to) => events
    .filter((e) => e.kind === 'read' && (e.at ?? 0) >= from && (e.at ?? 0) < to)
    .reduce((sum, e) => sum + (e.tokens || 0), 0);

  const current = spend(at - windowMs, at + 1);
  const previous = spend(at - windowMs * 2, at - windowMs);

  const ledger = remedyLedger(dir).filter((r) => !r.revertedAt);
  const proven = ledger.filter((r) => Number.isFinite(r.savedPerSession) && r.savedPerSession > 0);

  const lines = [];

  if (previous > 0) {
    const change = Math.round(((current - previous) / previous) * 100);
    lines.push(change === 0
      ? 'Read spend is level with the previous window.'
      : `Read spend is ${Math.abs(change)}% ${change > 0 ? 'higher' : 'lower'} than the previous window (${current.toLocaleString()} vs ${previous.toLocaleString()}).`);
  }

  if (proven.length) {
    const total = proven.reduce((sum, r) => sum + r.savedPerSession, 0);
    lines.push(`${proven.length} applied fix(es) saving a measured ${total.toLocaleString()} tokens/session.`);
  }

  const top = detections.slice(0, 6);
  if (top.length) {
    lines.push('', 'Costing the most now:');
    for (const d of top) {
      const cost = d.costPerSession ? `${d.costPerSession.toLocaleString()}/session` : 'cost not yet measurable';
      const fix = d.remedy?.kind === 'ours' ? `fix: ${d.remedy.type}`
        : d.remedy?.kind === 'yours' ? 'proposed edit, needs your yes'
          : 'no automatic fix -- this names an amount, not a thing to stop doing';
      // A detector that has been measured and never paid says so beside its own
      // finding, rather than looking as authoritative as one that has.
      lines.push(`  ${d.title}\n    ${cost}; ${fix}${d.weak ? ' [detector WEAK: has not saved anything when applied]' : ''}`);
    }
  }

  const unmeasured = ledger.filter((r) => !Number.isFinite(r.savedPerSession));
  if (unmeasured.length) {
    lines.push('', `${unmeasured.length} applied fix(es) not yet measurable (fewer than two sessions since).`);
  }

  return lines.length ? { text: lines.join('\n'), current, previous, applied: ledger.length } : null;
}
