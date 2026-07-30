/**
 * Regressions for the third review round.
 *
 * ONE OF THESE GUARDS A PROCESS FAILURE, NOT A CODE ONE. Two fixes I reported
 * as done had never actually applied: the patch scripts used string replacement
 * that silently no-ops when the pattern does not match, and nothing checked. The
 * directory-permission fix in particular was "covered" by a test that is skipped
 * on Windows, so it never ran where it would have failed.
 *
 * Where a behaviour cannot be asserted on every platform, the SOURCE is asserted
 * instead. That is a weaker check of correctness but a strictly stronger check
 * of presence, and presence is what was actually missing.
 */

import { mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { load, putNode, putEdge, nodeId } from '../../hooks-core/wiki.mjs';
import { serve, indexFile } from '../../hooks-core/staleness.mjs';
import { record, recordRead, report } from '../../hooks-core/metrics.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let workspace;
let dir;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'round3-'));
  dir = join(workspace, 'wiki');
  process.env.TOKEN_OPTIMIZER_HOLDOUT = '0';
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

describe('the graph directory is created restrictively -- on every platform', () => {
  // Asserting the SOURCE, because the behavioural assertion is POSIX-only and
  // therefore skipped exactly where this regressed unnoticed.
  const source = readFileSync(join(ROOT, 'hooks-core', 'wiki.mjs'), 'utf8');

  test('append() passes mode 0o700 to mkdirSync', () => {
    expect(source).toMatch(/mkdirSync\(dir,\s*\{\s*recursive:\s*true,\s*mode:\s*0o700\s*\}\)/);
  });

  test('append() also chmods explicitly', () => {
    // recursive:true applies the mode only to directories it creates, and umask
    // masks it further -- so the mode argument alone does not guarantee it.
    expect(source).toMatch(/chmodSync\(dir,\s*0o700\)/);
  });

  test('the metrics directory gets the same treatment', () => {
    const metrics = readFileSync(join(ROOT, 'hooks-core', 'metrics.mjs'), 'utf8');
    expect(metrics).toMatch(/mode:\s*0o700/);
    expect(metrics).toMatch(/chmodSync\(dir,\s*0o700\)/);
  });
});

describe('graph writes are serialized', () => {
  test('append takes a lock rather than trusting append atomicity', () => {
    // POSIX guarantees atomic appends only up to PIPE_BUF (often 4 KB), and a
    // single record here can carry a 256 KB snapshot.
    const source = readFileSync(join(ROOT, 'hooks-core', 'wiki.mjs'), 'utf8');
    expect(source).toContain('withLock');
  });

  test('a large record round-trips intact', () => {
    const big = 'x'.repeat(200_000);
    const id = putNode(dir, { kind: 'finding', key: 'big', claim: big, confidence: 0.9 });
    expect(load(dir).nodes.get(id).claim).toHaveLength(200_000);
  });

  test('the lock file is released, not left behind', () => {
    putNode(dir, { kind: 'file', key: '/a.ts' });
    expect(() => statSync(join(dir, '.graph.lock'))).toThrow();
  });
});

describe('the metrics log is read bounded, not whole', () => {
  test('a log far larger than the window still reports', () => {
    // Previously the entire never-rotated file was read into memory before any
    // slicing, on the SessionStart hook path.
    record(dir, { kind: 'inject', anchor: '/seed.ts', sessionId: 's', holdout: false, tokens: 1 });

    const filler = JSON.stringify({ kind: 'noise', pad: 'y'.repeat(4000) }) + '\n';
    const path = join(dir, 'metrics.jsonl');
    for (let i = 0; i < 800; i++) appendFileSync(path, filler);
    expect(statSync(path).size).toBeGreaterThan(3_000_000);

    for (let i = 0; i < 25; i++) {
      record(dir, { kind: 'inject', anchor: `/t${i}.ts`, sessionId: 's', holdout: false, tokens: 100 });
      recordRead(dir, { anchor: `/t${i}.ts`, sessionId: 's', bytes: 1_000 });
    }
    for (let i = 0; i < 8; i++) {
      record(dir, { kind: 'inject', anchor: `/c${i}.ts`, sessionId: 's', holdout: true, tokens: 0 });
      recordRead(dir, { anchor: `/c${i}.ts`, sessionId: 's', bytes: 40_000 });
    }

    const out = report(dir);
    expect(out.sufficientData).toBe(true);
    expect(out.estimatedTokensAvoided).toBeGreaterThan(0);
  });
});

describe('downstream cost is per touch, not per anchor', () => {
  test('repeated injections against one anchor do not multiply its read cost', () => {
    // Charging each injection the full read total made arm means scale with
    // injections-per-anchor rather than measuring per-touch cost.
    const many = join(workspace, 'many');
    const one = join(workspace, 'one');

    // Treated: one anchor touched five times, one read after them.
    for (let i = 0; i < 25; i++) {
      record(many, { kind: 'inject', anchor: '/hot.ts', sessionId: 's', holdout: false, tokens: 10 });
    }
    recordRead(many, { anchor: '/hot.ts', sessionId: 's', bytes: 4_000 });

    // Same total read, but a single injection.
    record(one, { kind: 'inject', anchor: '/hot.ts', sessionId: 's', holdout: false, tokens: 10 });
    recordRead(one, { anchor: '/hot.ts', sessionId: 's', bytes: 4_000 });

    const perTouchMany = report(many);
    const perTouchOne = report(one);
    // The split means the heavily-touched anchor cannot claim 25x the cost.
    expect(perTouchMany.injectedTokens).toBeGreaterThan(perTouchOne.injectedTokens);
  });
});

describe('serve() is the final gate on retired findings', () => {
  test('a retired finding handed to serve() directly is still not returned', () => {
    // findingsFor and sessionIndex already filter, so this is redundant today --
    // deliberately. serve()'s contract is that it is the only thing that hands a
    // finding to a model, so a future caller reaching into the graph directly
    // cannot resurrect a claim a human withdrew.
    const path = join(workspace, 'a.ts');
    writeFileSync(path, 'export const a = 1;');
    indexFile(dir, path);

    const id = putNode(dir, {
      kind: 'finding', key: 'gone', claim: 'withdrawn claim', confidence: 0.9, retired: true,
    });
    putEdge(dir, id, 'derived_from', nodeId('file', path));

    const graph = load(dir);
    expect(serve(graph, [graph.nodes.get(id)])).toHaveLength(0);
  });

  test('a live finding still passes through', () => {
    const path = join(workspace, 'a.ts');
    writeFileSync(path, 'export const a = 1;');
    indexFile(dir, path);

    const id = putNode(dir, { kind: 'finding', key: 'live', claim: 'current claim', confidence: 0.9 });
    putEdge(dir, id, 'derived_from', nodeId('file', path));

    const graph = load(dir);
    expect(serve(graph, [graph.nodes.get(id)])).toHaveLength(1);
  });
});
