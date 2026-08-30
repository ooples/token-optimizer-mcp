#!/usr/bin/env node
/**
 * Warm-launch shim for the token-optimizer MCP server.
 *
 * WHY THIS EXISTS. The plugin previously launched the server with
 * `npx -y @ooples/token-optimizer-mcp@latest`. That keeps the deliberate
 * "always @latest, no committed version" property (see scripts/pin-mcp-version.mjs
 * for why pinning was rejected), but it pays a per-launch cost that npx cannot
 * avoid: it re-resolves the `latest` dist-tag against the registry on EVERY start
 * (~2s) and, on a cold npm cache, downloads and verifies the tarball. Measured on
 * a healthy network:
 *
 *     cold  npx -y ...@latest  -> ~18s to first response   (blows the 30s MCP
 *                                                            connect budget on any
 *                                                            slower network -> the
 *                                                            CONNECT_TIMEOUT users hit)
 *     warm  npx -y ...@latest  -> ~6s   (npx env setup + registry round-trip floor)
 *     node  dist/server/index.js -> ~1.9s  (the server itself; no npx, no network)
 *
 * The server is not slow; the launch mechanism is. This shim keeps the always-latest
 * philosophy while removing the per-launch penalty:
 *
 *   - FAST PATH: if a usable server is already installed in the managed runtime,
 *     spawn it directly with `node` (offline, ~1.9s), then kick off a THROTTLED,
 *     DETACHED background refresh that installs a newer `latest` for the NEXT launch.
 *     So the running session never waits on the network, and the runtime converges
 *     to latest one launch behind — the standard "use cached, update in background"
 *     pattern (npm, VS Code, browsers all do this).
 *   - FIRST RUN / CORRUPT RUNTIME: no managed copy yet. If a copy is already in
 *     the npx cache (every user of the old npx-based config has one), serve THAT
 *     instantly and populate the managed runtime in the background — so even the
 *     first launch is fast. Only a truly cold machine (nothing cached anywhere)
 *     pays a one-time synchronous install before the first spawn.
 *
 * NO VERSION IS COMMITTED ANYWHERE. The shim always asks the registry for `latest`;
 * git carries no version, so nothing here can go stale (the exact property
 * pin-mcp-version.mjs preserves).
 *
 * CORRECTNESS NOTES (the traps this design avoids):
 *   - Version dirs are IMMUTABLE once built. A background refresh installs into a
 *     brand-new versions/<v> dir and only then flips the `current` pointer, so it
 *     never mutates files a running server may still be lazy-`require`-ing.
 *   - The `current` pointer is swapped atomically (write temp + rename).
 *   - A single-flight lock stops concurrent launches (multiple Claude sessions)
 *     from installing on top of each other.
 *   - Signals and exit code are forwarded to the child so Claude Code's MCP
 *     lifecycle (SIGTERM on shutdown, stdin-end) behaves exactly as before.
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  renameSync,
  rmSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Decoded absolute path to THIS file. Must use fileURLToPath, not
// `new URL(import.meta.url).pathname`, which leaves percent-encoding intact
// (e.g. a space becomes %20) and mishandles the Windows leading-slash — either
// would hand `node` a path that does not exist and silently break the refresh.
const THIS_FILE = fileURLToPath(import.meta.url);

const PACKAGE = '@ooples/token-optimizer-mcp';
const IS_WIN = process.platform === 'win32';
const NPM = IS_WIN ? 'npm.cmd' : 'npm';

// Where the managed runtime lives. Overridable for tests / non-standard homes.
const RUNTIME =
  process.env.TOKEN_OPTIMIZER_RUNTIME ||
  join(homedir(), '.token-optimizer', 'runtime');
const VERSIONS_DIR = join(RUNTIME, 'versions');
const CURRENT_FILE = join(RUNTIME, 'current');
const LOCK_DIR = join(RUNTIME, '.refresh.lock');
const ACTIVE_DIR = join(RUNTIME, 'active');
const LAST_REFRESH_FILE = join(RUNTIME, '.last-refresh');

// Don't hammer the registry on frequent restarts: only background-refresh if it
// has been at least this long since the last attempt. Default 6h; 0 disables the
// throttle (every launch refreshes); a very large value effectively pins to the
// installed copy until it is cleared.
const REFRESH_INTERVAL_MS = numericEnv(
  'TOKEN_OPTIMIZER_REFRESH_INTERVAL_MS',
  6 * 60 * 60 * 1000
);

/**
 * An exact version to serve, or '' for the normal @latest-tracking behaviour.
 *
 * Without this there is no way to say which build runs. `current` and the npx
 * cache decide, and the npx cache is not a property of the install at all: on a
 * cold runtime the shim serves whatever copy that cache happens to hold, so a
 * machine with 6.0.2 installed was observed serving 6.0.0 on first launch.
 * REFRESH_INTERVAL_MS could not prevent it -- that only throttles the
 * background refresh, it does not choose what is served now.
 *
 * When set, this is authoritative: the npx cache is only accepted if it is the
 * pinned version, no background refresh runs (a refresh exists to move off the
 * current version, which is precisely what a pin forbids), and a missing
 * pinned build is installed at that exact version rather than at latest.
 */
