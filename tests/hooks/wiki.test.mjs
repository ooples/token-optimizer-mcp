/**
 * Phase 1 wiki graph: the store and traversal retrieval.
 *
 * These test the properties the design leans on -- append-only concurrency
 * safety, corruption tolerance, and traversal that follows real edges -- rather
 * than restating the API back to itself.
 */

import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  putNode, putEdge, load, findingsFor, harvest, nodeId, contentHash, wikiDir,
} from '../../hooks-core/wiki.mjs';

let dir;
let workspace;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'wiki-'));
  dir = join(workspace, 'wiki');
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

describe('identity', () => {
  test('the same file is one node, not two', () => {
    expect(nodeId('file', '/a/b.ts')).toBe(nodeId('file', '/a/b.ts'));
  });

  test('kind is part of identity', () => {
    expect(nodeId('file', 'x')).not.toBe(nodeId('symbol', 'x'));
  });

  test('an unknown node kind is rejected rather than stored', () => {
    expect(() => putNode(dir, { kind: 'nonsense', key: 'x' })).toThrow();
  });
});

describe('the log folds to a graph', () => {
  test('a later write of the same id wins', () => {
    putNode(dir, { kind: 'file', key: '/a.ts', hash: 'aaa' });
    putNode(dir, { kind: 'file', key: '/a.ts', hash: 'bbb' });
    const graph = load(dir);
    // Update is expressed by appending, never by mutating in place -- that is
    // what makes concurrent sessions safe.
    expect(graph.nodes.size).toBe(1);
    expect([...graph.nodes.values()][0].hash).toBe('bbb');
  });

  test('a truncated final line does not destroy the graph', () => {
    putNode(dir, { kind: 'file', key: '/a.ts' });
    putNode(dir, { kind: 'file', key: '/b.ts' });
    // Exactly what a process killed mid-append leaves behind.
    appendFileSync(join(dir, 'graph.jsonl'), '{"t":"n","id":"file:trunc');
    expect(load(dir).nodes.size).toBe(2);
  });

  test('an empty graph loads rather than throwing', () => {
    expect(load(dir).nodes.size).toBe(0);
  });
});

describe('traversal retrieval', () => {
  test('a finding is reachable from the file it was derived from', () => {
    const file = putNode(dir, { kind: 'file', key: '/auth.ts', hash: 'h1' });
    const finding = putNode(dir, {
      kind: 'finding', key: 'f1', claim: 'expired tokens are rejected here', confidence: 0.9,
    });
    putEdge(dir, finding, 'derived_from', file);

    const hits = findingsFor(load(dir), file);
    expect(hits).toHaveLength(1);
    expect(hits[0].claim).toContain('expired tokens');
  });

  test('touching a file surfaces findings about symbols inside it', () => {
    // The one-hop-through-contains rule: a finding anchored to a function must
    // be found by someone who reaches for the file, not only the symbol.
    const file = putNode(dir, { kind: 'file', key: '/auth.ts' });
    const symbol = putNode(dir, { kind: 'symbol', key: '/auth.ts#verify' });
    putEdge(dir, file, 'contains', symbol);

    const finding = putNode(dir, { kind: 'finding', key: 'f2', claim: 'verify() is O(n)', confidence: 0.8 });
    putEdge(dir, finding, 'derived_from', symbol);

    expect(findingsFor(load(dir), file).map((f) => f.claim)).toContain('verify() is O(n)');
  });

  test('findings about OTHER files are not returned', () => {
    const a = putNode(dir, { kind: 'file', key: '/a.ts' });
    const b = putNode(dir, { kind: 'file', key: '/b.ts' });
    const finding = putNode(dir, { kind: 'finding', key: 'f3', claim: 'about b', confidence: 0.9 });
    putEdge(dir, finding, 'derived_from', b);

    expect(findingsFor(load(dir), a)).toHaveLength(0);
  });

  test('higher confidence ranks first', () => {
    const file = putNode(dir, { kind: 'file', key: '/x.ts' });
    for (const [key, claim, confidence] of [['lo', 'weak', 0.2], ['hi', 'strong', 0.95]]) {
      const f = putNode(dir, { kind: 'finding', key, claim, confidence });
      putEdge(dir, f, 'derived_from', file);
    }
    expect(findingsFor(load(dir), file)[0].claim).toBe('strong');
  });
});

describe('structural harvest is free and cannot be wrong', () => {
  test('a touched file becomes a node carrying its content hash', () => {
    const path = join(workspace, 'code.ts');
    writeFileSync(path, 'export const a = 1;');

    const id = harvest(dir, { filePath: path, sessionId: 's1', action: 'Read' });
    const node = load(dir).nodes.get(id);

    expect(node.kind).toBe('file');
    // The hash is what makes staleness computable in P2 rather than guessed.
    expect(node.hash).toBe(contentHash(path));
  });

  test('the session that touched it is linked', () => {
    const path = join(workspace, 'code.ts');
    writeFileSync(path, 'x');
    harvest(dir, { filePath: path, sessionId: 's1', action: 'Read' });

    expect(load(dir).edges.some((e) => e.edge === 'derived_from')).toBe(true);
  });

  test('a missing file harvests nothing rather than recording a phantom', () => {
    expect(harvest(dir, { filePath: join(workspace, 'gone.ts'), sessionId: 's1' })).toBeNull();
  });

  test('an unwritable graph directory does not throw', () => {
    // Harvest failure must never fail the user's tool call.
    const path = join(workspace, 'code.ts');
    writeFileSync(path, 'x');
    expect(() => harvest('\0invalid', { filePath: path, sessionId: 's1' })).not.toThrow();
  });
});

describe('storage location', () => {
  test('defaults to the project, and is configurable', () => {
    expect(wikiDir('/proj')).toContain('.token-optimizer');
    process.env.TOKEN_OPTIMIZER_WIKI_DIR = '/custom/wiki';
    expect(wikiDir('/proj')).toBe('/custom/wiki');
    delete process.env.TOKEN_OPTIMIZER_WIKI_DIR;
  });
});
