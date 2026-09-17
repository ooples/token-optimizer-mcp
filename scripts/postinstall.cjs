#!/usr/bin/env node

/** Activate global installs using the same non-interactive installer as the CLI. */
const { execFileSync } = require('node:child_process');
const path = require('node:path');

// npm can pipe lifecycle output even for an interactive global install.
// A missing TTY therefore says nothing about whether setup was requested.
const enabled = (value) => /^(1|true|yes)$/i.test(value || '');
const isCI = ['CI', 'CONTINUOUS_INTEGRATION', 'GITHUB_ACTIONS'].some(
  (key) => enabled(process.env[key])
);

if (isCI || !enabled(process.env.npm_config_global)) {
  console.log('[token-optimizer-mcp] Skipping automatic setup (CI or local install)');
  console.log('[token-optimizer-mcp] Run token-optimizer-install to activate hooks and managed CLI commands.');
} else {
  try {
    const root = path.resolve(__dirname, '..');
    execFileSync(process.execPath, [path.join(root, 'scripts', 'install-cli.mjs')], {
      stdio: 'inherit', cwd: root, windowsHide: true,
    });
    console.log('[token-optimizer-mcp] Hooks and managed CLI commands installed. Open a new shell to activate them.');
  } catch (error) {
    // An optional integration failure must not make the MCP package unusable.
    console.warn('[token-optimizer-mcp] Automatic setup failed:', error.message);
    console.warn('[token-optimizer-mcp] Run token-optimizer-install to retry setup.');
  }
}
