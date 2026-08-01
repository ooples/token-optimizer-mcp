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
