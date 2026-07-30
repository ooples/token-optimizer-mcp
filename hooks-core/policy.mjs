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

import { statSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync } from 'node:fs';
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

/** A usable state object, whatever was on disk. */
function emptyState() {
  return { seen: {}, denied: {} };
}

/**
 * Loads session state, validating its SHAPE and not merely that it parsed.
 *
 * Only a parse *throw* used to fall back to a default, so a file containing
 * `null`, `{}`, or a layout from an older version produced an object with no
 * `seen`/`denied` maps -- and the very next property access threw inside the
 * router. That exception is caught and fails open, so the visible symptom would
 * have been "enforcement silently stops working for this session", which is
 * exactly the kind of quiet failure that never gets reported.
 */
export function loadState(sessionId) {
  try {
    const parsed = JSON.parse(readFileSync(statePath(sessionId), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return emptyState();
    return {
      seen: parsed.seen && typeof parsed.seen === 'object' ? parsed.seen : {},
      denied: parsed.denied && typeof parsed.denied === 'object' ? parsed.denied : {},
    };
  } catch {
    return emptyState();
  }
}

/**
 * Persists session state, merging rather than overwriting.
 *
 * CONCURRENCY IS THE NORMAL CASE HERE, not an edge case: a client may run
 * several tool calls in parallel, and each one spawns its own hook process.
 * Those processes load, mutate and save the same file with no lock between
 * them, so a plain write means the last writer erases whatever the others
 * recorded -- losing a `denied` entry re-arms a refusal that was already
 * issued, which is precisely the loop the design promises cannot happen.
 *
 * Re-reading and merging immediately before writing shrinks that window to the
 * gap between read and rename. It does not close it -- that needs a lock file,
 * which is a poor trade for state whose worst-case loss is one extra refusal --
 * but it turns "last writer wins" into "union of writers", which is the
 * behaviour the two maps actually want, since both are append-only sets.
 */
export function saveState(sessionId, state) {
  let lock = null;
  try {
    mkdirSync(STATE_ROOT, { recursive: true, mode: 0o700 });

    // A LOCK, because merging alone still loses updates: two processes can both
    // read, both merge, and the second write still discards the first's
    // additions. `wx` fails if the file exists, which makes creation an atomic
    // test-and-set on every platform we target.
    //
    // Bounded and best-effort: if the lock cannot be taken quickly the write
    // proceeds anyway. A stale lock from a killed process must never wedge
    // enforcement, and the worst case without the lock is the merge behaviour
    // that was already acceptable.
    lock = takeLock(sessionId);

    const current = loadState(sessionId);
    const merged = {
      seen: { ...current.seen, ...state.seen },
      denied: { ...current.denied, ...state.denied },
    };

    // Write-then-rename so a reader never observes a half-written file.
    const target = statePath(sessionId);
    const temporary = `${target}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(merged), { mode: 0o600 });
    renameSync(temporary, target);
  } catch {
    // State is an optimization, not a requirement. Losing it degrades re-read
    // detection to size-only -- the old behaviour -- and never blocks anyone.
  } finally {
    if (lock) {
      try {
        unlinkSync(lock);
      } catch {
        // Already gone; nothing to release.
      }
    }
  }
}

/** Best-effort exclusive lock. Returns the lock path, or null if not acquired. */
function takeLock(sessionId, { attempts = 20, staleMs = 5000 } = {}) {
  const path = `${statePath(sessionId)}.lock`;
  for (let i = 0; i < attempts; i++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      closeSync(fd);
      return path;
    } catch {
      // A lock left behind by a killed process would otherwise block every
      // future write for the life of the session.
      try {
        if (Date.now() - statSync(path).mtimeMs > staleMs) unlinkSync(path);
      } catch {
        // Raced with the holder releasing it; just retry.
      }
    }
  }
  return null;
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

/**
 * Reads and parses the hook payload from stdin, or null when unusable.
 *
 * BOUNDED, because fail-open does not cover a stall. Every entry point wraps
 * this in a catch that allows the call on a throw -- but a host that opens the
 * pipe and never closes it produces no throw at all, just a hook that waits
 * forever while the user's tool call hangs behind it. A hung optimizer is worse
 * than an absent one, so the wait has a ceiling and expiring it is treated
 * exactly like unusable input.
 */
export async function readPayload({ timeoutMs = 5000, maxBytes = 8_000_000 } = {}) {
  const chunks = [];
  let size = 0;

  const raw = await new Promise((resolve) => {
    const onData = (chunk) => {
      size += chunk.length;
      // A payload this large is not a tool call; refusing to buffer it
      // unboundedly keeps a hook from becoming a memory problem.
      if (size > maxBytes) { finish(null); return; }
      chunks.push(chunk);
    };
    const onEnd = () => finish(chunks.join(''));
    const onError = () => finish(null);

    // Listeners are REMOVED on every exit path. Leaving them attached after the
    // timeout wins means a late chunk keeps growing a buffer nobody will read,
    // and holds the stream referenced so the process cannot exit cleanly.
    function finish(value) {
      clearTimeout(timer);
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.off('error', onError);
      process.stdin.pause();
      resolve(value);
    }

    const timer = setTimeout(() => finish(null), timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.on('error', onError);
  });

  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
