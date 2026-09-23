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
const { mkdtempSync, existsSync } = require('node:fs');
const { join, delimiter } = require('node:path');
const { tmpdir } = require('node:os');

// Windows' system32/bash.exe is a WSL launcher, not an installed Bash runtime.
// Shell-contract tests need Git Bash when it is installed. Scope the PATH change
// to test workers and their children; never edit the user's global environment.
if (process.platform === 'win32') {
  const candidates = [
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'Git', 'bin'),
    process.env['ProgramFiles(x86)'] &&
      join(process.env['ProgramFiles(x86)'], 'Git', 'bin'),
    process.env.LOCALAPPDATA &&
      join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin'),
  ].filter(Boolean);
  const gitBash = candidates.find((directory) =>
    existsSync(join(directory, 'bash.exe'))
  );
  if (gitBash) {
    process.env.TOKEN_OPTIMIZER_TEST_BASH = join(gitBash, 'bash.exe');
    const key =
      Object.keys(process.env).find((name) => name.toLowerCase() === 'path') ||
      'PATH';
    const entries = (process.env[key] || '').split(delimiter);
    process.env[key] = [
      gitBash,
      ...entries.filter(
        (entry) => entry.toLowerCase() !== gitBash.toLowerCase()
      ),
    ].join(delimiter);
  }
}

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

// THE DEVELOPER'S OPT-OUT MUST NOT REACH THE SUITE. TOKEN_OPTIMIZER_MODE=off in the shell (or in the
// agent's settings `env`, which its child processes inherit) disables every hook, and 69 hook tests
// then failed on a machine where that override had been set -- while CI, which never sets it, stayed
// green. Tests assert the default posture unless they set a mode themselves, which they still can:
// beforeEach and per-spawn env run after this.
delete process.env.TOKEN_OPTIMIZER_MODE;

// NO TEST MAY START A BACKGROUND SERVICE, OR REACH THE DEVELOPER'S OWN CLIENT.
//
// The MCP server ensures the compression route at startup, and several suites spawn that server for
// real. On this machine that left a detached supervisor running after `npm test` and wrote a route
// into the developer's actual ~/.claude/settings.json -- which the next run then healed back out,
// so the only visible trace was a settings file that had quietly changed twice.
//
// Autostart off is enough to stop both: every routing entry point answers null without a supervisor,
// and nothing is written unless a route was really served. A suite that tests the supervisor starts
// one itself, in-process, on a port of its own.
process.env.TOKEN_OPTIMIZER_PROXY_AUTOSTART = '0';
// Startup migration has its own isolated integration coverage; ordinary server probes must
// never inspect or update the developer's actual launchers and shell profiles.
process.env.TOKEN_OPTIMIZER_AUTO_REPAIR = '0';
