/**
 * The graph log is append-only, and nothing was reclaiming it.
 *
 * MEASURED on this repository's own graph before this existed: 206.6 MB across
 * 41,810 records, of which only 6,125 ids were live -- 85.4% of the file was
 * superseded, 97.5 MB reclaimable. `load()` parses all of it on EVERY hook
 * invocation, so every tool call paid 1.2-1.6 seconds against a 118 ms median
 * on a small graph.
 *
 * It reached us as a flaky test: a 20 s spawn budget that a loaded machine
 * sometimes exceeded. That is the kind of failure that gets re-run rather than
 * read, which is why "flaky" is worth treating as a defect report.
 *
 * The risk in compaction is silent data loss, so that is what these assert:
 * the graph after compaction must be indistinguishable from the graph before.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { load, putNode, putEdge, nodeId } from '../../hooks-core/wiki.mjs';

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'compact-'));
  // A low floor, so the test does not have to write eight megabytes to see the
  // behaviour the production default is tuned for.
  process.env.TOKEN_OPTIMIZER_GRAPH_COMPACT_BYTES = '20000';
});

afterEach(() => {
  delete process.env.TOKEN_OPTIMIZER_GRAPH_COMPACT_BYTES;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* windows */
  }
});

/** Rewrites one node many times, which is what real churn looks like. */
function churn(times, { snapshot = 'x'.repeat(400) } = {}) {
  for (let i = 0; i < times; i++) {
    putNode(dir, { kind: 'file', key: '/src/a.ts', hash: 'h' + i, snapshot });
    putNode(dir, { kind: 'file', key: '/src/b.ts', hash: 'g' + i, snapshot });
  }
}

const graphSize = () => statSync(join(dir, 'graph.jsonl')).size;

describe('compaction reclaims superseded records', () => {
  it('grows sublinearly in what is written, which is the whole point', () => {
    // THE INVARIANT IS SUBLINEARITY, not a shrink on any given append.
    // Compaction is amortised -- it runs once the file has doubled since the
    // last one -- so the size sawtooths and comparing two adjacent measurements
    // lands wherever the trigger happened to fall. My first attempt asserted
    // exactly that and failed by 3%.
    //
    // What must hold is that rewriting the same nodes forever cannot grow the
    // file without bound, which is what took the real graph to 206 MB across
    // 41,810 records holding 6,125 live ids.
    const SNAPSHOT = 'x'.repeat(400);
    const WRITES = 240;
    churn(WRITES / 2, { snapshot: SNAPSHOT });

    // A generous lower bound on what an uncompacted log would have held.
    const writtenBytes = WRITES * SNAPSHOT.length;
    expect(graphSize()).toBeLessThan(writtenBytes / 4);

    // And the live set is intact.
    const live = load(dir).nodes;
    expect(live.has(nodeId('file', '/src/a.ts'))).toBe(true);
    expect(live.has(nodeId('file', '/src/b.ts'))).toBe(true);
  });

  it('holds far fewer records than were written, without losing a node', () => {
    churn(120);
    putNode(dir, { kind: 'file', key: '/src/c.ts', hash: 'z' });

    const lines = readFileSync(join(dir, 'graph.jsonl'), 'utf8').split('\n').filter(Boolean);
    const live = load(dir).nodes;

    // 241 node writes went in; the file holds a small multiple of the live set
    // rather than the history. Exact counts depend on where the amortised
    // trigger fell, so this asserts the shape, not a brittle number.
    expect(lines.length).toBeLessThan(60);
    expect(live.has(nodeId('file', '/src/a.ts'))).toBe(true);
    expect(live.has(nodeId('file', '/src/b.ts'))).toBe(true);
    expect(live.has(nodeId('file', '/src/c.ts'))).toBe(true);
    // The latest write wins, not an older superseded one.
    expect(live.get(nodeId('file', '/src/a.ts')).hash).toBe('h119');
  });

  it('preserves edges, and does not duplicate them', () => {
    const a = putNode(dir, { kind: 'file', key: '/src/a.ts', hash: 'h' });
    const f = putNode(dir, { kind: 'finding', key: 'f1', claim: 'a claim', confidence: 0.9 });
    putEdge(dir, f, 'derived_from', a);
    // The same edge asserted repeatedly, as a re-harvest would.
    for (let i = 0; i < 40; i++) putEdge(dir, f, 'derived_from', a);
    churn(60);
    putNode(dir, { kind: 'file', key: '/trigger.ts', hash: 't' });

    const g = load(dir);
    const derived = g.edges.filter((e) => e.edge === 'derived_from' && e.from === f && e.to === a);
    expect(derived.length).toBe(1);
    // And the finding is still anchored, which is the property that matters.
    expect(g.nodes.has(f)).toBe(true);
  });

  it('does not compact a log that is merely large but not wasteful', () => {
    // Distinct ids: nothing is superseded, so there is nothing to reclaim and
    // rewriting would be pure cost. A size threshold alone would rewrite this
    // on every append forever.
    for (let i = 0; i < 80; i++) {
      putNode(dir, { kind: 'file', key: `/src/f${i}.ts`, hash: 'h', snapshot: 'x'.repeat(400) });
    }
    const size = graphSize();
    putNode(dir, { kind: 'file', key: '/src/last.ts', hash: 'h' });

    // It may compact once (the baseline starts at the floor), but the result
    // must still hold every distinct node.
    const g = load(dir);
    expect(g.nodes.size).toBeGreaterThanOrEqual(81);
    expect(graphSize()).toBeGreaterThan(size * 0.5);
  });

  it('leaves the log intact when compaction cannot complete', () => {
    churn(60);
    const before = readFileSync(join(dir, 'graph.jsonl'), 'utf8');

    // A directory where the temp file wants to be: the rename cannot succeed.
    const blocker = join(dir, 'graph.jsonl.compact');
    mkdirSync(blocker, { recursive: true });

    expect(() => putNode(dir, { kind: 'file', key: '/src/d.ts', hash: 'd' })).not.toThrow();

    // The original survives: a failed compaction costs space, never data.
    const after = readFileSync(join(dir, 'graph.jsonl'), 'utf8');
    expect(after.startsWith(before)).toBe(true);
    expect(load(dir).nodes.has(nodeId('file', '/src/a.ts'))).toBe(true);
  });

  it('records a baseline so it cannot compact on every append', () => {
    churn(60);
    putNode(dir, { kind: 'file', key: '/src/c.ts', hash: 'z' });

    const marker = join(dir, 'graph.compact.json');
    expect(existsSync(marker)).toBe(true);
    const { sizeAfter } = JSON.parse(readFileSync(marker, 'utf8'));
    expect(sizeAfter).toBeGreaterThan(0);

    // A second append right afterwards must NOT rewrite the file again.
    const sizeBefore = graphSize();
    putNode(dir, { kind: 'file', key: '/src/e.ts', hash: 'e' });
    expect(graphSize()).toBeGreaterThan(sizeBefore);
  });

  it('keeps records from another schema version rather than deleting them', () => {
    churn(60);
    // A record load() will skip: compaction must not silently drop it.
    writeFileSync(
      join(dir, 'graph.jsonl'),
      readFileSync(join(dir, 'graph.jsonl'), 'utf8') +
        JSON.stringify({ t: 'n', v: 999, id: 'future:1', kind: 'file', key: '/future.ts' }) +
        '\n'
    );
    putNode(dir, { kind: 'file', key: '/src/c.ts', hash: 'z' });

    const raw = readFileSync(join(dir, 'graph.jsonl'), 'utf8');
    expect(raw).toContain('future:1');
  });
});
