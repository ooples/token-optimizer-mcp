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
import { record, rereadWaste, rereadsByAnchor, fingerprint, recordRead } from '../../hooks-core/metrics.mjs';

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

/**
 * The per-anchor rows, which exist because two consumers now need them.
 *
 * The churn detector in derive.mjs asks WHICH file was re-read pointlessly;
 * rereadWaste asks HOW MUCH was wasted in total. Answering both from one
 * grouping is the point -- a second implementation would be a second definition
 * of "wasteful", and the two would drift.
 */
describe('re-reads grouped by anchor', () => {
  it('groups re-reads by anchor, worst first', () => {
    const events = [
      { kind: 'read', anchor: 'a.ts', fp: 'x', tokens: 100, at: 1 },
      { kind: 'read', anchor: 'a.ts', fp: 'x', tokens: 100, at: 2 },
      { kind: 'read', anchor: 'a.ts', fp: 'x', tokens: 100, at: 3 },
      { kind: 'read', anchor: 'b.ts', fp: 'y', tokens: 50, at: 4 },
      { kind: 'read', anchor: 'b.ts', fp: 'z', tokens: 50, at: 5 },
    ];
    const rows = rereadsByAnchor(events);
    expect(rows[0].anchor).toBe('a.ts');
    // Two repeats with an unchanged fingerprint are wasteful; b.ts changed, so it is not.
    expect(rows[0].wasteful).toBe(2);
    expect(rows.find((r) => r.anchor === 'b.ts').wasteful).toBe(0);
  });

  it('reports only the WASTEFUL tokens on a row, never the legitimate ones', () => {
    // A row whose headline number included re-reads of a file that changed
    // would overstate the recoverable waste in exactly the way the 14.6M
    // headline did.
    const events = [
      { kind: 'read', anchor: 'a.ts', fp: 'x', tokens: 100, at: 1 },
      { kind: 'read', anchor: 'a.ts', fp: 'x', tokens: 100, at: 2 },
      { kind: 'read', anchor: 'a.ts', fp: 'CHANGED', tokens: 999, at: 3 },
    ];
    const [row] = rereadsByAnchor(events);
    expect(row.tokens).toBe(100);
    expect(row.legitimateTokens).toBe(999);
  });

  it('merges one anchor across sessions into one row without inventing a repeat', () => {
    // Grouping is per session -- a file read once in each of two sessions is
    // not a re-read -- but the ROW is per anchor, so a caller asking "which
    // file do we keep re-reading" gets one answer rather than one per session.
    const events = [
      { kind: 'read', anchor: 'a.ts', sessionId: 's1', fp: 'x', tokens: 10, at: 1 },
      { kind: 'read', anchor: 'a.ts', sessionId: 's1', fp: 'x', tokens: 10, at: 2 },
      { kind: 'read', anchor: 'a.ts', sessionId: 's2', fp: 'x', tokens: 10, at: 3 },
      { kind: 'read', anchor: 'a.ts', sessionId: 's2', fp: 'x', tokens: 10, at: 4 },
    ];
    const rows = rereadsByAnchor(events);
    expect(rows.length).toBe(1);
    expect(rows[0].repeats).toBe(2);
  });

  it('leaves every existing rereadWaste field untouched', () => {
    const events = [
      { kind: 'read', anchor: '/src/a.ts', sessionId: 's1', fp: 'x', tokens: 100, at: 1 },
      { kind: 'read', anchor: '/src/a.ts', sessionId: 's1', fp: 'x', tokens: 100, at: 2 },
    ];
    const before = rereadWaste(dir, { events, includeFixtures: true });
    expect(before).toHaveProperty('repeats', 1);
    expect(before).toHaveProperty('wasteful', 1);
    expect(before).toHaveProperty('wastefulTokens', 100);
    expect(before).toHaveProperty('legitimate', 0);
    expect(before).toHaveProperty('legitimateTokens', 0);
    expect(before).toHaveProperty('undecidable', 0);
    expect(before).toHaveProperty('undecidableTokens', 0);
    expect(before).toHaveProperty('coverage', 1);
    // Additive, and bounded: the offenders behind the totals.
    expect(Array.isArray(before.worst)).toBe(true);
    expect(before.worst[0].anchor).toBe('/src/a.ts');
  });
});
