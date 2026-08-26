/**
 * Claude Code Stop adapter -- run the semantic harvest the design specifies.
 *
 * The wiki design says findings are extracted "at Stop and PreCompact" by a
 * cheap model, out of band. The extractor (`lib/harvest.mjs`) was implemented
 * and then imported by nothing: no hook invoked it, and Stop carried no
 * token-optimizer entry at all. The consequence was not a crash but a graph
 * that could serve findings and never acquired any -- 122 file / 132 symbol /
 * 61 task nodes and zero findings on a real project after a full session, with
 * injection, staleness and the metrics all wired and idle behind it.
 *
 * OUT OF BAND IS THE POINT. The extraction is a model call; doing it inline
 * would make the session that did the work pay for summarising itself, which is
 * the cost this whole subsystem exists to avoid. So this spawns a detached
 * worker and returns immediately. Stop is never delayed.
 *
 * IT ALSO REPORTS WHEN IT CANNOT RUN. Harvest requires an API key, and without
 * one `harvestEnabled()` returns false and the module skips silently. Silence
 * was how this stayed invisible: nothing in doctor, audit or waste mentions
 * harvest, so a user sees a graph filling with structural nodes and no findings
 * and has no way to learn why. Saying so once per session is the difference
 * between a disabled feature and a broken one.
 */

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  chmodSync,
  readFileSync,
  openSync,
  writeSync,
  closeSync,
  lstatSync,
  constants,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { mode, MODE_OFF } from './policy.mjs';
import { harvestEnabled, harvestMode } from './harvest.mjs';
import { archive } from './transcript.mjs';
import { wikiDir, projectRootFor, sharedDir, load } from './wiki.mjs';
import { detectRefusals, recordRefusal } from './harvest-write.mjs';

/** What to tell the user, per reason the harvest is not running. */
const OFF_REASON = {
  'off:mode': null, // The whole optimizer is off; saying more would be noise.
  'off:not-opted-in':
    'token-optimizer: automatic finding-extraction is OFF. It costs a model call and ' +
    'sends a digest (paths, commands, prompts, conclusions -- never file contents) off ' +
    'this machine, so it is opt-in: set TOKEN_OPTIMIZER_HARVEST=1 with an API key, or ' +
    'point TOKEN_OPTIMIZER_HARVEST_ENDPOINT at a local model to run it free and private. ' +
    'Meanwhile lifecycle-based structural graph capture keeps working. Durable semantic MCP ' +
    'writes require a writer schema that is actually registered in the current CLI session.',
  'off:no-key':
    'token-optimizer: finding-extraction is opted in but has no credential. Set ' +
    'TOKEN_OPTIMIZER_API_KEY, or point TOKEN_OPTIMIZER_HARVEST_ENDPOINT at a local model ' +
    'to run it without one.',
};

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * A session id reduced to something that cannot leave the marker directory.
 *
 * The id arrives in the hook payload, so it is external input, and it was being
 * interpolated straight into a path: a value containing separators or `..` would
 * have placed (and later read) the marker anywhere on disk. Everything outside a
 * conservative allowlist becomes an underscore, which keeps ordinary uuids
 * readable while making traversal unrepresentable rather than merely unlikely.
 */
function markerName(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');
  // A name of only dots would still resolve to a directory entry.
  const cleaned = /^[.]+$/.test(safe) ? 'unknown' : safe;
  return `harvest-notice-${cleaned.slice(0, 64)}`;
}

/**
 * A private, per-user directory for this hook's markers.
 *
 * os.tmpdir() is per-user on Windows but resolves to a SHARED, world-writable
 * /tmp on POSIX. The marker name is derived from the session id, so it is
 * predictable enough for another local user to pre-create -- as a symlink, or
 * as a file they own -- and writeFileSync would then follow it and write
 * through with this user's privileges.
 *
 * The state here is a debounce timestamp and a "said it once" flag, so the fix
 * is not to guard a shared location but to stop using one. XDG_STATE_HOME is
 * the standard place for state that should persist across runs but is not
 * precious, and it is inside the user's own home on every POSIX system.
 */
