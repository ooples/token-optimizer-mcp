/**
 * Once a session pages through a file it was given an outline of, it gets
 * whole files from then on.
 *
 * Measured 2026-10-30 on two long porting sessions: 22 of 29 outlines were
 * followed by paged Reads of the same file, usually covering all of it. The
 * outlines saved 21k tokens in total and cost about 25 extra calls, and the
 * sessions reported each outline as a read paid twice.
 */

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { outlineRead } from '../../hooks-core/outline-rewrite.mjs';

let workspace;
let sessionId;
// Far enough into a session that any file above the absolute floor is priced
// for an outline, as in the measured sessions.
const state = { toolCalls: 200 };

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'outline-reread-'));
  sessionId = `reread-${randomUUID()}`;
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

/** A source file large enough to outline: many small functions. */
function source(name) {
  const path = join(workspace, name);
  const body = Array.from(
    { length: 120 },
    (_, i) =>
      `export function handler${i}(input: number): number {\n` +
      Array.from(
        { length: 8 },
        (_, j) => `  const step${j} = input * ${j + 2} + ${i} - Math.floor(input / ${j + 3});\n`
      ).join('') +
      `  return step7 > 100 ? step7 - 100 : step0 + ${i};\n}\n`
  ).join('\n');
  writeFileSync(path, body);
  return path;
}

const read = (filePath, extra = {}) => outlineRead({ sessionId, filePath, state, ...extra });

describe('outlines stop once the session pages through an outlined file', () => {
  test('a whole read is outlined until then (positive control)', () => {
    expect(read(source('a.ts'))).not.toBeNull();
    expect(read(source('b.ts'))).not.toBeNull();
  });

  test('a paged read of an outlined file ends outlining for the session', () => {
    const a = source('a.ts');
    expect(read(a)).not.toBeNull();
    expect(read(a, { offset: 1, limit: 200 })).toBeNull();
    expect(read(source('b.ts'))).toBeNull();
  });

  test('a paged read of a file that was never outlined changes nothing', () => {
    const a = source('a.ts');
    expect(read(a, { offset: 1, limit: 50 })).toBeNull();
    expect(read(a)).not.toBeNull();
  });

  test('another session keeps its outlines', () => {
    const a = source('a.ts');
    read(a);
    read(a, { offset: 1, limit: 200 });
    sessionId = `reread-${randomUUID()}`;
    expect(read(source('b.ts'))).not.toBeNull();
  });
});
