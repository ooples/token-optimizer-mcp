#!/usr/bin/env node
/**
 * The managed launchers' stable entry: run the `run-client.mjs` of whichever
 * runtime `<runtime>/current` names, so a launcher always serves the updated
 * runtime and never names a version that a refresh can prune.
 *
 * WHY THIS EXISTS. Launchers (`~/.token-optimizer/bin/codex.cmd`, the managed
 * shell-profile functions) used to embed one version's path,
 * `<runtime>/versions/7.3.0/.../scripts/run-client.mjs`. They served that
 * version's MCP server for as long as they existed, however many refreshes
 * happened underneath, and once retention dropped 7.3.0 every launch failed
 * with `Cannot find module ...\versions\7.3.0\...\run-client.mjs` (2026-10-12).
 *
 * COPIED, NOT IMPORTED. The installer copies this file to `<runtime>/` so its
 * path is the same across versions; it therefore imports nothing outside node
 * and must keep working whichever version copied it.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const runtime =
  process.env.TOKEN_OPTIMIZER_RUNTIME || dirname(fileURLToPath(import.meta.url));

const entryFor = (version) =>
  join(
    runtime,
    'versions',
    version,
    'node_modules',
    '@ooples',
    'token-optimizer-mcp',
    'scripts',
    'run-client.mjs'
  );

/** The run-client `current` names, else the newest installed one, else null. */
function target() {
  try {
    const current = readFileSync(join(runtime, 'current'), 'utf8').trim();
    if (current && existsSync(entryFor(current))) return entryFor(current);
  } catch {
    // No pointer yet, or unreadable: fall back to what is installed.
  }
  let newest = null;
  let newestAt = -1;
  try {
    for (const version of readdirSync(join(runtime, 'versions'))) {
      const entry = entryFor(version);
      if (!existsSync(entry)) continue;
      const at = statSync(join(runtime, 'versions', version)).mtimeMs;
      if (at > newestAt) {
        newest = entry;
        newestAt = at;
      }
    }
  } catch {
    // No versions directory at all.
  }
  return newest;
}

const script = target();
if (!script) {
  console.error(
    `token-optimizer: no installed runtime under ${runtime}. ` +
      'Reinstall with: npx -y @ooples/token-optimizer-mcp@latest install'
  );
  process.exit(1);
}

const child = spawn(process.execPath, [script, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
// The terminal delivers Ctrl+C to the client directly; this process only waits
// for it to finish. A termination aimed at this process is passed on, so the
// client is not left running without the wrapper that started it.
process.on('SIGINT', () => {});
for (const signal of ['SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  });
}
child.on('error', (error) => {
  console.error(`token-optimizer: could not start ${script}: ${error.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