const PINNED_VERSION = String(
  process.env.TOKEN_OPTIMIZER_VERSION || ''
).trim();

/**
 * An exact release, as opposed to anything npm would resolve for us.
 *
 * Ranges (`^9.0.0`), dist-tags (`latest`, `next`) and aliases are all valid
 * `npm install` specs and all resolve to a version chosen by the registry --
 * which defeats a pin, because the value recorded would be the spec rather than
 * what actually installed. Prereleases and build metadata are allowed; a
 * leading `v` is not, so the value matches the directory name it becomes.
 */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function numericEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function log(msg) {
  // stderr only — stdout is the MCP JSON-RPC channel and must not be polluted.
  process.stderr.write(`[token-optimizer/launch] ${msg}\n`);
}

/** Block the current thread for ms without spawning a process. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Given an installed package directory, return { entry, version } if it holds a
 * usable server, else null. `entry` is the absolute path to spawn with node.
 */
function pkgInfo(pkgDir) {
  const pkgJson = join(pkgDir, 'package.json');
  if (!existsSync(pkgJson)) return null;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(pkgJson, 'utf8'));
  } catch {
    return null;
  }
  const rel =
    (manifest.bin && (manifest.bin['token-optimizer-mcp'] || manifest.bin)) ||
    manifest.main ||
    'dist/server/index.js';
  const entry = join(pkgDir, typeof rel === 'string' ? rel : 'dist/server/index.js');
  return existsSync(entry) ? { entry, version: manifest.version || 'unknown' } : null;
}

/** Absolute path to the server entry inside a managed version dir, or null. */
function entryFor(versionDir) {
  return pkgInfo(join(versionDir, 'node_modules', PACKAGE))?.entry ?? null;
}

/** Numeric-dotted version compare: 1 if a>b, -1 if a<b, 0 if equal. */
function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * Highest-version copy already sitting in npm's npx cache, or null.
 *
 * The old plugin config launched via `npx -y ...@latest`, so essentially every
 * existing user already has a published copy cached here — which lets the very
 * first launch under the shim be instant instead of paying a synchronous install.
 * Computed from the default/env cache path (no `npm` spawn); any layout surprise
 * is swallowed and we simply fall through to a synchronous install.
 */
function findCachedEntry(wantVersion = null) {
  const cacheRoot =
    process.env.npm_config_cache ||
    (IS_WIN
      ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'npm-cache')
      : join(homedir(), '.npm'));
  const npxDir = join(cacheRoot, '_npx');
  let best = null;
  try {
    for (const hash of readdirSync(npxDir)) {
      const info = pkgInfo(join(npxDir, hash, 'node_modules', PACKAGE));
      if (!info) continue;
      // A PIN ASKS A DIFFERENT QUESTION THAN "what is newest here".
      // Returning only the highest version meant a cache holding both 9.9.9 and
      // 10.0.0 answered a 9.9.9 pin with 10.0.0, which the caller then declined
      // -- so an offline launch failed with the requested build already on disk.
      if (wantVersion) {
        if (info.version === wantVersion) return info;
        continue;
      }
      if (!best || compareVersions(info.version, best.version) > 0) best = info;
    }
  } catch {
    /* no npx cache dir — fall through */
  }
  return wantVersion ? null : best;
}

