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
import { outlineRead, outlineShell } from '../../hooks-core/outline-rewrite.mjs';

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

  test.each([
    (p) => `sed -n '1,200p' ${p}`,
    (p) => `awk 'NR>=10 && NR<=90' "${p}"`,
    (p) => `head -n 120 ${p}`,
    (p) => `Get-Content ${p} | Select-Object -Skip 40 -First 80`,
    (p) => `cd somewhere; sed -n 5,9p ${p} | cat -n`,
  ])('a ranged SHELL read of an outlined file ends outlining too: %#', (shape) => {
    const a = source('a.ts');
    expect(read(a)).not.toBeNull();
    outlineShell({ sessionId, command: shape(a), cwd: workspace, shell: 'posix', state });
    expect(read(source('b.ts'))).toBeNull();
  });

  test('a Read outline and a cat of the same file share one record', () => {
    // Asking twice means the outline did not answer: the second whole read,
    // through either tool, gets the file.
    const a = source('a.ts');
    expect(read(a)).not.toBeNull();
    expect(outlineShell({ sessionId, command: `cat ${a}`, cwd: workspace, shell: 'posix', state })).toBeNull();
  });

  test('only the file the ranged read reads counts, not every path in the command', () => {
    // Review: `echo a.ts | sed -n '1,20p' b.ts` reads b.ts. a.ts was outlined,
    // but nothing here pages through it.
    const a = source('a.ts');
    expect(read(a)).not.toBeNull();
    const b = source('b.ts');
    outlineShell({ sessionId, command: `echo ${a} | sed -n '1,20p' ${b}`, cwd: workspace, shell: 'posix', state });
    expect(read(source('c.ts'))).not.toBeNull();
  });

  test.each(['default', '', undefined])('no real session id (%p) keeps no shared marker', (none) => {
    const a = source('a.ts');
    const r = (path, extra = {}) => outlineRead({ sessionId: none, filePath: path, state, ...extra });
    r(a);
    r(a, { offset: 1, limit: 200 });
    outlineShell({ sessionId: none, command: `sed -n '1,200p' ${a}`, cwd: workspace, shell: 'posix', state });
    // Another session without an id must still be outlined.
    expect(r(source(`fresh-${randomUUID()}.ts`))).not.toBeNull();
  });

  test('a ranged shell read of a file never outlined changes nothing', () => {
    const a = source('a.ts');
    outlineShell({ sessionId, command: `sed -n '1,200p' ${a}`, cwd: workspace, shell: 'posix', state });
    expect(read(source('b.ts'))).not.toBeNull();
  });

  test('another session keeps its outlines', () => {
    const a = source('a.ts');
    read(a);
    read(a, { offset: 1, limit: 200 });
    sessionId = `reread-${randomUUID()}`;
    expect(read(source('b.ts'))).not.toBeNull();
  });
});
