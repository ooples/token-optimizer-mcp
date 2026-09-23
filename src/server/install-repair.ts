import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** All MCP hosts share this upgrade path, including hosts without a plugin loader. */
export function startManagedInstallRepair(): void {
  if (
    process.env.TOKEN_OPTIMIZER_VERSION ||
    /^(0|false|no|off)$/i.test(process.env.TOKEN_OPTIMIZER_AUTO_REPAIR || '') ||
    process.env.TOKEN_OPTIMIZER_MODE?.trim().toLowerCase() === 'off'
  )
    return;
  const entry = join(
    dirname(fileURLToPath(import.meta.url)),
    '../../scripts/repair-managed-install.mjs'
  );
  // Profile discovery may invoke PowerShell. Keep it outside the MCP event loop and stdio.
  const child = spawn(process.execPath, [entry], {
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
  });
  child.on('error', () => {
    /* optional repair must not prevent MCP startup */
  });
  child.unref();
}
