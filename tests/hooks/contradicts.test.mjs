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
import { restorationPlan } from '../../hooks-core/restore.mjs';
import { writeHarvested } from '../../hooks-core/harvest-write.mjs';
import { canonicalPath } from '../../hooks-core/paths.mjs';
import { record } from '../../hooks-core/metrics.mjs';

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
    // Identified, not merely defined: `toBeDefined` passes on any object the
    // finder happens to return, including the contradictOR.
    expect(old.key).toBe('old');
    expect(Boolean(old.retired)).toBe(false);
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

  test('serve discloses WHEN the dispute was raised, not only why', () => {
    // `contradict` writes contradictedAt and contradictionReason on the same
    // line of the same putNode call. Round 1 gave the reason a reader and left
    // the timestamp unread, so a disclosure could say a claim was disputed and
    // why, and not whether that happened this morning or a year ago -- which
    // for a reader deciding whether to trust it is most of the signal.
    const before = Date.now();
    contradict(dir, { key: 'old', byKey: 'new', reason: 're-derived' });
    const graph = load(dir);
    const served = serve(graph, [...graph.nodes.values()].filter((n) => n.kind === 'finding'));

    for (const key of ['old', 'new']) {
      const at = findingIn(served, key).contradictedAt;
      expect(typeof at).toBe('number');
      expect(at).toBeGreaterThanOrEqual(before);
      expect(at).toBeLessThanOrEqual(Date.now());
    }
  });

  test('serve leaves an undisputed finding unmarked', () => {
    contradict(dir, { key: 'old', byKey: 'new', reason: 're-derived' });
    const graph = load(dir);
    const served = serve(graph, [...graph.nodes.values()].filter((n) => n.kind === 'finding'));

    const other = findingIn(served, 'other');
    expect(other.contradicted).toBeUndefined();
    expect(other.contradictedBy).toBeUndefined();
    expect(other.contradictedAt).toBeUndefined();
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

  test('the restore brief marks a disputed finding disputed too', () => {
    // A dispute disclosed on the injection path and silent in a restore reads
    // as "the dispute went away", so the restore brief goes through the same
    // fields. `Likely next` is reached through a `related` edge, which is how
    // co-occurrence recommends a file the session never opened.
    const touched = write('touched.ts', 'export const a = 1;');
    const predicted = write('predicted.ts', 'export function h() { return 1; }');
    indexFile(dir, touched);
    indexFile(dir, predicted);
    putEdge(dir, nodeId('file', touched), 'related', nodeId('file', predicted));
    anchored('restored', 'h returns 1', predicted);
    putNodeWithEdges(dir, {
      kind: 'finding', key: 'rebuttal3', claim: 'h returns 4', confidence: 0.9,
    });
    contradict(dir, { key: 'restored', byKey: 'rebuttal3', reason: 'read it again' });

    const brief = restorationPlan(dir, load(dir), { recentAnchors: [touched] }).text;
    expect(brief).toContain('## Likely next');
    expect(brief).toContain('h returns 1');
    expect(brief).toContain('(disputed by rebuttal3)');
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

/**
 * The `answers` edge: a finding back to the task that produced it.
 *
 * The last of `EDGE_KINDS` with no write site. Its whole point is provenance
 * traversal -- "which session established this, and from what" -- so what is
 * under test is that the edge appears when a real task node exists, and is
 * refused rather than left dangling when it does not.
 */
describe('answers', () => {
  it('links a finding to the task that produced it', () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'ans-'));
    const file = join(dir2, 'x.ts');
    writeFileSync(file, 'export const x = 1;');
    indexFile(dir2, file, 'export const x = 1;');
    putNodeWithEdges(dir2, { kind: 'task', key: 'task-1', prompt: 'why is x 1' });

    writeHarvested(
      dir2,
      [{ type: 'finding', claim: 'x is 1 by default', anchors: [file], confidence: 0.8 }],
      { sessionId: 's1', taskId: 'task-1', projectRoot: dir2 }
    );

    const graph = load(dir2);
    const edge = graph.edges.find((e) => e.edge === 'answers');
    expect(edge).toBeDefined();
    expect(edge.to).toBe(nodeId('task', 'task-1'));
    rmSync(dir2, { recursive: true, force: true });
  });

  it('writes no edge when the supplied taskId resolves to no existing task node', () => {
    // A taskId that names nothing must not become a dangling edge -- the same
    // discipline `resolveAnchor` already holds anchors to above.
    const dir2 = mkdtempSync(join(tmpdir(), 'ans-'));
    const file = join(dir2, 'y.ts');
    writeFileSync(file, 'export const y = 1;');
    indexFile(dir2, file, 'export const y = 1;');
    // Deliberately no task node created for 'ghost-task'.

    writeHarvested(
      dir2,
      [{ type: 'finding', claim: 'y is 1 by default', anchors: [file], confidence: 0.8 }],
      { sessionId: 's1', taskId: 'ghost-task', projectRoot: dir2 }
    );

    const graph = load(dir2);
    expect(graph.edges.some((e) => e.edge === 'answers')).toBe(false);
    // The finding itself must still be written -- an unresolved taskId refuses
    // only the edge, not the whole write.
    expect([...graph.nodes.values()].some((n) => n.kind === 'finding')).toBe(true);
    rmSync(dir2, { recursive: true, force: true });
  });

  it('writes no answers edge when no taskId is supplied at all', () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'ans-'));
    const file = join(dir2, 'z.ts');
    writeFileSync(file, 'export const z = 1;');
    indexFile(dir2, file, 'export const z = 1;');
    // A task node keyed by the SESSION id, present on purpose: omitting
    // `taskId` must not silently fall back to `sessionId` and resolve against
    // it anyway.
    putNodeWithEdges(dir2, { kind: 'task', key: 's1' });

    writeHarvested(
      dir2,
      [{ type: 'finding', claim: 'z is 1 by default', anchors: [file], confidence: 0.8 }],
      { sessionId: 's1', projectRoot: dir2 }
    );

    const graph = load(dir2);
    expect(graph.edges.some((e) => e.edge === 'answers')).toBe(false);
    rmSync(dir2, { recursive: true, force: true });
  });
});

