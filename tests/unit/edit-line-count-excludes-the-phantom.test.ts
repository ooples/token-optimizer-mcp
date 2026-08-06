import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  SmartEditTool,
  type EditOperation,
} from '../../src/tools/file-operations/smart-edit.js';
import { CacheEngine } from '../../src/core/cache-engine.js';
import { TokenCounter } from '../../src/core/token-counter.js';
import { MetricsCollector } from '../../src/core/metrics.js';

/**
 * A file ending in a newline has N lines, not N+1 -- and only `insert` may
 * address the position after the last one.
 *
 * Splitting content that ends with a newline leaves a trailing empty element, so
 * a 10-line file yields 11. That number was reported as `originalLines`, counted
 * again as `finalLines`, and handed to `validateOperations` as the file's length,
 * which made line 11 of a 10-line file addressable by every operation type.
 *
 * WHAT THE PHANTOM ACTUALLY COSTS, measured on a 10-line file ending in a
 * newline, driving the tool the way the MCP server does:
 *
 *   replace @ 11  -> success, verified: true, content appended, TRAILING NEWLINE GONE
 *   delete  @ 11  -> success, verified: true, the separator itself removed
 *   insert  @ 11  -> success, appends correctly (this one is legitimate)
 *
 * Both corrupting cases report success, so nothing surfaces until git shows the
 * last line as modified.
 *
 * WHY THIS FILE WAS REWRITTEN. Its first version asserted that `replace` and
 * `delete` past the end were already refused with the file intact, and every
 * assertion passed. They passed for the wrong reason: the calls were written as
 * `edit(path, { operations: [...] })` when the signature is
 * `edit(path, operations, options)`, so the tool received one object that was not
 * an operation, executed nothing, and truthfully reported "nothing applied, file
 * unchanged". The suite was green and testing nothing. Called correctly, the
 * corruption above is exactly what happens.
 *
 * Two things follow, and both are in this change: the validator now REFUSES a
 * malformed operation instead of silently doing nothing with it, and every test
 * below asserts a positive outcome -- what the file contains afterwards, what
 * changed -- rather than only that something failed. An assertion that only ever
 * checks for failure is satisfied by a call that never ran.
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
  it('reports the real number of lines on both sides of the edit', async () => {
    const path = write('count.txt', TEN_LINES);

    const result = await tool.edit(path, [
      { type: 'replace', startLine: 1, endLine: 1, content: 'X' },
    ]);

    // BOTH, because they are read together. Reporting 10 in and 11 out describes
    // an edit that added a line, and this one replaced one.
    expect(result.success).toBe(true);
    expect(result.metadata.originalLines).toBe(10);
    expect(result.metadata.finalLines).toBe(10);
    expect(readFileSync(path, 'utf8')).toBe(TEN_LINES.replace('L01', 'X'));
  });

  it('counts the line an insert actually added', async () => {
    // The count must track the edit, not just avoid the phantom: an append makes
    // it 11, and a test that only ever expects 10 would pass on a hard-coded one.
    const path = write('grew.txt', TEN_LINES);

    const result = await tool.edit(path, [
      { type: 'insert', startLine: 11, content: 'L11' },
    ]);

    expect(result.success).toBe(true);
    expect(result.metadata.originalLines).toBe(10);
    expect(result.metadata.finalLines).toBe(11);
    expect(readFileSync(path, 'utf8')).toBe(`${TEN_LINES}L11\n`);
  });

  it('counts the line a delete actually removed', async () => {
    const path = write('shrank.txt', TEN_LINES);

    const result = await tool.edit(path, [{ type: 'delete', startLine: 5 }]);

    expect(result.success).toBe(true);
    expect(result.metadata.finalLines).toBe(9);
    expect(readFileSync(path, 'utf8')).not.toContain('L05');
  });

  it('refuses to replace the phantom line when endLine is OMITTED', async () => {
    // THE CASE THAT ACTUALLY CORRUPTS, and the one the first attempt at this
    // file missed. With `endLine: 11` the separate endLine bound (`> totalLines`)
    // already refused it, which is why master looked correct and why a mutation
    // check on that version showed nothing. Omit `endLine` -- which the API
    // explicitly allows, meaning "just this line" -- and the startLine bound is
    // the only thing standing between the caller and the phantom.
    //
    // Measured without the fix: success, verified: true, PHANTOM appended, and
    // the file's trailing newline gone.
    const path = write('phantom-replace-open.txt', TEN_LINES);

    const result = await tool.edit(path, [
      { type: 'replace', startLine: 11, content: 'PHANTOM' },
    ]);

    expect(result.success).toBe(false);
    expect(result.operation).toBe('failed');
    expect(result.metadata.editsApplied).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe(TEN_LINES);
  });

  it('refuses to replace the phantom line, and leaves the file byte-identical', async () => {
    const path = write('phantom-replace.txt', TEN_LINES);

    const result = await tool.edit(path, [
      { type: 'replace', startLine: 11, endLine: 11, content: 'PHANTOM' },
    ]);

    expect(result.success).toBe(false);
    expect(result.operation).toBe('failed');
    expect(result.metadata.editsApplied).toBe(0);
    // The refusal must say WHICH line and why, or the caller cannot correct it.
    expect(result.error).toMatch(/11/);
    // Byte-identical, not merely "still ends with a newline": the observed
    // failure appended content AND stripped the separator, and an endsWith check
    // would have caught only the second.
    expect(readFileSync(path, 'utf8')).toBe(TEN_LINES);
  });

  it('refuses to delete the phantom line, which is the trailing newline itself', async () => {
    // The `delete` half was never covered. It corrupts differently from
    // `replace` -- it removes the separator rather than appending past it -- so a
    // bound that fixed only `replace` would still lose the newline here.
    const path = write('phantom-delete.txt', TEN_LINES);

    const result = await tool.edit(path, [{ type: 'delete', startLine: 11 }]);

    expect(result.success).toBe(false);
    expect(result.metadata.editsApplied).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe(TEN_LINES);
  });

  it('still lets insert address the position after the last line', async () => {
    // The other half of the bound. Refusing line 11 outright would make appending
    // impossible, which is a worse bug than the one being fixed -- so the
    // asymmetry is asserted, not just the refusal.
    const path = write('append.txt', TEN_LINES);

    const result = await tool.edit(path, [
      { type: 'insert', startLine: 11, content: 'L11' },
    ]);

    expect(result.success).toBe(true);
    expect(result.metadata.editsApplied).toBe(1);
    expect(readFileSync(path, 'utf8')).toBe(`${TEN_LINES}L11\n`);
  });

  it('refuses insert beyond the append position too', async () => {
    const path = write('too-far.txt', TEN_LINES);

    const result = await tool.edit(path, [
      { type: 'insert', startLine: 12, content: 'L12' },
    ]);

    expect(result.success).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(TEN_LINES);
  });

  it('refuses an operation that is not an operation, instead of doing nothing quietly', async () => {
    // The exact shape that made this file's predecessor vacuous: an options-style
    // object where an operation array belongs. Silently reporting "unchanged" let
    // a whole test file assert behaviour it never reached.
    const malformed = { operations: [{ type: 'replace', startLine: 1 }] };
    const path = write('malformed.txt', TEN_LINES);

    const result = await tool.edit(
      path,
      malformed as unknown as EditOperation[]
    );

    expect(result.success).toBe(false);
    expect(result.operation).toBe('failed');
    expect(result.error).toMatch(/replace, insert or delete/);
    expect(readFileSync(path, 'utf8')).toBe(TEN_LINES);
  });

  it('keeps the trailing newline on an ordinary edit', async () => {
    const path = write('newline.txt', TEN_LINES);

    const result = await tool.edit(path, [
      { type: 'replace', startLine: 2, endLine: 2, content: 'TWO' },
    ]);

    expect(result.success).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(TEN_LINES.replace('L02', 'TWO'));
  });

  it('counts a file with no trailing newline as-is', async () => {
    // The phantom only exists when the content ends with a separator.
    const path = write('bare.txt', 'A\nB\nC');

    const result = await tool.edit(path, [
      { type: 'replace', startLine: 1, endLine: 1, content: 'X' },
    ]);

    expect(result.metadata.originalLines).toBe(3);
    expect(result.metadata.finalLines).toBe(3);
    expect(readFileSync(path, 'utf8')).toBe('X\nB\nC');
  });

  it('reports the logical count in a dry run as well', async () => {
    // Preview and applied share the metadata shape, and a caller comparing a
    // preview against the real thing must not see the counts disagree.
    const path = write('preview.txt', TEN_LINES);

    const result = await tool.edit(
      path,
      [{ type: 'replace', startLine: 1, endLine: 1, content: 'X' }],
      { dryRun: true }
    );

    expect(result.operation).toBe('preview');
    expect(result.metadata.originalLines).toBe(10);
    expect(result.metadata.finalLines).toBe(10);
    expect(readFileSync(path, 'utf8')).toBe(TEN_LINES);
  });
});
