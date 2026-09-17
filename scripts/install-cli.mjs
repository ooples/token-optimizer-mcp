#!/usr/bin/env node
/**
 * `npx token-optimizer-install` -- wire the hooks when postinstall could not.
 *
 * Package-manager policy can disable lifecycle scripts. In that case the
 * package installs without wiring hooks or managed CLI commands. This command
 * provides an explicit setup path independent of lifecycle policy.
 *
 * Relying on a lifecycle script that the ecosystem is actively disabling is not
 * a plan, so recovery is a first-class command rather than a buried shell
 * script: one line, no path archaeology, works the same on every platform.
 */

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { activateShells } from './managed-shell.mjs';
import { activateWindowsCommands } from './windows-commands.mjs';
import { repairCodexStartup } from './codex-startup.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const settings = process.env.TOKEN_OPTIMIZER_SETTINGS
  || join(homedir(), '.claude', 'settings.json');
const hooksDir = join(root, 'plugin', 'hooks');

const run = (script, args) => execFileSync(process.execPath, [join(root, 'scripts', script), ...args], {
  stdio: 'inherit', cwd: root,
});

try {
  if (!process.env.TOKEN_OPTIMIZER_SETTINGS && !process.env.TOKEN_OPTIMIZER_SHELL_PROFILES) {
    const config = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml');
    if (repairCodexStartup(config)) console.log('Codex MCP startup timeout set to 60 seconds.');
  }
  run('wire-hooks.mjs', [settings, hooksDir]);
  run('record-install.mjs', [hooksDir, settings]);
  if (!/^(0|false|no|off)$/i.test(process.env.TOKEN_OPTIMIZER_MANAGED_CLIENTS?.trim() || '')) {
    const profiles = activateShells();
    const commands = activateWindowsCommands({ root });
    for (const command of commands) console.log(`Managed Windows command activation: ${command}`);
    if (commands.length) console.log('Reopen your terminal to load the updated User PATH for Command Prompt and PowerShell.');
    for (const profile of profiles) console.log(`Managed Claude Code, Codex, and OpenCode activation: ${profile}`);
    if (profiles.length) console.log('Open a new PowerShell, Bash, or Zsh session to activate normal claude/codex/opencode commands.');
  }
  console.log('');
  console.log('Verify it actually works with: npx token-optimizer-doctor');
} catch (error) {
  console.error(`[token-optimizer-mcp] installation failed: ${error?.message || error}`);
  process.exit(1);
}
