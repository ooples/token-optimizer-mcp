import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, readdirSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import {
  writeBackup,
  backupRoot,
  backupDirFor,
  BACKUP_ROOT,
} from '../../src/utils/file-backup.js';

/**
 * Two defects, both reported by review and both reproduced before fixing.
 *
 *   The root was a fixed constant off `homedir()`, so every test exercising
 *   writeBackup wrote into the REAL home directory and had to clean up by hand.
 *   One forgot, and left a permanent directory behind on every single run.
 *
 *   The filename's only uniqueness was a millisecond timestamp. One call takes
 *   ~1.09 ms, so sequential calls only just miss each other -- but concurrent
 *   ones do not. Measured: five concurrent backups of one file produced four
 *   files, silently dropping a version.
 */

describe('backup location', () => {
  let store: string;
  let original: string | undefined;

  beforeEach(() => {
    store = mkdtempSync(join(tmpdir(), 'backup-root-'));
    original = process.env.TOKEN_OPTIMIZER_BACKUP_DIR;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.TOKEN_OPTIMIZER_BACKUP_DIR;
    else process.env.TOKEN_OPTIMIZER_BACKUP_DIR = original;
    try {
      rmSync(store, { recursive: true, force: true });
    } catch {
      /* temp dir, reclaimed by the OS */
    }
  });

  it('defaults to the home directory when nothing overrides it', () => {
    delete process.env.TOKEN_OPTIMIZER_BACKUP_DIR;
    expect(backupRoot()).toBe(BACKUP_ROOT);
    expect(backupRoot()).toContain(homedir());
  });

  it('honours the override', () => {
    process.env.TOKEN_OPTIMIZER_BACKUP_DIR = store;
    expect(backupRoot()).toBe(store);
  });

  it('reads the override at call time, not at import', () => {
    // This module is imported once per suite. Capturing the root at import
    // would leave every test after the first writing to the real home.
    process.env.TOKEN_OPTIMIZER_BACKUP_DIR = store;
    expect(backupDirFor('/some/file.ts').startsWith(store)).toBe(true);

    const other = mkdtempSync(join(tmpdir(), 'backup-root-2-'));
    process.env.TOKEN_OPTIMIZER_BACKUP_DIR = other;
    expect(backupDirFor('/some/file.ts').startsWith(other)).toBe(true);

    rmSync(other, { recursive: true, force: true });
  });

  it('writes nothing under the real home when overridden', () => {
    process.env.TOKEN_OPTIMIZER_BACKUP_DIR = store;
    const file = join(store, 'subject.ts');

    expect(writeBackup(file, 'content')).toBe(true);
    expect(existsSync(backupDirFor(file))).toBe(true);
    expect(backupDirFor(file).startsWith(BACKUP_ROOT)).toBe(false);
  });

  it('keeps two files with the same basename apart', () => {
    process.env.TOKEN_OPTIMIZER_BACKUP_DIR = store;
    expect(backupDirFor('/a/config.ts')).not.toBe(backupDirFor('/b/config.ts'));
  });
});

describe('backup filenames', () => {
  let store: string;
  let original: string | undefined;
  const file = '/project/src/subject.ts';

  beforeEach(() => {
    store = mkdtempSync(join(tmpdir(), 'backup-names-'));
    original = process.env.TOKEN_OPTIMIZER_BACKUP_DIR;
    process.env.TOKEN_OPTIMIZER_BACKUP_DIR = store;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.TOKEN_OPTIMIZER_BACKUP_DIR;
    else process.env.TOKEN_OPTIMIZER_BACKUP_DIR = original;
    try {
      rmSync(store, { recursive: true, force: true });
    } catch {
      /* temp dir, reclaimed by the OS */
    }
  });

  it('does not lose a version when two writes share a timestamp', () => {
    // THE CLOCK IS PINNED, and that is the whole point of the test.
    //
    // This used to wrap the writes in `Promise.all`, which proves nothing:
    // `writeBackup` is synchronous, so each callback runs to completion before
    // the next begins. There was no concurrency, and whether the writes
    // collided depended on whether all five happened to land inside the same
    // millisecond -- true on a fast machine, not guaranteed. On a slow or
    // heavily loaded one they straddle a millisecond boundary, timestamp-only
    // names come out distinct, and the test passes while testing nothing.
    //
    // Freezing `toISOString` forces the exact collision the naming scheme
    // exists to survive, so the test fails for the real reason or not at all.
    const versions = ['a', 'b', 'c', 'd', 'e'];
    const realToISOString = Date.prototype.toISOString;
    Date.prototype.toISOString = () => '2026-01-01T00:00:00.000Z';
    try {
      for (const v of versions) writeBackup(file, v);
    } finally {
      Date.prototype.toISOString = realToISOString;
    }

    const written = readdirSync(backupDirFor(file));
    expect(written).toHaveLength(versions.length);

    const contents = written
      .map((f) => readFileSync(join(backupDirFor(file), f), 'utf8'))
      .sort();
    expect(contents).toEqual(versions);
  });

  it('names sort oldest-first, so pruning drops the right one', () => {
    // The timestamp stays the LEADING component precisely so the lexical sort
    // `writeBackup` uses for pruning remains an age order after the uniqueness
    // suffix was added.
    //
    // Asserting that `readdirSync` returns entries already sorted would test
    // the filesystem, not the naming scheme -- Node guarantees no order for it.
    // Sorting the names and checking the CONTENTS come back in write order
    // tests the scheme itself, whatever order the directory was read in.
    const written = ['first', 'second', 'third'];
    for (const v of written) writeBackup(file, v);

    const dir = backupDirFor(file);
    const byName = readdirSync(dir).sort();
    const contents = byName.map((f) => readFileSync(join(dir, f), 'utf8'));

    expect(contents).toEqual(written);

    // AND the timestamp must come FIRST, asserted structurally.
    //
    // The behavioural check above passes either way, because the sequence
    // counter is monotonic within one process -- so it would happily accept a
    // name like `0000-ab12__2026-...`. That ordering breaks ACROSS processes:
    // a freshly started process restarts the counter at 0000, its newest backup
    // sorts before an existing 0004, and pruning then deletes the newest file
    // instead of the oldest. Only the timestamp is comparable between runs.
    for (const name of byName) {
      expect(name).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it('keeps only the newest five versions', () => {
    for (let i = 0; i < 9; i++) writeBackup(file, `version ${i}`);

    const kept = readdirSync(backupDirFor(file));
    expect(kept).toHaveLength(5);

    const contents = kept.map((f) =>
      readFileSync(join(backupDirFor(file), f), 'utf8')
    );
    expect(contents).toContain('version 8');
    expect(contents).not.toContain('version 0');
  });

  it('reports false rather than true when it cannot write', () => {
    // `wasBackedUp` used to echo the caller's request, so a read-only or
    // missing destination produced a result claiming a backup that did not
    // exist -- exactly when someone would rely on it.
    process.env.TOKEN_OPTIMIZER_BACKUP_DIR = join(store, 'sub\0invalid');
    expect(writeBackup(file, 'content')).toBe(false);
  });
});
