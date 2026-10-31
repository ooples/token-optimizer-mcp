// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/hook-latency.mjs. Regenerate with `npm run sync:hooks`.
/**
 * Are the tool-call hooks fast on this machine, and if not, where does the time go?
 *
 * Every pre-tool and post-tool hook delays the tool call it guards. On one
 * machine (2026-10) their p90 was 84 s for weeks and 64 were killed at the
 * host's 600 s timeout. The logs recorded all of it, and nothing read them:
 * doctor printed a p95 without judging it, and the health status said
 * "healthy", because a hook that ends late still ends in success. This reads
 * the recent log tail, so a session can say so at its start, and doctor can
 * name the slow phase from the marks observability.mjs records.
 */
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { hookLogDirectory } from './observability.mjs';

/** At most this much of each log is read: a session start must stay cheap. */
const TAIL_BYTES = 1 << 20;
const RECENT_RUNS = 200;
/** Fewer runs than this say nothing either way. */
const MIN_RUNS = 20;
export const SLOW_P90_MS = 10_000;
/** A start with no completion this long after it was killed: the host's timeout is 600 s. */
const KILLED_AFTER_MS = 15 * 60 * 1000;
const MIN_KILLED = 2;
/** Only kills this recent count: one from days ago says nothing about now. */
const KILLED_WITHIN_MS = 24 * 60 * 60 * 1000;
const TOOL_EVENTS = new Set(['pre-tool', 'post-tool']);

/** The phase segments, by the marks that bound them (observability.mjs markHookPhase). */
const SEGMENTS = [
  ['runtime switch', null, 'resolved'],
  ['loading the hook', 'resolved', 'begun'],
  ['reading the payload', 'begun', 'input'],
  ['deciding', 'input', 'output'],
  ['writing the answer', 'output', 'completed'],
];

function tail(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = statSync(path).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const text = buffer.toString('utf8');
    // A cut first line is not a record.
    return length < size ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The newest two logs, oldest first: a rotation can split the recent runs across them. */
function recentLogs(dir) {
  try {
    return readdirSync(dir)
      .filter((name) => /^hook-events-.*\.jsonl$/.test(name))
      .map((name) => {
        const path = join(dir, name);
        return { path, at: statSync(path).mtimeMs };
      })
      .sort((a, b) => b.at - a.at)
      .slice(0, 2)
      .reverse()
      .map((entry) => entry.path);
  } catch {
    return [];
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
}

/** The phase that took longest in the median slow run, or null without marks. */
function slowestPhase(runs) {
  let best = null;
  for (const [name, from, to] of SEGMENTS) {
    const spans = runs
      .map((run) => {
        const phases = run.phasesMs;
        // A hook that allows silently writes no answer: deciding runs to the end.
        const end =
          to === 'output' && !Number.isFinite(phases?.output)
            ? phases?.completed
            : phases?.[to];
        if (!Number.isFinite(end)) return null;
        const start = from === null ? 0 : phases[from];
        return Number.isFinite(start) ? end - start : null;
      })
      .filter((span) => span !== null);
    const typical = median(spans);
    if (typical !== null && (best === null || typical > best.ms))
      best = { name, ms: typical };
  }
  return best;
}

/**
 * Latency of the recent tool-call hooks: p90 of the last runs, how many the
 * host killed, and the phase slow runs spent most in.
 */
export function recentToolHookLatency({
  dir = hookLogDirectory(),
  now = Date.now(),
} = {}) {
  const started = new Map();
  const done = [];
  const finished = new Set();
  for (const path of recentLogs(dir)) {
    for (const line of tail(path).split('\n')) {
      if (!line.includes('-tool"')) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (!TOOL_EVENTS.has(event.hookEvent) || !event.invocationId) continue;
      if (event.event === 'hook.started')
        started.set(event.invocationId, Date.parse(event.timestamp));
      else if (event.event === 'hook.completed') {
        finished.add(event.invocationId);
        if (Number.isFinite(event.durationMs)) done.push(event);
      }
    }
  }
  const runs = done.slice(-RECENT_RUNS);
  const durations = runs.map((run) => run.durationMs).sort((a, b) => a - b);
  const p90Ms =
    durations.length >= MIN_RUNS
      ? durations[Math.floor(durations.length * 0.9)]
      : null;
  let killed = 0;
  for (const [id, at] of started)
    if (
      !finished.has(id) &&
      now - at > KILLED_AFTER_MS &&
      now - at < KILLED_WITHIN_MS
    )
      killed += 1;
  const slow = runs.filter(
    (run) => run.durationMs >= Math.max(SLOW_P90_MS, p90Ms ?? Infinity)
  );
  return { runs: runs.length, p90Ms, killed, slowestPhase: slowestPhase(slow) };
}

/** The session-start notice, or null while the hooks are fast. */
export function slowHookNotice(latency = recentToolHookLatency()) {
  const slow = latency.p90Ms !== null && latency.p90Ms > SLOW_P90_MS;
  if (!slow && latency.killed < MIN_KILLED) return null;
  const parts = [];
  if (slow)
    parts.push(
      `over the last ${latency.runs} tool calls the p90 was ${Math.round(latency.p90Ms / 1000)} s`
    );
  if (latency.killed >= MIN_KILLED)
    parts.push(`${latency.killed} were killed by the host's timeout`);
  const phase = latency.slowestPhase
    ? ` Most of a slow run went to ${latency.slowestPhase.name}.`
    : '';
  return (
    `token-optimizer's hooks have been slow on this machine: ${parts.join(', and ')}. ` +
    `Each slow hook delays the tool call it guards.${phase} Tell the user once; ` +
    '`npx token-optimizer-doctor` shows the breakdown.'
  );
}
