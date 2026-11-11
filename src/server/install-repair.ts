import { FeatureName, featureEnabled } from '../rollout/resolve.js';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Re-creates the old-layout paths in this installed package (see
 * src/scripts/legacy-layout.mjs). Unconditional and cheap: older hook copies
 * and launchers need them whether or not the repair rollout is on.
 */
function healLegacyLayout(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const module = join(here, '../../src/scripts/legacy-layout.mjs');
  import(pathToFileURL(module).href)
    .then((m: { ensureLegacyLayout: (root: string) => string[] }) =>
      m.ensureLegacyLayout(join(here, '../..'))
    )
    .catch(() => {
      /* optional: the package runs without them */
    });
}

/** All MCP hosts share this upgrade path, including hosts without a plugin loader. */
export function startManagedInstallRepair(): void {
  healLegacyLayout();
  if (
    process.env.TOKEN_OPTIMIZER_VERSION ||
    !featureEnabled(FeatureName.AutoRepair) ||
    process.env.TOKEN_OPTIMIZER_MODE?.trim().toLowerCase() === 'off'
  )
    return;
  const entry = join(
    dirname(fileURLToPath(import.meta.url)),
    '../../src/scripts/repair-managed-install.mjs'
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
