import { describe, it, expect } from '@jest/globals';
import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Both installers verified the wrong files, so both always reported failure.
 *
 * The hook layer was redesigned from a downloaded `dispatcher` plus `handlers/`
 * and `helpers/` shell libraries into three ES modules under plugin/hooks.
 * `Install-HooksFiles` was updated to copy the new modules; `Test-Installation`
 * was not, and still required dispatcher.ps1, handlers/*.ps1 and five
 * helpers/*.ps1 that the same file's own comments describe as replaced.
 *
 * The consequence is not a cosmetic warning. Verification failing means the
 * installer throws "Installation verification failed", which skips
 * scripts/record-install.mjs -- so no install manifest is written, and
 * `install_doctor` then reports "install manifest present: FAIL / no record of
 * what was installed". The doctor was telling the truth about a file the
 * installer had been prevented from writing.
 *
 * install-hooks.sh carries the identical stale list (dispatcher.sh,
 * handlers/token-optimizer-orchestrator.sh, helpers/invoke-mcp.sh), so this is
 * not a Windows-only bug.
 *
 * These assertions are deliberately about the RELATIONSHIP between the two
 * halves of each installer rather than about a hardcoded list: an installer must
 * only require files it actually installs.
 */

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** Every file actually shipped under plugin/hooks, as basenames. */
function shippedHookFiles(): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(ROOT, dir))) {
      const rel = `${dir}/${entry}`;
      if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
      else out.add(entry);
    }
  };
  walk('plugin/hooks');
  return out;
}

/**
 * Paths an installer treats as required for verification, as basenames.
 *
 * Scoped to the required-files array rather than every $HOOKS_DIR mention in the
 * file: install-hooks.sh also prints "$HOOKS_DIR/logs/dispatcher.log" in its
 * closing help text, which is a log location, not a file installation produces.
 * Counting it would fail the installer for telling the user where to look.
 */
function requiredByInstaller(source: string): string[] {
  // `@(` in PowerShell, `(` in bash.
  const block = source.match(/required_?[Ff]iles\s*=\s*@?\(([\s\S]*?)\)/);
  if (!block) return [];
  const matches = block[1].matchAll(/["']\$(?:\{)?HOOKS_DIR(?:\})?[\\/]([^"']+)["']/g);
  return [...matches].map((m) => m[1].replace(/\\/g, '/').split('/').pop() as string);
}

const ENTRYPOINTS = ['session-start.mjs', 'pretooluse-router.mjs', 'precompact-optimize.mjs'];

describe.each([
  ['install-hooks.ps1', 'install-hooks.ps1'],
  ['install-hooks.sh', 'install-hooks.sh'],
])('%s verification', (_label, file) => {
  it('only requires files the installer actually ships', () => {
    if (!existsSync(join(ROOT, file))) return;

    const shipped = shippedHookFiles();
    const required = requiredByInstaller(read(file));
    const missing = required.filter((name) => !shipped.has(name));

    // Anything here is a file verification demands and installation never
    // produces -- a guaranteed failure on every run.
    expect(missing).toEqual([]);
  });

  it('requires the three real hook entrypoints', () => {
    if (!existsSync(join(ROOT, file))) return;

    // The inverse failure: verification that checks nothing meaningful would
    // also pass the test above. These are the modules hooks.json invokes, so an
    // install missing any of them is broken and must not verify clean.
    const required = requiredByInstaller(read(file));
    for (const entry of ENTRYPOINTS) {
      expect(required).toContain(entry);
    }
  });
});

describe('the install manifest', () => {
  it('is recorded even when optional verification steps do not apply', () => {
    // record-install.mjs sat inside `if ($verified)`, so any verification
    // failure -- including the MCP-configured check, which cannot pass for a
    // Claude Code CLI user because that path configures MCP via the plugin
    // rather than claude_desktop_config.json -- silently skipped it.
    const ps1 = read('install-hooks.ps1');
    const recordIndex = ps1.indexOf('record-install.mjs');
    expect(recordIndex).toBeGreaterThan(-1);

    // The recording must not be gated on the verification verdict.
    const gatedOnVerified = /if\s*\(\s*\$verified\s*\)[\s\S]{0,400}record-install\.mjs/.test(ps1);
    expect(gatedOnVerified).toBe(false);
  });
});