/** Resolve the currently-pointed entry, validating it exists. */
function currentEntry() {
  if (!existsSync(CURRENT_FILE)) return null;
  let version;
  try {
    version = readFileSync(CURRENT_FILE, 'utf8').trim();
  } catch {
    return null;
  }
  if (!version) return null;
  return entryFor(join(VERSIONS_DIR, version));
}

function atomicWrite(file, contents) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, contents);
  renameSync(tmp, file);
}

/**
 * Install PACKAGE@latest into a fresh, immutable versions/<v> dir and return its
 * entry path — WITHOUT flipping `current`. Returns null on any failure (offline,
 * registry down, install error) so callers fall back to what they already have.
 */
function installLatest(spec = 'latest') {
  mkdirSync(VERSIONS_DIR, { recursive: true });
  const staging = join(
    RUNTIME,
    `.install-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(staging, { recursive: true });
  try {
    const res = spawnSync(
      NPM,
      [
        'install',
        `${PACKAGE}@${spec}`,
        '--prefix',
        staging,
        '--no-save',
        '--no-audit',
        '--no-fund',
        '--loglevel=error',
      ],
      {
        stdio: ['ignore', 'ignore', 'inherit'],
        // .cmd on Windows must go through a shell; args have no shell metachars.
        shell: IS_WIN,
        env: process.env,
      }
    );
    if (res.status !== 0) {
      log(`install failed (npm exit ${res.status ?? 'null'})`);
      safeRm(staging);
      return null;
    }
    const stagedEntry = entryFor(staging);
    if (!stagedEntry) {
      log('install produced no usable server entry');
      safeRm(staging);
      return null;
    }
    // Name the immutable version dir after the version we actually got.
    let version = 'unknown';
    try {
      version = JSON.parse(
        readFileSync(join(staging, 'node_modules', PACKAGE, 'package.json'), 'utf8')
      ).version;
    } catch {
      /* keep 'unknown' */
    }
    const versionDir = join(VERSIONS_DIR, version);
    if (existsSync(versionDir)) {
      // Another launch already produced this exact version — discard ours.
      safeRm(staging);
      return entryFor(versionDir);
    }
    renameSync(staging, versionDir);
    return entryFor(versionDir);
  } catch (err) {
    log(`install error: ${err?.message ?? err}`);
    safeRm(staging);
    return null;
  }
}

function safeRm(p) {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/**
 * Record that THIS shim is serving `version`, so a later refresh can see it.
 *
 * A RETENTION COUNT IS A GUESS; THIS IS THE ANSWER. Keeping the newest few
 * directories protects a session across one or two refreshes and then quietly
 * stops: on v1 -> v2 -> v3 the second refresh sees `prev` as v2, so the v1 a
 * server is still running from ages out and is deleted. Review caught that, and
 * it is the same defect as the original one, just delayed.
 *
 * Liveness is cheap after all -- `process.kill(pid, 0)` asks the OS whether a
 * pid exists, on every platform, without signalling it. The earlier comment
 * here claimed there was no such check; there is, and this uses it.
 */
function registerActiveVersion(version) {
  try {
    mkdirSync(ACTIVE_DIR, { recursive: true });
    // ATOMIC, because a reader runs concurrently. `writeFileSync` updates the
    // marker in place, so a refresh calling activeVersions() mid-write gets a
    // truncated file, fails to parse it, and DELETES it as corrupt -- and the
    // live shim only ever writes this once, so it never comes back. The
    // runtime it was protecting is then prunable for the rest of the session.
    // Review caught this. `atomicWrite` writes a temp file and renames, and a
    // rename is atomic.
    //
    // NOT COVERED BY A TEST, AND SAYING SO. Catching this would need a reader
    // to observe a half-written file, which is a genuine timing race and not
    // something a unit test can stage deterministically -- a mutation swapping
    // this back to writeFileSync survives the suite. What IS tested is the
    // consequence of the fix: the temp file this creates must not be mistaken
    // for a marker. The atomicity itself rests on rename being atomic.
    atomicWrite(
      join(ACTIVE_DIR, `${process.pid}.json`),
      JSON.stringify({ version, startedAt: Date.now() })
    );
  } catch {
    // Best effort. Failing to register costs retention, not correctness: the
    // version-count fallback still protects the common case.
  }
}

function unregisterActiveVersion() {
  safeRm(join(ACTIVE_DIR, `${process.pid}.json`));
}

/** True when a process with this pid exists (it is not signalled). */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else -- still alive.
    return err?.code === 'EPERM';
  }
}

/**
 * Versions that a live shim is currently serving.
 *
 * Also reaps its own stale markers, so a machine that has been rebooted or has
 * crashed sessions does not accumulate them forever. A marker is only trusted
 * for 30 days, which bounds the damage from pid reuse: a recycled pid could
 * otherwise pin a version indefinitely.
 */
function activeVersions() {
  const alive = new Set();
  const MAX_MARKER_AGE_MS = 30 * 24 * 60 * 60 * 1000;
  let names = [];
  try {
    names = readdirSync(ACTIVE_DIR);
  } catch {
    return alive;
  }
  for (const name of names) {
    const file = join(ACTIVE_DIR, name);

    // ONLY `<pid>.json` IS A MARKER. `atomicWrite` lands a `<pid>.json.tmp-...`
    // file in this same directory for an instant, and `Number.parseInt` reads
    // leading digits happily -- so a temp file would otherwise be treated as a
    // marker for that pid, and deleting it as unparseable would race the
    // rename that is about to consume it. A temp left behind by a crashed
    // write is swept once it is older than any marker would be trusted.
    if (!/^\d+\.json$/.test(name)) {
      try {
        if (Date.now() - statSync(file).mtimeMs > MAX_MARKER_AGE_MS) safeRm(file);
      } catch {
        /* vanished under us, which is the outcome we wanted anyway */
      }
      continue;
    }

    const pid = Number.parseInt(name, 10);
    let record;
    try {
      record = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      safeRm(file);
      continue;
    }
    const tooOld =
      !Number.isFinite(record?.startedAt) ||
      Date.now() - record.startedAt > MAX_MARKER_AGE_MS;
    if (!Number.isFinite(pid) || tooOld || !pidAlive(pid)) {
      safeRm(file);
      continue;
    }
    if (record?.version) alive.add(record.version);
  }
  return alive;
}

/** Best-effort single-flight lock via mkdir (atomic on all platforms). */
function acquireLock() {
  try {
    mkdirSync(LOCK_DIR); // throws if it already exists
    return true;
  } catch {
    // Stale-lock recovery: if the lock is older than 10 min, steal it.
    try {
      if (Date.now() - statSync(LOCK_DIR).mtimeMs > 10 * 60 * 1000) {
        safeRm(LOCK_DIR);
        mkdirSync(LOCK_DIR);
        return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  }
}

function releaseLock() {
  safeRm(LOCK_DIR);
}

/**
 * How many version directories survive a prune, newest first.
 *
 * NOT ONE, WHICH IS WHAT IT USED TO BE. The header of this file promises that a
 * refresh "never mutates files a running server may still be lazy-require-ing",
 * and then this function deleted every directory except the newest -- including
 * the one a server is executing from right now. Deleting is the most extreme
 * mutation available, so the invariant was being broken by the very code that
 * documented it.
 *
 * The damage is invisible for almost everything. A running server has already
 * imported its eager modules, and those stay in memory, so the server keeps
 * answering normally. Only a path resolved at CALL time notices -- and the wiki
 * tools resolve one, importing hooks-core lazily through `coreUrl()`. Observed
 * 2026-08-28: a session that outlived one refresh got
 * `Cannot find module ...\\versions\\6.0.0\\...\\hooks-core\\wiki.mjs` from
 * every wiki_write call for the rest of the session, while every other tool
 * carried on fine. The whole knowledge-capture feature was dead and nothing
 * else looked wrong.
 *
 * The refresh interval is six hours, so an ordinary working session routinely
 * outlives one. Keeping three versions buys roughly eighteen hours of grace for
 * a few tens of megabytes of disk. It is a retention count rather than a
 * liveness check because there is no reliable, cheap way to ask "is a process
 * still running from this directory" across platforms -- and guessing wrong in
 * that direction deletes a live runtime again.
 *
 * A FLOOR OF TWO, NOT ONE. Retaining a single directory is never a coherent
 * setting here: a refresh prunes with the version it just INSTALLED, so keeping
 * exactly one deletes the version the live session is running from and puts the
 * original defect straight back. Review caught this -- the first cut floored at
 * one, and a test asserted that behaviour as if it were correct.
 */
const VERSIONS_TO_KEEP = Math.max(
  2,
  Math.floor(numericEnv('TOKEN_OPTIMIZER_RUNTIME_KEEP', 3))
);

/**
 * Delete stale version directories.
 *
 * `keepVersion` is what the next launch will use; `alsoKeep` is the version the
 * pointer named BEFORE this refresh, which is what any live session is still
 * executing from. Both are retained by NAME rather than left to the mtime
 * ordering, because those are the two that must survive and neither is
 * guaranteed to sort newest -- a reinstall can freshen an unrelated directory's
 * timestamp.
 *
 * Exported for tests; see VERSIONS_TO_KEEP for why it is not just "keep one".
 */
export function pruneOldVersions(keepVersion, alsoKeep = null) {
  try {
    const dirs = readdirSync(VERSIONS_DIR).map((name) => {
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(join(VERSIONS_DIR, name)).mtimeMs;
      } catch {
        // Vanished from under us, or unreadable. Sorting it oldest is safe:
        // the worst case is that we decline to keep a directory we could not
        // even stat.
      }
      return { name, mtimeMs };
    });

    const present = new Set(dirs.map((entry) => entry.name));

    // ONLY NAMES THAT EXIST COUNT TOWARD RETENTION. `keep` used to take
    // `keepVersion` and `alsoKeep` unconditionally, so a stale `current`
    // pointer naming a directory that is not there consumed a retention slot
    // and the cleanup could then strip everything else. Review caught it.
    const keep = new Set();
    const reserve = (name) => {
      if (name && present.has(name)) keep.add(name);
    };

    // Every runtime a live shim is serving, first: this is the whole point.
    for (const version of activeVersions()) reserve(version);

    // Then the one the next launch will use, and the one the pointer named
    // before this refresh -- by name, since neither is guaranteed to sort
    // newest once a reinstall has freshened another directory's timestamp.
    reserve(keepVersion);
    reserve(alsoKeep);

    for (const { name } of [...dirs].sort((a, b) => b.mtimeMs - a.mtimeMs)) {
      if (keep.size >= VERSIONS_TO_KEEP) break;
      keep.add(name);
    }

    for (const { name } of dirs) {
      if (!keep.has(name)) safeRm(join(VERSIONS_DIR, name));
    }
  } catch {
    /* ignore */
  }
}

/** --refresh: install latest for NEXT launch, flip pointer, prune. */
function runRefresh() {
  if (!acquireLock()) return; // another refresh is in flight
  try {
    atomicWrite(LAST_REFRESH_FILE, String(Date.now()));
    const entry = installLatest();
    if (!entry) return; // offline or failed — keep the current pointer as-is
    // entry === <VERSIONS_DIR>/<version>/node_modules/...; recover <version>.
    const version = entry
      .slice(VERSIONS_DIR.length + 1)
      .split(/[\\/]/)[0];
    const prev = existsSync(CURRENT_FILE)
      ? readFileSync(CURRENT_FILE, 'utf8').trim()
      : null;
    if (version !== prev) {
      atomicWrite(CURRENT_FILE, version);
      log(`refreshed runtime -> ${version} (was ${prev ?? 'none'})`);
    }
    // `prev` is what a live session is still running from, so it is named
    // explicitly rather than trusted to be among the newest by mtime.
    pruneOldVersions(version, prev);
  } finally {
    releaseLock();
  }
}

function refreshDueNow() {
  if (REFRESH_INTERVAL_MS === 0) return true;
  try {
    const last = Number(readFileSync(LAST_REFRESH_FILE, 'utf8').trim());
    if (Number.isFinite(last)) return Date.now() - last >= REFRESH_INTERVAL_MS;
  } catch {
    /* no record yet */
  }
  return true;
}

/** Fire a detached background refresh that outlives this process. */
function spawnBackgroundRefresh() {
  if (!refreshDueNow()) return;
  try {
    const child = spawn(process.execPath, [THIS_FILE, '--refresh'], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
  } catch (err) {
    log(`could not start background refresh: ${err?.message ?? err}`);
  }
}

/** Spawn the server, forwarding stdio, signals, and exit code. */
function runServer(entry) {
  // Announce which runtime this shim is serving BEFORE the server starts, so a
  // refresh that fires immediately afterwards can already see it.
  const served = entry.startsWith(VERSIONS_DIR)
    ? entry.slice(VERSIONS_DIR.length + 1).split(/[\\/]/)[0]
    : null;
  if (served) {
    registerActiveVersion(served);
    process.on('exit', unregisterActiveVersion);
  }

  const child = spawn(process.execPath, [entry], {
    stdio: 'inherit',
    env: process.env,
  });
  const forward = (sig) => {
    try {
      child.kill(sig);
    } catch {
      /* child already gone */
    }
  };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));
  process.on('SIGHUP', () => forward('SIGHUP'));
  child.on('exit', (code, signal) => {
    if (signal) {
      // Re-raise so our exit reflects the child's signal death.
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 0);
    }
  });
  child.on('error', (err) => {
    log(`failed to spawn server: ${err?.message ?? err}`);
    process.exit(1);
  });
}

/**
 * Installs exactly PINNED_VERSION and returns its entry, or null.
 *
 * VERIFIES WHAT ARRIVED rather than trusting the spec: npm can resolve a spec
 * to a different manifest version, and writing PINNED_VERSION into `current`
 * without checking would make the marker claim a version that is not what sits
 * in the directory. The caller must hold the lock.
 */
function installPinnedVersion() {
  const entry = installLatest(PINNED_VERSION);
  if (!entry) return null;

  const installed = pkgInfo(
    join(VERSIONS_DIR, PINNED_VERSION, 'node_modules', PACKAGE)
  );
  if (installed?.version !== PINNED_VERSION) {
    log(
      `install of ${PACKAGE}@${PINNED_VERSION} produced version ` +
        `${installed?.version ?? 'unknown'}; refusing to serve it`
    );
    return null;
  }

  atomicWrite(CURRENT_FILE, PINNED_VERSION);
  return entry;
}

function main() {
  // Ensure the runtime dir exists BEFORE anything else — runRefresh's lock is a
  // mkdir of RUNTIME/.refresh.lock, which fails (and silently no-ops the refresh)
  // if RUNTIME does not exist yet. This matters for a standalone/cron `--refresh`
  // on a cold machine, where nothing else has created RUNTIME first.
  mkdirSync(RUNTIME, { recursive: true });

  if (process.argv.includes('--refresh')) {
    runRefresh();
    return;
  }

  // A PIN SHORT-CIRCUITS EVERY OTHER SOURCE. Deliberately ahead of `current`
  // and of the npx cache, because both of those are exactly what a pin exists
  // to overrule, and no background refresh is started: a refresh's job is to
  // move off the version being served, which is what the pin forbids.
  if (PINNED_VERSION) {
    let pinned = entryFor(join(VERSIONS_DIR, PINNED_VERSION));

    if (!pinned) {
      // The npx cache is acceptable only when it happens to hold the pinned
      // version. Serving its newest copy is the unpinned behaviour, and is the
      // bug this branch exists to prevent.
      const cached = findCachedEntry(PINNED_VERSION);
      if (cached) pinned = cached.entry;
    }

    // A PIN MUST BE AN EXACT VERSION, checked before anything is installed.
    // `npm install <pkg>@<spec>` also accepts ranges, dist-tags and aliases,
    // and those resolve to whatever the registry decides -- so `^9.0.0` or
    // `latest` would install one version while this code recorded the spec
    // string as though it were the version. A pin whose value cannot be
    // verified afterwards is not a pin.
    if (!EXACT_VERSION.test(PINNED_VERSION)) {
      log(
        `TOKEN_OPTIMIZER_VERSION must be an exact version like 6.0.2, ` +
          `not a range, dist-tag or alias (got "${PINNED_VERSION}"). ` +
          `Unset it to track latest.`
      );
      process.exit(1);
    }

    if (!pinned) {
      log(`pinned to ${PINNED_VERSION}; installing that exact version…`);

      // RETRY THE LOCK, do not merely wait for the directory. The lock is
      // shared with `runRefresh()`, which installs `latest` rather than this
      // pin -- so a launch that only watched VERSIONS_DIR would sit through its
      // entire budget and exit, even though the lock became free seconds in and
      // the refresh was never going to produce the pinned version. Each pass
      // therefore tries the lock first, and also notices a directory that
      // another pinned launch may have produced in the meantime.
      for (let i = 0; i < 120 && !pinned; i++) {
        if (acquireLock()) {
          try {
            pinned = installPinnedVersion();
          } finally {
            releaseLock();
          }
          break; // we held the lock and attempted the install; that is the answer
        }
        pinned = entryFor(join(VERSIONS_DIR, PINNED_VERSION));
        if (pinned) break;
        sleepSync(500);
      }
    }

    if (!pinned) {
      // FAIL LOUDLY RATHER THAN FALLING BACK. Someone who pinned a version and
      // silently got a different one is worse off than someone who got an
      // error: the whole point of the pin is knowing what ran.
      log(
        `could not obtain pinned version ${PINNED_VERSION}. ` +
          `Unset TOKEN_OPTIMIZER_VERSION to track latest, or install it once: ` +
          `npx -y ${PACKAGE}@${PINNED_VERSION}`
      );
      process.exit(1);
    }

    runServer(pinned);
    return;
  }

  let entry = currentEntry();
  if (entry) {
    // Fast path: serve immediately from the managed runtime, update in background.
    spawnBackgroundRefresh();
    runServer(entry);
    return;
  }

  // First run (or wiped/corrupt runtime): if a copy already exists in the npx
  // cache — which every user of the old npx-based config has — serve it instantly
  // and populate the managed runtime in the background. @latest freshness is kept:
  // the background refresh installs latest for the next launch. This is the ONLY
  // thing standing between a brand-new install and a fast first start.
  const cached = findCachedEntry();
  if (cached) {
    log(
      `first run: serving npx-cached ${cached.version}; ` +
        'populating managed runtime in the background'
    );
    spawnBackgroundRefresh();
    runServer(cached.entry);
    return;
  }

  // Truly cold (nothing cached anywhere): install synchronously, then serve.
  log('no cached server; installing latest (one-time)…');
  if (acquireLock()) {
    try {
      atomicWrite(LAST_REFRESH_FILE, String(Date.now()));
      entry = installLatest();
      if (entry) {
        const version = entry.slice(VERSIONS_DIR.length + 1).split(/[\\/]/)[0];
        atomicWrite(CURRENT_FILE, version);
      }
    } finally {
      releaseLock();
    }
  } else {
    // Someone else is installing; wait briefly for them to publish `current`.
    for (let i = 0; i < 120 && !entry; i++) {
      sleepSync(500);
      entry = currentEntry();
    }
  }

  if (!entry) {
    log(
      'could not obtain a server (offline with an empty cache?). ' +
        `Try once: npx -y ${PACKAGE}@latest`
    );
    process.exit(1);
  }
  runServer(entry);
}

// IMPORTABLE FOR TESTS, AND DELIBERATELY FAIL-OPEN. Anything other than an
// explicit opt-out still calls main(), so if this check is ever wrong the shim
// launches a server anyway. The alternative -- detecting whether this file is
// the entry point -- fails in the other direction: one bad comparison and the
// launcher silently does nothing, which means no MCP server at all.
if (process.env.TOKEN_OPTIMIZER_LAUNCH_IMPORT_ONLY !== '1') {
  main();
}
