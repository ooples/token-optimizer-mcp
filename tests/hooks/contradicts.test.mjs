/**
 * The `contradicts` edge: recorded disagreement instead of a silent overwrite.
 *
 * `EDGE_KINDS` has declared this edge since the schema existed, `WIKI_GRAPH.md`
 * gives it a paragraph as the design's departure from RAG, and `audit()` already
 * read it. Nothing wrote it. The properties under test are the ones that make it
 * worth being an edge at all: BOTH claims survive, the disagreement is
 * addressable from either end, and neither end can be promoted on measured
 * utility while the dispute is open.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { putNodeWithEdges, load, nodeId } from '../../hooks-core/wiki.mjs';
import { contradict, hasOutstandingContradiction, audit } from '../../hooks-core/curate.mjs';

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'contra-'));
  putNodeWithEdges(dir, {
    kind: 'finding', key: 'old', claim: 'f returns 1', confidence: 0.9, origin: 'harvested',
  });
  putNodeWithEdges(dir, {
    kind: 'finding', key: 'new', claim: 'f returns 2', confidence: 0.9, origin: 'human',
  });
  // A third finding involved in nothing. Without it, a `hasOutstandingContradiction`
  // that simply returned true would pass every assertion below.
  putNodeWithEdges(dir, {
    kind: 'finding', key: 'other', claim: 'g returns 3', confidence: 0.9, origin: 'harvested',
  });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const findingByKey = (graph, key) =>
  [...graph.nodes.values()].find((n) => n.kind === 'finding' && n.key === key);

describe('contradicts', () => {
  test('records a disagreement as a directed edge rather than an overwrite', () => {
    expect(contradict(dir, { key: 'old', byKey: 'new', reason: 're-derived' })).toBe(true);

    const graph = load(dir);
    const edges = graph.edges.filter((e) => e.edge === 'contradicts');
    expect(edges).toHaveLength(1);
    // Direction carries meaning: the contradictOR is the source. Reversed, the
    // graph says the established claim disputes the new one.
    expect(edges[0].from).toBe(nodeId('finding', 'new'));
    expect(edges[0].to).toBe(nodeId('finding', 'old'));
  });

  test('leaves the contradicted finding present, not retired', () => {
    contradict(dir, { key: 'old', byKey: 'new', reason: 're-derived' });
    const old = findingByKey(load(dir), 'old');
    expect(old).toBeDefined();
    expect(old.retired).toBeFalsy();
  });

  test('leaves BOTH claims readable -- the whole reason this is an edge', () => {
    contradict(dir, { key: 'old', byKey: 'new', reason: 're-derived' });
    const graph = load(dir);

    // putNode does not merge: it writes the record it is handed and `load`
    // replaces the node wholesale. Annotating the target without spreading it
    // back in blanks the claim, which is the overwrite this edge exists to
    // avoid -- and it would still look "present, not retired" to the test above.
    const old = findingByKey(graph, 'old');
    expect(old.claim).toBe('f returns 1');
    expect(old.confidence).toBe(0.9);
    expect(old.origin).toBe('harvested');
    expect(findingByKey(graph, 'new').claim).toBe('f returns 2');
  });

  test('records WHY the belief changed, capped', () => {
    contradict(dir, { key: 'old', byKey: 'new', reason: 'x'.repeat(600) });
    const old = findingByKey(load(dir), 'old');
    expect(old.contradictionReason).toBe('x'.repeat(400));
    expect(typeof old.contradictedAt).toBe('number');
  });

  test('surfaces both ends to audit, which needs a person to resolve them', () => {
    contradict(dir, { key: 'old', byKey: 'new', reason: 're-derived' });
    const keys = audit(load(dir)).contradicted.map((f) => f.key).sort();
    expect(keys).toEqual(['new', 'old']);
  });

  test('reports an outstanding contradiction at BOTH ends, which blocks promotion', () => {
    contradict(dir, { key: 'old', byKey: 'new', reason: 're-derived' });
    const graph = load(dir);
    expect(hasOutstandingContradiction(graph, 'old')).toBe(true);
    // The design's named hazard is presenting "the new one as though it had
    // always been true". Gating only the older claim leaves the newer one --
    // which nothing here has adjudicated -- free to be promoted on measured
    // utility alone, which is exactly what this gate exists to stop.
    expect(hasOutstandingContradiction(graph, 'new')).toBe(true);
    // And it is not simply true for everything.
    expect(hasOutstandingContradiction(graph, 'other')).toBe(false);
  });

  test('reports no contradiction before one is recorded, or for an unknown key', () => {
    const graph = load(dir);
    expect(hasOutstandingContradiction(graph, 'old')).toBe(false);
    expect(hasOutstandingContradiction(graph, 'nope')).toBe(false);
  });

  test('refuses a contradiction against a key that does not exist', () => {
    expect(contradict(dir, { key: 'nope', byKey: 'new', reason: 'x' })).toBe(false);
    expect(contradict(dir, { key: 'old', byKey: 'nope', reason: 'x' })).toBe(false);
    // Nothing written: an edge pointing at an id nothing created is an
    // un-invalidatable claim, and the annotation alone would assert a dispute
    // with no disputant.
    const graph = load(dir);
    expect(graph.edges.some((e) => e.edge === 'contradicts')).toBe(false);
    expect(findingByKey(graph, 'old').contradictedAt).toBeUndefined();
  });

  test('refuses a finding disagreeing with itself', () => {
    expect(contradict(dir, { key: 'old', byKey: 'old', reason: 'x' })).toBe(false);
    const graph = load(dir);
    expect(graph.edges.some((e) => e.edge === 'contradicts')).toBe(false);
    // A self-edge would block promotion forever with no second claim to choose.
    expect(hasOutstandingContradiction(graph, 'old')).toBe(false);
  });
});
