#!/usr/bin/env node
/**
 * `npx token-optimizer-install` -- wire the hooks when postinstall could not.
 *
 * npm 11 gates lifecycle scripts behind `allow-scripts`, so on a default global
 * install our postinstall NEVER RUNS and no hooks are wired. The package
 * installs, the server appears in /mcp, and nothing is optimized -- which is
 * precisely the "connected but saving nothing" failure this project exists to
 * prevent, arriving through the package manager instead of through the code.
 *
 * Relying on a lifecycle script that the ecosystem is actively disabling is not
 * a plan, so recovery is a first-class command rather than a buried shell
 * script: one line, no path archaeology, works the same on every platform.
 */

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const settings = process.env.TOKEN_OPTIMIZER_SETTINGS
  || join(homedir(), '.claude', 'settings.json');
const hooksDir = join(root, 'plugin', 'hooks');

const run = (script, args) => execFileSync(process.execPath, [join(root, 'scripts', script), ...args], {
  stdio: 'inherit', cwd: root,
});

try {
  run('wire-hooks.mjs', [settings, hooksDir]);
  run('record-install.mjs', [hooksDir, settings]);
  console.log('');
  console.log('Verify it actually works with: npx token-optimizer-doctor');
} catch (error) {
  console.error(`[token-optimizer-mcp] installation failed: ${error?.message || error}`);
  process.exit(1);
}