/**
 * `answers` inferred from the graph itself, session-scoped and requiring
 * full coverage.
 *
 * An adversarial review of an earlier version (scanning the whole graph for
 * ANY task sharing ANY anchor, tie broken by recency) constructed four cases
 * where that attributes a finding to the WRONG task: a stale prior session, a
 * concurrent session that touched the anchor a millisecond later, a task that
 * covered only SOME of the finding's anchors, and a tie-break comparator that
 * contradicted its own documented direction. The fix scopes candidates to
 * `nodeId('task', sessionId)` -- the ONE task node this session's own
 * structural harvest could have written -- and requires it to cover EVERY
 * anchor. That is at most one candidate, so there is nothing left to break a
 * tie between; see `taskForAnchors`'s own comment in harvest-write.mjs for why
 * the old tie-break machinery was deleted rather than "fixed".
 */
describe('answers inferred by anchor traversal', () => {
  it('attributes to the current session’s task when it covers every one of the finding’s anchors', () => {
    const dir3 = mkdtempSync(join(tmpdir(), 'ans-trav-'));
    const fileA = join(dir3, 'a1.ts');
    const fileB = join(dir3, 'a2.ts');
    writeFileSync(fileA, 'export const a1 = 1;');
    writeFileSync(fileB, 'export const a2 = 1;');
    indexFile(dir3, fileA, 'export const a1 = 1;');
    indexFile(dir3, fileB, 'export const a2 = 1;');

    putNode(dir3, { kind: 'task', key: 'session-a' });
    putEdge(dir3, nodeId('task', 'session-a'), 'derived_from', nodeId('file', fileA));
    putEdge(dir3, nodeId('task', 'session-a'), 'derived_from', nodeId('file', fileB));

    writeHarvested(
      dir3,
      [{ type: 'finding', claim: 'a1 and a2 both default to 1', anchors: [fileA, fileB], confidence: 0.8 }],
      { sessionId: 'session-a', authoritativeSessionId: 'session-a', projectRoot: dir3 }
    );

    const graph = load(dir3);
    const edge = graph.edges.find((e) => e.edge === 'answers');
    expect(edge).toBeDefined();
    expect(edge.to).toBe(nodeId('task', 'session-a'));
    rmSync(dir3, { recursive: true, force: true });
  });

  it('writes no edge when the current session’s task covers only some of the anchors (overlap, not coverage)', () => {
    const dir3 = mkdtempSync(join(tmpdir(), 'ans-trav-'));
    const fileA = join(dir3, 'b1.ts');
    const fileB = join(dir3, 'b2.ts');
    writeFileSync(fileA, 'export const b1 = 1;');
    writeFileSync(fileB, 'export const b2 = 1;');
    indexFile(dir3, fileA, 'export const b1 = 1;');
    indexFile(dir3, fileB, 'export const b2 = 1;');

    putNode(dir3, { kind: 'task', key: 'session-b' });
    // Touched ONLY fileA. A finding about both files is not this task's work.
    putEdge(dir3, nodeId('task', 'session-b'), 'derived_from', nodeId('file', fileA));

    writeHarvested(
      dir3,
      [{ type: 'finding', claim: 'b1 and b2 both default to 1', anchors: [fileA, fileB], confidence: 0.8 }],
      { sessionId: 'session-b', authoritativeSessionId: 'session-b', projectRoot: dir3 }
    );

    const graph = load(dir3);
    expect(graph.edges.some((e) => e.edge === 'answers')).toBe(false);
    rmSync(dir3, { recursive: true, force: true });
  });

  it('ignores a DIFFERENT (stale, prior) session’s task even when it fully covers the anchor', () => {
    const dir3 = mkdtempSync(join(tmpdir(), 'ans-trav-'));
    const file = join(dir3, 'c.ts');
    writeFileSync(file, 'export const c = 1;');
    indexFile(dir3, file, 'export const c = 1;');

    // An OLDER session that genuinely touched this file, days or weeks ago in
    // spirit -- nothing about it is wrong except that it is not THIS session.
    putNode(dir3, { kind: 'task', key: 'old-session' });
    putEdge(dir3, nodeId('task', 'old-session'), 'derived_from', nodeId('file', file));

    // THIS session never touched the file at all -- it reasoned from injected
    // memory and wrote a finding about it anyway.
    writeHarvested(
      dir3,
      [{ type: 'finding', claim: 'c is 1 by default', anchors: [file], confidence: 0.8 }],
      { sessionId: 'new-session', authoritativeSessionId: 'new-session', projectRoot: dir3 }
    );

    const graph = load(dir3);
    expect(graph.edges.some((e) => e.edge === 'answers')).toBe(false);
    rmSync(dir3, { recursive: true, force: true });
  });

  it('ignores a CONCURRENT session’s task, even one that touched the anchor a moment later', () => {
    const dir3 = mkdtempSync(join(tmpdir(), 'ans-trav-'));
    const file = join(dir3, 'd.ts');
    writeFileSync(file, 'export const d = 1;');
    indexFile(dir3, file, 'export const d = 1;');

    // A second window on the same repository, touching the SAME file at
    // whatever moment `putEdge` happens to run -- no `tick()` here on
    // purpose: the point is that timing must not matter at all, not that this
    // session loses a race.
    putNode(dir3, { kind: 'task', key: 'other-window' });
    putEdge(dir3, nodeId('task', 'other-window'), 'derived_from', nodeId('file', file));

    writeHarvested(
      dir3,
      [{ type: 'finding', claim: 'd is 1 by default', anchors: [file], confidence: 0.8 }],
      { sessionId: 'this-window', authoritativeSessionId: 'this-window', projectRoot: dir3 }
    );

    const graph = load(dir3);
    expect(graph.edges.some((e) => e.edge === 'answers')).toBe(false);
    rmSync(dir3, { recursive: true, force: true });
  });

  it('writes no edge when no task shares an anchor with the finding', () => {
    const dir3 = mkdtempSync(join(tmpdir(), 'ans-trav-'));
    const file = join(dir3, 'e.ts');
    const other = join(dir3, 'unrelated.ts');
    writeFileSync(file, 'export const e = 1;');
    writeFileSync(other, 'export const f = 1;');
    indexFile(dir3, file, 'export const e = 1;');
    indexFile(dir3, other, 'export const f = 1;');

    putNode(dir3, { kind: 'task', key: 'session-e' });
    putEdge(dir3, nodeId('task', 'session-e'), 'derived_from', nodeId('file', other));

    writeHarvested(
      dir3,
      [{ type: 'finding', claim: 'e is 1 by default', anchors: [file], confidence: 0.8 }],
      { sessionId: 'session-e', authoritativeSessionId: 'session-e', projectRoot: dir3 }
    );

    const graph = load(dir3);
    expect(graph.edges.some((e) => e.edge === 'answers')).toBe(false);
    rmSync(dir3, { recursive: true, force: true });
  });

  it('lets an explicit taskId override traversal entirely', () => {
    const dir3 = mkdtempSync(join(tmpdir(), 'ans-trav-'));
    const file = join(dir3, 'g.ts');
    writeFileSync(file, 'export const g = 1;');
    indexFile(dir3, file, 'export const g = 1;');

    // Traversal would find THIS one -- it is this session's task and it
    // covers the anchor.
    putNode(dir3, { kind: 'task', key: 'inferred-task' });
    putEdge(dir3, nodeId('task', 'inferred-task'), 'derived_from', nodeId('file', file));
    // The caller supplies THIS one instead, and never touched the anchor.
    putNode(dir3, { kind: 'task', key: 'explicit-task' });

    writeHarvested(
      dir3,
      [{ type: 'finding', claim: 'g is 1 by default', anchors: [file], confidence: 0.8 }],
      { sessionId: 'inferred-task', authoritativeSessionId: 'inferred-task', taskId: 'explicit-task', projectRoot: dir3 }
    );

    const graph = load(dir3);
    const edge = graph.edges.find((e) => e.edge === 'answers');
    expect(edge).toBeDefined();
    expect(edge.to).toBe(nodeId('task', 'explicit-task'));
    rmSync(dir3, { recursive: true, force: true });
  });

  it('does not mistake a prior finding’s own derived_from edge to the anchor for a task', () => {
    // `derived_from` is also how a FINDING cites its anchors. The lookup is
    // now a direct `nodeId('task', sessionId)` read, not a scan of every edge
    // in the graph, so a finding's own edge is never even visited -- covered
    // here as a construction guarantee, not a runtime filter.
    const dir3 = mkdtempSync(join(tmpdir(), 'ans-trav-'));
    const file = join(dir3, 'h.ts');
    writeFileSync(file, 'export const h = 1;');
    indexFile(dir3, file, 'export const h = 1;');

    putNodeWithEdges(
      dir3,
      { kind: 'finding', key: 'prior-finding', claim: 'h was 1 once', confidence: 0.9, type: 'finding' },
      [{ edge: 'derived_from', to: nodeId('file', file) }]
    );

    writeHarvested(
      dir3,
      [{ type: 'finding', claim: 'h is 1 by default', anchors: [file], confidence: 0.8 }],
      { sessionId: 'prior-finding', authoritativeSessionId: 'prior-finding', projectRoot: dir3 }
    );

    const graph = load(dir3);
    expect(graph.edges.some((e) => e.edge === 'answers')).toBe(false);
    rmSync(dir3, { recursive: true, force: true });
  });

  it('writes no edge from a plain sessionId alone, even when a real FOREIGN session fully covers the anchor', () => {
    // Round 3's fix closed "unrelated or invented sessionId" and "a
    // concurrent session's task wins a timing race". It did NOT close this:
    // a caller (`wiki_write`) can supply a REAL, foreign session's id --
    // named by mistake, or copied from a stale value -- and coverage cannot
    // tell that session apart from the current one, because that OTHER
    // session genuinely did touch these files. `sessionId` alone is not
    // evidence; only `authoritativeSessionId` (never supplied by an
    // unverified caller) may gate the traversal.
    const dir3 = mkdtempSync(join(tmpdir(), 'ans-trav-'));
    const file = join(dir3, 'i.ts');
    writeFileSync(file, 'export const i = 1;');
    indexFile(dir3, file, 'export const i = 1;');

    // A genuinely real PRIOR session whose task actually covers the anchor.
    putNode(dir3, { kind: 'task', key: 'foreign-real-session' });
    putEdge(dir3, nodeId('task', 'foreign-real-session'), 'derived_from', nodeId('file', file));

    // The caller names that session as `sessionId` -- exactly the shape an
    // unverified MCP tool argument would take -- but supplies no
    // `authoritativeSessionId`.
    writeHarvested(
      dir3,
      [{ type: 'finding', claim: 'i is 1 by default', anchors: [file], confidence: 0.8 }],
      { sessionId: 'foreign-real-session', projectRoot: dir3 }
    );

    const graph = load(dir3);
    expect(graph.edges.some((e) => e.edge === 'answers')).toBe(false);
    rmSync(dir3, { recursive: true, force: true });
  });
});

