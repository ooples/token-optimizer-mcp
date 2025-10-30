#!/usr/bin/env node

/**
 * Automatic hook installation after npm install
 * Runs the appropriate platform-specific installer
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Detect if we're in a CI environment or non-interactive shell
const isCI = process.env.CI === 'true' ||
             process.env.CONTINUOUS_INTEGRATION === 'true' ||
             process.env.GITHUB_ACTIONS === 'true' ||
             !process.stdout.isTTY;

// Skip hook installation in CI or when installing as a dependency
if (isCI || process.env.npm_config_global !== 'true') {
  console.log('[token-optimizer-mcp] Skipping automatic hook installation (CI or local install)');
  console.log('[token-optimizer-mcp] To install hooks manually, see: https://github.com/ooples/token-optimizer-mcp#installation');
  process.exit(0);
}

console.log('[token-optimizer-mcp] Starting automatic hook installation...');

try {
  const platform = process.platform;
  const packageRoot = path.resolve(__dirname, '..');

  let installScript;
  let command;

  if (platform === 'win32') {
    installScript = path.join(packageRoot, 'install-hooks.ps1');

    // Check if PowerShell is available
    try {
      execSync('powershell -Command "exit 0"', { stdio: 'ignore' });
    } catch (error) {
      console.warn('[token-optimizer-mcp] PowerShell not available, skipping hook installation');
      console.log('[token-optimizer-mcp] Run install-hooks.ps1 manually to enable hooks');
      process.exit(0);
    }

    command = `powershell -ExecutionPolicy Bypass -File "${installScript}"`;
  } else {
    installScript = path.join(packageRoot, 'install-hooks.sh');

    // Make the script executable
    try {
      fs.chmodSync(installScript, 0o755);
    } catch (error) {
      console.warn('[token-optimizer-mcp] Could not make install script executable:', error.message);
    }

    command = `bash "${installScript}"`;
  }

  // Check if install script exists
  if (!fs.existsSync(installScript)) {
    console.warn('[token-optimizer-mcp] Install script not found:', installScript);
    console.log('[token-optimizer-mcp] Skipping automatic hook installation');
    process.exit(0);
  }

  console.log('[token-optimizer-mcp] Running hook installer...');

  // Run the installer
  execSync(command, {
    stdio: 'inherit',
    cwd: packageRoot
  });

  console.log('[token-optimizer-mcp] ✓ Hooks installed successfully!');
  console.log('[token-optimizer-mcp] Token optimization is now active for all Claude Code operations');

} catch (error) {
  console.warn('[token-optimizer-mcp] Hook installation encountered an issue:', error.message);
  console.log('[token-optimizer-mcp] You can manually install hooks by running:');

  if (process.platform === 'win32') {
    console.log('[token-optimizer-mcp]   powershell -ExecutionPolicy Bypass -File install-hooks.ps1');
  } else {
    console.log('[token-optimizer-mcp]   bash install-hooks.sh');
  }

  // Don't fail the installation if hooks can't be installed
  process.exit(0);
}
