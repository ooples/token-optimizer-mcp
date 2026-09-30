/**
 * The two numbers this whole feature was built for.
 *
 * event.ts says it plainly: the fields worth having that the receiving table
 * did not already hold are "the holdout arm's outcome, and how often the graph
 * answered instead of a tool", and that today we learn them one machine at a
 * time. Both were still learned one machine at a time. The recorder was wired
 * to the MCP tool surface and to the proxy, and the hooks -- which is where the
 * holdout runs, where substitutions are served and where most users spend the
 * whole of their time with this product -- reported nothing at all. A user who
 * opted in and never called an MCP tool transmitted a version string.
 *
 * THE HOOKS ARE NOT MADE TO REPORT; THEIR MEASUREMENTS ARE READ. Each hook is a
 * process that lives for one tool call, so it can hold no window in memory, and
 * teaching it to would put a second consent decision in a second language --
 * hooks-core imports nothing from dist/, so it cannot ask policy.ts. It already
 * writes every one of these measurements to the project's own log. So this reads
 * that log, at boot, from the one process that does own the policy, and nothing
 * on the hook path changes.
 *
 * WHAT IT SENDS IS COUNTS, NEVER THE LOG. The metrics log names real files from
 * a private codebase and may never be transmitted; `report()` reduces it to
 * integers, and only named integers from that reduction are copied here.
 * sanitiseProperties would drop a string anyway, which is the backstop, not the
 * plan.
 *
 * IT IS A GAUGE, NOT A COUNTER, and the receiver has to treat it as one. The
 * log is a sliding tail bounded by bytes and by event count, so two snapshots
 * overlap by an unknown amount and their difference is not a delta. Each row is
 * the state of one project's ledger at one instant. Sending real deltas would
 * need a high-water mark that the tail can slide past, which would silently
 * under-report exactly the busiest machines.
 *
 * A FIELD THAT IS ABSENT MEANS "NOT YET KNOWN". The holdout needs 20 treated
 * and 5 withheld reads before it estimates anything; below that `report()`
 * answers null and the field is omitted rather than sent as a zero, because a
 * zero saving and an unmeasured saving are the opposite finding.
 *
 * ONCE PER WINDOW PER MACHINE, not once per boot: restarting an editor six times
 * in an afternoon is not six observations of anything. The stamp is a file, so
 * the throttle survives the process it belongs to.
 */

/* eslint-disable n/no-sync -- the stamp is a ~30-byte file read once per boot to
 * decide whether to do any work at all, and written once per six hours. Making it
 * async would turn `dueForSnapshot` from a pure function of (now, env) -- which is
 * how it is tested and how the refusal above is expressed -- into a promise, for
 * no measurable gain on two operations of that size. `recorder.ts`, which owns the
 * same directory, gives the same answer for its own appends. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { record, libraryVersion, telemetryDir } from './recorder.js';
import { localTelemetryEnabled } from './policy.js';
import type { SafeValue } from './event.js';

/** How long one machine's snapshot stands before another is worth taking. */
export const SNAPSHOT_EVERY_MS = 6 * 60 * 60 * 1000;

/** Where the last snapshot's time is remembered. */
export function snapshotStampFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(telemetryDir(env), 'last-snapshot.json');
}

/** When the last snapshot was taken, or null if none was or the stamp is unreadable. */
export function lastSnapshotAt(env: NodeJS.ProcessEnv = process.env): number | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(snapshotStampFile(env), 'utf8'));
    const at =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as { at?: unknown }).at
        : undefined;
    return typeof at === 'number' && Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

/**
 * Is a snapshot due?
 *
 * An unreadable or absent stamp answers yes. The alternative -- treating a
 * missing stamp as "just taken" -- means a machine that cannot write the stamp
 * never reports at all, and says nothing about why.
 */
export function dueForSnapshot(
  now: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const last = lastSnapshotAt(env);
  if (last === null) return true;
  // A stamp from the future is a clock that moved backwards, not a reason to go
  // silent until it catches up.
  if (last > now) return true;
  return now - last >= SNAPSHOT_EVERY_MS;
}

/** Remembers that a snapshot was taken. Failure to remember costs a duplicate, not a throw. */
export function stampSnapshot(
  now: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env
): void {
  try {
    mkdirSync(telemetryDir(env), { recursive: true });
    writeFileSync(snapshotStampFile(env), `${JSON.stringify({ at: now })}\n`, 'utf8');
  } catch {
    // The snapshot itself is already recorded. A stamp that could not be written
    // means the next boot takes another one, which the receiver sees as a second
    // reading of the same gauge -- not as data loss.
  }
}

