/**
 * Which tools were used, rolled up the same way the proxy's requests are.
 *
 * THE MCP SURFACE WAS THE BLIND SPOT. `rollup.ts` counts what passes through
 * the proxy, and a user who never runs the proxy -- which is most of them,
 * since the tools are the product -- reported nothing at all. Every tool call
 * already goes out through one function, so a single call from there covers
 * the whole catalog and no tool can be added later without being counted.
 *
 * THE TOOL NAME IS A KEY, NOT A VALUE, and that is the only reason it can be
 * sent at all. `sanitiseProperties` drops strings, so a name in a value would
 * vanish silently and the event would say a call happened without saying what
 * ran. Keys are not sanitised, so this module does that job itself, and it
 * does it by refusing rather than by escaping: a name the server did not
 * advertise, or one that is not lower-case ascii, or one arriving after this
 * window already holds MAX_TOOL_KEYS distinct tools, is counted under
 * `unknown`. The request names the tool, so an unfiltered name would be a
 * string channel running from the caller straight into the payload.
 *
 * ELAPSED TIME IS A SUM, NOT A LIST. Total milliseconds over total calls is a
 * mean, which is what a field report can act on; a distribution would need
 * either per-call rows -- the thing a rollup exists to avoid -- or buckets
 * nobody has yet had a reason to choose.
 *
 * CONSENT IS NOT DECIDED HERE. Counting happens in memory whatever the policy
 * says; `record` is the gate and checks it on every call. See `rollup.ts`.
 */

import { record, libraryVersion } from './recorder.js';

/** Tool calls per rollup. Matches the proxy's window, for the same reasons. */
export const TOOL_ROLLUP_EVERY = 200;

/**
 * How many distinct tools one window may name.
 *
 * A bound on the event's size that holds even if a caller ever passes
 * `advertised` as true when it should not. The catalog is under a hundred
 * tools and a session touches a handful, so this is not reached in practice.
 */
export const MAX_TOOL_KEYS = 64;

/** The shape a tool name must have before it may become a property key. */
const SAFE_NAME = /^[a-z][a-z0-9_]{0,40}$/;

/** Where everything unrecognised is counted, so the total stays right. */
const UNKNOWN = 'unknown';

interface ToolCounts {
  calls: number;
  failed: number;
}

let calls = 0;
let failed = 0;
let msTotal = 0;
let perTool = new Map<string, ToolCounts>();

function bucket(name: string, advertised: boolean): string {
  if (!advertised || !SAFE_NAME.test(name)) return UNKNOWN;
  // A tool already in this window costs no new key, so the cap applies only to
  // the first call of a name -- otherwise a busy session would start losing
  // tools it had been reporting correctly all along.
  if (perTool.has(name)) return name;
  if (perTool.size >= MAX_TOOL_KEYS) return UNKNOWN;
  return name;
}

/**
 * Count one tool call, and emit a rollup when the window is full.
 *
 * `advertised` is the server's own answer to whether it offers this tool, and
 * it is required rather than defaulted: which value is the safe one depends on
 * what the caller knows, and a default would pick one on behalf of a call site
 * that had not thought about it.
 */
export function noteToolCall(
  name: string,
  elapsedMs: number,
  ok: boolean,
  advertised: boolean,
  env: NodeJS.ProcessEnv = process.env
): ReturnType<typeof record> {
  const key = bucket(name, advertised);
  const entry = perTool.get(key) ?? { calls: 0, failed: 0 };
  entry.calls += 1;
  if (!ok) entry.failed += 1;
  perTool.set(key, entry);

  calls += 1;
  if (!ok) failed += 1;
  if (Number.isFinite(elapsedMs) && elapsedMs > 0) msTotal += elapsedMs;

  if (calls < TOOL_ROLLUP_EVERY) return null;
  return emit('window', env);
}

/** Write what has accumulated, if anything has. Called at shutdown. */
export function flushToolRollup(
  env: NodeJS.ProcessEnv = process.env
): ReturnType<typeof record> {
  if (calls === 0) return null;
  return emit('shutdown', env);
}

function emit(
  which: 'window' | 'shutdown',
  env: NodeJS.ProcessEnv
): ReturnType<typeof record> {
  const properties = counters();
  properties.final = which === 'shutdown';
  // RESET BEFORE THE WRITE, for the reason `rollup.ts` gives: instrumentation
  // that throws must lose counts, never repeat them.
  resetToolRollup();
  return record('mcp_tool_rollup', libraryVersion(), properties, env);
}

function counters(): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {
    calls,
    failed,
    ms_total: msTotal,
  };
  for (const [name, counts] of perTool) {
    out['t_' + name] = counts.calls;
    // Omitted rather than zeroed: a window where nothing failed should not
    // carry a key per tool saying so.
    if (counts.failed > 0) out['e_' + name] = counts.failed;
  }
  return out;
}

/** The counts not yet emitted. For `doctor` and for tests. */
export function pendingToolCounts(): Readonly<
  Record<string, number | boolean>
> {
  return counters();
}

/** Drop everything counted so far without writing it. Tests, and `emit`. */
export function resetToolRollup(): void {
  calls = 0;
  failed = 0;
  msTotal = 0;
  perTool = new Map();
}
