import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Every manifest that names a version must name the SAME version as package.json,
 * and release-please must be told about every one of those fields BY JSONPATH.
 *
 * `plugin-version-tracks-package.test.ts` covers the Claude plugin manifest. Three more
 * carried their own version and nothing checked any of them, so they rotted for many
 * releases while every build stayed green:
 *
 *     server.json            5.1.1   against a package at 5.4.3
 *     server.json packages[0]  5.1.1
 *     mcp.json               0.2.0
 *     gemini-extension.json  5.1.2
 *
 * server.json is the one with teeth. docs/PUBLISHING.md states the rule outright --
 * "registry returns 422; keep server.json version in lockstep with npm" -- because the
 * MCP Registry validates that the declared version exists on npm carrying the matching
 * mcpName. At 5.1.1 the registry entry described a version three minors behind whatever
 * users install, and a publish attempt would be rejected.
 *
 * WIRING IS CHECKED PER JSONPATH, NOT PER FILE. An earlier version of this test
 * collected `extra-files` into a set of PATHS, so both server.json entries collapsed
 * into one member and deleting `$.packages[0].version` from the config still passed --
 * the exact drift it exists to prevent, left uncovered by the test that claimed to
 * cover it. Verified by deleting that entry: all six assertions passed.
 */

const ROOT = process.cwd();
const read = (p: string) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

const packageVersion = read('package.json').version as string;

interface Target {
  path: string;
  jsonpath: string;
  value: unknown;
}

/**
 * Every version field release-please has to bump, addressed exactly as the config
 * addresses it.
 *
 * server.json's packages are enumerated rather than hard-coded at index 0, so adding a
 * second package entry produces a target that must be wired instead of a silent gap.
 */
function targets(): Target[] {
  const server = read('server.json');
  const packages = (server.packages ?? []) as Array<{ version?: unknown }>;

  return [
    { path: 'server.json', jsonpath: '$.version', value: server.version },
    ...packages.map((p, i) => ({
      path: 'server.json',
      jsonpath: `$.packages[${i}].version`,
      value: p.version,
    })),
    {
      path: 'mcp.json',
      jsonpath: '$.version',
      value: read('mcp.json').version,
    },
    {
      path: 'gemini-extension.json',
      jsonpath: '$.version',
      value: read('gemini-extension.json').version,
    },
    {
      path: 'integrations/codex/plugin/.codex-plugin/plugin.json',
      jsonpath: '$.version',
      value: read('integrations/codex/plugin/.codex-plugin/plugin.json').version,
    },
  ];
}

describe('manifest versions track package.json', () => {
  const required = targets();

  it('finds every version field it is meant to check', () => {
    // Without this, a manifest that stopped declaring a version would empty the
    // list and turn every assertion below into a vacuous pass.
    expect(required.length).toBeGreaterThanOrEqual(5);
  });

  it.each(required.map((t) => [`${t.path} ${t.jsonpath}`, t] as const))(
    '%s declares the package version',
    (_label, target) => {
      expect({ at: _label, value: target.value }).toEqual({
        at: _label,
        value: packageVersion,
      });
    }
  );

  it('wires every one of those fields into release-please, by jsonpath', () => {
    // The value check above only catches drift AFTER it happens. This catches the
    // cause: a field release-please does not know about will drift on the very next
    // release, and nobody will notice until a registry publish returns 422.
    const config = read('release-please-config.json');
    const extras = (config.packages['.']['extra-files'] ?? []) as Array<{
      path: string;
      jsonpath: string;
    }>;
    const wired = new Set(extras.map((e) => `${e.path} ${e.jsonpath}`));

    const missing = required
      .map((t) => `${t.path} ${t.jsonpath}`)
      .filter((key) => !wired.has(key));

    expect(missing).toEqual([]);
    // The plugin manifest has its own value test but the same wiring requirement,
    // and it is the one that already rotted through four releases.
    expect(wired.has('plugin/.claude-plugin/plugin.json $.version')).toBe(true);
  });
});
