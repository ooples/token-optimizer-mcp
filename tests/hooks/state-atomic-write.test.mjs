/**
 * State files are replaced with write-then-rename. On Windows the rename fails, briefly, while another hook process
 * has the target open (state readers take no lock), and the callers swallow every error, so one refused rename used
 * to drop that write silently and strand its `<state>.json.<pid>.tmp` for good. writeAtomically retries a transient
 * refusal and removes the temporary file on every path.
 */

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeAtomically } from '../../hooks-core/policy.mjs';

let dir;
let target;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atomic-write-'));
  target = join(dir, 'session.json');
  writeFileSync(target, '{"old":true}');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const refused = (code) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
const leftovers = () => readdirSync(dir).filter((name) => name.endsWith('.tmp'));

describe('writeAtomically', () => {
  test('a rename Windows refuses for a moment is retried, and the write lands', () => {
    let calls = 0;
    writeAtomically(target, '{"new":true}', {
      rename: (from, to) => {
        calls++;
        if (calls <= 2) throw refused('EPERM');
        renameSync(from, to);
      },
    });
    expect(calls).toBe(3);
    expect(readFileSync(target, 'utf8')).toBe('{"new":true}');
    expect(leftovers()).toEqual([]);
  });

  test('a rename that keeps failing throws, leaves the old file, and strands no temporary file', () => {
    let calls = 0;
    expect(() =>
      writeAtomically(target, '{"new":true}', {
        attempts: 3,
        rename: () => {
          calls++;
          throw refused('EBUSY');
        },
      })
    ).toThrow(/EBUSY/);
    expect(calls).toBe(3);
    expect(readFileSync(target, 'utf8')).toBe('{"old":true}');
    expect(leftovers()).toEqual([]);
  });

  test('an error that is not a sharing refusal is not retried', () => {
    let calls = 0;
    expect(() =>
      writeAtomically(target, '{"new":true}', {
        rename: () => {
          calls++;
          throw refused('ENOSPC');
        },
      })
    ).toThrow(/ENOSPC/);
    expect(calls).toBe(1);
    expect(leftovers()).toEqual([]);
  });

  test('the ordinary path replaces the file and leaves nothing beside it', () => {
    writeAtomically(target, '{"new":true}');
    expect(readFileSync(target, 'utf8')).toBe('{"new":true}');
    expect(existsSync(target)).toBe(true);
    expect(leftovers()).toEqual([]);
  });
});