/**
 * The derivation record: the checkable half of provenance.
 *
 * A session or task id says WHERE a claim came from. It never says whether
 * that derivation still applies -- so alongside `answers`, every newly
 * written finding also gets a small, bounded `derivation` record: the hash
 * each anchor carried at claim time (new information; the `derived_from`
 * edges already say WHICH anchors, so this does not restate that), and
 * whatever matching `tool-outcome` evidence exists, reduced to only the
 * fields that evidence actually carries.
 */
describe('the derivation record', () => {
  it('records the hash each anchor carried at claim time', () => {
    const dir3 = mkdtempSync(join(tmpdir(), 'deriv-'));
    const file = join(dir3, 'e.ts');
    writeFileSync(file, 'export const e = 1;');

    writeHarvested(
      dir3,
      [{ type: 'finding', claim: 'e is 1 by default', anchors: [file], confidence: 0.8 }],
      { sessionId: 's1', projectRoot: dir3 }
    );

    const graph = load(dir3);
    const fileNode = graph.nodes.get(nodeId('file', file));
    const finding = [...graph.nodes.values()].find((n) => n.kind === 'finding');
    expect(finding.derivation).toBeDefined();
    expect(finding.derivation.anchors[nodeId('file', file)]).toBe(fileNode.hash);
    rmSync(dir3, { recursive: true, force: true });
  });

  it('includes only the fields a matching tool-outcome event actually evidences', () => {
    const dir3 = mkdtempSync(join(tmpdir(), 'deriv-'));
    const file = join(dir3, 'f.ts');
    writeFileSync(file, 'export const f = 1;');

    record(dir3, {
      kind: 'tool-outcome',
      anchor: canonicalPath(file).slice(0, 120),
      toolName: 'Read',
      success: true,
      at: Date.now(),
    });

    writeHarvested(
      dir3,
      [{ type: 'finding', claim: 'f is 1 by default', anchors: [file], confidence: 0.8 }],
      { sessionId: 's1', projectRoot: dir3 }
    );

    const graph = load(dir3);
    const finding = [...graph.nodes.values()].find((n) => n.kind === 'finding');
    expect(finding.derivation.operations).toHaveLength(1);
    const op = finding.derivation.operations[0];
    expect(op.tool).toBe('Read');
    expect(op.success).toBe(true);
    // Not fabricated: this pipeline's tool-outcome events carry no exit code
    // or output today, so neither key is present rather than invented.
    expect(op.exit).toBeUndefined();
    expect(op.output).toBeUndefined();
    rmSync(dir3, { recursive: true, force: true });
  });

  it('ignores a tool-outcome event anchored to a different file', () => {
    const dir3 = mkdtempSync(join(tmpdir(), 'deriv-'));
    const file = join(dir3, 'g.ts');
    const other = join(dir3, 'other.ts');
    writeFileSync(file, 'export const g = 1;');

    record(dir3, {
      kind: 'tool-outcome',
      anchor: canonicalPath(other).slice(0, 120),
      toolName: 'Read',
      success: true,
      at: Date.now(),
    });

    writeHarvested(
      dir3,
      [{ type: 'finding', claim: 'g is 1 by default', anchors: [file], confidence: 0.8 }],
      { sessionId: 's1', projectRoot: dir3 }
    );

    const graph = load(dir3);
    const finding = [...graph.nodes.values()].find((n) => n.kind === 'finding');
    expect(finding.derivation.operations).toHaveLength(0);
    rmSync(dir3, { recursive: true, force: true });
  });

  it('bounds the number of operations recorded, keeping the most recent', () => {
    const dir3 = mkdtempSync(join(tmpdir(), 'deriv-'));
    const file = join(dir3, 'h.ts');
    writeFileSync(file, 'export const h = 1;');
    const label = canonicalPath(file).slice(0, 120);

    const base = Date.now() - 1000;
    for (let i = 0; i < 8; i++) {
      record(dir3, {
        kind: 'tool-outcome',
        anchor: label,
        toolName: `tool-${i}`,
        success: true,
        at: base + i,
      });
    }

    writeHarvested(
      dir3,
      [{ type: 'finding', claim: 'h is 1 by default', anchors: [file], confidence: 0.8 }],
      { sessionId: 's1', projectRoot: dir3 }
    );

    const graph = load(dir3);
    const finding = [...graph.nodes.values()].find((n) => n.kind === 'finding');
    // Capped -- this is not a replay log -- and the most RECENT of the 8,
    // not the first 5 written.
    expect(finding.derivation.operations).toHaveLength(5);
    expect(finding.derivation.operations[0].tool).toBe('tool-7');
    expect(finding.derivation.operations[4].tool).toBe('tool-3');
    // An empty `operations` array is ambiguous by itself; the completeness
    // flag is what says "more existed than the cap kept" here, versus
    // "genuinely nothing happened" in the test below.
    expect(finding.derivation.operationsComplete).toBe(false);
    rmSync(dir3, { recursive: true, force: true });
  });

  it('declares its scope as file-surface only, and never joins a command-surface tool-outcome', () => {
    // `adapter.mjs` stores the COMMAND TEXT in `anchor` for a command-surface
    // event; `anchorLabel` produces a canonical FILE PATH. There is no join
    // key in common, so a build or test run can never appear here -- this
    // asserts that gap is declared, not silently absent.
    const dir3 = mkdtempSync(join(tmpdir(), 'deriv-'));
    const file = join(dir3, 'j.ts');
    writeFileSync(file, 'export const j = 1;');

    record(dir3, {
      kind: 'tool-outcome',
      surface: 'command',
      anchor: 'npm test',
      toolName: 'Bash',
      success: true,
      at: Date.now(),
    });

    writeHarvested(
      dir3,
      [{ type: 'finding', claim: 'j is 1 by default', anchors: [file], confidence: 0.8 }],
      { sessionId: 's1', projectRoot: dir3 }
    );

    const graph = load(dir3);
    const finding = [...graph.nodes.values()].find((n) => n.kind === 'finding');
    expect(finding.derivation.operationsScope).toBe('file');
    expect(finding.derivation.operations).toHaveLength(0);
    // Confirmed empty, not merely absent-looking: nothing was capped and the
    // log was not truncated, so this IS "no file-surface operations matched".
    expect(finding.derivation.operationsComplete).toBe(true);
    rmSync(dir3, { recursive: true, force: true });
  });

  it('marks operationsComplete false when the evidence log itself may have dropped older matches', () => {
    // `MAX_BYTES` (metrics.mjs) is read from its env var ONCE, at module
    // load -- already evaluated for this whole test run -- so overriding the
    // env var per-test has no effect. Cross the real 2,000,000-byte default
    // instead, with a single padded event, rather than fight the constant.
    const dir3 = mkdtempSync(join(tmpdir(), 'deriv-'));
    const file = join(dir3, 'k.ts');
    writeFileSync(file, 'export const k = 1;');

    // None of these match this finding's anchor at all -- the point is that
    // TRUNCATION ALONE, independent of any match, must still mark the record
    // incomplete: an older matching event could have been evicted before
    // this join ever saw it.
    record(dir3, {
      kind: 'tool-outcome',
      anchor: canonicalPath(join(dir3, 'padding.ts')).slice(0, 120),
      toolName: 'Read',
      success: true,
      padding: 'x'.repeat(2_100_000),
    });
    record(dir3, {
      kind: 'tool-outcome',
      anchor: canonicalPath(join(dir3, 'other.ts')).slice(0, 120),
      toolName: 'Read',
      success: true,
    });

    writeHarvested(
      dir3,
      [{ type: 'finding', claim: 'k is 1 by default', anchors: [file], confidence: 0.8 }],
      { sessionId: 's1', projectRoot: dir3 }
    );

    const graph = load(dir3);
    const finding = [...graph.nodes.values()].find((n) => n.kind === 'finding');
    expect(finding.derivation.operations).toHaveLength(0);
    expect(finding.derivation.operationsComplete).toBe(false);
    rmSync(dir3, { recursive: true, force: true });
  });
});

