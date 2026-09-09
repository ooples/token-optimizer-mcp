/**
 * Keeps the test suite out of the developer's real home directory.
 *
 * `smart_edit` defaults to `createBackup: true`, so any test that edits a file
 * writes a backup. Those went to the real `~/.token-optimizer/backups`, one new
 * hash-keyed directory per run per file, and nothing ever removed them --
 * measured: 376 accumulated directories, with three separate suites still
 * adding to them.
 *
 * Fixing it per test does not hold. The suites that touch backups knowingly
 * were straightforward to redirect; the two that leaked did not mention backups
 * at all -- they just edited a file, which is enough. Any test added later has
 * the same property, so the guarantee belongs here, once, where no future test
 * can forget it.
 *
 * A test that wants to assert on backup contents still can: it overrides the
 * same variable with a directory of its own.
 *
 * THE HARVEST FAILURE RECORD IS HERE FOR THE SAME REASON. The reason a
 * harvest produced nothing is now written to disk so it can cross a process
 * boundary -- the harvest runs in a detached worker and `doctor` runs in a
 * separate node invocation, so a module variable could never reach the
 * reader. That made every test calling `extract()` a writer into the real
 * `~/.token-optimizer/last-harvest.json`, and the leak was immediate: a stub
 * transport in one suite left `transport stubbed` behind, and
 * doctor-reports-harvest-state then failed on a local endpoint it had never
 * touched. Same lesson as the backups: the suites that know about the file
 * can redirect it, and the ones that merely call extract() cannot be expected
 * to know they need to.
 *
 * CommonJS on purpose -- Jest runs `setupFiles` before the ESM loader is in
 * play, so an `import` statement here fails to parse.
 */
const { mkdtempSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

if (!process.env.TOKEN_OPTIMIZER_BACKUP_DIR) {
  process.env.TOKEN_OPTIMIZER_BACKUP_DIR = mkdtempSync(
    join(tmpdir(), 'token-optimizer-test-backups-')
  );
}

// FRESH FOR EVERY TEST FILE, unlike the backup directory above. Jest reuses a
// worker process across suites, so the `if (!...)` guard would hand the second
// suite in a worker the first one's file -- which is exactly what happened: a
// stub transport in one suite wrote `transport stubbed`, and
// doctor-reports-harvest-state, running later in the same worker, reported a
// failed harvest on a local endpoint it had never called. setupFiles runs per
// test FILE, so assigning unconditionally is what makes it per suite. A suite
// that wants to control the path still overrides it in beforeEach, which runs
// after this.
process.env.TOKEN_OPTIMIZER_HARVEST_STATE = join(
  mkdtempSync(join(tmpdir(), 'token-optimizer-test-harvest-')),
  'last-harvest.json'
);