function stateDir() {
  const home = homedir();
  const base =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA || tmpdir()
      : process.env.XDG_STATE_HOME ||
        (home ? join(home, '.local', 'state') : tmpdir());

  const dir = join(base, 'token-optimizer');
  try {
    // 0o700 AND an explicit chmod, for the reason the graph store documents:
    // `recursive` applies the mode only to directories it actually creates, and
    // the umask masks it further, so neither alone guarantees the result.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Not POSIX, or not ours to chmod.
    }
  } catch {
    /* best effort */
  }
  return dir;
}

/** Where the once-per-session notice is remembered, so Stop does not nag. */
function noticePath(sessionId) {
  return join(stateDir(), markerName(sessionId));
}

/**
 * True when the path is absent, or is a regular file this user owns.
 *
 * lstat rather than stat: stat FOLLOWS the link and would happily report on the
 * target, which is the thing being defended against.
 */
function ownedRegularFile(path) {
  let info;
  try {
    info = lstatSync(path);
  } catch {
    return true; // Absent. The O_NOFOLLOW open below settles the race.
  }
  if (!info.isFile()) return false;
  // getuid is undefined on Windows, where stateDir() is already per-user.
  if (typeof process.getuid === 'function' && info.uid !== process.getuid())
    return false;
  return true;
}

/**
 * Writes a marker, refusing to follow a symlink.
 *
 * O_NOFOLLOW makes the refusal ATOMIC rather than a check-then-use window: a
 * link swapped in after ownedRegularFile() returns fails the open instead of
 * being written through. The flag does not exist on Windows, where it is
 * undefined and falls back to 0 -- acceptable, because the directory is
 * per-user there to begin with.
 */
function writeMarker(path, contents) {
  if (!ownedRegularFile(path)) return false;
  const NOFOLLOW = constants.O_NOFOLLOW || 0;
  let fd;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW,
      0o600
    );
    writeSync(fd, contents);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

