#!/usr/bin/env node
/**
 * Writes the install manifest, at the end of an installation.
 *
 * Called by install-hooks.sh / install-hooks.ps1 once the files are in place.
 * Without this the manifest half of the trust story is a promise: uninstall has
 * nothing to be exact about, and "what did this put on my machine" has no
 * answer. Hashing here, rather than in shell, keeps one implementation of the
 * hashing rather than three that can disagree.
 *
 *     node scripts/record-install.mjs <hooksDir> [settingsFile]
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeManifest, manifestPath, ourEntries } from '../hooks-core/manifest.mjs';

const hooksDir = process.argv[2];
const settingsFile = process.argv[3];

if (!hooksDir) {
  console.error('usage: record-install.mjs <hooksDir> [settingsFile]');
  process.exit(2);
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}

const files = [...walk(hooksDir)];

// Config entries are recorded by what they are, not removed automatically: we
// never rewrite somebody's settings file, so uninstall names them for the user
// to remove rather than editing around whatever else is in there.
const entries = [];
if (settingsFile) {
  try {
    const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
    for (const found of ourEntries(settings)) {
      entries.push({ file: settingsFile, path: found.path, description: 'hook command we added' });
    }
  } catch {
    // A settings file we cannot parse is one we certainly did not write.
  }
}

let version = null;
try {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
} catch { /* version is a nicety, not a requirement */ }

const manifest = writeManifest({ files, entries, version });
const bytes = files.reduce((sum, f) => {
  try { return sum + statSync(f).size; } catch { return sum; }
}, 0);

console.log(`[token-optimizer-mcp] recorded ${manifest.files.length} file(s), ` +
  `${entries.length} config entry/entries, ${Math.round(bytes / 1024)} KB -> ${manifestPath()}`);
console.log('[token-optimizer-mcp] remove it all with: npm run uninstall-hooks -- --apply');
