/**
 * P6: curation, audit, and export.
 *
 * The properties under test are the ones that keep a human-editable graph
 * trustworthy: corrections append rather than overwrite, provenance is never
 * lost, human assertions get no exemption from staleness, and the audit view
 * actually surfaces the nodes that can rot silently.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  pin, correct, retire, create, activeFindings, audit, exportMarkdown, ORIGIN_HUMAN,
} from '../../hooks-core/curate.mjs';
import { load, putNode, putEdge, nodeId } from '../../hooks-core/wiki.mjs';
import { canonicalPath } from '../../hooks-core/paths.mjs';
import { indexFile, checkAnchor } from '../../hooks-core/staleness.mjs';

let workspace;
let dir;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'curate-'));
  dir = join(workspace, 'wiki');
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

const write = (name, text) => {
  const path = join(workspace, name);
  writeFileSync(path, text);
  return path;
};

function seed(path, key = 'f1', claim = 'the retry budget is shared') {
  // Index first so the anchor NODE exists, not just an edge pointing at an id.
  // A dangling edge is what an older graph version or a direct write leaves
  // behind, and export correctly treats those findings as unanchored.
  indexFile(dir, path);
  const id = putNode(dir, { kind: 'finding', key, claim, confidence: 0.8, origin: 'harvested' });
  putEdge(dir, id, 'derived_from', nodeId('file', path));
  return key;
}

describe('corrections append, never overwrite', () => {
  test('the original is retired and kept, not deleted', () => {
    const path = write('a.ts', 'x');
    const key = seed(path);

    const replacement = correct(dir, key, 'the retry budget is per-host');
    const graph = load(dir);

    // The record of what was believed survives -- that is the whole reason the
    // store is append-only.
    expect(graph.nodes.get(nodeId('finding', key)).retired).toBe(true);
    expect(graph.nodes.get(nodeId('finding', replacement)).claim).toBe('the retry budget is per-host');
    expect(graph.edges.some((e) => e.edge === 'supersedes')).toBe(true);
  });

  test('a correction inherits the anchors, so it can still go stale', () => {
    // Otherwise correcting a finding would quietly make it un-invalidatable.
    const path = write('a.ts', 'x');
    const replacement = correct(dir, seed(path), 'revised claim here');

    const graph = load(dir);
    const anchors = graph.edges.filter(
      (e) => e.edge === 'derived_from' && e.from === nodeId('finding', replacement));
    expect(anchors).toHaveLength(1);
  });

  test('a correction is marked as human-asserted', () => {
    const path = write('a.ts', 'x');
    const replacement = correct(dir, seed(path), 'revised claim here');
    expect(load(dir).nodes.get(nodeId('finding', replacement)).origin).toBe(ORIGIN_HUMAN);
  });

  test('correcting a finding that does not exist fails cleanly', () => {
    expect(correct(dir, 'nope', 'whatever')).toBe(false);
  });
});

describe('retired findings leave every read path', () => {
  test('a retired finding is excluded from active findings', () => {
    const path = write('a.ts', 'x');
    const key = seed(path);
    expect(activeFindings(load(dir))).toHaveLength(1);
    retire(dir, key);
    expect(activeFindings(load(dir))).toHaveLength(0);
  });
});

describe('hand-written findings', () => {
  test('anchors are required of humans too', () => {
    // A human assertion with no anchor can never be re-checked against the
    // code, which is exactly what the harvest schema refuses.
    expect(create(dir, { claim: 'the system is well designed', anchors: [] })).toBeNull();
    expect(create(dir, { claim: 'no anchors at all' })).toBeNull();
  });

  test('a valid hand-written finding is stored and marked human', () => {
    const path = write('a.ts', 'x');
    const key = create(dir, { claim: 'this module owns retry policy', anchors: [path] });
    expect(load(dir).nodes.get(nodeId('finding', key)).origin).toBe(ORIGIN_HUMAN);
  });

  test('a human finding is NOT exempt from staleness', () => {
    // Exemption would create the un-invalidatable node the schema exists to
    // prevent -- a person's claim about code is still a claim about code.
    const path = write('a.ts', 'export function f() { return 1; }');
    indexFile(dir, path);
    create(dir, { claim: 'f returns one', anchors: [path] });

    writeFileSync(path, 'export function f() { return 2; }');
    expect(checkAnchor(load(dir).nodes.get(nodeId('file', path))).fresh).toBe(false);
  });

  test('pinning survives a reload', () => {
    const path = write('a.ts', 'x');
    const key = seed(path);
    pin(dir, key);
    expect(load(dir).nodes.get(nodeId('finding', key)).pinned).toBe(true);
  });
});

describe('audit surfaces what rots silently', () => {
  test('contradicting findings are reported', () => {
    const path = write('a.ts', 'x');
    const a = putNode(dir, { kind: 'finding', key: 'a', claim: 'cache is write-through', confidence: 0.8 });
    const b = putNode(dir, { kind: 'finding', key: 'b', claim: 'cache is write-back', confidence: 0.8 });
    putEdge(dir, a, 'derived_from', nodeId('file', path));
    putEdge(dir, b, 'derived_from', nodeId('file', path));
    putEdge(dir, a, 'contradicts', b);

    expect(audit(load(dir)).contradicted).toHaveLength(2);
  });

  test('unanchored findings are reported as the dangerous case', () => {
    putNode(dir, { kind: 'finding', key: 'loose', claim: 'something unanchored', confidence: 0.9 });
    expect(audit(load(dir)).orphaned).toHaveLength(1);
  });

  test('low-confidence findings are reported', () => {
    const path = write('a.ts', 'x');
    const id = putNode(dir, { kind: 'finding', key: 'weak', claim: 'possibly true', confidence: 0.2 });
    putEdge(dir, id, 'derived_from', nodeId('file', path));
    expect(audit(load(dir)).lowConfidence).toHaveLength(1);
  });

  test('retired findings never appear in the audit', () => {
    putNode(dir, { kind: 'finding', key: 'loose', claim: 'unanchored', confidence: 0.9 });
    retire(dir, 'loose');
    expect(audit(load(dir)).orphaned).toHaveLength(0);
  });
});

describe('markdown export', () => {
  test('findings are grouped by the file they anchor to', () => {
    const a = write('auth.ts', 'x');
    const b = write('cache.ts', 'x');
    seed(a, 'f1', 'tokens are verified before the handler runs');
    seed(b, 'f2', 'the cache evicts on write');

    const markdown = exportMarkdown(load(dir));
    // Canonical, because that is the identity the graph stores.
    expect(markdown).toContain('## ' + canonicalPath(a));
    expect(markdown).toContain('## ' + canonicalPath(b));
    expect(markdown).toContain('tokens are verified');
  });

  test('stale and human findings are LABELLED, not filtered out', () => {
    // A reader deciding whether to trust a line needs to know which it is.
    const path = write('a.ts', 'x');
    const id = putNode(dir, {
      kind: 'finding', key: 'f1', claim: 'this went stale', confidence: 0.8,
      stale: true, origin: ORIGIN_HUMAN,
    });
    putEdge(dir, id, 'derived_from', nodeId('file', path));

    const markdown = exportMarkdown(load(dir));
    expect(markdown).toContain('this went stale');
    expect(markdown).toContain('STALE');
    expect(markdown).toContain('human');
  });

  test('an empty graph exports a valid document, not a crash', () => {
    expect(exportMarkdown(load(dir))).toContain('No findings recorded yet');
  });

  test('retired findings are excluded from the export', () => {
    const path = write('a.ts', 'x');
    retire(dir, seed(path, 'f1', 'this was wrong'));
    expect(exportMarkdown(load(dir))).not.toContain('this was wrong');
  });
});
