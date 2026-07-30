/**
 * The annotated skeleton -- the substitution a refusal carries.
 *
 * The property that matters is not "smaller". Competing tools already return
 * smaller: a delta, a structure map, a head/tail slice. Every one of those is a
 * lossier version of the file.
 *
 * What is tested here is that the substitution can be MORE useful than the file
 * -- structure plus what was learned about it -- and that a cold file, where
 * nothing has been learned yet, still carries knowledge from its history.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { annotatedSkeleton, contestedHistory, gitSignals } from '../../hooks-core/skeleton.mjs';
import { load, putNode, putEdge, nodeId } from '../../hooks-core/wiki.mjs';
import { indexFile } from '../../hooks-core/staleness.mjs';
import { substitutionBudget, record, recordRead } from '../../hooks-core/metrics.mjs';
import { substitutionFor } from '../../hooks-core/inject.mjs';
import { canonicalPath } from '../../hooks-core/paths.mjs';

let workspace;
let dir;
let source;
let target;

const SOURCE = [
  'export function verify(token) {',
  '  return token.exp > Date.now();',
  '}',
  '',
  'export class Session {',
  '  refresh() { return true; }',
  '}',
  '',
  'export function evict(key) {',
  '  return key;',
  '}',
].join('\n')
  // Padded to a realistic size. The substitution only ever replaces a file large
  // enough to have been refused (>25 KB), and on a 600-byte fixture a skeleton
  // genuinely is not worth sending -- which the guard correctly reports.
  + `\n${'// filler standing in for a real implementation body\n'.repeat(1200)}`;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'skeleton-'));
  dir = join(workspace, 'wiki');
  target = join(workspace, 'auth.ts');
  writeFileSync(target, SOURCE);
  source = SOURCE;
  indexFile(dir, target, source);
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

function addFinding(symbol, claim, type = 'finding') {
  const id = putNode(dir, { kind: 'finding', key: claim.slice(0, 10), claim, confidence: 0.9, type });
  putEdge(dir, id, 'derived_from', nodeId('symbol', `${canonicalPath(target)}#${symbol}`));
  return id;
}

describe('the substitution carries knowledge, not just fewer bytes', () => {
  test('a finding appears beside the symbol it is about', () => {
    addFinding('verify', 'compares exp against the local clock, so skew causes false 401s');

    const { text } = annotatedSkeleton(load(dir), target, source, { git: false });
    const lines = text.split('\n');
    const symbolLine = lines.findIndex((l) => l.includes('verify'));

    expect(symbolLine).toBeGreaterThan(-1);
    // Directly beneath, not in a separate list the reader has to correlate.
    expect(lines[symbolLine + 1]).toContain('local clock');
  });

  test('studied symbols sort above unstudied ones', () => {
    addFinding('evict', 'eviction is write-through');

    const { text } = annotatedSkeleton(load(dir), target, source, { git: false });
    expect(text.indexOf('evict')).toBeLessThan(text.indexOf('verify'));
  });

  test('a stale finding is marked, never served bare', () => {
    const id = addFinding('verify', 'this claim is about to go stale');
    putNode(dir, {
      kind: 'finding', key: load(dir).nodes.get(id).key,
      claim: 'this claim is about to go stale', confidence: 0.9, stale: true, diff: '- old\n+ new',
    });
    writeFileSync(target, source.replace('token.exp', 'token.expiry'));

    const { text } = annotatedSkeleton(load(dir), target, source, { git: false });
    expect(text).toContain('STALE');
  });

  test('a failure -- knowledge that exists nowhere in the file -- is carried', () => {
    // The row no compression tool can produce: the file cannot contain the fact
    // that something was tried and abandoned.
    addFinding('evict', 'tried a shared retry budget; it deadlocked under burst', 'failure');
    const { text } = annotatedSkeleton(load(dir), target, source, { git: false });
    expect(text).toContain('deadlocked under burst');
  });
});

describe('a cold file is not knowledge-free', () => {
  test('a revert-then-redo history is reported as a dead end', () => {
    const entries = [
      { when: '2 days ago', subject: 'fix token expiry handling' },
      { when: '3 days ago', subject: 'Revert "fix token expiry handling"' },
      { when: '4 days ago', subject: 'fix token expiry handling again' },
    ];
    // The single most valuable thing available about a file nobody has studied.
    expect(contestedHistory(entries)).toMatch(/round the loop|reverted/i);
  });

  test('an ordinary history reports no dead end', () => {
    expect(contestedHistory([
      { when: '1 day ago', subject: 'add caching' },
      { when: '2 days ago', subject: 'update docs' },
      { when: '3 days ago', subject: 'bump deps' },
    ])).toBeNull();
  });

  test('too little history is not over-interpreted', () => {
    expect(contestedHistory([{ when: 'now', subject: 'initial' }])).toBeNull();
  });

  test('git signals fail quiet outside a repository', () => {
    // This runs inside a hook: a missing or slow git must cost nothing.
    expect(gitSignals(join(workspace, 'auth.ts'))).toBeNull();
  });

  test('a real repository yields history', () => {
    execFileSync('git', ['init', '-q'], { cwd: workspace, windowsHide: true });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: workspace, windowsHide: true });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: workspace, windowsHide: true });
    execFileSync('git', ['add', 'auth.ts'], { cwd: workspace, windowsHide: true });
    execFileSync('git', ['commit', '-qm', 'add auth'], { cwd: workspace, windowsHide: true });

    const signals = gitSignals(target);
    expect(signals).not.toBeNull();
    expect(signals.entries[0].subject).toBe('add auth');
  });
});

describe('the substitution is bounded and worth sending', () => {
  test('it is far cheaper than the file it replaces', () => {
    addFinding('verify', 'a claim about verify');
    const substitution = substitutionFor(dir, load(dir), target, source);
    expect(substitution).not.toBeNull();
    expect(substitution.length).toBeLessThan(source.length / 3);
  });

  test('a tiny file is NOT substituted -- there is nothing to save', () => {
    const small = join(workspace, 'small.ts');
    writeFileSync(small, 'export const a = 1;\n');
    indexFile(dir, small);
    // Sending a skeleton that costs as much as the content buys a round trip
    // and nothing else, so it falls back to the ordinary redirect.
    expect(substitutionFor(dir, load(dir), small, 'export const a = 1;\n')).toBeNull();
  });

  test('the budget respects its ceiling', () => {
    for (let i = 0; i < 60; i++) addFinding('verify', `finding number ${i} with a long claim attached to it`);
    const { tokens } = annotatedSkeleton(load(dir), target, source, { budget: 400, git: false });
    expect(tokens).toBeLessThanOrEqual(400);
  });
});

describe('the budget is earned per file, from the control arm', () => {
  test('a new file starts at the default rather than a verdict from noise', () => {
    expect(substitutionBudget(dir, canonicalPath(target))).toBe(1200);
  });

  test('a file whose annotations suppress later reads earns more room', () => {
    const anchor = canonicalPath(target);
    // Treated touches followed by little reading; withheld followed by a lot.
    for (let i = 0; i < 6; i++) {
      record(dir, { kind: 'inject', anchor, sessionId: `t${i}`, holdout: false, tokens: 200 });
      recordRead(dir, { anchor, sessionId: `t${i}`, bytes: 400 });
    }
    for (let i = 0; i < 3; i++) {
      record(dir, { kind: 'inject', anchor, sessionId: `c${i}`, holdout: true, tokens: 0 });
      recordRead(dir, { anchor, sessionId: `c${i}`, bytes: 60_000 });
    }
    // Nobody without a control arm can tell a paying annotation from an ignored
    // one, which is why this cannot simply be copied.
    expect(substitutionBudget(dir, anchor)).toBeGreaterThan(1200);
  });

  test('a file whose annotations are ignored shrinks back', () => {
    const anchor = canonicalPath(target);
    for (let i = 0; i < 6; i++) {
      record(dir, { kind: 'inject', anchor, sessionId: `t${i}`, holdout: false, tokens: 900 });
      recordRead(dir, { anchor, sessionId: `t${i}`, bytes: 60_000 });
    }
    for (let i = 0; i < 3; i++) {
      record(dir, { kind: 'inject', anchor, sessionId: `c${i}`, holdout: true, tokens: 0 });
      recordRead(dir, { anchor, sessionId: `c${i}`, bytes: 62_000 });
    }
    expect(substitutionBudget(dir, anchor)).toBeLessThan(1200);
  });
});
