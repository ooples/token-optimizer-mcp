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
const LAST_REFRESH_FILE = join(RUNTIME, '.last-refresh');

// Don't hammer the registry on frequent restarts: only background-refresh if it
// has been at least this long since the last attempt. Default 6h; 0 disables the
// throttle (every launch refreshes); a very large value effectively pins to the
// installed copy until it is cleared.
const REFRESH_INTERVAL_MS = numericEnv(
  'TOKEN_OPTIMIZER_REFRESH_INTERVAL_MS',
  6 * 60 * 60 * 1000
);

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
function findCachedEntry() {
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
      if (info && (!best || compareVersions(info.version, best.version) > 0)) {
        best = info;
      }
    }
  } catch {
    /* no npx cache dir — fall through */
  }
  return best;
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
function installLatest() {
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
        `${PACKAGE}@latest`,
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

function pruneOldVersions(keepVersion) {
  try {
    for (const name of readdirSync(VERSIONS_DIR)) {
      if (name !== keepVersion) safeRm(join(VERSIONS_DIR, name));
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
    pruneOldVersions(version);
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
    const child = spawn(process.execPath, [fileURL(), '--refresh'], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
  } catch (err) {
    log(`could not start background refresh: ${err?.message ?? err}`);
  }
}

function fileURL() {
  return new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
}

/** Spawn the server, forwarding stdio, signals, and exit code. */
function runServer(entry) {
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

function main() {
  if (process.argv.includes('--refresh')) {
    runRefresh();
    return;
  }

  mkdirSync(RUNTIME, { recursive: true });

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

main();
