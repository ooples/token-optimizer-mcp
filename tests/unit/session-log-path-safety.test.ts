import { describe, it, expect } from '@jest/globals';
import { isValidSessionId } from '../../src/utils/session-id.js';

/**
 * A session id is the only thing that may shape a session-log path.
 *
 * Both dashboard endpoints concatenate a caller-supplied `sessionId` into a
 * filesystem path. The allowlist below is what stands between that and an
 * unauthenticated arbitrary read (CWE-22 / js/path-injection).
 *
 * CodeQL flagged the request parameter reaching readFileSync after a refactor
 * moved the read into a helper that took a PATH. The allowlist did close the
 * hole, but the proof lived in a different function from the read, so it held
 * only while every future caller remembered to call the validator. The helper
 * now takes an id and rebuilds the path itself; these cases pin the allowlist
 * that makes that safe.
 */
describe('session id validation', () => {
  it('accepts the ids the hooks actually generate', () => {
    expect(isValidSessionId('cfc9bff7-4a3b-448a-adaa-4cdd860c3764')).toBe(true);
    expect(isValidSessionId('20260731-170500-a1b2')).toBe(true);
    expect(isValidSessionId('smoketest')).toBe(true);
    expect(isValidSessionId('a')).toBe(true);
  });

  it('rejects every shape that could leave the hooks data directory', () => {
    for (const evil of [
      '../../../../etc/passwd',
      '..',
      '../secret',
      'a/../../b',
      'C:/Windows/win.ini',
      'C:\\Windows\\win.ini',
      '/etc/passwd',
      'sess/../..',
      'sess\\..\\..',
      'sess.jsonl', // a dot is enough to build an extension or a segment
      'sess\u0000.txt', // null byte truncation
      'sess%2F..%2F', // encoded separator, if ever decoded upstream
    ]) {
      expect(isValidSessionId(evil)).toBe(false);
    }
  });

  it('rejects empty and over-long ids', () => {
    expect(isValidSessionId('')).toBe(false);
    expect(isValidSessionId('x'.repeat(65))).toBe(false);
    expect(isValidSessionId('x'.repeat(64))).toBe(true);
  });

  it('rejects separators even without any dot segments', () => {
    // A bare separator still redirects the read, with no `..` involved.
    expect(isValidSessionId('sub/dir')).toBe(false);
    expect(isValidSessionId('sub\\dir')).toBe(false);
  });
});
