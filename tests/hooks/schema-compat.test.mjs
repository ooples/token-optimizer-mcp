/**
 * The reader accepts a RANGE of schema versions, not one exact version.
 *
 * `load()` used to skip any record whose `v !== GRAPH_VERSION`, justified by a
 * header comment claiming nothing had been released. The package ships on npm,
 * so that justification was false AND load-bearing: the first version bump
 * would have silently zeroed every existing user graph. `compactIfWasteful`
 * carried the same comparison, giving a second route to the same loss.
 *
 * These tests are the net, and the net has to work WITHOUT a hand-edited
 * constant. With SUPPORTED_VERSIONS = [1] and GRAPH_VERSION = 1,
 * `versions.includes(v)` and `v === GRAPH_VERSION` are extensionally identical,
 * so any test pinned to the live constants passes under either -- it proves only
 * that two currently-equivalent expressions are equivalent. That is why
 * `readable` takes its version range as a PARAMETER: exercised against [1, 2] it
 * distinguishes a range from an equality, and those cases cannot pass if anyone
 * reverts the predicate.
 *
 * For the same reason nothing here asserts `GRAPH_VERSION === 1`. That assertion
 * would force whoever eventually bumps the version to edit this file -- the file
 * holding the net -- at exactly the moment they are most likely to weaken it.
 * The invariants asserted instead are the ones that must survive a bump: the
 * current version is supported, and support for the OLDEST version is never
 * dropped.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load, putNode, readable, SUPPORTED_VERSIONS, upcast, GRAPH_VERSION } from '../../hooks-core/wiki.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'schema-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('schema compatibility', () => {
  it('loads a v1 log with every node intact -- the regression that would have caught silent zeroing', () => {
    writeFileSync(
      join(dir, 'graph.jsonl'),
      [
        JSON.stringify({ t: 'n', v: 1, id: 'file:aaa', kind: 'file', key: '/x/a.ts', at: 1 }),
        JSON.stringify({ t: 'n', v: 1, id: 'finding:bbb', kind: 'finding', key: 'k1', claim: 'c', at: 2 }),
        JSON.stringify({ t: 'e', v: 1, from: 'finding:bbb', edge: 'derived_from', to: 'file:aaa', at: 3 }),
      ].join('\n') + '\n'
    );
    const graph = load(dir);
    expect(graph.nodes.size).toBe(2);
    expect(graph.edges).toHaveLength(1);
  });

  it('still skips a record from a FUTURE version, because ignoring the future is safe', () => {
    writeFileSync(
      join(dir, 'graph.jsonl'),
      JSON.stringify({ t: 'n', v: 9999, id: 'file:zzz', kind: 'file', key: '/x/z.ts', at: 1 }) + '\n'
    );
    expect(load(dir).nodes.size).toBe(0);
  });

  it('supports the current version and never drops the oldest -- the invariants that survive a bump', () => {
    // NOT `expect(GRAPH_VERSION).toBe(1)`. Pinning the constant here would make
    // a legitimate future bump fail in the very file that guards against the
    // damage a bump can do, inviting whoever does it to edit the net.
    expect(SUPPORTED_VERSIONS).toContain(GRAPH_VERSION);
    // v1 is what is on every user's disk today. A change may ADD versions to
    // this range; dropping the oldest is the data loss this whole file exists
    // to prevent.
    expect(SUPPORTED_VERSIONS[0]).toBe(1);
    expect(SUPPORTED_VERSIONS.every((v) => Number.isInteger(v) && v > 0)).toBe(true);
  });

  describe('readable is a RANGE check, not an equality check', () => {
    // These are the cases that cannot pass under `v === GRAPH_VERSION`, and they
    // do not depend on today's values of GRAPH_VERSION or SUPPORTED_VERSIONS.
    // With GRAPH_VERSION === 1, an equality check rejects v2 -- so the middle
    // case below fails the moment anyone reverts the predicate.
    it('accepts an OLDER version in range', () => {
      expect(readable({ v: 1 }, [1, 2])).toBe(true);
    });

    it('accepts the NEWEST version in range', () => {
      expect(readable({ v: 2 }, [1, 2])).toBe(true);
    });

    it('rejects a version beyond the range, because the future is unknowable', () => {
      expect(readable({ v: 3 }, [1, 2])).toBe(false);
    });

    it('treats a missing v as version 0, which no range supports', () => {
      expect(readable({}, [1, 2])).toBe(false);
    });

    it('accepts every version it claims to support', () => {
      for (const v of SUPPORTED_VERSIONS) expect(readable({ v })).toBe(true);
    });
  });

  it('upcast is idempotent, because compaction upcasts and then load upcasts again', () => {
    // The contract for the first non-identity step. A record keyed by an upcast
    // in compactIfWasteful is read back and upcast a SECOND time by every later
    // load, so a step that is not idempotent applies twice to anything
    // compaction has touched.
    for (const v of SUPPORTED_VERSIONS) {
      const record = { t: 'n', v, id: 'file:a', kind: 'file', key: '/a.ts', at: 1 };
      expect(upcast(upcast(record))).toEqual(upcast(record));
    }
  });

  it('upcast is identity for a current-version record', () => {
    const record = { t: 'n', v: GRAPH_VERSION, id: 'x', kind: 'file', key: '/a', at: 1 };
    expect(upcast(record)).toEqual(record);
  });

  it('compaction preserves records of every supported version', () => {
    // The second data-loss route: compactIfWasteful carried the same version
    // filter as load, so a bump would drop old records while compacting.
    //
    // DEVIATION FROM THE BRIEF, which assumed `load(dir, { snapshots: true })`
    // triggers compaction. It does not -- `compactIfWasteful` is called only
    // from `appendAll`, inside the write lock, and only once the pair of logs
    // exceeds the floor. So the real route is taken: a low floor plus appends,
    // exactly as tests/hooks/graph-compaction.test.mjs does it. The assertion
    // is unchanged -- the record count must survive the rewrite -- and the run
    // asserts compaction actually happened rather than assuming it.
    process.env.TOKEN_OPTIMIZER_GRAPH_COMPACT_BYTES = '20000';
    try {
      writeFileSync(
        join(dir, 'graph.jsonl'),
        Array.from({ length: 50 }, (_, i) =>
          JSON.stringify({
            t: 'n',
            v: 1,
            id: `file:${i}`,
            kind: 'file',
            key: `/x/${i}.ts`,
            at: i,
            // Padding, so 50 records clear the compaction floor without needing
            // thousands of them.
            pad: 'p'.repeat(500),
          })
        ).join('\n') + '\n'
      );
      const before = load(dir).nodes.size;
      expect(before).toBe(50);

      // Churn one id repeatedly: every append re-enters the lock and so gives
      // compactIfWasteful its chance, and the superseded copies are what make
      // the rewrite worth doing.
      const APPENDS = 40;
      for (let i = 0; i < APPENDS; i++) {
        putNode(dir, { kind: 'file', key: '/src/churn.ts', hash: 'h' + i, pad: 'p'.repeat(500) });
      }

      // COMPACTION REALLY RAN, asserted rather than assumed. The marker is
      // written only on the last line of a completed compaction, and the log
      // holds fewer lines than the 50 + 40 that were appended to it, so records
      // were genuinely reclaimed rather than merely accumulated.
      expect(existsSync(join(dir, 'graph.compact.json'))).toBe(true);
      const lines = readFileSync(join(dir, 'graph.jsonl'), 'utf8').split('\n').filter(Boolean).length;
      expect(lines).toBeLessThan(50 + APPENDS);

      const after = load(dir);
      // Every pre-existing record survived, plus the one churned id.
      expect(after.nodes.size).toBe(before + 1);
      for (let i = 0; i < 50; i++) {
        expect(after.nodes.has(`file:${i}`)).toBe(true);
      }
    } finally {
      delete process.env.TOKEN_OPTIMIZER_GRAPH_COMPACT_BYTES;
    }
  });

  /**
   * THE ASYMMETRY THAT MADE THE SIDECAR DESTRUCTIVE.
   *
   * graph.jsonl keeps every line it cannot interpret (the `raw:` bucket), so an
   * unreadable record there survives a compaction. snapshots.jsonl had no
   * equivalent: compaction REBUILT it from only what it could read, so for the
   * sidecar "skip the record" and "delete the record forever" were the same
   * operation.
   *
   * Note the direction. This is the FORWARD case -- a version from the future --
   * which a reader is right to ignore. A rewriter is not: ignoring the future
   * while replacing the file is data loss. And it is the expected case here,
   * because hooks-core is vendored into eleven client directories that update
   * independently, so a stale client compacting after a newer one has written is
   * ordinary operation.
   */
  describe('compaction preserves sidecar snapshots it cannot read', () => {
    /**
     * Drives a real compaction: low floor, then appends that re-enter the lock.
     *
     * compactIfWasteful is reachable ONLY from appendAll, inside the write lock,
     * and only once graph.jsonl + snapshots.jsonl together clear both the floor
     * and twice the recorded baseline -- so the floor has to sit well under what
     * these appends produce (~700 bytes each across the pair).
     */
    function compact(appends = 40) {
      process.env.TOKEN_OPTIMIZER_GRAPH_COMPACT_BYTES = '4000';
      try {
        for (let i = 0; i < appends; i++) {
          putNode(dir, { kind: 'file', key: '/src/churn.ts', hash: 'h' + i, snapshot: 's'.repeat(500) });
        }
        // Asserted, not assumed: the marker is written only by a compaction that
        // ran to completion.
        expect(existsSync(join(dir, 'graph.compact.json'))).toBe(true);
      } finally {
        delete process.env.TOKEN_OPTIMIZER_GRAPH_COMPACT_BYTES;
      }
    }

    const sidecarLines = () =>
      readFileSync(join(dir, 'snapshots.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));

    it('keeps a FUTURE-version snapshot record verbatim through a rebuild', () => {
      const future = { t: 's', v: 9999, id: 'file:future', snapshot: 'FUTURE-PAYLOAD', at: 1, extra: 'a field this reader knows nothing about' };
      writeFileSync(join(dir, 'snapshots.jsonl'), JSON.stringify(future) + '\n');
      // Sanity: this reader genuinely cannot interpret it, so its survival is
      // not an accident of it being readable after all.
      expect(readable(future)).toBe(false);

      compact();

      const survivor = sidecarLines().find((rec) => rec.id === 'file:future');
      expect(survivor).toBeDefined();
      // VERBATIM: the payload, the version stamp and the unknown field all
      // survive. A rebuild that re-serialized it would drop `extra`.
      expect(survivor).toEqual(future);
    });

    it('does not restamp a surviving snapshot with the current version', () => {
      // Compaction must never relabel bytes it did not write. Restamping was the
      // other half of this defect: every survivor was written back as
      // `v: GRAPH_VERSION` regardless of what produced it.
      const future = { t: 's', v: 9999, id: 'file:future', snapshot: 'p', at: 1 };
      writeFileSync(join(dir, 'snapshots.jsonl'), JSON.stringify(future) + '\n');

      compact();

      const survivor = sidecarLines().find((rec) => rec.id === 'file:future');
      expect(survivor).toBeDefined();
      expect(survivor.v).toBe(9999);
      expect(survivor.v).not.toBe(GRAPH_VERSION);
    });

    it('keeps readable snapshots too, so preserving the unreadable costs nothing', () => {
      // The fix must not trade one loss for another: the ordinary path still
      // has to work, and a readable record still carries its own version.
      putNode(dir, { kind: 'file', key: '/src/keep.ts', hash: 'h', snapshot: 'KEEP-ME' });
      const unreadable = { t: 's', v: 9999, id: 'file:future', snapshot: 'p', at: 1 };
      appendFileSync(join(dir, 'snapshots.jsonl'), JSON.stringify(unreadable) + '\n');

      compact();

      const ids = sidecarLines().map((rec) => rec.id);
      expect(ids).toContain('file:future');
      // The churned node's snapshot is the one compaction is meant to keep.
      const readableSurvivors = sidecarLines().filter((rec) => rec.v === GRAPH_VERSION);
      expect(readableSurvivors.length).toBeGreaterThan(0);
      // And a reader still sees only what it can interpret.
      const graph = load(dir, { snapshots: true });
      expect(graph.nodes.has('file:future')).toBe(false);
    });
  });
});
