/**
 * Wired is not the same as working.
 *
 * The wiring check is a substring test, so a settings file naming a script that
 * no longer exists reads as perfectly healthy while every invocation of it dies
 * with MODULE_NOT_FOUND. That is what happened when an upgrade wired its own
 * staging directory and the OS later cleaned that directory up: the Stop hook
 * failed on every turn and the diagnostic said the hooks were wired.
 */

import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checklist } from '../../hooks-core/doctor.mjs';

function settingsWiredTo(dir, hooksDir) {
  const path = join(dir, 'settings.json');
  writeFileSync(
    path,
    JSON.stringify({
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: 'command',
                command: `node "${hooksDir}/stop.mjs" --token-optimizer-hook`,
              },
            ],
          },
        ],
      },
    }),
  );
  return path;
}

const named = (checks, name) => checks.find((c) => c.name === name);

describe('doctor reports a wired hook that no longer resolves', () => {
  it('fails the check and names the missing path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tok-stale-'));
    const settingsPath = settingsWiredTo(dir, join(dir, 'gone'));

    const checks = checklist({ root: dir, settingsPath, install: { method: 'script' } });
    const check = named(checks, 'wired hooks resolve on disk');

    expect(check).toBeDefined();
    expect(check.pass).toBe(false);
    expect(check.detail).toContain('stop.mjs');
  });

  it('passes when the file is there, wherever there happens to be', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tok-live-'));
    const hooksDir = join(dir, 'anywhere', 'at', 'all');
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, 'stop.mjs'), 'export default 1;');
    const settingsPath = settingsWiredTo(dir, hooksDir);

    const checks = checklist({ root: dir, settingsPath, install: { method: 'script' } });
    const check = named(checks, 'wired hooks resolve on disk');

    expect(check).toBeDefined();
    expect(check.pass).toBe(true);
  });
});
