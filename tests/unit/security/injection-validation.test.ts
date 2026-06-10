import { describe, it, expect } from '@jest/globals';
import { validateToolArgs } from '../../../src/validation/validator.js';
import { isValidSessionId } from '../../../src/server/web-server.js';

/**
 * Defense-in-depth tests: the tightened Zod schemas reject command-injection
 * payloads in the security-sensitive fields of the affected tools, and the
 * dashboard session-id guard blocks path traversal (GHSA-76pc-mqxp-3rq5).
 */
describe('tool-schema injection rejection', () => {
  it('smart_install: rejects a non-allowlisted packageManager', () => {
    expect(() =>
      validateToolArgs('smart_install', { packageManager: 'npm; id #' })
    ).toThrow(/Validation failed/);
  });

  it('smart_install: rejects option-flag package specs', () => {
    expect(() =>
      validateToolArgs('smart_install', { packages: ['--registry=http://evil'] })
    ).toThrow(/Validation failed/);
  });

  it('smart_install: accepts a valid invocation', () => {
    expect(
      validateToolArgs('smart_install', {
        packageManager: 'npm',
        packages: ['lodash', '@scope/pkg'],
        dev: true,
      })
    ).toMatchObject({ packageManager: 'npm' });
  });

  it('smart_merge: rejects an injection payload in branch', () => {
    expect(() =>
      validateToolArgs('smart_merge', { branch: 'main; rm -rf /' })
    ).toThrow(/Validation failed/);
  });

  it('smart_log: rejects a command-substitution filePath', () => {
    expect(() =>
      validateToolArgs('smart_log', { filePath: 'a\nb' })
    ).toThrow(/Validation failed/);
  });

  it('smart_diff: accepts legitimate refs and files', () => {
    expect(
      validateToolArgs('smart_diff', {
        source: 'HEAD~1',
        target: 'HEAD',
        files: ['src/index.ts'],
      })
    ).toMatchObject({ source: 'HEAD~1' });
  });

  it('smart_branch: rejects mergedInto injection', () => {
    expect(() =>
      validateToolArgs('smart_branch', { mergedInto: '$(id)' })
    ).toThrow(/Validation failed/);
  });
});

describe('dashboard session-id guard (path traversal)', () => {
  it('accepts well-formed session ids', () => {
    expect(isValidSessionId('abc123')).toBe(true);
    expect(isValidSessionId('session_2024-01-01')).toBe(true);
  });

  it('rejects path-traversal payloads', () => {
    for (const payload of [
      'abc/../../../../etc/passwd',
      '../../secret',
      'a/b',
      'a.b',
      '',
      'a'.repeat(65),
    ]) {
      expect(isValidSessionId(payload)).toBe(false);
    }
  });
});
