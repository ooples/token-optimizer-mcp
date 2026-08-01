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

  it('does not lose a version when calls are concurrent', async () => {
    // Five at once. With a millisecond timestamp alone this produced four
    // files; the fifth silently overwrote one of the others.
    const versions = ['a', 'b', 'c', 'd', 'e'];
    await Promise.all(versions.map((v) => Promise.resolve().then(() => writeBackup(file, v))));

    const written = readdirSync(backupDirFor(file));
    expect(written).toHaveLength(versions.length);

    const contents = written.map((f) => readFileSync(join(backupDirFor(file), f), 'utf8')).sort();
    expect(contents).toEqual(versions);
  });

  it('still sorts oldest-first so pruning drops the right one', () => {
    // The timestamp stays the leading component precisely so the lexical sort
    // used for pruning remains an age order after adding a uniqueness suffix.
    for (const v of ['1', '2', '3']) writeBackup(file, v);

    const names = readdirSync(backupDirFor(file));
    expect([...names].sort()).toEqual(names);
  });

  it('keeps only the newest five versions', () => {
    for (let i = 0; i < 9; i++) writeBackup(file, `version ${i}`);

    const kept = readdirSync(backupDirFor(file));
    expect(kept).toHaveLength(5);

    const contents = kept.map((f) => readFileSync(join(backupDirFor(file), f), 'utf8'));
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
