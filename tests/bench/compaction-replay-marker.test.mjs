/**
 * The replay counts a result as already compacted only when the compactor's
 * notice is its last line, not wherever the notice's text happens to appear.
 */

import { describe, expect, test } from '@jest/globals';
import { wasCompacted } from '../../bench/field/compaction-replay.mjs';

const NOTICE =
  '[token-optimizer: 8 KB output compacted; 25 lines omitted; full output: Read C:\\a\\b.txt]';

describe('wasCompacted', () => {
  test('a result ending in the notice was compacted', () => {
    expect(wasCompacted('Bash', { stdout: `line 1\nline 2\n${NOTICE}\n` })).toBe(true);
    expect(wasCompacted('Grep', { content: `a.ts:1:x\n${NOTICE}` })).toBe(true);
  });

  test('a file that merely contains the notice text was not', () => {
    // A recorded `cat hooks-core/output-compact.mjs`.
    const source =
      "  const parts = [`[token-optimizer: ${kb(originalBytes)} output compacted`];\n" +
      '  return `${parts.join(\'; \')}; ${how}]`;\n}\n';
    expect(wasCompacted('Bash', { stdout: source })).toBe(false);
  });

  test('a compacted stderr counts: its original is gone too', () => {
    expect(wasCompacted('Bash', { stdout: 'ok\n', stderr: `warn\n${NOTICE}\n` })).toBe(true);
    expect(wasCompacted('Bash', { stdout: 'ok\n', stderr: `${NOTICE} -- quoted mid-line\nmore` })).toBe(false);
  });
});
