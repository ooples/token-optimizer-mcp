import {
  claudeSettingsFile,
  maintainDefaultRouting,
  readRoutingManifest,
} from './default-routing.js';
import { proxyEnabled } from './server.js';
import { readFileSync } from 'node:fs';
import {
  ensureSupervisor,
  readSupervisorState,
  controlPort,
} from './supervisor.js';

/** Keep an installed route alive after a supervisor crash, without delaying MCP. */
export function startRoutingMaintenance({
  env = process.env,
  intervalMs = 5000,
  maintain = maintainDefaultRouting,
  recover = ensureSupervisor,
} = {}): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const stillOwned = (): boolean => {
    const path = claudeSettingsFile(env);
    const entry = readRoutingManifest(env).entries[path];
    return (
      !!entry &&
      // Inspect ownership before recovery without yielding to another settings writer.
      // eslint-disable-next-line n/no-sync
      JSON.parse(readFileSync(path, 'utf8')).env?.[entry.variable] ===
        entry.value
    );
  };
  const run = async (initial = false): Promise<void> => {
    try {
      // Persistent routes are shared by clients (including Zed), not owned by Claude.
      // The supervisor restores its complete route table on restart, at the recorded ports.
      const saved = readSupervisorState(env);
      if (
        !stopped &&
        proxyEnabled(env) &&
        Array.isArray(saved?.routes) &&
        saved.routes.length &&
        saved.controlUrl === `http://127.0.0.1:${controlPort(env)}`
      )
        await recover(env);
      // Initial setup may install a route. Later checks only maintain a route we still own:
      // removing routing or opting out must not be undone by a background timer.
      if (!stopped && (initial || stillOwned())) await maintain(env);
    } catch {
      // A transient filesystem/startup error must not take down the MCP server.
    } finally {
      if (!stopped) {
        // Schedule after completion: slow recovery attempts must never overlap.
        timer = setTimeout(() => void run(), intervalMs);
        timer.unref();
      }
    }
  };
  void run(true);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
