// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/policy.mjs. Regenerate with `npm run sync:hooks`.
﻿/**
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

import {
  statSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  openSync,
  closeSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { isFsSafePath } from './paths.mjs';

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
export const largeFileBytes = () =>
  intEnv('TOKEN_OPTIMIZER_LARGE_READ_BYTES', 25_600);

/**
 * Size below which NO refusal can pay for itself.
 *
 * A refusal is not free: the message replacing the file is itself 50-110 tokens
 * of context. Refusing a file smaller than that spends more than it saves, and
 * a negative saving is the one number this project must never produce.
 *
 * Measured live: a re-read of a 9-byte `version.json` -- 2 tokens of content --
 * was refused with a 57-token message, 28x worse than allowing the read. The
 * re-read branch had reasoned that "the saving is proportional to the whole file
 * regardless of how small it is", which is true of the SAVING and silently
 * assumes the refusal costs nothing.
 *
 * 1 KB is about 256 tokens, comfortably above the largest refusal this hook
 * emits, so a refusal above the floor always pays.
 */
export const refusalFloorBytes = () =>
  intEnv('TOKEN_OPTIMIZER_REFUSAL_FLOOR_BYTES', 1_024);

/** Extensions whose bytes are not tokens, so byte thresholds do not apply. */
const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.ico',
  '.svg',
  '.pdf',
  '.zip',
  '.gz',
  '.tar',
  '.7z',
  '.rar',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.wasm',
  '.mp3',
  '.mp4',
  '.wav',
  '.mov',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
]);

export function isBinaryPath(path) {
  const dot = path.lastIndexOf('.');
  return dot !== -1 && BINARY_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

/**
 * Directories owned by a machine rather than by a person.
 *
 * Found live: a `Read` of `.git/index` -- 1.3 MB of binary index -- was REFUSED
 * with an offer of "structure and what is known about it", delivered an empty
 * structure section because there is none, and pointed at smart_read, which
 * would have dumped the binary. The same call also wrote `.git/index` into the
 * knowledge graph as a file node.
 *
 * Extension-based binary detection cannot catch this: `.git/index` has no
 * extension. These paths are excluded wholesale instead -- nothing here is
 * knowledge, all of it churns constantly (so it would thrash staleness), and
 * none of it is something a person reads.
 */
const MACHINE_OWNED =
  /(?:^|[/\\])(?:\.git|\.hg|\.svn|node_modules|\.venv|__pycache__|\.next|\.turbo|dist|obj|bin)(?:[/\\]|$)/i;

/**
 * Collapses `.` and `..` textually, without touching the filesystem.
 *
 * `node_modules/../src/large.ts` is an AUTHORED file, but the raw string
 * contains `node_modules/`, so matching before normalising excluded it from
 * harvesting and let that spelling slip past Read enforcement. Resolving the
 * segments first means classification depends on where a path POINTS, not on
 * how it happens to be written.
 *
 * Textual, deliberately: these paths are frequently relative, and resolving
 * against cwd would answer a different question -- and would answer it
 * differently in the hook process than in the caller.
 */
function normalizeSegments(p) {
  const drive = /^[a-z]:/i.test(p) ? p.slice(0, 2) : '';
  const rest = drive ? p.slice(2) : p;
  const rooted = rest.startsWith('/');

  const out = [];
  for (const seg of rest.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      // Above the root is still the root; above a relative start is a real
      // `..` that must be kept, or the path would silently change meaning.
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!rooted && !drive) out.push('..');
      continue;
    }
    out.push(seg);
  }

  return drive + (rooted || drive ? '/' : '') + out.join('/');
}

/** Whether a path lives inside -- or IS -- something the user never authored. */
export function isMachineOwned(path) {
  // The trailing `$` in MACHINE_OWNED matters: a git worktree or submodule
  // stores `.git` as a FILE, so `/repo/.git` has no trailing separator and
  // was classified as authored content -- putting git metadata through Read
  // refusal and into the knowledge graph.
  return MACHINE_OWNED.test(
    normalizeSegments(
      String(path || '')
        .split('\\')
        .join('/')
    )
  );
}

