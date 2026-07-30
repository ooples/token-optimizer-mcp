/**
 * Shared policy for the token-optimizer Claude Code hooks.
 *
 * WHY THIS EXISTS: before this module, installing the plugin registered exactly
 * one hook -- a PreToolUse advisory on `Read` -- whose default action was a
 * non-blocking tip. An agent that ignored the tip (most of them, most of the
 * time) used zero optimized tooling, so a user could install the plugin, see it
 * listed in `/mcp`, and save nothing at all. The skill did not help: skills are
 * model-invoked, so it only loads if the model already decided it cared.
 *
 * The redesign inverts the default. Optimized tooling is the path of least
 * resistance: expensive built-in calls are DENIED with a message naming the
 * exact replacement to call. Everything here exists to make that safe.
 *
 * FOUR SAFETY PROPERTIES, none of which are optional:
 *
 *   1. FAIL OPEN. Any unexpected condition -- bad payload, unreadable file,
 *      thrown exception -- allows the original call. A token optimizer that
 *      wedges the agent is worse than one that saves nothing.
 *
 *   2. LOOP BREAKING. A denial is only ever issued once per target. If the
 *      model comes back to the same file a second time, it is allowed through.
 *      This is what makes the design safe when the MCP server is missing or
 *      broken: the agent pays one wasted turn, then proceeds normally, with no
 *      human intervention and no permanent breakage.
 *
 *   3. AN ESCAPE HATCH THAT IS ONE VARIABLE. TOKEN_OPTIMIZER_MODE=off disables
 *      everything; =advise restores the old non-blocking behaviour.
 *
 *   4. NO BLOCKING OF CHEAP CALLS. Small files, paged reads, and searches that
 *      already read from a pipe cost little and are left alone. Blocking them
 *      would trade real tokens for hook overhead and user irritation.
 */

import { statSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** Enforcement modes, least to most permissive. */
export const MODE_ENFORCE = 'enforce';
export const MODE_ADVISE = 'advise';
export const MODE_OFF = 'off';

/**
 * Reads the mode. Enforcement is the DEFAULT -- that is the entire point of the
 * redesign. An unrecognised value falls back to enforce rather than silently
 * disabling, so a typo cannot quietly turn the product off.
 */
export function mode() {
  const raw = (process.env.TOKEN_OPTIMIZER_MODE || '').trim().toLowerCase();
  if (raw === MODE_OFF) return MODE_OFF;
  if (raw === MODE_ADVISE) return MODE_ADVISE;
  return MODE_ENFORCE;
}

function intEnv(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Size at which a built-in read stops being cheap.
 *
 * 25 KB is roughly 6-8k tokens -- several percent of a context window for a
 * single file. Below it the hook's own overhead is a meaningful fraction of the
 * savings, so the call is left alone.
 */
export const largeFileBytes = () => intEnv('TOKEN_OPTIMIZER_LARGE_READ_BYTES', 25_600);

/** Extensions whose bytes are not tokens, so byte thresholds do not apply. */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg',
  '.pdf', '.zip', '.gz', '.tar', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.wasm',
  '.mp3', '.mp4', '.wav', '.mov', '.woff', '.woff2', '.ttf', '.eot',
]);

export function isBinaryPath(path) {
  const dot = path.lastIndexOf('.');
  return dot !== -1 && BINARY_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

/** Size in bytes, or -1 when the path is missing or is not a regular file. */
export function fileSize(path) {
  try {
    const st = statSync(path);
    return st.isFile() ? st.size : -1;
  } catch {
    return -1;
  }
}

/* ------------------------------------------------------------------ *
 * Session state
 *
 * Re-reads are the single biggest miss in the previous design, which gated
 * purely on file SIZE. A 5 KB config read twenty times across a session costs
 * far more than one 200 KB file read once, and the old hook never fired on it.
 * Catching that requires remembering what this session already read, which
 * means state on disk, keyed by the session id the hook payload carries.
 * ------------------------------------------------------------------ */

const STATE_ROOT = join(tmpdir(), 'token-optimizer-hooks');

function statePath(sessionId) {
  // Session ids come from the harness and are uuid-shaped, but they land in a
  // file path, so anything that could traverse is stripped rather than trusted.
  const safe = String(sessionId || 'default').replace(/[^A-Za-z0-9_-]/g, '');
  return join(STATE_ROOT, `${safe || 'default'}.json`);
}

export function loadState(sessionId) {
  try {
    return JSON.parse(readFileSync(statePath(sessionId), 'utf8'));
  } catch {
    return { seen: {}, denied: {} };
  }
}

export function saveState(sessionId, state) {
  try {
    mkdirSync(STATE_ROOT, { recursive: true });
    writeFileSync(statePath(sessionId), JSON.stringify(state));
  } catch {
    // State is an optimization, not a requirement. Losing it degrades re-read
    // detection to size-only -- the old behaviour -- and never blocks anyone.
  }
}

/**
 * Records that a target was denied, and reports whether this is a REPEAT.
 *
 * The caller must allow any repeat through. That single rule is what bounds the
 * cost of every failure mode in this system: if the MCP server is not
 * installed, is misconfigured, or the model simply cannot work out how to call
 * it, the agent loses exactly one turn per target and then continues normally.
 */
export function alreadyDenied(state, key) {
  const seen = Boolean(state.denied[key]);
  state.denied[key] = true;
  return seen;
}

/* ------------------------------------------------------------------ *
 * Hook responses
 * ------------------------------------------------------------------ */

/** Emits nothing and exits 0 -- the normal permission flow proceeds. */
export function allow() {
  process.exit(0);
}

/**
 * Blocks the call and tells the model exactly what to call instead.
 *
 * The reason string is the whole user interface of this product for an agent.
 * It names the replacement tool AND its arguments, because a denial that only
 * says "use the optimized tool" gets met with a retry of the same call.
 */
export function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

/** Lets the call through, attaching a note the model sees. */
export function advise(context) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: context,
    },
  }));
  process.exit(0);
}

/**
 * Applies the configured mode to a decision.
 *
 * Every call site routes through here so that `advise` mode is guaranteed to be
 * non-blocking everywhere, rather than depending on each hook remembering to
 * check. `deniedBefore` collapses to an advisory for the reason above.
 */
export function enforce(reason, deniedBefore) {
  const current = mode();
  if (current === MODE_OFF) allow();
  if (current === MODE_ADVISE || deniedBefore) advise(reason);
  deny(reason);
}

/** Reads and parses the hook payload from stdin, or null when unusable. */
export async function readPayload() {
  const chunks = [];
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) chunks.push(chunk);
  try {
    return JSON.parse(chunks.join(''));
  } catch {
    return null;
  }
}
