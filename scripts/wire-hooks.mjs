#!/usr/bin/env node
/**
 * Wires (or unwires) our hooks in a settings file, preserving everything else.
 *
 * Called by install-hooks.sh and install-hooks.ps1 instead of the shell writing
 * JSON itself. The old approach overwrote the whole settings file when `jq` was
 * missing and replaced the whole `hooks` object when it was present -- either
 * way destroying every hook the user had. One tested implementation, called by
 * both installers, is how that stops being possible.
 *
 *     node scripts/wire-hooks.mjs <settingsFile> <hooksDir> [--remove] [--dry-run]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { wire, unwire, wirePlan, wiredEntries } from '../hooks-core/wire.mjs';

const [settingsPath, hooksDir] = process.argv.slice(2);
const remove = process.argv.includes('--remove');
const dryRun = process.argv.includes('--dry-run');

if (!settingsPath || (!hooksDir && !remove)) {
  console.error('usage: wire-hooks.mjs <settingsFile> <hooksDir> [--remove] [--dry-run]');
  process.exit(2);
}

let settings = {};
if (existsSync(settingsPath)) {
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch (error) {
    // Refuse rather than clobber. A settings file we cannot parse is one we
    // certainly did not write, and replacing it would destroy work.
    console.error(`[token-optimizer-mcp] ${settingsPath} is not valid JSON, so it will not be modified.`);
    console.error(`[token-optimizer-mcp] ${String(error.message)}`);
    process.exit(1);
  }
}

const plan = remove ? null : wirePlan(settings, hooksDir);
const next = remove ? unwire(settings) : wire(settings, hooksDir);

if (dryRun) {
  console.log(remove
    ? `[token-optimizer-mcp] would remove ${wiredEntries(settings).length} entry/entries, leaving everything else`
    : `[token-optimizer-mcp] would wire ${plan.events.join(', ')}; ` +
      `replacing ${plan.replacing} of ours, preserving ${plan.preserving} of yours`);
  process.exit(0);
}

if (existsSync(settingsPath)) {
  const backup = `${settingsPath}.backup`;
  try {
    copyFileSync(settingsPath, backup);
  } catch { /* a failed backup is not a reason to refuse a reversible change */ }
}

mkdirSync(dirname(settingsPath), { recursive: true });
writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`);

console.log(remove
  ? `[token-optimizer-mcp] removed our hook entries from ${settingsPath}; your other hooks were left alone`
  : `[token-optimizer-mcp] wired ${plan.events.join(', ')} into ${settingsPath}; ` +
    `${plan.preserving} existing hook entry/entries preserved`);
