/**
 * `editsApplied` must say how many operations actually ran.
 *
 * The unchanged branch hardcoded `editsApplied: 0, success: true`, which
 * collapsed two opposite outcomes into one indistinguishable result:
 *
 *   every operation ran and reproduced the existing text  -> a genuine no-op
 *   no operation ran at all                               -> a dropped edit
 *
 * Observed live: a two-operation call came back `success: true`,
 * `operation: "unchanged"`, `editsApplied: 0`, `verified: true`, and the file
 * on disk was untouched. Nothing in that response says the edit was lost, so a
 * caller that does not re-read the file afterwards silently loses work. The
 * count now reflects operations that executed, and a non-empty operations array
 * that applies nothing is reported as a failure with a message.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { runSmartEdit } from '../../../src/tools/file-operations/smart-edit.js';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let dir: string;
let file: string;

const ORIGINAL = ['alpha', 'bravo', 'charlie', 'delta', 'echo'].join('\n');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'smart-edit-applied-'));
  file = join(dir, 'subject.txt');
  writeFileSync(file, ORIGINAL);
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* windows can hold a handle briefly */
  }
});

describe('smart_edit editsApplied', () => {
  it('counts every operation that ran, not just the ones that changed bytes', async () => {
    // Both operations rewrite a line with EXACTLY what is already there. The
    // file is legitimately unchanged, but two operations did run -- and that is
    // precisely the case the old code could not distinguish from a dropped edit.
    const result = await runSmartEdit(
      file,
      [
        { type: 'replace', startLine: 4, endLine: 4, content: 'delta' },
        { type: 'replace', startLine: 2, endLine: 2, content: 'bravo' },
      ],
      { returnDiff: false, createBackup: false }
    );

    expect(result.operation).toBe('unchanged');
    expect(result.success).toBe(true);
    expect(result.metadata.editsApplied).toBe(2);
    expect(readFileSync(file, 'utf8')).toBe(ORIGINAL);
  });

  it('reports the real count on a normal multi-operation edit', async () => {
    const result = await runSmartEdit(
      file,
      [
        { type: 'replace', startLine: 5, endLine: 5, content: 'ECHO' },
        { type: 'replace', startLine: 1, endLine: 1, content: 'ALPHA' },
      ],
      { returnDiff: false, createBackup: false }
    );

    expect(result.operation).toBe('applied');
    expect(result.metadata.editsApplied).toBe(2);

    const after = readFileSync(file, 'utf8').split(/\r?\n/);
    expect(after[0]).toBe('ALPHA');
    expect(after[4]).toBe('ECHO');
  });

  it('counts an insert and a delete', async () => {
    const result = await runSmartEdit(
      file,
      [
        { type: 'delete', startLine: 5, endLine: 5 },
        { type: 'insert', startLine: 1, content: 'zero' },
      ],
      { returnDiff: false, createBackup: false }
    );

    expect(result.metadata.editsApplied).toBe(2);
    const after = readFileSync(file, 'utf8').split(/\r?\n/);
    expect(after[0]).toBe('zero');
    expect(after).not.toContain('echo');
  });

  it('does not count a delete that removed nothing', async () => {
    // startLine === totalLines + 1 is ACCEPTED by validation (it is the legal
    // append position for an insert), but for a delete it splices at the end of
    // the array and removes nothing. splice throws nothing there, so the
    // operation would otherwise be counted as applied -- reintroducing, for one
    // operation type, exactly the "it says it worked and nothing happened"
    // failure this change exists to remove.
    const result = await runSmartEdit(
      file,
      [{ type: 'delete', startLine: 6 }],
      { returnDiff: false, createBackup: false }
    );

    expect(result.operation).toBe('unchanged');
    expect(result.metadata.editsApplied).toBe(0);
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(readFileSync(file, 'utf8')).toBe(ORIGINAL);
  });

  it('rejects a delete whose range runs past the end of the file', async () => {
    // A different outcome from the one above, and it should stay different:
    // endLine beyond the last line is caught by validation before any edit is
    // attempted, so this is a hard failure rather than a silent no-op.
    const result = await runSmartEdit(
      file,
      [{ type: 'delete', startLine: 6, endLine: 6 }],
      { returnDiff: false, createBackup: false }
    );

    expect(result.operation).toBe('failed');
    expect(result.success).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(ORIGINAL);
  });

  it('an empty operations array is still a success', async () => {
    // Nothing was asked for, so nothing running is the correct outcome -- the
    // new failure rule must not turn this into an error.
    const result = await runSmartEdit(file, [], {
      returnDiff: false,
      createBackup: false,
    });

    expect(result.success).toBe(true);
    expect(result.metadata.editsApplied).toBe(0);
    expect(result.error).toBeUndefined();
  });

  it('preserves CRLF and still counts correctly', async () => {
    const crlf = ORIGINAL.replace(/\n/g, '\r\n');
    writeFileSync(file, crlf);

    const result = await runSmartEdit(
      file,
      [
        { type: 'replace', startLine: 4, endLine: 4, content: 'DELTA' },
        { type: 'replace', startLine: 2, endLine: 2, content: 'BRAVO' },
      ],
      { returnDiff: false, createBackup: false }
    );

    expect(result.metadata.editsApplied).toBe(2);
    const after = readFileSync(file, 'utf8');
    expect(after).toContain('\r\n');
    expect(after).not.toMatch(/[^\r]\n/);
  });
});
