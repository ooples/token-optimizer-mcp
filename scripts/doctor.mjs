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

// Awaited: the server probe holds a child's stdin open while it speaks the MCP
// handshake, which a synchronous spawn cannot do. See probeServer in
// hooks-core/doctor.mjs for why closing stdin early was the bug.
const result = await diagnose({
  root,
  workspace: join(tmpdir(), 'token-optimizer-doctor'),
  graphDir: wikiDir(process.cwd()),
  settingsPath:
    process.env.TOKEN_OPTIMIZER_SETTINGS ||
    join(
      process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
      'settings.json'
    ),
});

console.log(renderDiagnosis(result));
const hookHealth = hookHealthSummary({ includeLogDirectory: true });
console.log('');
console.log('Lifecycle diagnostics (last 24 hours):');
if (hookHealth.total === 0) {
  console.log(
    `  No hook runs recorded yet. Log directory: ${hookHealth.logDirectory}`
  );
} else {
  console.log(
    `  ${hookHealth.total} runs; ${hookHealth.failures} failures; ` +
      `${hookHealth.timeouts} timeouts; ${hookHealth.blocked} policy blocks; ` +
      `${hookHealth.abandoned} abandoned; ${hookHealth.skipped} skipped; ` +
      `p95 ${hookHealth.p95DurationMs ?? 'n/a'} ms.`
  );
  for (const [client, counts] of Object.entries(hookHealth.byClient)) {
    console.log(
      `  ${client}: ${counts.total} runs, ${counts.failures} failures, ` +
        `${counts.timeouts} timeouts, ${counts.blocked || 0} policy blocks, ` +
        `${counts.skipped || 0} skipped; surfaces: ` +
        `${counts.hookEvents?.join(', ') || 'unknown'}.`
    );
  }
}
// WHAT TELEMETRY IS DOING, SAID OUT LOUD.
//
// The two switches defaulted off and were documented nowhere the user reads, so
// nobody could opt in even deliberately, and nobody opted in could tell whether
// it was working. Both halves are a discoverability bug rather than a code one,
// and `doctor` is where someone already goes to ask what this installation is up
// to.
//
// READ FROM dist SO THERE IS ONE SOURCE OF TRUTH. The policy is compiled
// TypeScript and re-implementing its three rules here is how a doctor ends up
// reporting a policy the product does not follow. The tradeoff is that an
// unbuilt tree cannot answer, which is said plainly rather than guessed at --
// this command exists to diagnose broken installs, and a missing dist is one.
// THE QUESTION A BROKEN INSTALL ASKS SECOND. Half the reports this command exists
// to answer are a version that was fixed upstream weeks ago, and nothing else in
// the output says which copy is running. The check is only made here, where a
// person has asked, and never during a session; a lookup that fails says so
// rather than claiming the copy is current.
console.log('');
console.log('Version:');
try {
  const { checkForUpdate, describeUpdate } = await import(
    '../dist/update/check.js'
  );
  const report = await checkForUpdate();
  for (const line of describeUpdate(report)) console.log(`  ${line}`);
} catch {
  console.log('  Cannot read the version: dist is missing or broken.');
  console.log('  Run `npm run build`, then ask again.');
}
console.log('');
console.log('Anonymous usage data:');
try {
  const { describePolicy } = await import('../dist/telemetry/policy.js');
  console.log(`  ${describePolicy()}`);
  try {
    const { recordedBytes, recorderLastError, eventsFile } = await import(
      '../dist/telemetry/recorder.js'
    );
    const bytes = recordedBytes();
    const failure = recorderLastError();
    console.log(
      bytes === null
        ? '  Nothing recorded on this machine yet.'
        : `  ${bytes} bytes recorded locally, at ${eventsFile()}.`
    );
    if (failure !== null) {
      // THE CASE WORTH PRINTING LOUDLY. The recorder swallows its own failures
      // so a full disk cannot break a tool call, which means an opted-in user
      // whose home directory is read-only sees a working switch and collects
      // nothing. This is the only place that says so.
      console.log(`  WARNING: recording is failing silently -- ${failure}`);
    }
  } catch {
    console.log('  Recorder not built; run `npm run build` to check it.');
  }
  console.log('  Off by default. To opt in:  TOKEN_OPTIMIZER_TELEMETRY=1');
  console.log('  Upload is a separate opt-in: TOKEN_OPTIMIZER_BEACON=1');
  console.log('  DO_NOT_TRACK=1 overrides both.');
} catch {
  console.log('  Cannot read the telemetry policy: dist is missing or broken.');
  console.log('  Run `npm run build`, then ask again.');
}

console.log('');
console.log(
  'Verify the release itself with `npm audit signatures` (provenance attestation),'
);
console.log('or `sha256sum -c CHECKSUMS.sha256` for an offline check.');
console.log(
  'Export a bounded summary with `npm run diagnostics -- --hours 24`.'
);
console.log(
  'Add `--include-events --limit 100` only when event-level evidence is required.'
);

// A broken install should fail a script that asks whether it is broken.
//
// SET, NOT CALLED. `process.exit()` here aborts the whole process with
// STATUS_STACK_BUFFER_OVERRUN on Node 25.6.0 whenever an https fetch has been
// made in the run -- which the version check above now does. It reproduces in
// eleven lines with no project code (fetch a URL, then process.exit), so it is
// the runtime's bug, not ours; what is ours is not tripping it. Setting the code
// and letting the loop drain reports the same result without the crash, and if a
// stray handle ever holds this open the watchdog below is what says so.
process.exitCode = result.healthy ? 0 : 1;

// THE COST OF NOT CALLING process.exit: a leaked handle now hangs the command
// instead of being killed by the exit. Rather than hang silently, say which
// handles are still up and then go, so the symptom names its own cause.
const watchdog = setTimeout(() => {
  const held = (process.getActiveResourcesInfo?.() ?? []).join(', ');
  console.error(
    `doctor: finished but something is holding the process open (${held || 'unknown'})`
  );
  process.exit(process.exitCode ?? 0);
}, 5000);
watchdog.unref();