/**
 * THE REASON A PERSON TYPED HAD NO READER.
 *
 * `contradict` stores `contradictionReason` -- up to 400 characters of human
 * explanation -- on every call, and until this it was read by nothing outside
 * this file's own "records WHY the belief changed" test. The dispute disclosure
 * named the other key and stopped; `audit` counts ends; the dashboard detail view
 * renders neither `contradictionReason` nor `contradictedAt`. Someone typed why
 * one claim contradicts another and it was seen by nobody.
 *
 * NOTE ON THE GUARD THAT DID NOT CATCH THIS. The reachability check scans
 * EXPORTS, so an unread RECORD FIELD is invisible to it -- correct code that
 * nothing calls, in the one shape the guard cannot see.
 */
describe('the contradiction reason reaches a reader', () => {
  let dir4;
  let workspace;
  let anchorPath;
  let priorHoldout;

  beforeEach(() => {
    // PIN THE ARM, the same way `disclosing a dispute when a finding is served`
    // above does. `forTouch` returns null for an anchor in the measurement
    // holdout -- a withheld baseline is the point of the holdout, not a failure
    // -- and the arm is drawn from a hash of the (random) workspace path, so a
    // suite asserting on injected text without pinning is red a fraction of runs
    // for the CORRECT reason. Observed: two failures in four full-suite runs,
    // `expect(null).toContain('DISPUTED by claim-b')`.
    //
    // THE PRIOR VALUE IS RESTORED RATHER THAN DELETED, matching
    // command-injection.test.mjs: another suite in the same worker may have set
    // it, and `afterEach` runs even when the test threw, which is the `finally`
    // this needs.
    priorHoldout = process.env.TOKEN_OPTIMIZER_HOLDOUT;
    process.env.TOKEN_OPTIMIZER_HOLDOUT = '0';
    dir4 = mkdtempSync(join(tmpdir(), 'contra-reason-'));
    workspace = mkdtempSync(join(tmpdir(), 'contra-reason-ws-'));
    anchorPath = canonicalPath(join(workspace, 'k.ts'));
    writeFileSync(anchorPath, 'export function k() { return 1; }');
    indexFile(dir4, anchorPath);
    const id = putNode(dir4, {
      kind: 'finding', key: 'claim-a', claim: 'k returns 1', confidence: 0.9, type: 'finding',
    });
    putEdge(dir4, id, 'derived_from', nodeId('file', anchorPath));
    putNodeWithEdges(dir4, {
      kind: 'finding', key: 'claim-b', claim: 'k returns 2', confidence: 0.9,
    });
  });

  afterEach(() => {
    if (priorHoldout === undefined) delete process.env.TOKEN_OPTIMIZER_HOLDOUT;
    else process.env.TOKEN_OPTIMIZER_HOLDOUT = priorHoldout;
    rmSync(dir4, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  const servedFindings = () => {
    const graph = load(dir4);
    return serve(graph, [...graph.nodes.values()].filter((n) => n.kind === 'finding'));
  };

  test('serve carries it, at BOTH ends of the disagreement', () => {
    contradict(dir4, { key: 'claim-a', byKey: 'claim-b', reason: 'read the tests, it returns 2' });
    const served = servedFindings();
    // `contradict` annotates only the contradicted end, so a disclosure reading
    // its own record alone would tell one side of the dispute why and leave the
    // other side pointing at a key with no explanation.
    expect(served.find((f) => f.key === 'claim-a').contradictionReason)
      .toBe('read the tests, it returns 2');
    expect(served.find((f) => f.key === 'claim-b').contradictionReason)
      .toBe('read the tests, it returns 2');
  });

  test('the injection disclosure renders it beside the key', () => {
    contradict(dir4, { key: 'claim-a', byKey: 'claim-b', reason: 'read the tests, it returns 2' });
    const out = forTouch(dir4, load(dir4), anchorPath, { sessionId: 'reason-1' });
    expect(out).toContain('DISPUTED by claim-b');
    expect(out).toContain('Reason given: read the tests, it returns 2');
  });

  test('an empty reason renders nothing, rather than an empty label', () => {
    contradict(dir4, { key: 'claim-a', byKey: 'claim-b', reason: '   ' });
    const served = servedFindings().find((f) => f.key === 'claim-a');
    expect(served.contradicted).toBe(true);
    expect(served.contradictionReason).toBeUndefined();
    const out = forTouch(dir4, load(dir4), anchorPath, { sessionId: 'reason-2' });
    expect(out).toContain('DISPUTED by claim-b');
    expect(out).not.toContain('Reason given:');
  });

  test('a long reason is truncated where it is rendered, not where it is stored', () => {
    const reason = 'x'.repeat(400);
    contradict(dir4, { key: 'claim-a', byKey: 'claim-b', reason });
    // Stored and served in full: `wiki_query` is a detail view and pays no
    // injection budget.
    expect(servedFindings().find((f) => f.key === 'claim-a').contradictionReason).toBe(reason);
    // Rendered short, because `fit` prices this string against the budget.
    const out = forTouch(dir4, load(dir4), anchorPath, { sessionId: 'reason-3' });
    expect(out).toContain(`Reason given: ${'x'.repeat(140)}...`);
    expect(out).not.toContain('x'.repeat(141));
  });
});
