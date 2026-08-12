#!/usr/bin/env node
/**
 * `npm run doctor` -- does this installation actually work?
 *
 * The command-line form of the same examination the install_doctor tool runs,
 * for the case where the MCP server is exactly what is broken and cannot be
 * asked. This one DOES probe the server, since it is not running inside it.
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, homedir } from 'node:os';
import { diagnose, renderDiagnosis } from '../hooks-core/doctor.mjs';
import { wikiDir } from '../hooks-core/wiki.mjs';
import { hookHealthSummary } from '../hooks-core/observability.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const result = diagnose({
  root,
  workspace: join(tmpdir(), 'token-optimizer-doctor'),
  graphDir: wikiDir(process.cwd()),
  settingsPath: process.env.TOKEN_OPTIMIZER_SETTINGS || join(homedir(), '.claude', 'settings.json'),
});

console.log(renderDiagnosis(result));
const hookHealth = hookHealthSummary({ includeLogDirectory: true });
console.log('');
console.log('Lifecycle diagnostics (last 24 hours):');
if (hookHealth.total === 0) {
  console.log(`  No hook runs recorded yet. Log directory: ${hookHealth.logDirectory}`);
} else {
  console.log(
    `  ${hookHealth.total} runs; ${hookHealth.failures} failures; ` +
    `${hookHealth.timeouts} timeouts; ${hookHealth.skipped} skipped; ` +
    `p95 ${hookHealth.p95DurationMs ?? 'n/a'} ms.`
  );
  for (const [client, counts] of Object.entries(hookHealth.byClient)) {
    console.log(
      `  ${client}: ${counts.total} runs, ${counts.failures} failures, ` +
      `${counts.timeouts} timeouts, ${counts.skipped || 0} skipped.`
    );
  }
}
console.log('');
console.log('Verify the release itself with `npm audit signatures` (provenance attestation),');
console.log('or `sha256sum -c CHECKSUMS.sha256` for an offline check.');
console.log('Export a bounded summary with `npm run diagnostics -- --hours 24`.');
console.log('Add `--include-events --limit 100` only when event-level evidence is required.');

// A broken install should fail a script that asks whether it is broken.
process.exit(result.healthy ? 0 : 1);