/** A finite number, or null when the report had nothing to say. */
function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Reads one nested field without asserting the shape of the whole report. */
function at(row: unknown, ...path: string[]): unknown {
  let cursor: unknown = row;
  for (const key of path) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

/**
 * The counts worth sending, or null when this project has not used the graph.
 *
 * A project where nothing was injected, withheld or substituted has nothing to
 * report, and a row of zeros per machine per window would be the majority of
 * the table -- outnumbering the rows that answer the question.
 */
export function snapshotProperties(
  report: unknown
): Record<string, SafeValue> | null {
  const substitutions = num(at(report, 'nativeOptimizer', 'substitutions')) ?? 0;
  const deliveries = num(at(report, 'memoryDeliveries')) ?? 0;
  const holdouts = num(at(report, 'memoryHoldouts')) ?? 0;
  if (substitutions + deliveries + holdouts <= 0) return null;

  const fields: Record<string, number | boolean | null> = {
    // How often the graph answered instead of a tool, and what that was worth.
    substitutions,
    substitution_holdouts: num(at(report, 'nativeOptimizer', 'holdouts')),
    tokens_saved: num(at(report, 'nativeOptimizer', 'tokensSaved')),
    tokens_returned: num(at(report, 'nativeOptimizer', 'tokensReturned')),
    // The holdout arm: what was delivered, what was withheld, what it cost.
    deliveries,
    holdouts,
    file_touch_treated: num(at(report, 'injections')),
    file_touch_holdouts: num(at(report, 'holdouts')),
    command_injections: num(at(report, 'commandInjections')),
    session_start_injections: num(at(report, 'sessionStartInjections')),
    session_start_tokens: num(at(report, 'sessionStartInjectedTokens')),
    delivery_tokens: num(at(report, 'deliveryTokens')),
    injected_tokens: num(at(report, 'injectedTokens')),
    harvest_tokens: num(at(report, 'harvestTokens')),
    stale_served: num(at(report, 'staleServed')),
    stale_rate: num(at(report, 'staleRate')),
    // And its outcome, which is absent until the arms are large enough to have one.
    tokens_avoided: num(at(report, 'estimatedTokensAvoided')),
    net_tokens: num(at(report, 'netTokens')),
    sufficient_data: at(report, 'sufficientData') === true,
    downstream_samples: num(
      at(report, 'measurement', 'metrics', 'readingAvoided', 'samples')
    ),
    ledger_age_ms: num(at(report, 'measurement', 'freshness', 'ageMs')),
  };

  const out: Record<string, SafeValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== null) out[key] = value;
  }
  return out;
}

export interface SnapshotResult {
  /** The event that was recorded, or null when none was. */
  readonly recorded: boolean;
  /** Why nothing was recorded, or null when something was. */
  readonly refused: string | null;
}

/**
 * Record one project's graph ledger as a telemetry event, if it is due.
 *
 * Never throws: every failure is a refusal this returns, for the same reason
 * recorder.ts gives. The metrics reader is imported by path rather than by
 * package specifier because hooks-core ships unbuilt beside dist/ -- the same
 * idiom proxy/findings.ts uses -- and the import is awaited here rather than at
 * module load so that a caller who is not opted in pays nothing for it.
 */
export async function flushHookSnapshot(
  env: NodeJS.ProcessEnv = process.env,
  root: string = process.cwd(),
  now: number = Date.now()
): Promise<SnapshotResult> {
  // CHECKED BEFORE THE LOG IS EVEN OPENED. `record` would refuse anyway, but a
  // user who has not opted in should not have their metrics log read by a
  // telemetry module at all -- the refusal has to be visible in the order of
  // operations, not just in the outcome.
  if (!localTelemetryEnabled(env)) {
    return { recorded: false, refused: 'local telemetry is not enabled' };
  }
  if (!dueForSnapshot(now, env)) {
    return { recorded: false, refused: 'a snapshot was taken recently' };
  }
  let report: unknown;
  try {
    const moduleUrl = pathToFileURL(
      fileURLToPath(new URL('../../hooks-core/metrics.mjs', import.meta.url))
    ).href;
    const wikiUrl = pathToFileURL(
      fileURLToPath(new URL('../../hooks-core/wiki.mjs', import.meta.url))
    ).href;
    const [metrics, wiki] = await Promise.all([import(moduleUrl), import(wikiUrl)]);
    report = metrics.report(wiki.wikiDir(root));
  } catch (err) {
    return {
      recorded: false,
      refused: `could not read the ledger: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const properties = snapshotProperties(report);
  if (!properties) {
    // STAMPED ANYWAY. Otherwise every boot on a machine that does not use the
    // graph re-reads and re-reduces the whole log to decide the same thing.
    stampSnapshot(now, env);
    return { recorded: false, refused: 'the graph was not used in this project' };
  }
  const event = record('hook_graph_snapshot', libraryVersion(), properties, env);
  if (!event) return { recorded: false, refused: 'the event could not be written' };
  stampSnapshot(now, env);
  return { recorded: true, refused: null };
}