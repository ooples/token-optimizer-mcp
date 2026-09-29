/**
 * The doctor must not exit with a fetch in flight.
 *
 * `npm run doctor` now asks the registry which version is published, and on Node
 * 25.6.0 an https fetch followed by `process.exit()` aborts the process with
 * STATUS_STACK_BUFFER_OVERRUN -- a clean 17/17 report followed by a crash exit
 * code, which is worse than either a pass or a fail because a CI step reads the
 * code and not the text. It reproduces in eleven lines with no project code, so
 * it is the runtime's bug; not tripping it is ours. A ~4 second gap is enough for
 * the teardown to finish, which is why the long-lived server is unaffected and
 * only the script that prints and leaves was.
 *
 * ASSERTED ON THE SOURCE, not by spawning it, on purpose. The crash is specific
 * to Windows, so an assertion on a spawned exit code would pass on Linux CI
 * whatever the script did -- it would guard nothing exactly where the guard is
 * cheapest to lose. What survives a move to any platform is the shape: this
 * script sets `process.exitCode` and lets the loop drain.
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const doctor = readFileSync(
  join(process.cwd(), 'scripts', 'doctor.mjs'),
  'utf8'
);

/** Lines with the code stripped of comments, since a comment may name the trap. */
const code = doctor
  .split(/\r?\n/)
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n');

describe('scripts/doctor.mjs', () => {
  it('reports its verdict through process.exitCode', () => {
    expect(code).toContain('process.exitCode = result.healthy ? 0 : 1');
  });

  it('calls process.exit only from the watchdog that has waited', () => {
    const calls = code.match(/process\.exit\(/g) ?? [];
    expect(calls).toHaveLength(1);
    // The one remaining call is inside the timeout, whose whole purpose is to
    // have waited before exiting. Anchored on the surrounding setTimeout so that
    // moving the call out of it fails here.
    expect(code).toMatch(
      /setTimeout\(\(\) => \{[\s\S]*process\.exit\(process\.exitCode \?\? 0\);[\s\S]*\}, \d+\);/
    );
  });

  it('asks the registry for the published version', () => {
    expect(code).toContain("await import(\n    '../dist/update/check.js'\n  )");
    expect(code).toContain('checkForUpdate()');
  });
});