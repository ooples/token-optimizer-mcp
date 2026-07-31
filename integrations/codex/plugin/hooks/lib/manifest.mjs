// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/manifest.mjs. Regenerate with `npm run sync:hooks`.
/**
 * A record of everything we put on your machine.
 *
 * We ask people to install hooks that DENY their tool calls. That is a larger
 * ask than a normal dependency makes, and it deserves a larger answer than
 * "trust us": an exact list of every file written and every config entry added,
 * with hashes, so "what did this do to my machine" has an answer rather than a
 * promise -- and so removal can be exact rather than best-effort.
 *
 * THE HASHES ARE WHAT MAKE UNINSTALL SAFE. Recording that we added a hook entry
 * is not enough, because the user may have edited it since. Removing an entry
 * somebody has customised is destroying their work; leaving it silently is
 * leaving a landmine. Recording what we WROTE lets uninstall tell the two apart
 * and say which it did.
 *
 * Release verification lives elsewhere and is stronger than a manifest can be:
 * the package is published with npm provenance, so `npm audit signatures` ties
 * the artifact to the CI run and the commit that built it without trusting us
 * at all. A CHECKSUMS.sha256 file accompanies each release for offline checking.
 * This file answers the different question of what happened locally.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export const MANIFEST_VERSION = 1;

/** Where the record of this installation lives. */
export function manifestPath() {
  return process.env.TOKEN_OPTIMIZER_MANIFEST
    || join(homedir(), '.claude-global', 'token-optimizer-install.json');
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** The hash of a file as it stands on disk, or null if it is not there. */
export function fileHash(path) {
  try {
    return sha256(readFileSync(path));
  } catch {
    return null;
  }
}

/**
 * Records an installation.
 *
 * @param files    Paths we wrote, hashed as written.
 * @param entries  Config additions: { file, path, description }.
 */
export function writeManifest({ files = [], entries = [], version = null } = {}, target = manifestPath()) {
  const manifest = {
    manifestVersion: MANIFEST_VERSION,
    packageVersion: version,
    installedAt: Date.now(),
    files: files.map((path) => ({ path, sha256: fileHash(path) })).filter((f) => f.sha256),
    entries,
  };

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}

/** The recorded installation, or null when there is no record of one. */
export function readManifest(target = manifestPath()) {
  try {
    const parsed = JSON.parse(readFileSync(target, 'utf8'));
    return parsed?.manifestVersion === MANIFEST_VERSION ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Compares the manifest against what is actually on disk.
 *
 * Three states per file, and they need different treatment: `intact` is ours to
 * remove, `modified` is now partly the user's and must not be removed silently,
 * `missing` is already gone.
 */
export function verifyManifest(manifest = readManifest()) {
  if (!manifest) return null;

  const files = manifest.files.map((entry) => {
    const now = fileHash(entry.path);
    return {
      ...entry,
      state: now === null ? 'missing' : now === entry.sha256 ? 'intact' : 'modified',
    };
  });

  return {
    files,
    intact: files.filter((f) => f.state === 'intact').length,
    modified: files.filter((f) => f.state === 'modified').length,
    missing: files.filter((f) => f.state === 'missing').length,
    entries: manifest.entries || [],
    installedAt: manifest.installedAt,
    packageVersion: manifest.packageVersion,
  };
}

/**
 * What an uninstall would do, without doing any of it.
 *
 * A dry run is the honest default for a destructive operation on somebody
 * else's machine: the plan is inspectable before it runs, and the parts it
 * refuses to touch are named rather than skipped quietly.
 */
export function removalPlan(manifest = readManifest()) {
  const verified = verifyManifest(manifest);
  if (!verified) return null;

  const remove = verified.files.filter((f) => f.state === 'intact').map((f) => f.path);
  const keep = verified.files
    .filter((f) => f.state === 'modified')
    .map((f) => ({ path: f.path, why: 'edited after we wrote it -- removing it would destroy your changes' }));
  const gone = verified.files.filter((f) => f.state === 'missing').map((f) => f.path);

  return {
    remove,
    keep,
    gone,
    entries: verified.entries,
    // Everything not in this manifest is, by construction, not ours.
    untouched: 'anything not listed here was not installed by us and is not touched',
  };
}

/**
 * Removes only what the manifest says is ours and unmodified.
 *
 * `apply` defaults to false. Deleting files on somebody's machine is the last
 * place to assume consent from the fact that a function was called.
 */
export function uninstall({ apply = false, manifest = readManifest(), rm = null } = {}) {
  const plan = removalPlan(manifest);
  if (!plan) return { removed: [], kept: [], applied: false, reason: 'no installation record found' };

  if (!apply) return { ...plan, applied: false, reason: 'dry run -- nothing was changed' };

  const removed = [];
  const failed = [];
  // Statically imported, not require()'d. This is an ES module, so `require` is
  // not defined -- the lazy version threw on every file and reported the whole
  // removal as failures, which meant `--apply` quietly removed nothing at all.
  const remove = rm || ((path) => unlinkSync(path));

  for (const path of plan.remove) {
    try {
      remove(path);
      removed.push(path);
    } catch (error) {
      failed.push({ path, error: String(error?.message || error) });
    }
  }

  return { ...plan, removed, failed, applied: true };
}

/**
 * Config entries in a settings file that are ours.
 *
 * Identified by the command they run rather than by position, because an entry
 * that has moved in the array is still ours and an entry someone else added at
 * our old index is not.
 */
export function ourEntries(settings, marker = 'token-optimizer') {
  const found = [];
  const walk = (node, path) => {
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${path}[${i}]`));
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'string' && value.includes(marker)) {
        found.push({ path: `${path}.${key}`, value });
        continue;
      }
      walk(value, `${path}.${key}`);
    }
  };
  walk(settings, '');
  return found;
}

/** Whether a settings file still contains anything of ours. */
export function residue(settingsPath, marker = 'token-optimizer') {
  if (!existsSync(settingsPath)) return { clean: true, entries: [] };
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const entries = ourEntries(settings, marker);
    return { clean: entries.length === 0, entries };
  } catch {
    // An unparseable settings file is not evidence of cleanliness.
    return { clean: false, entries: [], reason: 'settings file could not be parsed' };
  }
}

/** File size, for reporting what a manifest covers. */
export function manifestSize(manifest = readManifest()) {
  if (!manifest) return 0;
  return manifest.files.reduce((sum, f) => {
    try {
      return sum + statSync(f.path).size;
    } catch {
      return sum;
    }
  }, 0);
}
