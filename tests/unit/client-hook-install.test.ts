/**
 * THE TEN CLIENT CORES ARE NOT SHIPPED, AND THE INSTALLER IS WHY THAT IS SAFE.
 *
 * Ten integrations vendor byte-identical copies of the same core -- 10.87MB of
 * tarball for 1.44MB of unique content -- so `files` excludes them and
 * `scripts/install-client-hooks.mjs` composes each copy into the destination.
 *
 * The design this replaced composed "on first use" from inside the hook, and it
 * shipped a package in which all ten were silently inert: no client runs its
 * hooks from inside the installed package, so nothing the hook could execute
 * was able to find the composer. The fix inverts it -- the composer runs FROM
 * the package, where it can always be found, and writes TO the destination.
 *
 * Which means this file has to prove two things a file-count test cannot: that
 * the tarball carries everything the installer needs, and that what the
 * installer writes OUTSIDE ANY PACKAGE TREE actually enforces. The negative
 * control is the plain `cp -r` the installer replaces, against the same files.
 */

import { describe, expect, it } from '@jest/globals';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { coreFiles } from '../../scripts/lib/hook-core.mjs';
import { CLIENT_KEYS, specFor } from '../../scripts/install-client-hooks.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const posix = (p: string) => p.replace(/\\/g, '/');

const packed: string[] = JSON.parse(
  execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 200 * 1024 * 1024,
    shell: true,
  })
)[0].files.map((f: { path: string }) => posix(f.path));

/**
 * A tree holding exactly the files the tarball ships, and nothing else.
 *
 * Built from `npm pack --dry-run --json` rather than from the working tree,
 * because the whole question is what the PACKAGE carries: the tree has every
 * vendored copy and the package deliberately does not.
 */
function shippedPackage(): string {
  const sandbox = mkdtempSync(join(tmpdir(), 'to-shipped-'));
  for (const path of packed) {
    const destination = join(sandbox, path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(ROOT, path), destination);
  }
  return sandbox;
}

describe('the tarball drops the ten copies and keeps what the installer needs', () => {
  it('ships no vendored lib under integrations', () => {
    expect(packed.filter((p) => /^integrations\/.*\/lib\//.test(p))).toEqual(
      []
    );
  });

  it('still ships plugin/hooks/lib, which Claude Code loads directly', () => {
    // Claude Code reads this one straight out of the installed package, so it
    // cannot wait on any command the user has to run first.
    const names = coreFiles(ROOT);
    const shipped = new Set(packed);
    expect(names.filter((n) => !shipped.has(`plugin/hooks/lib/${n}`))).toEqual(
      []
    );
  });

  it('ships hooks-core and every module the installer imports', () => {
    const shipped = new Set(packed);
    expect(
      coreFiles(ROOT).filter((n) => !shipped.has(`hooks-core/${n}`))
    ).toEqual([]);
    // text.mjs is as load-bearing as the other two: the installer imports it,
    // and a `files` pattern that left it out would make the command throw on
    // every client while the package otherwise looked complete.
    for (const module of [
      'scripts/install-client-hooks.mjs',
      'scripts/lib/hook-core.mjs',
      'scripts/lib/main-module.mjs',
      'scripts/lib/text.mjs',
    ]) {
      expect(packed).toContain(module);
    }
  });
});

describe('the installer composes a complete core outside the package', () => {
  it.each(CLIENT_KEYS)('installs the whole core for %s', (client) => {
    const shipped = shippedPackage();
    const destination = mkdtempSync(join(tmpdir(), `to-dest-${client}-`));
    try {
      const result = spawnSync(
        process.execPath,
        [
          join(shipped, 'scripts', 'install-client-hooks.mjs'),
          '--client',
          client,
          '--dest',
          destination,
        ],
        { encoding: 'utf8', timeout: 120_000 }
      );
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);

      // Pinned against the destination, not the source: the point of the
      // command is that it writes a tree with no package above it.
      const library = join(destination, specFor(client).lib);
      const missing = coreFiles(ROOT).filter(
        (name) => !existsSync(join(library, name))
      );
      expect(missing).toEqual([]);
    } finally {
      rmSync(shipped, { recursive: true, force: true });
      rmSync(destination, { recursive: true, force: true });
    }
  });
});

