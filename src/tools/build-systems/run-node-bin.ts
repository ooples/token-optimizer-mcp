/**
 * Running a project's own CLI without a shell and without a `.cmd` shim.
 *
 * THE BUG THIS EXISTS FOR. These tools spawned `npx.cmd` on Windows with
 * `shell: false`, which used to be exactly right: naming the shim explicitly
 * meant caller-controlled arguments could never be reinterpreted by a shell.
 *
 * Node 20.12 changed that. As the fix for CVE-2024-27980 -- argument injection
 * through batch files -- Node now REFUSES to spawn any `.cmd` or `.bat` unless
 * `shell: true`, and throws EINVAL instead. Measured on this machine: every one
 * of smart_build, smart_install, smart_lint, smart_test and smart_typecheck
 * threw `spawn EINVAL` on every call. The entire build-systems category was
 * broken on Windows, and the obvious "fix" -- adding `shell: true` -- would
 * reintroduce precisely the injection the original comment was guarding
 * against.
 *
 * The way out is to stop involving a shim at all. Every one of these CLIs is a
 * JavaScript file; `node <that file> <args>` is argv mode, no shell, no batch
 * file, and identical on every platform.
 */

import {
  spawn,
  type SpawnOptionsWithoutStdio,
  type ChildProcessWithoutNullStreams,
} from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, dirname, resolve } from 'path';

/**
 * Finds the JS entry point of a package's CLI, searching upward from the
 * project so a locally installed copy wins over a global one.
 *
 * Returns null when the package is not installed -- the caller can then say so
 * plainly instead of failing with an errno.
 */
export function resolveBinScript(
  packageName: string,
  binName: string,
  fromDir: string
): string | null {
  let dir = resolve(fromDir);

  for (let depth = 0; depth < 40; depth++) {
    const pkgDir = join(dir, 'node_modules', packageName);
    const manifest = join(pkgDir, 'package.json');

    if (existsSync(manifest)) {
      try {
        const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as {
          bin?: string | Record<string, string>;
        };
        const bin = pkg.bin;
        const relative =
          typeof bin === 'string' ? bin : bin?.[binName] ?? Object.values(bin ?? {})[0];
        if (relative) {
          const script = join(pkgDir, relative);
          if (existsSync(script)) return script;
        }
      } catch {
        // A manifest we cannot read is treated as not found.
      }
    }

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

export class MissingProjectTool extends Error {
  constructor(packageName: string, toolName: string) {
    super(
      `${toolName} needs "${packageName}", which is not installed in this project.\n` +
        `  Install it with:  npm install --save-dev ${packageName}`
    );
    this.name = 'MissingProjectTool';
  }
}

/**
 * Spawns a package's CLI through the current Node binary.
 *
 * `shell: false` throughout: arguments reach the CLI as argv and are never
 * parsed by cmd.exe or sh, which is the property the original code wanted and
 * that `shell: true` would have thrown away.
 */
export function spawnNodeBin(
  packageName: string,
  binName: string,
  args: string[],
  options: SpawnOptionsWithoutStdio & { cwd: string },
  toolName: string
): ChildProcessWithoutNullStreams {
  const script = resolveBinScript(packageName, binName, options.cwd);
  if (!script) throw new MissingProjectTool(packageName, toolName);

  return spawn(process.execPath, [script, ...args], {
    ...options,
    shell: false,
    windowsHide: true,
  });
}

/**
 * The npm CLI, which ships with Node itself.
 *
 * `npm.cmd` hits the same EINVAL, but npm's own JS entry sits next to the node
 * binary in every distribution, so it can be run the same way.
 */
export function resolveNpmScript(): string | null {
  const nodeDir = dirname(process.execPath);
  const candidates = [
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

export function spawnNpm(
  args: string[],
  options: SpawnOptionsWithoutStdio & { cwd: string },
  toolName: string
): ChildProcessWithoutNullStreams {
  const script = resolveNpmScript();
  if (!script) throw new MissingProjectTool('npm', toolName);

  return spawn(process.execPath, [script, ...args], {
    ...options,
    shell: false,
    windowsHide: true,
  });
}

/**
 * The same resolution, for callers that run a package manager SYNCHRONOUSLY.
 *
 * Returns the executable and the arguments that must precede the caller's own,
 * so an `execFileSync`-style call site becomes
 *
 *     const { command, prefix } = packageManagerInvocation('npm', cwd, 'tool');
 *     execFileSync(command, [...prefix, 'list', '--json'], { cwd });
 *
 * -- still argv mode, still no shell, and never a `.cmd` for Node to refuse.
 */
export function packageManagerInvocation(
  packageManager: string,
  cwd: string,
  toolName: string
): { command: string; prefix: string[] } {
  const script =
    packageManager === 'npm'
      ? resolveNpmScript()
      : resolveBinScript(packageManager, packageManager, cwd);

  if (!script) throw new MissingProjectTool(packageManager, toolName);
  return { command: process.execPath, prefix: [script] };
}
