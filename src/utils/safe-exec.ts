/**
 * Safe command execution helpers (argv-mode, no shell).
 *
 * SECURITY: These helpers exist to eliminate the OS command-injection class
 * (CWE-78) that affected the smart_* git/system/build tools. The vulnerable
 * pattern was building a single command string with caller-controlled values
 * interpolated into it, then running it through `execSync`/`execAsync` or
 * `spawn(..., { shell: true })`. A shell then interpreted metacharacters such
 * as `;`, `|`, `$(...)`, and backticks, allowing arbitrary command execution.
 *
 * The fix is to ALWAYS pass the binary plus an argument ARRAY to
 * `execFile`/`spawn` with `shell: false`. In argv mode the OS executes the
 * binary directly and each array element is delivered to the process verbatim
 * as a single argument — no shell, so shell-metacharacter interpretation is
 * impossible regardless of input.
 *
 * Never reintroduce string-concatenated commands, `shell: true`, or
 * `execSync(`...${userInput}...`)` in tool code. Route everything through the
 * helpers below.
 */

import { execFile, execFileSync, spawn } from 'child_process';
import { promisify } from 'util';

const execFileAsyncImpl = promisify(execFile);

/** Default maximum bytes captured from a child process (10 MB). */
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

export interface SafeExecOptions {
  cwd?: string;
  /** Text encoding for captured output. Defaults to 'utf-8'. */
  encoding?: BufferEncoding;
  /** Milliseconds before the child is killed. */
  timeout?: number;
  /** Maximum bytes of stdout/stderr to buffer. */
  maxBuffer?: number;
  /** Environment variables for the child process. */
  env?: NodeJS.ProcessEnv;
  /** Data to write to the child's stdin. */
  input?: string;
  /** When true, resolve with stdout even if the process exits non-zero. */
  ignoreExitCode?: boolean;
}

/**
 * Run a command synchronously in argv mode and return its stdout.
 *
 * @param file  The executable name or path (never a full command string).
 * @param args  Argument array; each element is passed verbatim to the process.
 */
export function execFileSafeSync(
  file: string,
  args: readonly string[] = [],
  options: SafeExecOptions = {}
): string {
  // With `encoding` set, execFileSync returns a string.
  return execFileSync(file, [...args], {
    cwd: options.cwd,
    encoding: options.encoding ?? 'utf-8',
    timeout: options.timeout,
    maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
    env: options.env,
    input: options.input,
    shell: false,
    windowsHide: true,
  });
}

/**
 * Run a command asynchronously in argv mode.
 *
 * @returns Resolves with `{ stdout, stderr }`.
 */
export async function execFileSafe(
  file: string,
  args: readonly string[] = [],
  options: SafeExecOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsyncImpl(file, [...args], {
      cwd: options.cwd,
      encoding: options.encoding ?? 'utf-8',
      timeout: options.timeout,
      maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
      env: options.env,
      windowsHide: true,
      shell: false,
    });
    // With `encoding` set, execFile yields strings.
    return { stdout: stdout as string, stderr: stderr as string };
  } catch (error) {
    if (
      options.ignoreExitCode &&
      error &&
      typeof error === 'object' &&
      'stdout' in error
    ) {
      const e = error as { stdout?: string | Buffer; stderr?: string | Buffer };
      return {
        stdout: e.stdout ? e.stdout.toString() : '',
        stderr: e.stderr ? e.stderr.toString() : '',
      };
    }
    throw error;
  }
}

/**
 * Spawn a command in argv mode (no shell) and collect its output.
 * Use this where streaming/long-running behaviour is needed instead of the
 * buffered `execFileSafe`.
 */
export function spawnSafe(
  file: string,
  args: readonly string[] = [],
  options: SafeExecOptions = {}
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });
    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    if (options.input !== undefined && child.stdin) {
      child.stdin.write(options.input);
      child.stdin.end();
    }

    child.on('error', (err) => reject(err));
    child.on('close', (code) => resolve({ stdout, stderr, code }));
  });
}

// ---------------------------------------------------------------------------
// Input validators (defense-in-depth alongside argv-mode execution)
// ---------------------------------------------------------------------------

/**
 * Allowed characters for a git ref / branch / tag / commit-ish.
 * Git refs cannot contain shell metacharacters, whitespace, or control chars,
 * so this allowlist is both safe and non-restrictive for legitimate refs.
 */
const GIT_REF_RE = /^[A-Za-z0-9._/+@~^{}-]+$/;
const MAX_GIT_REF_LENGTH = 256;

/**
 * Validate a git ref-like value. Throws on anything outside the allowlist.
 * Returns the value unchanged when valid (so it can be used inline).
 */
export function assertSafeGitRef(value: string, fieldName = 'ref'): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid ${fieldName}: must be a non-empty string`);
  }
  if (value.length > MAX_GIT_REF_LENGTH) {
    throw new Error(
      `Invalid ${fieldName}: exceeds ${MAX_GIT_REF_LENGTH} characters`
    );
  }
  if (!GIT_REF_RE.test(value)) {
    throw new Error(
      `Invalid ${fieldName}: contains characters not allowed in a git ref`
    );
  }
  // Reject ref forms git itself rejects / that could be option-injected.
  if (value.startsWith('-')) {
    throw new Error(`Invalid ${fieldName}: must not start with '-'`);
  }
  return value;
}

const MAX_PATH_LENGTH = 4096;

/**
 * Validate a generic command argument (e.g. username, group name, path).
 * Even in argv mode we reject:
 *   - NUL / CR / LF, which can corrupt argument parsing, and
 *   - a leading '-', which a binary may interpret as an option flag rather
 *     than a positional argument (option injection).
 */
export function assertSafeArg(value: string, fieldName = 'argument'): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid ${fieldName}: must be a non-empty string`);
  }
  if (value.length > MAX_PATH_LENGTH) {
    throw new Error(
      `Invalid ${fieldName}: exceeds ${MAX_PATH_LENGTH} characters`
    );
  }
  if (/[\0\n\r]/.test(value)) {
    throw new Error(
      `Invalid ${fieldName}: contains illegal control characters`
    );
  }
  if (value.startsWith('-')) {
    throw new Error(`Invalid ${fieldName}: must not start with '-'`);
  }
  return value;
}

/**
 * Validate a path argument used in a command. Alias of {@link assertSafeArg}
 * with a path-oriented default field name.
 */
export function assertSafePathArg(value: string, fieldName = 'path'): string {
  return assertSafeArg(value, fieldName);
}

/**
 * Ensure a value is one of an allowed set. Use for enum-like arguments such as
 * package manager name, merge strategy, etc.
 */
export function assertAllowed<T extends string>(
  value: string,
  allowed: readonly T[],
  fieldName = 'value'
): T {
  if (!allowed.includes(value as T)) {
    throw new Error(
      `Invalid ${fieldName}: '${value}' is not one of ${allowed.join(', ')}`
    );
  }
  return value as T;
}
