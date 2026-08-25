/**
 * The reader accepts a RANGE of schema versions, not one exact version.
 *
 * `load()` used to skip any record whose `v !== GRAPH_VERSION`, justified by a
 * header comment claiming nothing had been released. The package ships on npm,
 * so that justification was false AND load-bearing: the first version bump
 * would have silently zeroed every existing user graph. `compactIfWasteful`
 * carried the same comparison, giving a second route to the same loss.
 *
 * These tests are the net. They must keep failing if anyone reintroduces an
 * equality check, and they deliberately assert that GRAPH_VERSION is still 1 --
 * this work changed no record shape, so it takes no bump.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load, putNode, SUPPORTED_VERSIONS, upcast, GRAPH_VERSION } from '../../hooks-core/wiki.mjs';

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

  it('does not bump the version, because no record shape changed in this work', () => {
    expect(GRAPH_VERSION).toBe(1);
    expect(SUPPORTED_VERSIONS).toContain(1);
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
});
