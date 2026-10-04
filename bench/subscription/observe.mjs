/**
 * ONE OBSERVATION: THE METER AND THE TOKENS THAT MOVED IT, PAIRED AND STAMPED.
 *
 * This is the only file in the rig that writes a record. It reads the meter
 * (`meter.mjs`), sums the exact tokens billed inside each window
 * (`transcripts.mjs`), and appends a single line to `observations.jsonl`.
 * `calibrate.mjs` later fits weights to those lines; nothing else does.
 *
 * It spends NO quota. Both halves are reads -- a GET against the usage
 * endpoint and a pass over local files -- so it is safe to run on a timer, and
 * running it often is the only way to beat the meter's 1% quantum.
 *
 * WHAT MAKES AN OBSERVATION USABLE, AND WHY EACH GUARD IS RECORDED RATHER THAN
 * ENFORCED. Every one of these can spoil a reading. None of them is a reason to
 * refuse to write the line: a spoiled observation that is labelled is evidence;
 * an observation silently dropped at capture time is a hole nobody can audit
 * later. So each condition is measured, written into the record, and left for
 * `calibrate.mjs` to filter on.
 *
 *  - COVERAGE. The fit assumes the transcripts account for everything the meter
 *    counted. They do not, necessarily: usage from claude.ai, from another
 *    machine on the same subscription, or from a client that writes no
 *    transcript all land on the meter and never on this disk. This is the
 *    reason `calibrate.mjs` prefers DIFFERENCES between consecutive
 *    observations -- an unobserved but steady baseline cancels in a delta, and
 *    does not cancel in a level.
 *
 *  - THE FLUSH RACE. A transcript row is written after its response completes,
 *    so a request that the meter has already counted may not be on disk yet
 *    when we read it. `secondsSinceLastRequest` exposes it: a reading taken
 *    seconds after a live turn is racing, one taken during a quiet stretch is
 *    not.
 *
 *  - SELF-CONTAMINATION. The session running this rig burns the same five-hour
 *    window it is measuring. That is not fatal -- its own requests appear in
 *    the transcripts like any other -- but it does mean an A/B that wants a
 *    clean before/after has to be run with this session idle, and
 *    `requestsLast10Min` is what tells you whether it was.
 *
 *  - THE WINDOW BOUNDARY. `resets_at` can pass between two runs, at which point
 *    utilisation drops to near zero and a delta against the previous
 *    observation is meaningless. The record carries `resetsAt` for each window
 *    so a delta that straddles a reset can be identified and discarded.
 *
 * NO CREDENTIAL IS EVER WRITTEN. The record holds token COUNTS and the meter's
 * percentages. The OAuth token stays inside `meter.mjs`, and `raw` from the
 * endpoint is deliberately not persisted.
 */

import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { snapshot, WINDOWS } from './meter.mjs';
import { loadRequests, totalsInWindow, zeroTotals } from './transcripts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const OBSERVATIONS = join(HERE, 'observations.jsonl');

/**
 * Capture one observation.
 *
 * `label` is free text carried into the record -- the name of the workload that
 * was just run, or `idle`. It is the only way a later analysis can tell which
 * lines bracket a deliberate experiment and which are background sampling.
 */
export async function observe({ label = 'idle', path = OBSERVATIONS, write = true } = {}) {
  const shot = await snapshot();
  const { requests, census } = await loadRequests();
  const nowMs = Date.parse(shot.at);

  let lastRequestAt = null;
  let requestsLast10Min = 0;
  for (const r of requests.values()) {
    if (r.at === null) continue;
    if (lastRequestAt === null || r.at > lastRequestAt) lastRequestAt = r.at;
    if (r.at >= nowMs - 10 * 60e3) requestsLast10Min++;
  }

  const windows = {};
  for (const [key, w] of Object.entries(shot.windows)) {
    // The window runs [resets_at - duration, resets_at), but only the part up
    // to NOW can have happened, so the upper bound is the read time. Using
    // `resets_at` here instead would be summing the future.
    const fromMs = w.startsAt ? Date.parse(w.startsAt) : nowMs - WINDOWS[key].seconds * 1000;
    const { all, byFamily } = totalsInWindow(requests, fromMs, nowMs);
    windows[key] = {
      percent: w.percent,
      resetsAt: w.resetsAt,
      startsAt: new Date(fromMs).toISOString(),
      secondsElapsed: Math.round((nowMs - fromMs) / 1000),
      totals: all,
      byFamily,
    };
  }

  const record = {
    at: shot.at,
    label,
    windows,
    // Provenance, so a line written by an older build of the rig is
    // identifiable rather than silently mixed into a fit.
    rig: 1,
    transcripts: {
      distinctRequests: census.distinctRequests,
      duplicateRows: census.duplicateRows,
      conflictsOtherShape: census.conflictsOtherShape,
      splitUnknownRequests: census.splitUnknownRequests,
    },
    quiet: {
      secondsSinceLastRequest:
        lastRequestAt === null ? null : Math.round((nowMs - lastRequestAt) / 1000),
      requestsLast10Min,
    },
  };

  if (write) {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
  }
  return record;
}

/** Every observation on disk, oldest first. Unparsable lines are skipped. */
export function readObservations(path = OBSERVATIONS) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a partially written final line; the next append fixes it */
    }
  }
  out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const labelArg = process.argv.indexOf('--label');
  const label = labelArg >= 0 ? (process.argv[labelArg + 1] ?? 'idle') : 'idle';
  const dry = process.argv.includes('--dry-run');
  const record = await observe({ label, write: !dry });
  console.log(`${record.at}  label=${record.label}${dry ? '  (dry run, not written)' : ''}`);
  console.log(
    `  quiet: last request ${record.quiet.secondsSinceLastRequest}s ago, ` +
      `${record.quiet.requestsLast10Min} in the last 10 min`
  );
  for (const [key, w] of Object.entries(record.windows)) {
    const t = w.totals ?? zeroTotals();
    console.log(
      `  ${WINDOWS[key].label.padEnd(3)} ${String(w.percent).padStart(3)}%  ` +
        `${t.requests} req  in ${t.input}  w5m ${t.cacheWrite5m}  ` +
        `w1h ${t.cacheWrite1h}  read ${t.cacheRead}  out ${t.output}`
    );
  }
  if (!dry) console.log(`appended to ${OBSERVATIONS}`);
}
