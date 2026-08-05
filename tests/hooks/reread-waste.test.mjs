/**
 * Re-read waste, and why the first version of this number was 68x too big.
 *
 * The claim "the graph prevents re-reading files you have already read" was
 * measured by counting every repeat read of a file within one session. That
 * produced 575 repeats and 14,569,375 tokens, which I reported as the
 * addressable target.
 *
 * It was wrong. Re-reading a file you have just EDITED is correct behaviour,
 * not waste, and the count could not tell the two apart. When the reads were
 * classified against what content hashes existed, only 99 of 575 could be
 * decided at all: 73 genuinely wasteful (213,651 tokens) and 26 legitimate.
 * The other 476 -- 97.8% of the tokens -- were unknowable, because capture
 * events carried an anchor on 122 of 4,735 records.
 *
 * So the fix is not a better sum over the same data. It is recording a
 * fingerprint ON THE READ, where the anchor, session and cost already are, so
 * the question becomes decidable at the point it is asked.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { record, rereadWaste, fingerprint, recordRead } from '../../hooks-core/metrics.mjs';

let dir;
let project;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reread-'));
  project = mkdtempSync(join(tmpdir(), 'reread-src-'));
});

afterEach(() => {
  for (const d of [dir, project]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* windows */
    }
  }
});

/** A read of `anchor` at `at`, with the fingerprint the router would capture. */
const read = (anchor, at, fp, tokens = 100) =>
  record(dir, { kind: 'read', anchor, sessionId: 's1', tokens, fp, at });

describe('a repeat read is only waste when the file did not change', () => {
  it('counts an unchanged re-read as wasteful', () => {
    read('/src/a.ts', 1, '100:5000');
    read('/src/a.ts', 2, '100:5000');

    const w = rereadWaste(dir);
    expect(w.repeats).toBe(1);
    expect(w.wasteful).toBe(1);
    expect(w.legitimate).toBe(0);
    expect(w.wastefulTokens).toBe(100);
  });

  it('counts a re-read AFTER AN EDIT as legitimate, not waste', () => {
    // THE CASE THAT BROKE THE FIRST MEASUREMENT. The largest single contributor
    // to the 14.6M was one file read 22 times in a session -- while it was
    // being edited. Every one of those reads was necessary.
    read('/src/a.ts', 1, '100:5000');
    read('/src/a.ts', 2, '140:6000');
    read('/src/a.ts', 3, '180:7000');

    const w = rereadWaste(dir);
    expect(w.repeats).toBe(2);
    expect(w.wasteful).toBe(0);
    expect(w.legitimate).toBe(2);
    expect(w.wastefulTokens).toBe(0);
  });

  it('reports what it cannot decide instead of guessing', () => {
    // Reads written before the fingerprint existed. Counting them either way
    // would be the measurement inventing its own answer.
    read('/src/a.ts', 1, null);
    read('/src/a.ts', 2, null);

    const w = rereadWaste(dir);
    expect(w.repeats).toBe(1);
    expect(w.undecidable).toBe(1);
    expect(w.wasteful).toBe(0);
    expect(w.legitimate).toBe(0);
    expect(w.coverage).toBe(0);
  });

  it('reports coverage, so a confident number from thin data is visible', () => {
    read('/src/a.ts', 1, '1:1');
    read('/src/a.ts', 2, '1:1');
    read('/src/b.ts', 1, null);
    read('/src/b.ts', 2, null);

    const w = rereadWaste(dir);
    expect(w.repeats).toBe(2);
    expect(w.coverage).toBe(0.5);
  });

  it('does not treat two different sessions as a re-read', () => {
    record(dir, { kind: 'read', anchor: '/src/a.ts', sessionId: 's1', tokens: 100, fp: '1:1', at: 1 });
    record(dir, { kind: 'read', anchor: '/src/a.ts', sessionId: 's2', tokens: 100, fp: '1:1', at: 2 });

    expect(rereadWaste(dir).repeats).toBe(0);
  });

  it('ignores fixture anchors, which are 366 of 370 substitutions on this machine', () => {
    read(join(tmpdir(), 'to-hooks-x', 'big.ts'), 1, '1:1');
    read(join(tmpdir(), 'to-hooks-x', 'big.ts'), 2, '1:1');

    expect(rereadWaste(dir).repeats).toBe(0);
  });
});

describe('the fingerprint itself', () => {
  it('changes when the file changes, and is stable when it does not', () => {
    const f = join(project, 'a.ts');
    writeFileSync(f, 'export const a = 1;');
    const first = fingerprint(f);
    expect(first).toBeTruthy();
    expect(fingerprint(f)).toBe(first);

    writeFileSync(f, 'export const a = 1; export const b = 2;');
    expect(fingerprint(f)).not.toBe(first);
  });

  it('returns null for a file that is not there, rather than throwing', () => {
    expect(fingerprint(join(project, 'nope.ts'))).toBeNull();
  });

  it('is attached by recordRead, so a read is self-describing', () => {
    const f = join(project, 'b.ts');
    writeFileSync(f, 'x'.repeat(400));
    recordRead(dir, { anchor: f, sessionId: 's1', bytes: 400, fp: fingerprint(f) });
    recordRead(dir, { anchor: f, sessionId: 's1', bytes: 400, fp: fingerprint(f) });

    // The scratch file lives under the temp directory, which the fixture
    // filter excludes by design; opt in so the real path is exercised.
    const w = rereadWaste(dir, { includeFixtures: true });
    expect(w.repeats).toBe(1);
    expect(w.wasteful).toBe(1);
    expect(w.coverage).toBe(1);
  });
});
