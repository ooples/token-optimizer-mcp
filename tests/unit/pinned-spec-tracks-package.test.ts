import { describe, it, expect } from '@jest/globals';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * Every client config names ONE spec: `@ooples/token-optimizer-mcp@latest`.
 *
 * This file used to assert the opposite -- that each config pinned the exact
 * package.json version, and that `@latest` never appeared. That invariant cannot
 * hold. release-please bumps package.json, so the configs are wrong the moment a
 * release starts, and every mechanism built to re-sync them (a CI check, a
 * pull_request workflow, a step inside the release job, a script) was itself a
 * release, which invalidated the pins again. Four releases went into that loop:
 * v5.4.0 and v5.4.1 were both tagged with GitHub Releases and neither reached npm.
 *
 * Pinning also failed at the job it was introduced for. It was meant to stop the
 * plugin and the server drifting apart, and a pin that lags does exactly that.
 * Measured from a real installed plugin cache:
 *
 *     plugin 5.3.6.pre-refresh  spawns server 5.3.2
 *     plugin 5.4.0              spawns server 5.3.6   <- a downgrade
 *
 * Only one of those ever matched itself, and the previous version of this test
 * asserted the mechanism that produced them.
 *
 * `@latest` is the ecosystem norm: Microsoft's official Playwright MCP ships
 * `npx @playwright/mcp@latest`, GitHub's official MCP carries no version at all, and
 * this project shipped `@latest` at 5.0.2 before the pinning sweep.
 */

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

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

/**
 * The configs that launch the server via an inline `package@version` spec.
 *
 * Everything in PINNED_CONFIGS is swept for a numeric version; only these are
 * required to CARRY a spec. mcp.json and server.json are registry manifests that
 * name the package and version in separate fields, so demanding an inline spec of
 * them would assert a shape they do not have.
 */
const INLINE_SPEC_CONFIGS = PINNED_CONFIGS.filter(
  (relative) => relative !== 'mcp.json' && relative !== 'server.json'
);

const present = () => PINNED_CONFIGS.filter((r) => existsSync(join(ROOT, r)));

describe('the MCP spec in client configs', () => {
  it.each(PINNED_CONFIGS)(
    'in %s resolves to latest, not a frozen version',
    (relative) => {
      if (!existsSync(join(ROOT, relative))) return; // not every target ships in every layout

      const specs = [...read(relative).matchAll(SPEC)].map((m) => m[1]);

      // AT LEAST ONE, asserted before the values are -- but only for the configs that
      // carry an inline `package@version` spec. A file that exists and carries no spec
      // made this loop body never execute, so the test passed while the config said
      // nothing about which server to launch, and the coverage test below only ever
      // required ONE spec across the whole set.
      //
      // mcp.json and server.json are excluded because they are MCP REGISTRY manifests:
      // they name the package and its version in separate fields rather than as an
      // `@version` suffix, which is why pin-mcp-version reports seven configs and not
      // nine. Their `version` fields are separately stale (0.2.0 and 5.1.1 against a
      // package at 5.4.2) and nothing checks them -- recorded here because it is the
      // same class of drift, not fixed here.
      if (INLINE_SPEC_CONFIGS.includes(relative)) {
        expect(specs.length).toBeGreaterThan(0);
      }

      for (const spec of specs) {
        expect(spec).toBe('latest');
      }
    }
  );

  it('never carries a numeric version, which is what went stale every release', () => {
    const frozen = present().filter((r) =>
      [...read(r).matchAll(SPEC)].some((m) => /^\d/.test(m[1]))
    );

    expect(frozen).toEqual([]);
  });

  it('covers at least one real config, so this file cannot pass vacuously', () => {
    // Every assertion above short-circuits on a missing file. Without this, deleting
    // the configs would turn the suite green.
    const withSpec = present().filter(
      (r) => [...read(r).matchAll(SPEC)].length > 0
    );

    expect(withSpec.length).toBeGreaterThan(0);
  });
});

describe('the generated-config gate', () => {
  const workflowDir = '.github/workflows';
  const workflows = readdirSync(join(ROOT, workflowDir)).filter((f) =>
    /\.ya?ml$/.test(f)
  );
  const allWorkflowText = workflows
    .map((f) => read(join(workflowDir, f)))
    .join('\n');

  it('runs sync:hooks:check somewhere in CI', () => {
    // The spec can no longer drift, but these files are still GENERATED, so a
    // generator and its committed output can still disagree.
    expect(allWorkflowText).toMatch(/sync:hooks:check|verify:all/);
  });

  it('still checks on the release path', () => {
    const release = read(join(workflowDir, 'release.yml'));
    expect(release).toMatch(/sync:hooks:check|verify:all/);
  });

  it('no longer relies on a workflow that cannot be triggered', () => {
    // sync-release-pins.yml existed to repair the release PR, but release-please opens
    // that PR with GITHUB_TOKEN and GitHub suppresses workflow runs from it, so every
    // run sat in `action_required` having executed nothing. With `@latest` there is
    // nothing to repair, so it is gone -- and must not return on that assumption.
    expect(workflows).not.toContain('sync-release-pins.yml');
  });
});
