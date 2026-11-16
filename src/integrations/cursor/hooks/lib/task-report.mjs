// GENERATED FILE -- do not edit.
// Source of truth: src/hooks-core/task-report.mjs. Regenerate with `npm run sync:hooks`.
/**
 * How task classification is doing, from its ledger (task-ledger.mjs).
 *
 * THREE ANSWERS, each only as strong as its evidence says:
 * - MIX: how prompts were classified, by category and by client.
 * - CORRECTIONS: how often the tool calls overruled the prompt's category --
 *   the closest thing to an error rate the product can see on its own. A high
 *   rate for a category means the prompt rules are guessing.
 * - COST BY ARM: what a prompt in each category cost in classified sessions
 *   against held-out sessions (the UNKNOWN row). Only this one is a measured
 *   effect, and only once both arms have enough prompts; below that it says
 *   so rather than printing a ratio from a handful of points.
 *
 * Costs are uncached-input equivalents, never currency: the comparison is
 * between arms of real sessions, and pricing it would add a precision the
 * sample does not have.
 */

import { ARM_CLASSIFIED, ARM_HOLDOUT, readTaskEvents } from './task-ledger.mjs';

/** A prompt's outcome is matched to the classification made within this of it. */
export const MATCH_WINDOW_MS = 2 * 60 * 1000;
/** Fewer prompts than this in either arm and no ratio is printed. */
export const MIN_ARM_PROMPTS = 20;
const RESAMPLES = 1000;

/** Deterministic: the same ledger always reports the same interval. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Ratio of means (classified / holdout) with a 95% percentile bootstrap
 * interval. Below 1 means classified sessions' prompts cost less.
 */
export function ratioInterval(treated, control, { resamples = RESAMPLES, seed = 1 } = {}) {
  if (treated.length < MIN_ARM_PROMPTS || control.length < MIN_ARM_PROMPTS) return null;
  const c = mean(control);
  if (!(c > 0)) return null;
  const rand = prng(seed);
  const draw = (xs) => {
    let s = 0;
    for (let i = 0; i < xs.length; i += 1) s += xs[Math.floor(rand() * xs.length)];
    return s / xs.length;
  };
  const ratios = [];
  for (let i = 0; i < resamples; i += 1) {
    const d = draw(control);
    if (d > 0) ratios.push(draw(treated) / d);
  }
  ratios.sort((a, b) => a - b);
  return {
    ratio: mean(treated) / c,
    low: ratios[Math.floor(ratios.length * 0.025)],
    high: ratios[Math.min(ratios.length - 1, Math.floor(ratios.length * 0.975))],
  };
}

/**
 * The report, from ledger rows (readTaskEvents). Pure: tests pass rows in.
 */
