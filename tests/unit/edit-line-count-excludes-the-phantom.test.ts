import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SmartEditTool } from '../../src/tools/file-operations/smart-edit.js';
import { CacheEngine } from '../../src/core/cache-engine.js';
import { TokenCounter } from '../../src/core/token-counter.js';
import { MetricsCollector } from '../../src/core/metrics.js';

/**
 * A file ending in a newline has N lines, not N+1.
 *
 * `content.split(/
?
/)` leaves a trailing empty element for any file that ends
 * with a newline -- nearly all of them -- so a 10-line file was reported as 11 in
 * `metadata.originalLines`, and that same inflated number was handed to
 * `validateOperations` as the file's length.
 *
 * A wrong count is not cosmetic here: it is the number a caller uses to decide
 * which lines it may address, and this tool returns it. Advertising line 11 of a
 * 10-line file invites an edit against a line that does not exist.
 *
 * SCOPE, stated precisely because the first version of this file overstated it.
 * The bug was found by driving the INSTALLED 5.4.3 plugin, where `replace` at
 * line 11 of a 10-line file returned success, appended the content and destroyed
 * the trailing newline. Checked against master afterwards, that no longer
 * happens -- the operation is already refused with the file left intact, so the
 * corruption is fixed and only the wrong COUNT survives. Claiming this change
 * fixes the corruption would have been false, and a mutation test caught it:
 * reverting the validation bound left every assertion here still passing.
 *
 * The refusal and no-write assertions are kept as regression guards for the
 * behaviour master already has. The count assertion is the one that fails
 * without this change.
 */

let dir: string;
let cache: CacheEngine;
let tokenCounter: TokenCounter;
let metrics: MetricsCollector;
let tool: SmartEditTool;

const TEN_LINES = 'L01\nL02\nL03\nL04\nL05\nL06\nL07\nL08\nL09\nL10\n';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'edit-lines-'));
  cache = new CacheEngine(join(dir, 'cache'), 10);
  tokenCounter = new TokenCounter();
  metrics = new MetricsCollector();
  tool = new SmartEditTool(cache, tokenCounter, metrics);
});

afterEach(() => {
  try {
    cache.close?.();
  } catch {
    // temp dir goes anyway
  }
  rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, body: string) => {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
};

describe('line counting for a file that ends with a newline', () => {
  it('reports the real number of lines', async () => {
    const path = write('count.txt', TEN_LINES);

    const result = await tool.edit(path, {
      operations: [{ type: 'replace', startLine: 1, endLine: 1, content: 'X' }],
    });

    expect(result.metadata?.originalLines).toBe(10);
  });

  it('refuses to replace a line past the end of the file', async () => {
    const path = write('phantom.txt', TEN_LINES);

    // It refuses by RETURNING failure, not by throwing -- checked rather than
    // assumed, because an earlier version of this test expected a rejection and
    // would have failed against correct behaviour.
    const result = await tool.edit(path, {
      operations: [
        { type: 'replace', startLine: 11, endLine: 11, content: 'PHANTOM' },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.metadata?.editsApplied ?? 0).toBe(0);
  });

  it('leaves the file untouched when it refuses', async () => {
    // A refusal that had already written is worse than no refusal.
    const path = write('untouched.txt', TEN_LINES);

    await tool
      .edit(path, {
        operations: [
          { type: 'replace', startLine: 11, endLine: 11, content: 'PHANTOM' },
        ],
      })
      .catch(() => undefined);

    expect(readFileSync(path, 'utf8')).toBe(TEN_LINES);
  });

  it('does not silently corrupt the file when asked to append past the end', async () => {
    // `insert` one past the last line does NOT append -- verified against master,
    // so it is pre-existing and NOT a regression from this change. It is recorded
    // here rather than fixed, because what matters for this defect is that the
    // refusal is clean: nothing written, trailing newline intact.
    const path = write('append.txt', TEN_LINES);

    const result = await tool.edit(path, {
      operations: [{ type: 'insert', startLine: 11, content: 'L11' }],
    });

    expect(result.success).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(TEN_LINES);
  });

  it('keeps the trailing newline on an ordinary edit', async () => {
    const path = write('newline.txt', TEN_LINES);

    await tool.edit(path, {
      operations: [
        { type: 'replace', startLine: 2, endLine: 2, content: 'TWO' },
      ],
    });

    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true);
  });

  it('counts a file with no trailing newline as-is', async () => {
    // The phantom only exists when the content ends with a separator.
    const path = write('bare.txt', 'A\nB\nC');

    const result = await tool.edit(path, {
      operations: [{ type: 'replace', startLine: 1, endLine: 1, content: 'X' }],
    });

    expect(result.metadata?.originalLines).toBe(3);
  });
});
