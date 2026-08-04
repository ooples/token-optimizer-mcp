/**
 * P2: symbols, staleness, and the diff invariant.
 *
 * The tests that matter most here are the ones about what must NOT happen:
 * unrelated edits must not mark a symbol stale, changes our hooks never saw
 * must still be caught, and a stale finding must never reach a model without
 * the evidence that invalidated it.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractSymbols, languageOf, spanText } from '../../hooks-core/symbols.mjs';
import { indexFile, checkAnchor, diffLines, serve, invalidateOnWrite } from '../../hooks-core/staleness.mjs';
import { load, putNode, putEdge, nodeId } from '../../hooks-core/wiki.mjs';
import { canonicalPath } from '../../hooks-core/paths.mjs';

let workspace;
let dir;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'stale-'));
  dir = join(workspace, 'wiki');
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

const write = (name, text) => {
  const path = join(workspace, name);
  writeFileSync(path, text);
  return path;
};

describe('symbol extraction', () => {
  test('finds functions, classes and arrow consts in TypeScript', () => {
    const names = extractSymbols('a.ts', [
      'export function parseHeader(x: string) {',
      '  return x;',
      '}',
      'export class Reader {',
      '  read() { return 1; }',
      '}',
      'export const verify = async (t) => t;',
    ].join('\n')).map((s) => s.name);

    expect(names).toEqual(expect.arrayContaining(['parseHeader', 'Reader', 'verify']));
  });

  test('control keywords are not mistaken for symbols', () => {
    // Without the keyword guard, `if (x) {` becomes a symbol in every C-like file.
    const names = extractSymbols('a.cs', [
      'public class Thing {',
      '  public void Run() {',
      '    if (ready) {',
      '    }',
      '    while (more) {',
      '    }',
      '  }',
      '}',
    ].join('\n')).map((s) => s.name);

    expect(names).not.toContain('if');
    expect(names).not.toContain('while');
    expect(names).toContain('Run');
  });

  test('an unknown language yields no symbols rather than junk', () => {
    expect(languageOf('notes.xyz')).toBeNull();
    expect(extractSymbols('notes.xyz', 'def foo():')).toEqual([]);
  });

  test('spans cover the body, not just the declaration line', () => {
    const text = ['def a():', '    return 1', '', 'def b():', '    return 2'].join('\n');
    const [a] = extractSymbols('x.py', text);
    expect(spanText(text, a)).toContain('return 1');
    expect(spanText(text, a)).not.toContain('return 2');
  });
});

describe('lazy verification catches what hooks never saw', () => {
  test('an unchanged file is fresh', () => {
    const path = write('a.ts', 'export function f() { return 1; }');
    indexFile(dir, path);
    const anchor = load(dir).nodes.get(nodeId('file', path));
    expect(checkAnchor(anchor).fresh).toBe(true);
  });

  test('a change made outside the agent is detected', () => {
    const path = write('a.ts', 'export function f() { return 1; }');
    indexFile(dir, path);
    const anchor = load(dir).nodes.get(nodeId('file', path));

    // Stands in for a git pull, a teammate, or another editor -- no hook fired.
    writeFileSync(path, 'export function f() { return 2; }');
    expect(checkAnchor(anchor).fresh).toBe(false);
  });

  test('a deleted file is stale, never fresh', () => {
    const path = write('a.ts', 'export function f() {}');
    indexFile(dir, path);
    const anchor = load(dir).nodes.get(nodeId('file', path));
    rmSync(path);
    expect(checkAnchor(anchor).fresh).toBe(false);
  });
});

describe('symbol-level staleness avoids false invalidation', () => {
  test('editing one function does not stale a finding about another', () => {
    // The entire reason symbols are first-class nodes.
    const path = write('a.py', ['def alpha():', '    return 1', '', 'def beta():', '    return 2'].join('\n'));
    indexFile(dir, path);
    const beta = load(dir).nodes.get(nodeId('symbol', `${path}#beta`));

    writeFileSync(path, ['def alpha():', '    return 99', '', 'def beta():', '    return 2'].join('\n'));
    expect(checkAnchor(beta).fresh).toBe(true);
  });

  test('an insert above a function does not stale it', () => {
    // Line numbers shift; re-locating by NAME is what prevents a false positive.
    const path = write('a.py', ['def beta():', '    return 2'].join('\n'));
    indexFile(dir, path);
    const beta = load(dir).nodes.get(nodeId('symbol', `${path}#beta`));

    writeFileSync(path, ['import os', '', 'def beta():', '    return 2'].join('\n'));
    expect(checkAnchor(beta).fresh).toBe(true);
  });

  test('editing the function itself does stale it', () => {
    const path = write('a.py', ['def beta():', '    return 2'].join('\n'));
    indexFile(dir, path);
    const beta = load(dir).nodes.get(nodeId('symbol', `${path}#beta`));

    writeFileSync(path, ['def beta():', '    return 3'].join('\n'));
    expect(checkAnchor(beta).fresh).toBe(false);
  });
});

describe('the diff invariant -- a stale finding never arrives bare', () => {
  function seed() {
    const path = write('a.ts', 'export function f() { return 1; }');
    indexFile(dir, path);
    const fileId = nodeId('file', path);
    const finding = putNode(dir, { kind: 'finding', key: 'f1', claim: 'f returns 1', confidence: 0.9 });
    putEdge(dir, finding, 'derived_from', fileId);
    return { path, finding };
  }

  test('a fresh finding is served unmarked and without a diff', () => {
    const { finding } = seed();
    const graph = load(dir);
    const [out] = serve(graph, [graph.nodes.get(finding)]);
    expect(out.stale).toBe(false);
    expect(out.diff).toBeUndefined();
  });

  test('a stale finding is served WITH a diff, not withheld', () => {
    const { path, finding } = seed();
    writeFileSync(path, 'export function f() { return 2; }');

    const graph = load(dir);
    const [out] = serve(graph, [graph.nodes.get(finding)]);

    // Served, not dropped -- re-verifying against a diff beats re-deriving.
    expect(out.claim).toBe('f returns 1');
    expect(out.stale).toBe(true);
    expect(out.diff).toContain('return 2');
  });

  test('a DELETED file still yields a real diff, because the snapshot survives', () => {
    // File nodes carry a snapshot, so the evidence outlives the file itself.
    // Before that fix this case produced an empty diff and fell through to the
    // "unverified" fallback -- and, worse, refusalPayload returned null for
    // every real file, so the zero-turn refusal never fired outside tests that
    // hand-wrote the snapshot.
    const { path, finding } = seed();
    rmSync(path);

    const graph = load(dir);
    const [out] = serve(graph, [graph.nodes.get(finding)]);
    expect(out.stale).toBe(true);
    expect(out.diff).toContain('- export function f() { return 1; }');
  });

  test('a finding with genuinely unreconstructable evidence says so explicitly', () => {
    // No snapshot at all -- what a file above the snapshot limit looks like.
    const path = write('huge.ts', 'export const a = 1;');
    putNode(dir, { kind: 'file', key: path, hash: 'stale-hash-no-snapshot' });
    const finding = putNode(dir, { kind: 'finding', key: 'f9', claim: 'about a huge file', confidence: 0.9 });
    putEdge(dir, finding, 'derived_from', nodeId('file', path));

    const graph = load(dir);
    const [out] = serve(graph, [graph.nodes.get(finding)]);
    expect(out.stale).toBe(true);
    // THE INVARIANT IS "never bare", not a particular sentence. The previous
    // assertion pinned the word "unverified", which is how the wording survived
    // long enough to be measured doing harm: identical findings scored 1/3
    // dead-ends avoided when the model was told to treat them as unverified and
    // 2/3 when it was not. Assert that the staleness is disclosed and that the
    // evidence gap is named -- not the exact phrasing, which should be free to
    // improve without a test standing in the way.
    expect(out.diff).toBeTruthy();
    expect(out.diff.length).toBeGreaterThan(20);
    expect(out.diff).toMatch(/reconstruct/i);
    // And it must carry NO instruction to abandon the claim, however phrased.
    // The measured harm was the instruction, not one particular word, so this
    // rejects the whole vocabulary rather than the sentence that was found
    // doing damage -- otherwise the next rewording reintroduces it freely.
    expect(out.diff).not.toMatch(
      /\b(unverified|unreliable|untrusted|discard|dismiss|disregard|ignore)\b/i
    );
    expect(out.diff).not.toMatch(/\bdo not (trust|rely|use)\b/i);
    // Nor may it assert a cause it has not established: `reason` carries
    // whatever was actually determined, and this branch is also reached by
    // eager marking and by an anchor that was never snapshotted.
    expect(out.diff).not.toMatch(/the anchor changed/i);
  });
});

describe('eager invalidation', () => {
  test('a write marks dependent findings and records the diff', () => {
    const path = write('a.ts', 'export function f() { return 1; }');
    indexFile(dir, path);
    const finding = putNode(dir, { kind: 'finding', key: 'f1', claim: 'f returns 1', confidence: 0.9 });
    putEdge(dir, finding, 'derived_from', nodeId('file', path));

    const after = 'export function f() { return 2; }';
    writeFileSync(path, after);
    const marked = invalidateOnWrite(dir, load(dir), path, 'export function f() { return 1; }', after);

    expect(marked).toContain('f1');
    const graph = load(dir);
    expect(graph.nodes.get(finding).stale).toBe(true);
  });

  test('re-indexing after a write stops the change being re-reported forever', () => {
    const path = write('a.ts', 'export function f() { return 1; }');
    indexFile(dir, path);
    const after = 'export function f() { return 2; }';
    writeFileSync(path, after);
    invalidateOnWrite(dir, load(dir), path, 'export function f() { return 1; }', after);

    expect(checkAnchor(load(dir).nodes.get(nodeId('file', path))).fresh).toBe(true);
  });
});

describe('diff output is bounded', () => {
  test('a huge change is capped rather than injected whole', () => {
    // An unbounded diff alongside a finding would cost more than re-deriving it.
    const before = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const after = Array.from({ length: 500 }, (_, i) => `changed ${i}`).join('\n');
    const diff = diffLines(before, after);
    expect(diff.split('\n').length).toBeLessThanOrEqual(44);
    expect(diff).toContain('more');
  });

  test('only the changed region is shown', () => {
    const diff = diffLines('a\nb\nc', 'a\nB\nc');
    expect(diff).toContain('- b');
    expect(diff).toContain('+ B');
    expect(diff).not.toContain('a');
  });
});