describe('what the installer writes enforces, and a plain copy does not', () => {
  const run = (entry: string, payload: unknown, home: string) => {
    const environment = { ...process.env } as Record<string, string>;
    delete environment.TOKEN_OPTIMIZER_MCP_CAPABILITIES;
    const result = spawnSync(process.execPath, [entry], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout: 180_000,
      env: {
        ...environment,
        HOME: home,
        USERPROFILE: home,
        TOKEN_OPTIMIZER_CACHE_DIR: join(home, 'cache'),
        TOKEN_OPTIMIZER_MODE: 'enforce',
      },
    });
    const out = (result.stdout || '').trim();
    // The repo's own rule, from tests/hooks/clients.test.mjs: a protocol that
    // refuses by EXIT CODE 2 writes no stdout at all.
    if (!out) return { decision: result.status === 2 ? 'deny' : 'allow' };
    const parsed = JSON.parse(out);
    const inner = parsed.hookSpecificOutput || parsed;
    return {
      decision:
        parsed.decision ||
        inner.permissionDecision ||
        inner.permission ||
        'allow',
    };
  };

  it('denies a large read through an installed cursor entry', () => {
    const shipped = shippedPackage();
    const destination = mkdtempSync(join(tmpdir(), 'to-cursor-'));
    try {
      execFileSync(
        process.execPath,
        [
          join(shipped, 'scripts', 'install-client-hooks.mjs'),
          '--client',
          'cursor',
          '--dest',
          destination,
        ],
        { encoding: 'utf8', timeout: 120_000 }
      );
      const big = join(destination, 'big.ts');
      writeFileSync(big, 'x'.repeat(80_000));
      // A FRESH SESSION ID, because hook state persists per id: reusing one
      // lets the second run rehydrate the first and answer `advise` where a
      // new session denies, which reads exactly like a regression.
      expect(
        run(
          join(destination, 'pre-tool.mjs'),
          {
            session_id: `installed-cursor-${randomUUID()}`,
            cwd: destination,
            tool_name: 'read_file',
            tool_input: { path: big },
          },
          destination
        ).decision
      ).toBe('deny');
    } finally {
      rmSync(shipped, { recursive: true, force: true });
      rmSync(destination, { recursive: true, force: true });
    }
  });

  it('allows everything after the plain copy the installer replaces', () => {
    // THE NEGATIVE CONTROL, and the reason the command exists. Same shipped
    // files, copied the way the old docs said: four entry files, no core, and a
    // hook that prints nothing and permits the read. Without this arm the test
    // above cannot tell "the installer works" from "enforce denies anyway".
    const shipped = shippedPackage();
    const destination = mkdtempSync(join(tmpdir(), 'to-plain-copy-'));
    try {
      const source = 'integrations/cursor/hooks';
      const copied = packed.filter((p) => p.startsWith(`${source}/`));
      expect(copied.length).toBeGreaterThan(0);
      for (const path of copied) {
        copyFileSync(
          join(shipped, path),
          join(destination, path.slice(`${source}/`.length))
        );
      }
      expect(existsSync(join(destination, 'lib', 'adapter.mjs'))).toBe(false);

      const big = join(destination, 'big.ts');
      writeFileSync(big, 'x'.repeat(80_000));
      expect(
        run(
          join(destination, 'pre-tool.mjs'),
          {
            session_id: `plain-copy-${randomUUID()}`,
            cwd: destination,
            tool_name: 'read_file',
            tool_input: { path: big },
          },
          destination
        ).decision
      ).toBe('allow');
    } finally {
      rmSync(shipped, { recursive: true, force: true });
      rmSync(destination, { recursive: true, force: true });
    }
  });
});

// The committed copies' stamp and composition parity are pinned once, in
// tests/unit/hook-core-vendored-copies.test.ts, which owns the vendored tree.

describe('the published bin runs the way the docs say to run it', () => {
  const bin: Record<string, string> = JSON.parse(
    readFileSync(join(ROOT, 'package.json'), 'utf8')
  ).bin;
  const scriptBins = Object.values(bin)
    .map((path) => path.replace(/^\.\//, ''))
    .filter((path) => path.startsWith('scripts/'));

  it('gives every script bin an interpreter line', () => {
    // npm links a bin as a bare executable, so on POSIX the kernel needs the
    // shebang to know what to run the file with. install-client-hooks.mjs
    // shipped without one while all six of its neighbours had it.
    const firstLines = scriptBins.map(
      (path) =>
        `${path} ${readFileSync(join(ROOT, path), 'utf8').split('\n')[0].trim()}`
    );
    expect(firstLines).toEqual(
      scriptBins.map((path) => `${path} #!/usr/bin/env node`)
    );
  });

  /**
   * The file under the name npm gives it: a symlink where the platform allows
   * one (npm's own shape, and what makes the realpath comparison necessary),
   * a hardlink otherwise, which still changes the basename the guard sees.
   */
  const linkAs = (real: string, directory: string, name: string) => {
    const link = join(directory, name);
    try {
      symlinkSync(real, link);
      return link;
    } catch {
      linkSync(real, `${link}.mjs`);
      return `${link}.mjs`;
    }
  };

  it('writes the core when invoked under its linked bin name', () => {
    // The regression this pins. The guard tested argv[1]'s BASENAME, which is
    // the command name through node_modules/.bin, so the CLI block never ran:
    // measured before the fix, exit 0, no output, 0 files written -- the same
    // silent success the whole PR exists to remove.
    const shipped = shippedPackage();
    const destination = mkdtempSync(join(tmpdir(), 'to-linked-'));
    try {
      const linked = linkAs(
        join(shipped, 'scripts', 'install-client-hooks.mjs'),
        join(shipped, 'scripts'),
        'token-optimizer-install-client'
      );
      const result = spawnSync(
        process.execPath,
        [linked, '--client', 'cursor', '--dest', destination],
        { encoding: 'utf8', timeout: 120_000 }
      );
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('installed cursor hooks: ');
      const present = coreFiles(ROOT).filter((name) =>
        existsSync(join(destination, 'lib', name))
      );
      expect(present).toEqual(coreFiles(ROOT));
    } finally {
      rmSync(shipped, { recursive: true, force: true });
      rmSync(destination, { recursive: true, force: true });
    }
  });
});
