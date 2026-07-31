/**
 * Regressions for defects found in review.
 *
 * Two of these were REAL PRODUCT BUGS that the existing suite could not see,
 * because the tests constructed the state they asserted on instead of
 * exercising the path that produces it:
 *
 *   - `downstream` was read by report() and written by NOTHING in the product.
 *     Both arm means were zero, so the headline saving would have been reported
 *     as zero forever while every test passed.
 *   - `file` nodes were never given a snapshot, so refusalPayload returned null
 *     for every real file and the zero-turn refusal never fired outside tests
 *     that wrote the snapshot by hand.
 *
 * The lesson is encoded here: these tests go through the PRODUCING path and
 * never write the field under test directly.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { load, putNode, putEdge, nodeId } from '../../hooks-core/wiki.mjs';
import { indexFile, invalidateOnWrite, checkAnchor } from '../../hooks-core/staleness.mjs';
import { extractSymbols, symbolKey } from '../../hooks-core/symbols.mjs';
import { readCostBytes } from '../../hooks-core/decide.mjs';
import { recordRead, record, report } from '../../hooks-core/metrics.mjs';
import { refusalPayload, sessionIndex } from '../../hooks-core/inject.mjs';
import { correct, create, audit, activeFindings } from '../../hooks-core/curate.mjs';
import { loadState, saveState } from '../../hooks-core/policy.mjs';

let workspace;
let dir;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'review-'));
  dir = join(workspace, 'wiki');
  process.env.TOKEN_OPTIMIZER_HOLDOUT = '0';
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

const write = (name, text) => {
  const path = join(workspace, name);
  writeFileSync(path, text);
  return path;
};

describe('the savings metric has a real producer', () => {
  test('report() measures a saving WITHOUT any test writing `downstream`', () => {
    // Every read cost here comes from recordRead, which the router calls on an
    // allowed read. If that producer is ever removed, this test fails rather
    // than the metric silently reporting zero.
    for (let i = 0; i < 25; i++) {
      record(dir, { kind: 'inject', anchor: `/t${i}.ts`, sessionId: 's', holdout: false, tokens: 120 });
      recordRead(dir, { anchor: `/t${i}.ts`, sessionId: 's', bytes: 1_200 });
    }
    for (let i = 0; i < 8; i++) {
      record(dir, { kind: 'inject', anchor: `/c${i}.ts`, sessionId: 's', holdout: true, tokens: 0 });
      recordRead(dir, { anchor: `/c${i}.ts`, sessionId: 's', bytes: 40_000 });
    }

    const out = report(dir);
    expect(out.sufficientData).toBe(true);
    expect(out.estimatedTokensAvoided).toBeGreaterThan(0);
  });

  test('an allowed read reports its real cost in bytes', () => {
    const path = write('big.ts', 'x'.repeat(40_000));
    expect(readCostBytes({ tool_name: 'Read', tool_input: { file_path: path } })).toBe(40_000);
  });

  test('non-reads and binaries contribute nothing', () => {
    const png = write('a.png', 'x'.repeat(40_000));
    expect(readCostBytes({ tool_name: 'Read', tool_input: { file_path: png } })).toBe(0);
    expect(readCostBytes({ tool_name: 'Grep', tool_input: { pattern: 'x' } })).toBe(0);
  });
});

describe('file nodes carry a snapshot, so the zero-turn refusal actually works', () => {
  test('indexFile alone is enough for refusalPayload to produce a diff', () => {
    // Goes through indexFile, NOT a hand-written putNode with a snapshot --
    // which is exactly how the original bug hid.
    const body = Array.from({ length: 200 }, (_, i) => `export const v${i} = ${i};`);
    const path = write('a.ts', body.join('\n'));
    indexFile(dir, path);

    writeFileSync(path, [...body.slice(0, 100), 'export const CHANGED = true;', ...body.slice(101)].join('\n'));

    const payload = refusalPayload(load(dir), path, { seenThisSession: true });
    expect(payload).toContain('+ export const CHANGED = true;');
  });

  test('an unchanged indexed file is reported as unchanged', () => {
    const path = write('a.ts', 'export const a = 1;\n');
    indexFile(dir, path);
    expect(refusalPayload(load(dir), path, { seenThisSession: true })).toContain('UNCHANGED');
  });
});

describe('eager invalidation is precise, not blanket', () => {
  test('editing one function does not permanently stale findings about another', () => {
    const before = ['def alpha():', '    return 1', '', 'def beta():', '    return 2'].join('\n');
    const path = write('a.py', before);
    indexFile(dir, path);

    const betaFinding = putNode(dir, { kind: 'finding', key: 'fb', claim: 'beta returns two', confidence: 0.9 });
    putEdge(dir, betaFinding, 'derived_from', nodeId('symbol', symbolKey(path, 'beta')));
    const alphaFinding = putNode(dir, { kind: 'finding', key: 'fa', claim: 'alpha returns one', confidence: 0.9 });
    putEdge(dir, alphaFinding, 'derived_from', nodeId('symbol', symbolKey(path, 'alpha')));

    const after = ['def alpha():', '    return 99', '', 'def beta():', '    return 2'].join('\n');
    writeFileSync(path, after);
    const marked = invalidateOnWrite(dir, load(dir), path, before, after);

    expect(marked).toContain('fa');
    // The whole point of symbol nodes: an unrelated edit must not stale this.
    expect(marked).not.toContain('fb');
  });
});

describe('same-named symbols do not collide', () => {
  test('two methods sharing a name get distinct keys', () => {
    const source = [
      'class A {',
      '  read() { return 1; }',
      '}',
      'class B {',
      '  read() { return 2; }',
      '}',
    ].join('\n');
    const names = extractSymbols('a.ts', source).map((s) => s.name);
    const reads = names.filter((n) => n.startsWith('read'));
    expect(reads).toHaveLength(2);
    // Collapsing onto one node meant staleness was evaluated against the wrong
    // span -- a function reported stale because a namesake changed.
    expect(new Set(reads).size).toBe(2);
  });

  test('a unique name keeps its plain, readable key', () => {
    const names = extractSymbols('a.ts', 'export function only() { return 1; }').map((s) => s.name);
    expect(names).toContain('only');
  });
});

describe('session state survives a malformed file', () => {
  test.each([['null', 'null'], ['empty object', '{}'], ['old layout', '{"files":[]}']])(
    '%s does not throw and yields usable maps', (_label, contents) => {
      const stateDir = join(tmpdir(), 'token-optimizer-hooks');
      mkdirSync(stateDir, { recursive: true });
      const session = `shape-${Math.abs(contents.length)}-${_label.replace(/\W/g, '')}`;
      writeFileSync(join(stateDir, `${session}.json`), contents);

      const state = loadState(session);
      // Only a parse THROW used to fall back, so these shapes produced an
      // object with no maps and the next property access threw inside the
      // router -- surfacing as "enforcement silently stopped working".
      expect(state.seen).toEqual({});
      expect(state.denied).toEqual({});
      rmSync(join(stateDir, `${session}.json`), { force: true });
    });

  test('concurrent saves union rather than overwrite', () => {
    const session = `merge-${Date.now()}`;
    saveState(session, { seen: { '/a.ts': true }, denied: {} });
    // A second process that loaded earlier and knows nothing about /a.ts.
    saveState(session, { seen: { '/b.ts': true }, denied: { 'read:/b.ts': true } });

    const merged = loadState(session);
    // Losing a `denied` entry re-arms a refusal already issued, which is the
    // loop the design promises cannot happen.
    expect(merged.seen['/a.ts']).toBe(true);
    expect(merged.seen['/b.ts']).toBe(true);
  });
});

describe('curation cannot destroy a claim', () => {
  test('the replacement is written before the original is retired', () => {
    const path = write('a.ts', 'export const a = 1;');
    indexFile(dir, path);
    const id = putNode(dir, { kind: 'finding', key: 'f1', claim: 'original claim here', confidence: 0.8 });
    putEdge(dir, id, 'derived_from', nodeId('file', path));

    const replacement = correct(dir, 'f1', 'corrected claim here');
    const graph = load(dir);

    // append() fails open, so retiring first risks a claim vanishing with
    // nothing in its place. The successor must exist first.
    expect(graph.nodes.get(nodeId('finding', replacement))).toBeTruthy();
    expect(activeFindings(graph).map((f) => f.claim)).toContain('corrected claim here');
  });

  test('a hand-written finding must anchor to a file that EXISTS', () => {
    // An edge to an id nothing created looks anchored to audit() but can never
    // be checked -- the un-invalidatable finding the rules exist to prevent.
    expect(create(dir, { claim: 'about an imaginary file', anchors: [join(workspace, 'nope.ts')] })).toBeNull();
  });

  test('a real anchor is indexed so the claim stays checkable', () => {
    const path = write('real.ts', 'export function f() { return 1; }');
    const key = create(dir, { claim: 'f returns one', anchors: [path] });
    expect(key).toBeTruthy();

    const graph = load(dir);
    expect(graph.nodes.has(nodeId('file', path))).toBe(true);
    expect(audit(graph).orphaned).toHaveLength(0);

    writeFileSync(path, 'export function f() { return 2; }');
    expect(checkAnchor(graph.nodes.get(nodeId('file', path))).fresh).toBe(false);
  });

  test('an edge to a missing node counts as orphaned, not anchored', () => {
    const id = putNode(dir, { kind: 'finding', key: 'ghost', claim: 'anchored to nothing', confidence: 0.9 });
    putEdge(dir, id, 'derived_from', nodeId('file', '/never/created.ts'));
    expect(audit(load(dir)).orphaned).toHaveLength(1);
  });
});

describe('retired findings never reach the model', () => {
  test('the session index excludes them', () => {
    const path = write('a.ts', 'export const a = 1;');
    indexFile(dir, path);
    const id = putNode(dir, { kind: 'finding', key: 'f1', claim: 'this will be retired', confidence: 0.9 });
    putEdge(dir, id, 'derived_from', nodeId('file', path));
    putNode(dir, { kind: 'finding', key: 'f1', claim: 'this will be retired', confidence: 0.9, retired: true });

    expect(sessionIndex(dir, load(dir))).toBeNull();
  });

  test('a finding with no claim does not crash the index', () => {
    putNode(dir, { kind: 'finding', key: 'malformed', confidence: 0.9 });
    expect(() => sessionIndex(dir, load(dir))).not.toThrow();
  });
});

describe('caller fields cannot overwrite node bookkeeping', () => {
  test('a stale id passed back in is ignored', () => {
    // curate.mjs spreads whole existing nodes back into putNode on every pin,
    // retire and correct, so this is the normal path rather than an edge case.
    const id = putNode(dir, { kind: 'file', key: '/a.ts', id: 'file:deadbeefdeadbeef', t: 'x' });
    expect(id).toBe(nodeId('file', '/a.ts'));
    expect(load(dir).nodes.get(id).id).toBe(nodeId('file', '/a.ts'));
  });
});

describe('the graph directory is not world-readable', () => {
  // POSIX mode bits are not meaningful on Windows, so the assertion is skipped
  // DECLARATIVELY rather than by an early return inside the test body. The
  // early return reported a pass on Windows while asserting nothing, which is
  // the worst of both -- no coverage, and a green tick claiming there was.
  const posixOnly = process.platform === 'win32' ? test.skip : test;

  posixOnly('it is created with mode 0700', () => {
    putNode(dir, { kind: 'file', key: '/a.ts' });
    expect(statSync(dir).mode & 0o077).toBe(0);
  });

  // This one is meaningful everywhere: the directory must exist and be usable.
  test('it is created and writable on every platform', () => {
    putNode(dir, { kind: 'file', key: '/a.ts' });
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(load(dir).nodes.size).toBe(1);
  });
});
