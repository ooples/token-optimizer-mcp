/**
 * THE REPO VENDORS ELEVEN COPIES OF THE CORE; THE PACKAGE SHIPS ONE OF THEM.
 *
 * Eleven directories hold byte-identical copies of the same core -- 10.87MB of
 * tarball for 1.44MB of unique content. Ten of them are the client
 * integrations, and `files` now excludes those: the tarball carries
 * `hooks-core/` once plus `plugin/hooks/lib`, and
 * `scripts/install-client-hooks.mjs` composes a client's copy INTO THE
 * DESTINATION when the user installs it.
 *
 * Which is not the design this file was written against. That one composed "on
 * first use" from inside the hook, and it shipped ten copies that were silently
 * inert: no client executes its hooks from inside the installed package -- each
 * runs them from a copy at a path the client dictates
 * (`.cursor/hooks/token-optimizer/`, `$HOME/.codex/hooks/`,
 * `.github/hooks/`, ...), and a copy at such a path has no package tree above
 * it, so nothing the hook could execute was able to find the composer. The
 * documented install produced four entry files, no core, and a pre-tool hook
 * that printed nothing and allowed everything.
 *
 * So the claims left here are the ones that survive the exclusion: what the
 * repo vendors is what the shared module composes, the committed copies carry
 * no version stamp, `plugin/hooks/lib` still ships whole because Claude Code
 * loads it straight out of the package, and each client copy is still COMPLETE
 * IN THE TREE, because that tree is what the installer composes from.
 *
 * That an installed copy enforces where it actually runs is proved in
 * tests/unit/client-hook-install.test.ts -- from the installer's own output,
 * against a negative control that shows the plain copy failing open.
 */

import { describe, expect, it } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLIENT_TARGETS,
  PLUGIN_TARGETS,
  coreFiles,
  composeCoreFile,
} from '../../scripts/lib/hook-core.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** EOL-insensitive, exactly as the drift gate compares. */
const sameText = (a: string, b: string) =>
  a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');

const posix = (p: string) => p.replace(/\\/g, '/');

describe('what is composed equals what the repo vendors', () => {
  it('composes every core file identically for every vendored target', () => {
    const names = coreFiles(ROOT);
    expect(names.length).toBeGreaterThan(0);
    for (const target of CLIENT_TARGETS) {
      for (const name of names) {
        const vendored = readFileSync(join(ROOT, target, name), 'utf8');
        expect(sameText(composeCoreFile(ROOT, name), vendored)).toBe(true);
      }
    }
  });

  it('keeps the version stamp out of the committed copies', () => {
    // A version literal in a generated-and-committed file makes
    // "generated output == committed file" unable to hold across a release.
    // scripts/sync-hook-core.mjs carries the post-mortem; this holds the line.
    for (const target of [...PLUGIN_TARGETS, ...CLIENT_TARGETS]) {
      const observability = readFileSync(
        join(ROOT, target, 'observability.mjs'),
        'utf8'
      );
      // PINNED POSITIVELY FIRST, because a bare `not.toContain` also passes
      // on an empty read or a path that does not exist -- which the repo's
      // own local/no-vacuous-assertions rule caught here.
      expect(observability).toContain('// GENERATED FILE -- do not edit.');
      expect(observability).toContain('Source of truth: hooks-core/');
      expect(observability).not.toContain('TOKEN_OPTIMIZER_VERSION =');
    }
  });

  it('still applies the stamp when asked for it', () => {
    // THE POSITIVE CONTROL for the assertion above: the stamp mechanism works,
    // so its absence from the committed copies is a choice and not a breakage.
    const stamped = composeCoreFile(ROOT, 'observability.mjs', {
      stamp: true,
      version: '9.9.9',
    });
    expect(stamped).toContain("TOKEN_OPTIMIZER_VERSION = '9.9.9'");
  });
});

describe('the tarball carries the core once, the tree carries every copy', () => {
  const packed: string[] = JSON.parse(
    execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 200 * 1024 * 1024,
      shell: true,
    })
  )[0].files.map((f: { path: string }) => posix(f.path));

  it.each(PLUGIN_TARGETS)('ships the whole core under %s', (target) => {
    // EVERY name, not a count and not a spot check: a `files` pattern that
    // drops one module leaves an import that throws inside a hook whose catch
    // block is silent, so the client advises nothing and says nothing. Claude
    // Code loads this copy out of the installed package, so it cannot wait on
    // any command the user has to run first.
    const shipped = new Set(packed);
    const missing = coreFiles(ROOT).filter(
      (name) => !shipped.has(posix(join(target, name)))
    );
    expect(missing).toEqual([]);
  });

  it.each(CLIENT_TARGETS)('ships no vendored lib under %s', (target) => {
    // The inverse of the line above, pinned per target rather than by one
    // pattern: these are the 10.87MB the exclusion removes, and a `files`
    // entry that let one back in would undo the shrink without failing
    // anything else.
    expect(packed.filter((p) => p.startsWith(`${posix(target)}/`))).toEqual([]);
  });

  it.each(CLIENT_TARGETS)(
    'keeps the whole core in the TREE under %s',
    (target) => {
      // Not shipped is not the same as not needed: the installer composes from
      // hooks-core/, and `npm run sync:hooks:check` compares against these
      // committed copies, so a copy missing a module is still drift.
      const missing = coreFiles(ROOT).filter(
        (name) => !existsSync(join(ROOT, target, name))
      );
      expect(missing).toEqual([]);
    }
  );

  it('ships hooks-core, which every copy is composed from', () => {
    expect(packed.filter((p) => p.startsWith('hooks-core/')).length).toBe(
      coreFiles(ROOT).length
    );
  });
});
