/**
 * A multi-edit call must work over MCP, not just in-process.
 *
 * ISSUE #339 reported this as "`wiki_write` rejects a valid `anchors` array",
 * and diagnosed it as array-typed arguments being dropped during marshalling.
 * That diagnosis is wrong -- `anchors` binds fine; `wikiWrite` validates it with
 * `Array.isArray(...)` and a non-empty-string filter at the top of the function
 * and a probe call gets past that check. What the issue caught the edge of is
 * real though, and it lives here.
 *
 * `operations` is the only input on this tool declared as a bare `oneOf`
 * (object OR array) with no top-level `type`. A client deciding how to
 * serialise a value from its declared type has nothing to go on, and the array
 * form arrives as JSON TEXT. `Array.isArray` is then false, the string is
 * wrapped as `[theString]`, and validation refuses it -- correctly, since a
 * string is not an operation -- with `Invalid operation type: undefined`.
 *
 * Measured over the real MCP transport on 2026-08-28, against a schema-valid
 * payload:
 *
 *     operations: [{ type: 'replace', startLine: 1, ... }]  -> Invalid operation type
 *     operations: {  type: 'replace', startLine: 1, ... }   -> applied
 *
 * So single edits worked and every multi-edit failed, which reads as a broken
 * tool rather than a marshalling quirk. It is why a whole session's file edits
 * were done with a hand-rolled script instead.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  normalizeOperations,
  runSmartEdit,
} from '../../../src/tools/file-operations/smart-edit.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (!dir) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* windows can hold a handle briefly */
    }
  }
});

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'edit-serialized-'));
  dirs.push(dir);
  const file = join(dir, 'a.txt');
  writeFileSync(file, 'line one\nline two\nline three\n');
  return file;
}

const OPS = [
  { type: 'replace' as const, startLine: 1, endLine: 1, content: 'LINE ONE' },
  { type: 'replace' as const, startLine: 3, endLine: 3, content: 'LINE THREE' },
];

describe('normalizeOperations', () => {
  it('parses the JSON text an array arrives as', () => {
    // THE BUG. Without this the string is wrapped as [theString] and every
    // multi-edit call dies on "Invalid operation type: undefined".
    expect(normalizeOperations(JSON.stringify(OPS))).toEqual(OPS);
  });

  it('leaves a real array alone', () => {
    expect(normalizeOperations(OPS)).toEqual(OPS);
  });

  it('wraps a single operation, however it arrived', () => {
    expect(normalizeOperations(OPS[0])).toEqual([OPS[0]]);
    expect(normalizeOperations(JSON.stringify(OPS[0]))).toEqual([OPS[0]]);
  });

  it('passes non-JSON through rather than throwing', () => {
    // Parsing must not become a second failure mode: validateOperations owns
    // the error message, and it is a better one than a parse error.
    expect(normalizeOperations('not json at all')).toEqual(['not json at all']);
  });
});

describe('smart_edit end to end', () => {
  it('applies every edit when operations arrive as JSON text', async () => {
    const file = fixture();

    const result = await runSmartEdit(file, JSON.stringify(OPS), {
      createBackup: false,
    });

    expect(result.success).toBe(true);
    expect(result.metadata.editsApplied).toBe(2);
    expect(readFileSync(file, 'utf8')).toBe('LINE ONE\nline two\nLINE THREE\n');
  }, 60_000);

  it('still applies an array that arrives as an array', async () => {
    const file = fixture();

    const result = await runSmartEdit(file, OPS, { createBackup: false });

    expect(result.success).toBe(true);
    expect(result.metadata.editsApplied).toBe(2);
  }, 60_000);

  it('still refuses garbage, and leaves the file alone', async () => {
    // The guard this fix must not weaken: an operation that is not an
    // operation is refused with a precise error, not silently applied as
    // nothing. Reported failure with the bytes already changed is the worst
    // outcome, because the only sane response is a retry.
    const file = fixture();
    const before = readFileSync(file, 'utf8');

    const result = await runSmartEdit(file, 'not json at all', {
      createBackup: false,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid operation type');
    expect(readFileSync(file, 'utf8')).toBe(before);
  }, 60_000);
});
