import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The plugin manifest's version is how Claude Code decides whether an update is
 * available. release-please only ever bumped package.json, so the manifest sat
 * at 5.2.0 while the package reached 5.3.4 -- across four releases.
 *
 * The consequence is not cosmetic. A user already on 5.2.0 is told there is
 * nothing to update to, so hook fixes shipped in 5.2.1 through 5.3.4 never
 * reach them, no matter how many times they check. The MCP server half is
 * unaffected (it is fetched from npm at @latest), which makes the split
 * especially easy to miss: the tools update and the hooks silently do not.
 *
 * release-please now bumps the manifest via `extra-files`. This asserts the two
 * stay in step, because the failure mode is invisible from inside the repo --
 * everything builds, every test passes, and the release publishes.
 */

const ROOT = process.cwd();
const read = (p: string) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

describe('plugin manifest version', () => {
  it('matches the package version', () => {
    const pkg = read('package.json').version;
    const plugin = read('plugin/.claude-plugin/plugin.json').version;

    expect(plugin).toBe(pkg);
  });

  it('is still configured for release-please to bump', () => {
    // If this entry is dropped, the versions drift again and the only symptom
    // is users quietly not receiving hook updates.
    const config = read('release-please-config.json');
    const extras = config.packages?.['.']?.['extra-files'] ?? [];

    expect(
      extras.some(
        (e: { path?: string; jsonpath?: string }) =>
          e.path === 'plugin/.claude-plugin/plugin.json' && e.jsonpath === '$.version'
      )
    ).toBe(true);
  });

  it('is a plain semver, which is what the update check compares', () => {
    const plugin = read('plugin/.claude-plugin/plugin.json').version;
    expect(plugin).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
