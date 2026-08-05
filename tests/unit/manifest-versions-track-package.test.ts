import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Every manifest that names a version must name the SAME version as package.json.
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
 * The cause was the same one that let the plugin manifest rot: release-please only bumps
 * what it is told about. All four are now in `extra-files`, and this asserts the result,
 * because the failure mode is invisible from inside the repo -- nothing builds
 * differently, no test fails, and the npm release publishes perfectly well.
 */

const ROOT = process.cwd();
const read = (p: string) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

const packageVersion = read('package.json').version as string;

/** Manifest path -> the version fields inside it that mean "the released version". */
const MANIFESTS: Array<
  [string, (m: Record<string, unknown>) => Array<[string, unknown]>]
> = [
  ['server.json', (m) => [['$.version', m.version]]],
  [
    'server.json',
    (m) => {
      const packages = (m.packages ?? []) as Array<{ version?: unknown }>;
      return packages.map(
        (p, i) => [`$.packages[${i}].version`, p.version] as [string, unknown]
      );
    },
  ],
  ['mcp.json', (m) => [['$.version', m.version]]],
  ['gemini-extension.json', (m) => [['$.version', m.version]]],
];

describe('manifest versions track package.json', () => {
  it.each(MANIFESTS)('%s declares the package version', (path, extract) => {
    const fields = extract(read(path));

    // A manifest that stopped declaring a version at all would otherwise pass by
    // yielding nothing to compare.
    expect(fields.length).toBeGreaterThan(0);

    for (const [jsonpath, value] of fields) {
      expect({ jsonpath, value }).toEqual({ jsonpath, value: packageVersion });
    }
  });

  it('every manifest with a version is wired into release-please', () => {
    // The check above only catches drift AFTER it happens. This catches the cause: a
    // manifest release-please does not know about will drift on the very next release,
    // and nobody will notice until a registry publish returns 422.
    const config = read('release-please-config.json');
    const extras = (config.packages['.']['extra-files'] ?? []) as Array<{
      path: string;
    }>;
    const wired = new Set(extras.map((e) => e.path));

    for (const path of new Set(MANIFESTS.map(([p]) => p))) {
      expect(wired.has(path)).toBe(true);
    }
    expect(wired.has('plugin/.claude-plugin/plugin.json')).toBe(true);
  });

  it('covers the nested packages[0].version, not only the top-level one', () => {
    // server.json carries the version twice: once for the server entry and once for the
    // npm package. Bumping only the outer one leaves the registry pointing at a version
    // that may not exist, which is exactly the 422 PUBLISHING.md warns about.
    const server = read('server.json');

    expect(server.packages?.[0]?.version).toBe(packageVersion);
    expect(server.version).toBe(packageVersion);
  });
});
