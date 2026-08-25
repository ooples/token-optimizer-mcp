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

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { putNode, putEdge, putNodeWithEdges, load, nodeId } from '../../hooks-core/wiki.mjs';
import { contradict, hasOutstandingContradiction, audit } from '../../hooks-core/curate.mjs';
import { indexFile, serve } from '../../hooks-core/staleness.mjs';
import { forTouch, sessionIndex } from '../../hooks-core/inject.mjs';

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

/**
 * A dispute is worthless unless the reader is told about it.
 *
 * `WIKI_GRAPH.md` argues for an edge rather than an overwrite so that a reader
 * "sees both claims and the disagreement between them". Recording the edge and
 * then serving the finding as though nothing disagreed with it throws that away,
 * so these tests are about the serve and render path rather than the store.
 */
describe('disclosing a dispute when a finding is served', () => {
  let workspace;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'contra-ws-'));
    // Pin the arm: forTouch delivers nothing in the holdout, and the arm is
    // chosen from the (random) workspace path, so this suite would otherwise be
    // red about one run in ten for the correct reason.
    process.env.TOKEN_OPTIMIZER_HOLDOUT = '0';
  });

  afterEach(() => {
    delete process.env.TOKEN_OPTIMIZER_HOLDOUT;
    rmSync(workspace, { recursive: true, force: true });
  });

  const write = (name, text) => {
    const path = join(workspace, name);
    writeFileSync(path, text);
    return path;
  };

  /** An anchored finding, which is what forTouch and staleness both need. */
  function anchored(key, claim, path, extra = {}) {
    const id = putNode(dir, {
      kind: 'finding', key, claim, confidence: 0.9, type: 'finding', ...extra,
    });
    putEdge(dir, id, 'derived_from', nodeId('file', path));
    return id;
  }

  const findingIn = (list, key) => list.find((f) => f.key === key);

  test('serve names the other claim, at both ends of the disagreement', () => {
    contradict(dir, { key: 'old', byKey: 'new', reason: 're-derived' });
    const graph = load(dir);
    const served = serve(graph, [...graph.nodes.values()].filter((n) => n.kind === 'finding'));

    // A key rather than the claim, because the reader can call wiki_query with
    // a key and the injection path pays for every character it renders.
    expect(findingIn(served, 'old').contradicted).toBe(true);
    expect(findingIn(served, 'old').contradictedBy).toBe('new');
    expect(findingIn(served, 'new').contradicted).toBe(true);
    expect(findingIn(served, 'new').contradictedBy).toBe('old');
  });

  test('serve leaves an undisputed finding unmarked', () => {
    contradict(dir, { key: 'old', byKey: 'new', reason: 're-derived' });
    const graph = load(dir);
    const served = serve(graph, [...graph.nodes.values()].filter((n) => n.kind === 'finding'));

    const other = findingIn(served, 'other');
    expect(other.contradicted).toBeUndefined();
    expect(other.contradictedBy).toBeUndefined();
  });

  test('serve discloses on a type an anchor cannot invalidate', () => {
    // `command` findings take serve's early return: they are not content
    // dependent, so no anchor is read and no staleness is computed. Another
    // finding can still disagree with them, and that path is the one that would
    // silently drop the disclosure.
    putNodeWithEdges(dir, {
      kind: 'finding', key: 'cmd', claim: 'run npm test', confidence: 0.9, type: 'command',
    });
    contradict(dir, { key: 'cmd', byKey: 'new', reason: 'npx jest does not work here' });

    const graph = load(dir);
    const served = serve(graph, [...graph.nodes.values()].filter((n) => n.kind === 'finding'));
    expect(findingIn(served, 'cmd').contradicted).toBe(true);
    expect(findingIn(served, 'cmd').contradictedBy).toBe('new');
  });

  test('the injected text names the disagreement and the key to query', () => {
    const path = write('a.ts', 'export function f() { return 1; }');
    indexFile(dir, path);
    anchored('served', 'f returns 1', path);
    putNodeWithEdges(dir, {
      kind: 'finding', key: 'rebuttal', claim: 'f returns 2', confidence: 0.9,
    });
    contradict(dir, { key: 'served', byKey: 'rebuttal', reason: 're-derived' });

    const out = forTouch(dir, load(dir), path, { sessionId: 's1' });
    expect(out).toContain('f returns 1');
    expect(out).toContain('DISPUTED by rebuttal');
    // A dispute is not staleness. Nothing touched the anchor, so none of the
    // staleness vocabulary may appear on the strength of a disagreement.
    expect(out).not.toContain('STALE');
    expect(out).not.toContain('recorded earlier');
  });

  test('a stale finding that is also disputed discloses both, separately', () => {
    const path = write('b.ts', 'export function g() { return 1; }');
    indexFile(dir, path);
    anchored('both', 'g returns 1', path);
    putNodeWithEdges(dir, {
      kind: 'finding', key: 'rebuttal2', claim: 'g returns 3', confidence: 0.9,
    });
    contradict(dir, { key: 'both', byKey: 'rebuttal2', reason: 'read it again' });
    // The anchor changes underneath the claim: staleness with evidence, which is
    // the strong stale form Task 4 guards.
    writeFileSync(path, 'export function g() { return 2; }');

    // SNAPSHOTS ON. `load` leaves them out by default, and without the stored
    // `before` there is no diff to rebuild -- which is the softened stale form,
    // not the strong one this test is about.
    const graph = load(dir, { snapshots: true });
    const served = serve(graph, [...graph.nodes.values()].filter((n) => n.kind === 'finding'));
    const finding = findingIn(served, 'both');
    expect(finding.stale).toBe(true);
    expect(finding.staleEvidence).toBe(true);
    expect(finding.contradicted).toBe(true);

    const out = forTouch(dir, load(dir, { snapshots: true }), path, { sessionId: 's2' });
    expect(out).toContain('STALE (');
    expect(out).toContain('What changed:');
    expect(out).toContain('DISPUTED by rebuttal2');
  });

  test('the session index lists a disputed finding as disputed', () => {
    contradict(dir, { key: 'old', byKey: 'new', reason: 're-derived' });
    const index = sessionIndex(dir, load(dir), { relevantFindingIds: ['old'] });

    // The first thing a session reads must not present a disputed claim as
    // settled either.
    expect(index).toContain('[DISPUTED by new]');
    expect(index).toContain('f returns 1');
  });
});
