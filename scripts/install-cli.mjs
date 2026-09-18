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
import { launcherCommands } from './managed-clients.mjs';
import { repairCodexStartup } from './codex-startup.mjs';
import { maintainDefaultRouting } from '../dist/proxy/default-routing.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const settings =
  process.env.TOKEN_OPTIMIZER_SETTINGS ||
  join(homedir(), '.claude', 'settings.json');
const hooksDir = join(root, 'plugin', 'hooks');

const run = (script, args) =>
  execFileSync(process.execPath, [join(root, 'scripts', script), ...args], {
    stdio: 'inherit',
    cwd: root,
  });

try {
  if (
    !process.env.TOKEN_OPTIMIZER_SETTINGS &&
    !process.env.TOKEN_OPTIMIZER_SHELL_PROFILES
  ) {
    const config = join(
      process.env.CODEX_HOME || join(homedir(), '.codex'),
      'config.toml'
    );
    if (repairCodexStartup(config))
      console.log('Codex MCP startup timeout set to 60 seconds.');
  }
  run('wire-hooks.mjs', [settings, hooksDir]);
  run('record-install.mjs', [hooksDir, settings]);
  if (
    !/^(0|false|no|off)$/i.test(
      process.env.TOKEN_OPTIMIZER_MANAGED_CLIENTS?.trim() || ''
    )
  ) {
    // Which clients these cover is decided per machine, so the messages name what was actually
    // wrapped rather than a fixed three that may be none of the ones installed here.
    const clients = launcherCommands();
    const profiles = activateShells({ clients });
    const commands = activateWindowsCommands({ root, clients });
    for (const command of commands)
      console.log(`Managed Windows command activation: ${command}`);
    if (commands.length)
      console.log(
        'Reopen your terminal to load the updated User PATH for Command Prompt and PowerShell.'
      );
    for (const profile of profiles)
      console.log(`Managed activation for ${clients.join(', ')}: ${profile}`);
    if (profiles.length)
      console.log(
        `Open a new PowerShell, Bash, or Zsh session to activate the normal ${clients.join('/')} commands.`
      );
    if (!clients.length)
      console.log(
        'No supported client CLI was found on PATH, so no command was wrapped. Install one and re-run this command, or set TOKEN_OPTIMIZER_MANAGED_CLIENTS to name them.'
      );
  }
  // Compression for a client we did not launch. Only ever written once the proxy has really served
  // the route, so an installation can never leave a settings file naming a dead port.
  const routing = await maintainDefaultRouting();
  if (routing.status === 'written')
    console.log(
      `Claude Code is now routed through the local compression proxy (${routing.path}).`
    );
  if (routing.status === 'foreign-proxy')
    console.log(
      'Claude Code is already pointed at another local proxy, so it was left unchanged.'
    );
  if (routing.status === 'unavailable')
    console.log(
      'The local compression proxy could not be started, so Claude Code was left unchanged.'
    );

  console.log('');
  console.log('Verify it actually works with: npx token-optimizer-doctor');
} catch (error) {
  console.error(
    `[token-optimizer-mcp] installation failed: ${error?.message || error}`
  );
  process.exit(1);
}
