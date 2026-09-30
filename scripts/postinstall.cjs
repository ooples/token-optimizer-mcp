#!/usr/bin/env node

/**
 * INSTALLING A PACKAGE MUST NOT CHANGE A MACHINE.
 *
 * This script used to run the full installer on any global install, which wrote
 * a hooks block into the user's real ~/.claude/settings.json. Those hooks match
 * nearly every tool call, so they took effect in every Claude Code session on
 * the machine, in every project -- including sessions already running, which is
 * how issue #449 was found: `npm install -g` alone started rewriting an
 * unrelated session's tool output. A plain install is something people run to
 * try a package out or read its source, and it is not consent to edit the
 * configuration of another application.
 *
 * So the only thing that activates anything is an explicit request:
 *
 *     token-optimizer-install                  a person asking, by name
 *     TOKEN_OPTIMIZER_AUTO_INSTALL=1 npm i -g  a provisioning script asking
 *
 * Without one of those this script prints what activation would do, where it
 * would write, how to undo it, and exits. Nothing is created, nothing is
 * edited. The installer it defers to is the same one either path runs, so there
 * is no second code path to keep in step.
 */
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

const enabled = (value) => /^(1|true|yes)$/i.test(value || '');
const root = path.resolve(__dirname, '..');

// The same expression install-cli.mjs uses, so the notice names the file that
// would really be written rather than a guess at the default location.
const settings =
  process.env.TOKEN_OPTIMIZER_SETTINGS ||
  path.join(
    process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
    'settings.json'
  );

if (enabled(process.env.TOKEN_OPTIMIZER_AUTO_INSTALL)) {
  try {
    execFileSync(
      process.execPath,
      [path.join(root, 'scripts', 'install-cli.mjs')],
      { stdio: 'inherit', cwd: root, windowsHide: true }
    );
    console.log(
      '[token-optimizer-mcp] Hooks and managed CLI commands installed at your request'
    );
    console.log(
      '[token-optimizer-mcp] (TOKEN_OPTIMIZER_AUTO_INSTALL). Open a new shell to activate them.'
    );
  } catch (error) {
    // An optional integration failure must not make the MCP package unusable.
    console.warn('[token-optimizer-mcp] Requested setup failed:', error.message);
    console.warn(
      '[token-optimizer-mcp] Run token-optimizer-install to retry setup.'
    );
  }
} else if (enabled(process.env.npm_config_global)) {
  console.log('');
  console.log(
    '[token-optimizer-mcp] Installed. Nothing on your machine has been changed yet.'
  );
  console.log('');
  console.log('  To activate, run:');
  console.log('      token-optimizer-install');
  console.log('');
  console.log('  That will add hooks to:');
  console.log(`      ${settings}`);
  console.log('  and managed commands to your shell profile.');
  console.log('  Undo at any time with:  token-optimizer-uninstall');
  console.log('');
  console.log(
    '  To activate automatically in an image or provisioning script, set'
  );
  console.log('  TOKEN_OPTIMIZER_AUTO_INSTALL=1 before installing.');
  console.log('');
} else {
  // A project-local install is already scoped to that project, and nobody
  // expects `npm i` in one repository to reconfigure every session on the box.
  console.log(
    '[token-optimizer-mcp] Local install: nothing outside this project was changed.'
  );
  console.log(
    '[token-optimizer-mcp] Run token-optimizer-install to wire hooks and managed CLI commands.'
  );
}