/** Size in bytes, or -1 when the path is missing or is not a regular file. */
export function fileSize(path) {
  // A path carrying U+10FFFF aborts libuv instead of throwing, so the catch
  // below cannot help. Checked here rather than at each call site: this is
  // exported and widely used, and review already found one caller that stat-ed
  // an unguarded path ahead of a call-site check.
  if (!isFsSafePath(path)) return -1;
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

/**
 * Where per-session hook state lives.
 *
 * Read per call rather than captured at import, so a test can point it at a
 * temp directory. Contention on this file is the normal case -- parallel tool
 * calls each spawn their own hook process -- and it was untestable while the
 * path was a module constant, which is part of why an unlocked
 * read-modify-write survived here unnoticed.
 */
const stateRoot = () =>
  process.env.TOKEN_OPTIMIZER_STATE_DIR ||
  join(tmpdir(), 'token-optimizer-hooks');

/**
 * Per SESSION and per AGENT, not per session alone.
 *
 * Every subagent inherits its parent's session id, so keying on the session
 * alone gave all of them ONE `seen` set. An agent was then refused a file it had
 * never opened -- observed verbatim: "release.yml is UNCHANGED since you last
 * read it this session" -- because a different agent had read it. That agent
 * fell back to Bash to get the contents, which defeats the optimizer and costs
 * more than the read it replaced.
 *
 * `agent` is the caller's transcript path, which is distinct per subagent. It is
 * HASHED rather than sanitised into the filename: it is an absolute path, so
 * stripping separators would collide across directories, and the digest keeps
 * the name bounded.
 *
 * Absent, the scope falls back to the session -- the main session's own calls
 * must keep sharing one state, or the once-per-session gates would reset on
 * every tool call.
 */
function statePath(sessionId, agent) {
  // Session ids come from the harness and are uuid-shaped, but they land in a
  // file path, so anything that could traverse is stripped rather than trusted.
  const safe = String(sessionId || 'default').replace(/[^A-Za-z0-9_-]/g, '');
  const scope = agent
    ? `-${createHash('sha256').update(String(agent)).digest('hex').slice(0, 12)}`
    : '';
  return join(stateRoot(), `${safe || 'default'}${scope}.json`);
}

/** A usable state object, whatever was on disk. */
function emptyState() {
  return { seen: {}, denied: {}, injected: [], actCounts: {}, forecast: null };
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
export function loadState(sessionId, agent) {
  try {
    const parsed = JSON.parse(
      readFileSync(statePath(sessionId, agent), 'utf8')
    );
    if (!parsed || typeof parsed !== 'object') return emptyState();
    return {
      seen: parsed.seen && typeof parsed.seen === 'object' ? parsed.seen : {},
      denied:
        parsed.denied && typeof parsed.denied === 'object' ? parsed.denied : {},
      // WITHOUT THIS THE ONCE-PER-SESSION GATE DOES NOT EXIST. Every tool call
      // is a separate hook PROCESS, so a set held only in memory dies with the
      // process that built it: the router recorded which findings it had
      // injected, saveState dropped the field, and the next call re-injected
      // the same advice. The gate looked correct in unit tests, which share one
      // process, and did nothing at all in production.
      injected: Array.isArray(parsed.injected) ? parsed.injected : [],
      // THE SAME REASON, ONE FIELD LATER. Every tool call is a separate process,
      // so a per-session tally not carried through here resets on every call and
      // can never reach a threshold. The act counter was written by the router and
      // dropped on the next load, so "three verification steps this session"
      // counted to one forever -- invisible rather than broken, which is the
      // harder failure to notice.
      actCounts:
        parsed.actCounts && typeof parsed.actCounts === 'object' && !Array.isArray(parsed.actCounts)
          ? parsed.actCounts
          : {},
      // THE SAME REASON A THIRD TIME. The forecast throttle records when the panel was last
      // computed and what runway it last SHOWED, and both are meaningless within a single hook
      // process -- every tool call is a new one. Dropped here, `checkedAt` would reset on every
      // call and the panel would rebuild itself, transcript parse and all, on each tool use; and
      // `shown` would reset, so worthSurfacing would compare against nothing and re-interrupt with
      // the same runway forever.
      // AND ITS TIMESTAMP MUST BE A NUMBER. The shape check alone accepted `checkedAt: "1700"`,
      // and both the throttle comparison and the merge below order by it -- so a persisted numeric
      // STRING compares by lexicographic coercion and can beat a later real timestamp, freezing
      // the throttle open or shut. Same class as every other field validated here: a value that
      // parsed is not a value that means anything.
      forecast:
        parsed.forecast && typeof parsed.forecast === 'object' && !Array.isArray(parsed.forecast)
          && Number.isFinite(parsed.forecast.checkedAt)
          ? parsed.forecast
          : null,
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
export function saveState(sessionId, state, agent) {
  let lock = null;
  try {
    mkdirSync(stateRoot(), { recursive: true, mode: 0o700 });

    // A LOCK, because merging alone still loses updates: two processes can both
    // read, both merge, and the second write still discards the first's
    // additions. `wx` fails if the file exists, which makes creation an atomic
    // test-and-set on every platform we target.
    //
    // NO UNLOCKED READ-MODIFY-WRITE. This used to fall through and write anyway
    // when the lock could not be taken, which reintroduces exactly the lost
    // update the lock exists to prevent: a process that misses the lock reads
    // the pre-merge state and can erase an `injected` id another process just
    // recorded, letting the same finding be injected twice in one session.
    //
    // Skipping the write is the safe direction. The cost is that THIS process's
    // additions are not persisted, and every consequence of that is already
    // bounded by design -- a repeated denial is allowed through by rule, and a
    // repeated injection costs its tokens once more. A stale lock is still
    // broken and taken below, so a killed process cannot wedge enforcement.
    lock = takeLock(sessionId, agent);
    if (!lock) return false;

    const current = loadState(sessionId, agent);
    const merged = {
      seen: { ...current.seen, ...state.seen },
      denied: { ...current.denied, ...state.denied },
      // UNION, not overwrite. Two hook processes running in parallel each hold
      // their own view of what has been injected; taking the last writer's copy
      // would resurrect a finding the other had already delivered, which is the
      // repetition the once-per-session gate exists to stop.
      injected: [
        ...new Set([...(current.injected || []), ...(state.injected || [])]),
      ],
      // HIGHEST WINS, for the same concurrency reason and with the same
      // direction of safety. Two hook processes each read the tally, each
      // increment, and a last-writer merge would lose one -- so a session that
      // genuinely performed three acts of a class could sit at two forever and
      // the reminder would never fire. Taking the max keeps the count
      // monotonic: it can under-count under heavy parallelism, never over-count,
      // and an under-count costs a reminder rather than producing a false one.
      actCounts: (() => {
        const out = { ...(current.actCounts || {}) };
        for (const [k, v] of Object.entries(state.actCounts || {})) {
          out[k] = Math.max(Number(out[k]) || 0, Number(v) || 0);
        }
        return out;
      })(),
      // LATEST CHECK WINS, which is the opposite direction from the fields above and correct for
      // this one. `seen`, `denied`, `injected` and `actCounts` are all append-only, so a union or
      // a max is the safe merge. The forecast throttle is a POINT IN TIME: taking the older of two
      // concurrent checks would re-open the window and let the panel be rebuilt immediately, which
      // is the cost the throttle exists to bound.
      forecast: (() => {
        const mine = state.forecast || null;
        const theirs = current.forecast || null;
        const stamp = (f) => (Number.isFinite(f?.checkedAt) ? f.checkedAt : null);
        if (stamp(mine) === null) return theirs;
        if (stamp(theirs) === null) return mine;
        return stamp(mine) >= stamp(theirs) ? mine : theirs;
      })(),
    };

    // Write-then-rename so a reader never observes a half-written file.
    const target = statePath(sessionId, agent);
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

/**
 * Forgets which files the session has read, keeping the rest of its state.
 *
 * SEPARATE FROM `saveState` BECAUSE saveState CANNOT SHRINK `seen`. It merges --
 * `{ ...current.seen, ...state.seen }` -- deliberately, so two concurrent hook
 * processes cannot erase each other's additions. Passing `seen: {}` through it
 * therefore does nothing at all: the merge restores every key. That was the first
 * attempt at this, and the test caught it.
 *
 * The one caller is the PreCompact hook. `seen` is what licenses the router to
 * refuse a Read with "unchanged since you last read it -- use what you already
 * have", which is a claim about the READER's context, and compaction is exactly the
 * event that empties it. Uncleared, the hook withholds content the model no longer
 * holds for the rest of the session.
 *
 * Same lock and write-then-rename discipline as saveState: a reader must never see a
 * half-written file, and a missed lock skips the write rather than racing it.
 */
export function clearSeen(sessionId, agent) {
  let lock = null;
  try {
    mkdirSync(stateRoot(), { recursive: true, mode: 0o700 });
    lock = takeLock(sessionId, agent);
    if (!lock) return false;

    const current = loadState(sessionId, agent);
    const cleared = { ...current, seen: {} };

    const target = statePath(sessionId, agent);
    const temporary = `${target}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(cleared), { mode: 0o600 });
    renameSync(temporary, target);
    return true;
  } catch {
    // Same rule as saveState: state is an optimization and must never fail a
    // compaction. Not clearing degrades to the old behaviour.
    return false;
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
/**
 * Sleeps synchronously.
 *
 * These hooks are single-shot processes that must reach a decision before they
 * return, so there is no event loop to yield to and nothing to await. Atomics
 * on a throwaway SharedArrayBuffer is the standard way to block a worker for a
 * bounded time without burning the CPU.
 */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // SharedArrayBuffer unavailable under some policies. The caller still makes
    // progress; it simply retries sooner.
  }
}

/** Best-effort exclusive lock. Returns the lock path, or null if not acquired. */
function takeLock(
  sessionId,
  agent,
  { attempts = 20, staleMs = 5000, waitMs = 15 } = {}
) {
  // Locks the file it actually guards. Scoping the state per agent while leaving
  // the lock on the session path would serialise every agent on one lock AND
  // protect the wrong file -- two agents could then interleave a
  // read-modify-write on their own states while holding a lock on neither.
  const path = `${statePath(sessionId, agent)}.lock`;
  for (let i = 0; i < attempts; i++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      closeSync(fd);
      return path;
    } catch {
      // A lock left behind by a killed process would otherwise block every
      // future write for the life of the session.
      try {
        if (Date.now() - statSync(path).mtimeMs > staleMs) {
          unlinkSync(path);
          continue; // Retry immediately; the holder is gone.
        }
      } catch {
        // Raced with the holder releasing it; retry immediately.
        continue;
      }

      // A LIVE holder. Waiting is the whole point: the previous loop retried
      // 20 times with no delay, so it exhausted in microseconds and the caller
      // fell through to an unlocked write. Backing off actually lets the holder
      // finish -- a state write is a few milliseconds -- which is the
      // difference between contending and merely pretending to.
      if (i < attempts - 1) sleepSync(waitMs);
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
 * Allows the call AND hands the model something it did not ask for.
 *
 * This is the delivery half of the knowledge graph, and it had no
 * implementation. `forTouch` -- the just-in-time injection the design calls
 * "where the win lands" -- was imported by nothing outside its own test, so a
 * finding could only ever reach a model through a REFUSAL. Measured across a
 * full working session on three real projects: 4,053 capture events, 2,063
 * reads, and findings served exactly twice. The graph was writing knowledge it
 * had no way to deliver.
 *
 * `additionalContext` rather than a `permissionDecisionReason`, because the call
 * is not being judged -- it is proceeding, and this rides along with it. Nothing
 * is emitted when there is nothing to say, so the common path stays a bare
 * exit(0).
 */
export function allowWithContext(context) {
  if (context) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: withEscape(context),
        },
      })
    );
  }
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
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: withEscape(reason),
      },
    })
  );
  process.exit(0);
}

/**
 * The off switch, carried by the thing doing the blocking.
 *
 * ENFORCEMENT THAT HIDES ITS OWN DISABLE IS COERCIVE. We ask people to install
 * hooks that refuse their tool calls; the least we can do is put the way out in
 * the refusal itself, where somebody who is being blocked will actually see it,
 * rather than in a README they are not reading at the moment they need it. It
 * costs a dozen tokens and turns an imposition into a default they are choosing
 * to keep.
 *
 * Appended once. A reason that already names it -- because it came from a
 * remedy rule that says so -- is left as it is.
 */
export function withEscape(reason) {
  const text = String(reason || '');
  if (text.includes('TOKEN_OPTIMIZER_MODE')) return text;
  return `${text} (Not what you wanted? TOKEN_OPTIMIZER_MODE=off disables enforcement.)`;
}

/** Lets the call through, attaching a note the model sees. */
export function advise(context) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: context,
      },
    })
  );
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
export async function readPayload({
  timeoutMs = 5000,
  maxBytes = 8_000_000,
} = {}) {
  const chunks = [];
  let size = 0;

  const raw = await new Promise((resolve) => {
    const onData = (chunk) => {
      size += chunk.length;
      // A payload this large is not a tool call; refusing to buffer it
      // unboundedly keeps a hook from becoming a memory problem.
      if (size > maxBytes) {
        finish(null);
        return;
      }
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
