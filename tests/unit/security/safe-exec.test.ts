import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtempSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  execFileSafeSync,
  execFileSafe,
  assertSafeGitRef,
  assertSafePathArg,
  assertSafeArg,
  assertAllowed,
} from '../../../src/utils/safe-exec.js';

/**
 * Security regression tests for the argv-mode command helpers and validators
 * introduced to remediate the OS command-injection advisories
 * (GHSA-29p3-56wx-ggfh, GHSA-8w8q-fgv9-j286, GHSA-49mq-fc6q-3h46).
 */
describe('safe-exec validators', () => {
  describe('assertSafeGitRef', () => {
    it('accepts legitimate git refs', () => {
      for (const ref of [
        'main',
        'HEAD',
        'feature/foo-bar',
        'v1.2.3',
        'release_2024',
        'origin/main',
        '@{u}',
      ]) {
        expect(assertSafeGitRef(ref)).toBe(ref);
      }
    });

    it('rejects command-injection payloads', () => {
      for (const payload of [
        'main; id',
        '$(id)',
        '`id`',
        'a|b',
        'a && b',
        'a > /tmp/x',
        "a'b",
        'a"b',
        'a b',
        'main\nid',
      ]) {
        expect(() => assertSafeGitRef(payload)).toThrow();
      }
    });

    it("rejects refs starting with '-' (option injection)", () => {
      expect(() => assertSafeGitRef('--upload-pack=evil')).toThrow();
    });

    it('rejects empty and over-long refs', () => {
      expect(() => assertSafeGitRef('')).toThrow();
      expect(() => assertSafeGitRef('a'.repeat(257))).toThrow();
    });
  });

  describe('assertSafePathArg / assertSafeArg', () => {
    it('accepts normal paths and identifiers', () => {
      for (const value of [
        'src/index.ts',
        './a/b/c.txt',
        'file with spaces.txt',
        'nginx.service',
        'user_name',
        'foo@bar.service',
      ]) {
        expect(assertSafePathArg(value)).toBe(value);
        expect(assertSafeArg(value)).toBe(value);
      }
    });

    it('rejects NUL and newline characters', () => {
      expect(() => assertSafePathArg('a\0b')).toThrow();
      expect(() => assertSafePathArg('a\nb')).toThrow();
      expect(() => assertSafeArg('a\rb')).toThrow();
    });

    it("rejects values starting with '-'", () => {
      expect(() => assertSafePathArg('-rf')).toThrow();
      expect(() => assertSafeArg('--privileged')).toThrow();
    });
  });

  describe('assertAllowed', () => {
    it('accepts allowed values and rejects others', () => {
      const allowed = ['npm', 'yarn', 'pnpm'] as const;
      expect(assertAllowed('npm', allowed, 'packageManager')).toBe('npm');
      expect(() => assertAllowed('npm; id', allowed, 'packageManager')).toThrow();
      expect(() => assertAllowed('bun', allowed, 'packageManager')).toThrow();
    });
  });
});

describe('argv-mode execution neutralizes shell metacharacters', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    while (tempDirs.length) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'token-optimizer-safeexec-'));
    tempDirs.push(dir);
    return dir;
  }

  it('passes a metacharacter-laden argument verbatim (no shell parsing)', () => {
    const payload = 'hello; world && $(id) `id` | cat';
    // node -e <script> <arg> → arg becomes process.argv[1] of the script.
    const out = execFileSafeSync('node', [
      '-e',
      'process.stdout.write(process.argv[1])',
      payload,
    ]);
    expect(out).toBe(payload);
  });

  it('does NOT execute an injected command embedded in an argument', () => {
    const dir = tempDir();
    const marker = join(dir, 'PWNED');
    // If a shell were interpreting this, the marker file would be created.
    const injection = `x"; require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); "`;
    execFileSafeSync('node', [
      '-e',
      'process.stdout.write("ok")',
      injection,
    ]);
    expect(existsSync(marker)).toBe(false);
  });

  it('execFileSafe (async) resolves with stdout/stderr strings', async () => {
    const { stdout } = await execFileSafe('node', [
      '-e',
      'process.stdout.write("async-ok")',
    ]);
    expect(stdout).toBe('async-ok');
  });
});