/** Reads a marker, ignoring anything that is not a regular file we own. */
function readMarker(path) {
  if (!ownedRegularFile(path)) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function alreadyNotified(sessionId) {
  const path = noticePath(sessionId);
  // Anything already at this path -- our marker, or something planted -- means
  // stay quiet. Repeating the notice is the worse failure, and refusing to
  // write over a foreign file is the point.
  if (existsSync(path)) return true;
  return !writeMarker(path, String(Date.now()));
}

/** Minimum gap between harvests of one session. */
const HARVEST_INTERVAL_MS =
  Number(process.env.TOKEN_OPTIMIZER_HARVEST_INTERVAL_MS) > 0
    ? Number(process.env.TOKEN_OPTIMIZER_HARVEST_INTERVAL_MS)
    : 10 * 60 * 1000;

/**
 * True when this session has not been harvested recently, and records that it
 * is about to be.
 *
 * Deliberately marks only when a harvest actually starts: touching it on every
 * Stop would let a run of skipped turns keep pushing the next harvest away.
 */
function dueForHarvest(sessionId) {
  const marker = join(stateDir(), `harvest-last-${markerName(sessionId)}`);

  const last = Number(readMarker(marker));
  // > 0 matters: readMarker returns null when the marker is missing or is not
  // ours, and Number(null) is 0, which is finite -- so without this an absent
  // marker would read as a harvest at the epoch.
  if (
    Number.isFinite(last) &&
    last > 0 &&
    Date.now() - last < HARVEST_INTERVAL_MS
  ) {
    return false;
  }

  // If the marker cannot be written the debounce degrades to off rather than
  // blocking the harvest entirely.
  writeMarker(marker, String(Date.now()));
  return true;
}

/**
 * The Stop-time harvest, for every client rather than one.
 *
 * WHY THIS IS A FUNCTION AND NOT A HOOK. It was a hook -- a Claude Code entry
 * point named `stop-harvest.mjs` -- and #300 unregistered it. Nothing replaced
 * it, so four capabilities went silently: the transcript archive, the harvest
 * worker spawn, refusal detection, and the notice that says why no findings
 * exist. Every client routes Stop through the shared adapter, and the adapter
 * did none of these, so on a full session with a valid credential
 * `harvestMode()` reported `remote` and nothing happened.
 *
 * NOTHING OBSERVED THAT IT DID NOT RUN, which is why it survived a year. There
 * is no `kind:'harvest'` event to be absent from a report, no error, and a
 * harvest that ran and found nothing looks exactly like one that never
 * started. The reachability guard could not see it either: this file's own
 * imports gave `archive`, `detectRefusals` and `recordRefusal` call sites, and
 * a name-based scan proves a reference exists, never that it runs.
 *
 * Returns a notice for the caller to emit, or null. It does NOT write to
 * stdout: the adapter emits exactly one JSON object per hook invocation, and a
 * second writer racing it is how a Stop payload gets corrupted.
 *
 * @returns {Promise<string|null>} a once-per-session message, or null.
 */
export async function runStopHarvest(payload = {}) {
  if (mode() === MODE_OFF) return null;

  const transcript = payload.transcript_path ?? payload.transcriptPath ?? null;
  if (!transcript || !existsSync(transcript)) return null;

  // ARCHIVE FIRST, AND UNCONDITIONALLY. This is a local file copy: it costs no
  // model call, spends no money, and sends nothing anywhere, so it must not sit
  // behind the opt-in that exists to gate cost and disclosure. Gating it there
  // would mean the record of what the user actually said is kept only for the
  // users who opted into a paid feature, which is exactly backwards.
  //
  // It also has to happen before the early return below, or a session with
  // harvesting off would archive nothing at all.
  try {
    archive(
      wikiDir(
        projectRootFor(
          join(payload.cwd || process.cwd(), '__session__'),
          payload.cwd
        )
      ),
      transcript,
      {
        sessionId: payload.session_id,
      }
    );
  } catch {
    // The archive is a convenience. Failing to write it must not affect Stop.
  }

  // CLOSE THE REFUSAL LOOP, and do it OUTSIDE the harvest opt-in. Reading the
  // transcript this process already holds costs no model call and sends nothing
  // anywhere, so gating it behind the paid feature would leave a mis-scoped
  // lesson costing tokens forever for everyone who did not opt in.
  //
  // The model states plainly when a cross-project lesson does not transfer --
  // "that figure is another repo's baseline and it doesn't transfer" -- and until
  // now nothing read it, so the same lesson was delivered again next session.
  try {
    const shared = sharedDir();
    const lessons = [...load(shared).nodes.values()].filter(
      (n) => n.kind === 'finding' && !n.retired && n.claim
    );
    if (lessons.length) {
      const text = readFileSync(transcript, 'utf8');
      for (const key of detectRefusals(lessons, text))
        recordRefusal(shared, key);
    }
  } catch {
    // Feedback is a refinement; a failure here must not affect Stop.
  }

  if (!harvestEnabled()) {
    // Say it once, name the reason and the variable that changes it, and state
    // what still works. A user who reads this should know exactly what they are
    // and are not getting, and what to do about it.
    const message = OFF_REASON[harvestMode()];
    // RETURNED, NOT WRITTEN. This used to write its own JSON to stdout and
    // race whatever the hook emitted; the adapter now folds this into the one
    // object it sends, so the notice cannot be dropped by a full pipe or
    // truncated by an exit -- which is what used to happen to the single line
    // explaining why no findings exist.
    if (message && !alreadyNotified(payload.session_id)) return message;
    return null;
  }

  // SIBLING IN THE SHARED CORE. The worker used to live beside the hook entry
  // in `plugin/hooks/`, which is why only Claude Code could ever have spawned
  // it -- it was vendored to no other client. It now sits in the core that
  // every client receives an identical copy of, so this resolves in all
  // eleven.
  const worker = join(HERE, 'harvest-worker.mjs');
  if (!existsSync(worker)) return null;

  // DEBOUNCE. Stop fires at the end of every assistant turn, so a talkative
  // session would spawn a model call per turn -- each re-reading an overlapping
  // transcript and re-extracting most of the same findings. The marker is
  // touched only when a harvest is actually started, so a skipped turn does not
  // push the next one further away.
  if (!dueForHarvest(payload.session_id)) return null;

  // Detached and fully released: the harvest must outlive this hook without
  // holding Stop open for a model round-trip.
  const child = spawn(
    process.execPath,
    [
      worker,
      transcript,
      String(payload.session_id || ''),
      String(payload.cwd || process.cwd()),
    ],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env },
    }
  );
  child.unref();
  return null;
}
