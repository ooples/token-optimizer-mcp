import { describe, it, expect } from '@jest/globals';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * The SPEC pinned inside the hand-maintained client configs is a second,
 * independent version that must track package.json -- and it did not.
 *
 * `plugin-version-tracks-package.test.ts` covers the plugin MANIFEST, which
 * release-please bumps via `extra-files`. The pinned npm spec is different: it
 * lives inside a string in an args array, so no jsonpath can reach it, and
 * `scripts/pin-mcp-version.mjs` is what keeps it in step. Nothing ran that
 * script during a release, so plugin/.mcp.json shipped `@5.3.2` while the hooks
 * beside it were 5.3.6.
 *
 * Observed live on a user machine: the plugin's four hooks loaded at 5.3.6 and
 * launched an MCP server three patch versions behind. Nothing failed loudly --
 * the tool surface happened to be compatible -- which is exactly why this needs
 * a test rather than vigilance.
 *
 * The second test is the one that actually prevents recurrence. `npm run
 * sync:hooks:check` already existed and already detected this drift; it simply
 * was not wired into any workflow, so it never ran. A gate that exists and is
 * never invoked is indistinguishable from no gate.
 */

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const pkgVersion = JSON.parse(read('package.json')).version as string;

// Mirrors TARGETS in scripts/pin-mcp-version.mjs. Kept as a literal rather than
// imported so a target silently dropped from the script is still asserted here.
const PINNED_CONFIGS = [
  'integrations/copilot/mcp-config.json',
  'integrations/gemini/gemini-extension.json',
  'integrations/opencode/opencode.json',
  'integrations/codex/config.toml',
  'integrations/codex/plugin/.mcp.json',
  'plugin/.mcp.json',
  'mcp.json',
  'server.json',
  'gemini-extension.json',
];

const SPEC = /@ooples\/token-optimizer-mcp@([^"'\s,\]]+)/g;

describe('pinned MCP spec', () => {
  it.each(PINNED_CONFIGS)('in %s is pinned to the package version', (relative) => {
    if (!existsSync(join(ROOT, relative))) return; // not every target ships in every layout

    const pinned = [...read(relative).matchAll(SPEC)].map((m) => m[1]);
    // A config with no pin at all is fine; one that pins the wrong version is not.
    for (const version of pinned) {
      expect(version).toBe(pkgVersion);
    }
  });

  it('is never left floating on @latest in a shipped config', () => {
    // `@latest` resolves at npx time, so the version a user runs depends on when
    // their npx cache was populated -- unreproducible and unpinnable.
    const floating = PINNED_CONFIGS.filter(
      (r) => existsSync(join(ROOT, r)) && read(r).includes('token-optimizer-mcp@latest')
    );
    expect(floating).toEqual([]);
  });
});

describe('the drift gate', () => {
  const workflowDir = '.github/workflows';
  const workflows = readdirSync(join(ROOT, workflowDir)).filter((f) => /\.ya?ml$/.test(f));
  const allWorkflowText = workflows.map((f) => read(join(workflowDir, f))).join('\n');

  it('runs sync:hooks:check somewhere in CI', () => {
    // Without this, pin drift can only be caught by a human remembering to run
    // the script -- which is how three patch versions of drift shipped.
    expect(allWorkflowText).toMatch(/sync:hooks:check|verify:all/);
  });

  it('guards the release path, which is where the drift is introduced', () => {
    // ci.yml deliberately skips release-please commits, so a gate that only runs
    // on ordinary PRs cannot see a bump made by the release PR itself.
    const release = read(join(workflowDir, 'release.yml'));
    expect(release).toMatch(/sync:hooks:check|verify:all/);
  });
});
