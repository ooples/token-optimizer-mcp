/**
 * A finding must never be observable without its anchors.
 *
 * The anchors are the only thing that can invalidate a claim: `serve()` checks
 * them against the current file, and `writeHarvested` refuses a finding whose
 * anchors all failed to resolve rather than store one that is unfalsifiable.
 * Writing the node and then LOOPING putEdge quietly broke that promise -- the
 * node is one append, each edge is another, and the harvest runs in a detached
 * worker that a session end or a sleeping machine can kill between any two of
 * them. The surviving record is an active finding anchored to nothing, served
 * as current forever.
 *
 * These tests assert the property under truncation rather than testing the
 * happy path, because the happy path was never what was broken.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { pathToFileURL } from 'url';
import { join } from 'path';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';

const WIKI = pathToFileURL(join(process.cwd(), 'hooks-core', 'wiki.mjs')).href;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'graph-atomicity-'));
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* windows can hold a handle briefly */
  }
});

const logPath = () => join(dir, 'graph.jsonl');
const lines = () => readFileSync(logPath(), 'utf8').split('\n').filter(Boolean);

describe('putNodeWithEdges', () => {
  it('writes the node and every edge in ONE append', async () => {
    const { putNodeWithEdges, putNode } = await import(WIKI);

    const a = putNode(dir, { kind: 'file', key: join(dir, 'a.ts') });
    const b = putNode(dir, { kind: 'file', key: join(dir, 'b.ts') });
    const before = lines().length;

    const id = putNodeWithEdges(
      dir,
      { kind: 'finding', key: 'f-1', claim: 'a thing', confidence: 0.9 },
      [
        { edge: 'derived_from', to: a },
        { edge: 'derived_from', to: b },
      ]
    );

    expect(id).toBeTruthy();
    // Three records -- one node, two edges -- from a single call.
    expect(lines().length).toBe(before + 3);
  });

  it('orders the node LAST, so a torn write can only lose the finding', async () => {
    const { putNodeWithEdges, putNode } = await import(WIKI);

    const a = putNode(dir, { kind: 'file', key: join(dir, 'a.ts') });
    putNodeWithEdges(dir, { kind: 'finding', key: 'f-1', claim: 'x' }, [
      { edge: 'derived_from', to: a },
    ]);

    const written = lines().map((l) => JSON.parse(l));
    const nodeIndex = written.findIndex(
      (r) => r.t === 'n' && r.kind === 'finding'
    );
    const edgeIndex = written.findIndex(
      (r) => r.t === 'e' && r.edge === 'derived_from'
    );

    expect(edgeIndex).toBeGreaterThanOrEqual(0);
    expect(nodeIndex).toBeGreaterThan(edgeIndex);
  });

  it('leaves NO unanchored finding at any truncation point', async () => {
    const { putNodeWithEdges, putNode, load } = await import(WIKI);

    const a = putNode(dir, { kind: 'file', key: join(dir, 'a.ts') });
    const b = putNode(dir, { kind: 'file', key: join(dir, 'b.ts') });
    putNodeWithEdges(
      dir,
      { kind: 'finding', key: 'f-1', claim: 'a claim', confidence: 0.9 },
      [
        { edge: 'derived_from', to: a },
        { edge: 'derived_from', to: b },
      ]
    );

    const full = readFileSync(logPath(), 'utf8');

    // Kill the process after every single byte in turn. This is the actual
    // hazard: a detached worker dying mid-write, including PART WAY THROUGH a
    // line, which is why the sweep is per-byte rather than per-line.
    for (let cut = 0; cut <= full.length; cut++) {
      writeFileSync(logPath(), full.slice(0, cut));

      const graph = load(dir);
      const anchored = new Set(
        graph.edges
          .filter((e: any) => e.edge === 'derived_from')
          .map((e: any) => e.from)
      );
      const orphans = [...graph.nodes.values()].filter(
        (n: any) => n.kind === 'finding' && !anchored.has(n.id)
      );

      expect({ cut, orphans: orphans.map((o: any) => o.key) }).toEqual({
        cut,
        orphans: [],
      });
    }
  });

  it('rejects an unknown edge kind before writing anything', async () => {
    const { putNodeWithEdges, putNode } = await import(WIKI);

    const a = putNode(dir, { kind: 'file', key: join(dir, 'a.ts') });
    const before = lines().length;

    expect(() =>
      putNodeWithEdges(dir, { kind: 'finding', key: 'f-1', claim: 'x' }, [
        { edge: 'not-a-real-edge', to: a },
      ])
    ).toThrow(/unknown edge kind/);

    // Validation happens while the batch is being BUILT, so a bad edge cannot
    // leave a half-written group behind.
    expect(lines().length).toBe(before);
  });
});

describe('writeHarvested', () => {
  it('stores no finding without its derived_from edges', async () => {
    const HARVEST_WRITE = pathToFileURL(
      join(process.cwd(), 'hooks-core', 'harvest-write.mjs')
    ).href;
    const { writeHarvested } = await import(HARVEST_WRITE);
    const { load } = await import(WIKI);

    const file = join(dir, 'subject.ts');
    writeFileSync(file, 'export function subject() { return 1; }\n');

    const keys = writeHarvested(
      dir,
      [
        {
          type: 'finding',
          claim: 'subject() returns one',
          confidence: 0.9,
          anchors: [file],
        },
      ],
      { projectRoot: dir }
    );

    expect(keys).toHaveLength(1);

    const graph = load(dir);
    const findings = [...graph.nodes.values()].filter(
      (n: any) => n.kind === 'finding'
    );
    const anchored = new Set(
      graph.edges
        .filter((e: any) => e.edge === 'derived_from')
        .map((e: any) => e.from)
    );

    expect(findings).toHaveLength(1);
    expect(anchored.has((findings[0] as any).id)).toBe(true);
  });
});