export function taskReport(rows, { sessionId = null } = {}) {
  const scoped = sessionId ? rows.filter((row) => row.s === sessionId) : rows;

  // One classification per (session, generation); a re-sent row keeps the first.
  const classified = new Map();
  // The LAST settle of a generation is where its turn ended.
  const settled = new Map();
  // A resumed session is folded again: the latest outcome for a prompt wins.
  const outcomes = new Map();
  for (const row of scoped) {
    if (row.k === 'classified' && row.gen) {
      const key = `${row.s}\u0000${row.gen}`;
      if (!classified.has(key)) classified.set(key, row);
    } else if (row.k === 'settled' && row.gen) {
      settled.set(`${row.s}\u0000${row.gen}`, row);
    } else if (row.k === 'outcome' && row.promptAt > 0) {
      outcomes.set(`${row.s}\u0000${row.promptAt}`, row);
    }
  }

  const mix = {};
  const byClient = {};
  const corrections = {};
  const bySession = new Map();
  for (const [key, row] of classified) {
    const final = settled.get(key);
    const category = final?.c || row.c;
    mix[row.c] = (mix[row.c] || 0) + 1;
    const client = row.client || 'unknown';
    byClient[client] = (byClient[client] || 0) + 1;
    const entry = (corrections[row.c] ||= { settled: 0, corrected: 0, to: {} });
    if (final) {
      entry.settled += 1;
      if (final.c !== row.c) {
        entry.corrected += 1;
        entry.to[final.c] = (entry.to[final.c] || 0) + 1;
      }
    }
    if (!bySession.has(row.s)) bySession.set(row.s, []);
    bySession.get(row.s).push({ at: row.at, category, arm: row.arm || ARM_CLASSIFIED });
  }

  // Each outcome goes to the nearest classification of its session in time.
  const costs = {};
  let matched = 0;
  let unmatched = 0;
  for (const row of outcomes.values()) {
    let best = null;
    for (const candidate of bySession.get(row.s) || []) {
      const gap = Math.abs(candidate.at - row.promptAt);
      if (gap <= MATCH_WINDOW_MS && (!best || gap < best.gap)) best = { gap, ...candidate };
    }
    if (!best) {
      unmatched += 1;
      continue;
    }
    matched += 1;
    const entry = (costs[best.category] ||= { [ARM_CLASSIFIED]: [], [ARM_HOLDOUT]: [] });
    (entry[best.arm] ||= []).push(Number(row.cu) || 0);
  }

  const cost = {};
  for (const [category, arms] of Object.entries(costs)) {
    const treated = arms[ARM_CLASSIFIED] || [];
    const control = arms[ARM_HOLDOUT] || [];
    cost[category] = {
      classified: { prompts: treated.length, median: treated.length ? median(treated) : null },
      holdout: { prompts: control.length, median: control.length ? median(control) : null },
      effect: ratioInterval(treated, control),
    };
  }

  return { prompts: classified.size, mix, byClient, corrections, cost, matched, unmatched };
}

const num = (n) => Math.round(n).toLocaleString('en-US');

/** Lines for the savings report; empty when nothing was ever classified. */
export function renderTaskReport(report) {
  if (!report || !report.prompts) return [];
  const lines = ['', '▸ Task classification (cost in uncached-input equivalents; not part of "verified saved")'];
  const mix = Object.entries(report.mix).sort((a, b) => b[1] - a[1]);
  lines.push(`  prompts classified : ${num(report.prompts)} — ${mix.map(([c, n]) => `${c} ${num(n)}`).join(', ')}`);
  lines.push(
    `  by client          : ${Object.entries(report.byClient)
      .map(([c, n]) => `${c} ${num(n)}`)
      .join(', ')}`
  );
  for (const [category, entry] of Object.entries(report.corrections)) {
    if (!entry.settled) continue;
    const to = Object.entries(entry.to)
      .map(([c, n]) => `${c} ${n}`)
      .join(', ');
    lines.push(
      `  ${category.padEnd(8)} corrected by tool calls: ${num(entry.corrected)}/${num(entry.settled)} (${Math.round(
        (100 * entry.corrected) / entry.settled
      )}%)${to ? ` → ${to}` : ''}`
    );
  }
  for (const [category, entry] of Object.entries(report.cost)) {
    const c = entry.classified;
    const h = entry.holdout;
    const head = `  ${category.padEnd(8)} median cost/prompt: classified ${c.median === null ? '—' : num(c.median)} (n=${c.prompts}), holdout ${
      h.median === null ? '—' : num(h.median)
    } (n=${h.prompts})`;
    const tail = entry.effect
      ? `; mean ratio ${entry.effect.ratio.toFixed(2)} [95% ${entry.effect.low.toFixed(2)}–${entry.effect.high.toFixed(2)}]`
      : `; no ratio below ${MIN_ARM_PROMPTS} prompts per arm`;
    lines.push(head + tail);
  }
  if (!report.matched) lines.push('  costs: none yet — prompts are costed when their session has ended and been folded');
  return lines;
}

/** For the report tool: read, scope and render in one call. */
export function taskReportFromLedger({ env = process.env, since = 0, until = Infinity, sessionId = null } = {}) {
  const rows = readTaskEvents(env, { since }).filter((row) => (row.at || 0) <= until);
  const report = taskReport(rows, { sessionId });
  return { report, lines: renderTaskReport(report) };
}
