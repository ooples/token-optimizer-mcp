/**
 * THE VENDORED HOOK COPIES SHIP, AND EACH ONE IS SELF-SUFFICIENT WHERE IT RUNS.
 *
 * Eleven directories hold byte-identical copies of the same core -- 10.87MB of
 * tarball for 1.44MB of unique content -- so excluding the ten client ones from
 * `files` and composing each on the installed machine looks free. It is not,
 * and this file is what remains of finding that out.
 *
 * No client executes its hooks from inside the installed package. Each one runs
 * them from a copy the user makes, at a path that client dictates
 * (`.cursor/hooks/token-optimizer/`, `$HOME/.codex/hooks/`, `.github/hooks/`,
 * ...). A copy at such a path has no package tree above it, so composing "on
 * first use" cannot reach it, and the directory it was copied from had no
 * `lib/` to begin with. The documented install produced four entry files, no
 * core, and a pre-tool hook that printed nothing and allowed everything.
 *
 * Three claims therefore have a test here: what the repo vendors is what the
 * shared module composes, every target's whole core is in the tarball, and an
 * entry RUN FROM OUTSIDE ANY PACKAGE TREE still enforces. The third is the one
 * that failed; the earlier version of it copied `scripts/` into its sandbox and
 * so tested a shape no install ever has.
 */

import { describe, expect, it } from '@jest/globals';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
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

describe('the tarball carries every vendored copy whole', () => {
  const packed: string[] = JSON.parse(
    execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 200 * 1024 * 1024,
      shell: true,
    })
  )[0].files.map((f: { path: string }) => posix(f.path));

  it.each([...PLUGIN_TARGETS, ...CLIENT_TARGETS])(
    'ships the whole core under %s',
    (target) => {
      // EVERY name, not a count and not a spot check: a `files` pattern that
      // drops one module leaves an import that throws inside a hook whose
      // catch block is silent, so the client advises nothing and says nothing.
      const shipped = new Set(packed);
      const missing = coreFiles(ROOT).filter(
        (name) => !shipped.has(posix(join(target, name)))
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

describe('a client entry copied out of the package still enforces', () => {
  it('denies a large read from a directory with no package above it', () => {
    // THE SHAPE EVERY DOCUMENTED INSTALL PRODUCES. `capabilities.mjs` tells a
    // Cursor user to "copy `hooks/` to `.cursor/hooks/token-optimizer/`", so
    // what runs is a copy of this directory somewhere else entirely -- with no
    // package.json, no scripts/ and no hooks-core/ anywhere above it.
    const sandbox = mkdtempSync(join(tmpdir(), 'to-copied-hooks-'));
    try {
      const source = join('integrations', 'cursor', 'hooks');
      const destination = join(sandbox, 'token-optimizer');
      mkdirSync(join(destination, 'lib'), { recursive: true });
      // Copied from the TARBALL's file list rather than from the working tree,
      // because the bug this test exists for was a `files` pattern: the tree
      // had every file and the package did not.
      const shipped: string[] = JSON.parse(
        execFileSync('npm', ['pack', '--dry-run', '--json'], {
          cwd: ROOT,
          encoding: 'utf8',
          maxBuffer: 200 * 1024 * 1024,
          shell: true,
        })
      )[0]
        .files.map((f: { path: string }) => posix(f.path))
        .filter((p: string) => p.startsWith(`${posix(source)}/`));
      expect(shipped.length).toBeGreaterThan(coreFiles(ROOT).length);
      for (const path of shipped) {
        const relative = path.slice(`${posix(source)}/`.length);
        copyFileSync(join(ROOT, path), join(destination, relative));
      }

      const big = join(sandbox, 'big.ts');
      writeFileSync(big, 'x'.repeat(80_000));

      const result = spawnSync(
        process.execPath,
        [join(destination, 'pre-tool.mjs')],
        {
          input: JSON.stringify({
            session_id: `copied-cursor-${randomUUID()}`,
            cwd: sandbox,
            tool_name: 'read_file',
            tool_input: { path: big },
          }),
          encoding: 'utf8',
          env: {
            ...process.env,
            // The hook's own state stays inside the sandbox; a test must never
            // write to the real home cache.
            HOME: sandbox,
            USERPROFILE: sandbox,
            TOKEN_OPTIMIZER_CACHE_DIR: join(sandbox, 'cache'),
            TOKEN_OPTIMIZER_MODE: 'enforce',
          },
          timeout: 120_000,
        }
      );

      // A SILENT EXIT 0 IS THE FAILURE MODE, so the decision is pinned
      // positively: the broken package produced empty stdout here, which any
      // assertion phrased as "did not allow" would have passed.
      const decision = JSON.parse(result.stdout.trim());
      expect(decision.permission).toBe('deny');
      expect(decision.agent_message).toContain('smart_read');
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
