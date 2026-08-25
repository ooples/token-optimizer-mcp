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
 * `answers` inferred from the graph itself, with no session id anywhere.
 *
 * Neither real caller (`plugin/hooks/harvest-worker.mjs`, `wiki_write`) can be
 * relied on to supply a session id that resolves to a task node -- one is
 * opt-in gated, the other's `sessionId` is optional and nothing populates it.
 * But the structural harvest writes `task -[derived_from]-> file` on every
 * tool call, unconditionally, so the task is DERIVABLE: it is whichever task
 * actually touched the SAME anchors this finding resolved to, not simply the
 * newest task node in the graph.
 */
describe('answers inferred by anchor traversal', () => {
  /** Forces the next Date.now() to differ, so edge `at` order is not a coin flip. */
  function tick() {
    const start = Date.now();
    while (Date.now() === start) { /* spin until the clock moves */ }
  }

  it('picks the task that touched the anchor over a more recently active task that did not', () => {
    const dir3 = mkdtempSync(join(tmpdir(), 'ans-trav-'));
    const file = join(dir3, 'a.ts');
    writeFileSync(file, 'export const a = 1;');
    indexFile(dir3, file, 'export const a = 1;');

    putNode(dir3, { kind: 'task', key: 'right-task' });
    putEdge(dir3, nodeId('task', 'right-task'), 'derived_from', nodeId('file', file));

    tick();
    // Created and touched something LATER, but never this anchor. A "most
    // recent task" rule would pick this one, which is exactly the wrong
    // provenance the traversal exists to avoid.
    putNode(dir3, { kind: 'task', key: 'decoy-task' });

    writeHarvested(
      dir3,
      [{ type: 'finding', claim: 'a is 1 by default', anchors: [file], confidence: 0.8 }],
      { sessionId: 's1', projectRoot: dir3 }
    );

    const graph = load(dir3);
    const edge = graph.edges.find((e) => e.edge === 'answers');
    expect(edge).toBeDefined();
    expect(edge.to).toBe(nodeId('task', 'right-task'));
    rmSync(dir3, { recursive: true, force: true });
  });

  it('writes no edge when no task shares an anchor with the finding', () => {
    const dir3 = mkdtempSync(join(tmpdir(), 'ans-trav-'));
    const file = join(dir3, 'b.ts');
    const other = join(dir3, 'unrelated.ts');
    writeFileSync(file, 'export const b = 1;');
    writeFileSync(other, 'export const c = 1;');
    indexFile(dir3, file, 'export const b = 1;');
    indexFile(dir3, other, 'export const c = 1;');

    putNode(dir3, { kind: 'task', key: 'unrelated-task' });
    putEdge(dir3, nodeId('task', 'unrelated-task'), 'derived_from', nodeId('file', other));

    writeHarvested(
      dir3,
      [{ type: 'finding', claim: 'b is 1 by default', anchors: [file], confidence: 0.8 }],
      { sessionId: 's1', projectRoot: dir3 }
    );

    const graph = load(dir3);
    expect(graph.edges.some((e) => e.edge === 'answers')).toBe(false);
    rmSync(dir3, { recursive: true, force: true });
  });

  it('lets an explicit taskId override traversal entirely', () => {
    const dir3 = mkdtempSync(join(tmpdir(), 'ans-trav-'));
    const file = join(dir3, 'c.ts');
    writeFileSync(file, 'export const c = 1;');
    indexFile(dir3, file, 'export const c = 1;');

    // Traversal would find THIS one -- it actually touched the anchor.
    putNode(dir3, { kind: 'task', key: 'inferred-task' });
    putEdge(dir3, nodeId('task', 'inferred-task'), 'derived_from', nodeId('file', file));
    // The caller supplies THIS one instead, and never touched the anchor.
    putNode(dir3, { kind: 'task', key: 'explicit-task' });

    writeHarvested(
      dir3,
      [{ type: 'finding', claim: 'c is 1 by default', anchors: [file], confidence: 0.8 }],
      { sessionId: 's1', taskId: 'explicit-task', projectRoot: dir3 }
    );

    const graph = load(dir3);
    const edge = graph.edges.find((e) => e.edge === 'answers');
    expect(edge).toBeDefined();
    expect(edge.to).toBe(nodeId('task', 'explicit-task'));
    rmSync(dir3, { recursive: true, force: true });
  });

  it('breaks a tie between two tasks that both touched the anchor by which touched it more recently', () => {
    const dir3 = mkdtempSync(join(tmpdir(), 'ans-trav-'));
    const file = join(dir3, 'd.ts');
    writeFileSync(file, 'export const d = 1;');
    indexFile(dir3, file, 'export const d = 1;');

    putNode(dir3, { kind: 'task', key: 'older-task' });
    putEdge(dir3, nodeId('task', 'older-task'), 'derived_from', nodeId('file', file));

    tick();

    putNode(dir3, { kind: 'task', key: 'newer-task' });
    putEdge(dir3, nodeId('task', 'newer-task'), 'derived_from', nodeId('file', file));

    writeHarvested(
      dir3,
      [{ type: 'finding', claim: 'd is 1 by default', anchors: [file], confidence: 0.8 }],
      { sessionId: 's1', projectRoot: dir3 }
    );

    const graph = load(dir3);
    const edge = graph.edges.find((e) => e.edge === 'answers');
    expect(edge).toBeDefined();
    expect(edge.to).toBe(nodeId('task', 'newer-task'));
    rmSync(dir3, { recursive: true, force: true });
  });

  it('does not mistake a prior finding’s own derived_from edge to the anchor for a task', () => {
    // `derived_from` is also how a FINDING cites its anchors (the edges the
    // main writeHarvested path always adds). Without a kind check, traversal
    // would find this edge, see it points at the same anchor, and hand back
    // the PRIOR FINDING's own node id as though it were the task -- a node
    // that does exist, so the no-dangling check alone would not catch it.
    const dir3 = mkdtempSync(join(tmpdir(), 'ans-trav-'));
    const file = join(dir3, 'i.ts');
    writeFileSync(file, 'export const i = 1;');
    indexFile(dir3, file, 'export const i = 1;');

    putNodeWithEdges(
      dir3,
      { kind: 'finding', key: 'prior-finding', claim: 'i was 1 once', confidence: 0.9, type: 'finding' },
      [{ edge: 'derived_from', to: nodeId('file', file) }]
    );

    writeHarvested(
      dir3,
      [{ type: 'finding', claim: 'i is 1 by default', anchors: [file], confidence: 0.8 }],
      { sessionId: 's1', projectRoot: dir3 }
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
    rmSync(dir3, { recursive: true, force: true });
  });
});
