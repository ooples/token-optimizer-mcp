/**
 * P3/P4/P5: harvest, injection, and the measurement that justifies both.
 *
 * The load-bearing tests here are the negative ones: that unanchored findings
 * are refused, that no file contents reach the network, that the holdout arm
 * behaves as if the graph were empty, and that a ratio is not reported before
 * the data can support one.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validate, buildDigest, harvestEnabled } from '../../hooks-core/harvest.mjs';
import { forTouch, sessionIndex, refusalPayload, linkCoOccurrence } from '../../hooks-core/inject.mjs';
import { inHoldout, record, readMetrics, report, indexBudget } from '../../hooks-core/metrics.mjs';
import { load, putNode, putEdge, nodeId } from '../../hooks-core/wiki.mjs';
import { indexFile } from '../../hooks-core/staleness.mjs';

let workspace;
let dir;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'inject-'));
  dir = join(workspace, 'wiki');
  delete process.env.TOKEN_OPTIMIZER_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;

  // Holdout OFF for every test that asserts injection HAPPENS.
  //
  // This suite was flaky roughly one run in ten before this line, and the cause
  // is worth recording: inHoldout is deterministic in (path, epoch), the
  // workspace path is random per run, so a test asserting an injection would
  // occasionally land in the control arm and correctly receive nothing. The
  // product was right and the test was wrong -- but an intermittent red run
  // erodes trust in the whole suite, so the arm is pinned here and only the
  // holdout tests opt back in.
  process.env.TOKEN_OPTIMIZER_HOLDOUT = '0';
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

const write = (name, text) => {
  const path = join(workspace, name);
  writeFileSync(path, text);
  return path;
};

function seedFinding(path, claim, confidence = 0.9) {
  const id = putNode(dir, { kind: 'finding', key: claim.slice(0, 12), claim, confidence, type: 'finding' });
  putEdge(dir, id, 'derived_from', nodeId('file', path));
  return id;
}

describe('P3 harvest -- the schema keeps the graph honest', () => {
  test('an unanchored finding is discarded, not stored', () => {
    // It could never go stale, so it would be served as current forever.
    expect(validate([{ type: 'finding', claim: 'the system is fast', confidence: 0.9, anchors: [] }])).toHaveLength(0);
  });

  test('an untyped or free-form claim is discarded', () => {
    expect(validate([{ claim: 'something happened', confidence: 0.5, anchors: ['/a.ts'] }])).toHaveLength(0);
    expect(validate([{ type: 'musing', claim: 'x is nice', confidence: 0.5, anchors: ['/a.ts'] }])).toHaveLength(0);
  });

  test('an invented anchor is dropped when the real file list is known', () => {
    // Models asked for paths will sometimes produce plausible fabrications.
    const known = new Set(['/real.ts']);
    const out = validate([
      { type: 'finding', claim: 'real one here', evidence: 'a passing focused test', applicability: 'when changing the real module', confidenceLabel: 'probable', confidence: 0.8, scope: 'project', anchors: ['/real.ts'] },
      { type: 'finding', claim: 'invented one here', evidence: 'an unsupported model guess', applicability: 'when changing an invented module', confidenceLabel: 'speculative', confidence: 0.8, scope: 'project', anchors: ['/imaginary.ts'] },
    ], { knownFiles: known });
    expect(out).toHaveLength(1);
    expect(out[0].claim).toBe('real one here');
  });

  test('a valid finding survives intact', () => {
    const out = validate([{ type: 'failure', claim: 'retry loop deadlocks on close', evidence: 'the close-path concurrency test timed out', applicability: 'when changing the retry close path', confidenceLabel: 'probable', confidence: 0.7, scope: 'project', invalidators: ['retry ownership changes'], anchors: ['/a.ts#run'] }]);
    expect(out).toEqual([{ type: 'failure', claim: 'retry loop deadlocks on close', evidence: 'the close-path concurrency test timed out', applicability: 'when changing the retry close path', confidenceLabel: 'probable', confidence: 0.7, scope: 'project', invalidators: ['retry ownership changes'], anchors: ['/a.ts#run'], trigger: undefined }]);
  });

  test('harvest is disabled without a key, rather than failing', () => {
    expect(harvestEnabled()).toBe(false);
  });
});

describe('P3 -- file contents never leave the machine', () => {
  test('the digest excludes tool results', () => {
    const transcript = write('t.jsonl', [
      JSON.stringify({ message: { role: 'user', content: 'fix the auth bug' } }),
      JSON.stringify({ message: { role: 'assistant', content: [
        { type: 'text', text: 'The token check is inverted.' },
        { type: 'tool_use', input: { file_path: '/src/auth.ts' } },
      ] } }),
      // A tool RESULT carrying source. This is the leak the digest must not have.
      JSON.stringify({ message: { role: 'user', content: [
        { type: 'tool_result', content: 'const SECRET_KEY = "sk-live-abc123";' },
      ] } }),
    ].join('\n'));

    const digest = buildDigest(transcript);
    expect(digest).toContain('/src/auth.ts');
    expect(digest).toContain('token check is inverted');
    expect(digest).not.toContain('SECRET_KEY');
    expect(digest).not.toContain('sk-live-abc123');
  });

  test('an unreadable transcript yields null rather than throwing', () => {
    expect(buildDigest(join(workspace, 'missing.jsonl'))).toBeNull();
  });
});

describe('P4 injection', () => {
  test('findings anchored to a touched file are returned', () => {
    const path = write('auth.ts', 'export function verify() {}');
    indexFile(dir, path);
    seedFinding(path, 'expired tokens are rejected in verify');

    const out = forTouch(dir, load(dir), path, { sessionId: 's1' });
    expect(out).toContain('expired tokens are rejected');
  });

  test('a file with no findings injects nothing', () => {
    const path = write('empty.ts', 'export const a = 1;');
    indexFile(dir, path);
    expect(forTouch(dir, load(dir), path, { sessionId: 's1' })).toBeNull();
  });

  test('the token budget is respected', () => {
    const path = write('big.ts', 'export function f() {}');
    indexFile(dir, path);
    for (let i = 0; i < 40; i++) seedFinding(path, `finding number ${i} with a reasonably long claim attached`, 0.9);

    const out = forTouch(dir, load(dir), path, { budget: 100, sessionId: 's1' });
    // Without the cap, heavily-worked files become the most expensive to touch.
    expect(Math.ceil(out.length / 4)).toBeLessThan(200);
  });

  test('the session index lists titles, never bodies', () => {
    const path = write('a.ts', 'x');
    indexFile(dir, path);
    seedFinding(path, 'the retry budget is shared across all outbound calls');

    const index = sessionIndex(dir, load(dir), {
      episode: { episodeId: 'consumer-1', client: 'codex', pairId: 'pair-1' },
    });
    expect(index).toContain('retry budget');
    expect(index).toContain('wiki_query');

    const delivery = readMetrics(dir).find(
      (event) => event.kind === 'inject' && event.surface === 'session-start'
    );
    expect(delivery).toMatchObject({
      episodeId: 'consumer-1',
      client: 'codex',
      pairId: 'pair-1',
      holdout: false,
      findingIds: ['the retry bu'],
    });
    expect(delivery.deliveredTokens).toBeGreaterThan(0);
  });

  test('the session index labels invalidated content claims before delivery', () => {
    const path = write('stale.ts', 'export const mode = "old";');
    indexFile(dir, path);
    seedFinding(path, 'the old mode is always required');
    writeFileSync(path, 'export const mode = "new";');

    const index = sessionIndex(dir, load(dir, { snapshots: true }));
    expect(index).toContain('STALE: file changed');
    expect(index).toContain('old mode');
  });

  test('an empty graph produces no index', () => {
    expect(sessionIndex(dir, load(dir))).toBeNull();
  });
});

describe('P4 -- the zero-turn refusal carries the answer', () => {
  test('an unchanged file is reported as unchanged, with nothing to re-read', () => {
    const path = write('a.ts', 'export const a = 1;');
    putNode(dir, { kind: 'file', key: path, hash: 'h', snapshot: 'export const a = 1;' });

    expect(refusalPayload(load(dir, { snapshots: true }), path, { seenThisSession: true })).toContain('UNCHANGED');
  });

  test('a session that never read the file is told NEITHER of those things', () => {
    // Found live, and the worst failure this project can have: a brand-new
    // session's FIRST EVER read of a file was refused with "UNCHANGED since you
    // last read it this session -- use what you already have". It had never
    // read it and had nothing to use, so the refusal withheld content the model
    // did not hold.
    //
    // The cause is that the graph is DURABLE and per project, while both of
    // these messages are claims about what the READER holds. A snapshot may
    // have been captured days ago by a different session. Returning null here
    // falls back to the annotated skeleton, which is true no matter who is
    // asking.
    const path = write('a.ts', 'export const a = 1;');
    putNode(dir, { kind: 'file', key: path, hash: 'h', snapshot: 'export const a = 1;' });
    expect(refusalPayload(load(dir, { snapshots: true }), path)).toBeNull();

    // Same for the diff branch: a diff against a baseline you never saw is not
    // an answer, it is a puzzle. Sized so the diff genuinely beats the file,
    // otherwise this would pass for the unrelated "not cheaper" reason.
    const lines = Array.from({ length: 400 }, (_, i) => `export const v${i} = ${i};`);
    const changed = write('b.ts', [...lines.slice(0, 100), 'export const CHANGED = true;', ...lines.slice(101)].join('\n'));
    putNode(dir, { kind: 'file', key: changed, hash: 'h', snapshot: lines.join('\n') });
    expect(refusalPayload(load(dir, { snapshots: true }), changed)).toBeNull();
    expect(refusalPayload(load(dir, { snapshots: true }), changed, { seenThisSession: true })).toContain('changed since');
  });

  test('a changed file yields the DIFF inside the refusal, not a redirect', () => {
    // This is the whole point: the model asked a question and the refusal
    // contains the answer, so there is no second call to make.
    //
    // The file is realistically sized on purpose. On a 20-byte file the diff is
    // genuinely not cheaper than the content, and the guard below correctly
    // declines -- the saving only exists once the file is bigger than the change.
    const body = Array.from({ length: 200 }, (_, i) => `export const v${i} = ${i};`);
    const before = body.join('\n');
    const after = [...body.slice(0, 100), 'export const CHANGED = true;', ...body.slice(101)].join('\n');

    const path = write('a.ts', after);
    putNode(dir, { kind: 'file', key: path, hash: 'h', snapshot: before });

    const payload = refusalPayload(load(dir, { snapshots: true }), path, { seenThisSession: true });
    expect(payload).toContain('+ export const CHANGED = true;');
    expect(payload).toContain('do not');
  });

  test('the diff is dramatically cheaper than the file it replaces', () => {
    // The economic claim, asserted rather than assumed.
    const body = Array.from({ length: 400 }, (_, i) => `export const v${i} = ${i};`);
    const after = [...body.slice(0, 200), 'export const CHANGED = true;', ...body.slice(201)].join('\n');

    const path = write('big.ts', after);
    putNode(dir, { kind: 'file', key: path, hash: 'h', snapshot: body.join('\n') });

    expect(refusalPayload(load(dir, { snapshots: true }), path, { seenThisSession: true }).length).toBeLessThan(after.length / 10);
  });

  test('it falls back when there is no snapshot', () => {
    const path = write('a.ts', 'x');
    expect(refusalPayload(load(dir, { snapshots: true }), path, { seenThisSession: true })).toBeNull();
  });

  test('it falls back when the diff would not be cheaper than the file', () => {
    // A rewrite saves nothing; the ordinary redirect is correct there.
    const path = write('a.ts', Array.from({ length: 50 }, (_, i) => `changed ${i}`).join('\n'));
    putNode(dir, {
      kind: 'file', key: path, hash: 'h',
      snapshot: Array.from({ length: 50 }, (_, i) => `original ${i}`).join('\n'),
    });
    expect(refusalPayload(load(dir, { snapshots: true }), path, { seenThisSession: true })).toBeNull();
  });
});

describe('P4 -- co-occurrence gives semantics without embeddings', () => {
  test('files touched together become related', () => {
    linkCoOccurrence(dir, 's1', ['/a.ts', '/b.ts', '/c.ts']);
    const related = load(dir).edges.filter((e) => e.edge === 'related');
    expect(related.length).toBe(3); // 3 choose 2
  });

  test('a wide session does not write a quadratic edge explosion', () => {
    const many = Array.from({ length: 200 }, (_, i) => `/f${i}.ts`);
    expect(linkCoOccurrence(dir, 's1', many)).toBeLessThanOrEqual(40);
  });
});

describe('P5 measurement', () => {
  test('the holdout is stable for a given file and epoch', () => {
    // Opts back in: beforeEach pins the arm off for the injection tests.
    process.env.TOKEN_OPTIMIZER_HOLDOUT = '0.1';
    // Flipping arms mid-session would contaminate both.
    const first = inHoldout('/a.ts');
    expect(inHoldout('/a.ts')).toBe(first);
  });

  test('the same file lands in different arms in different epochs', () => {
    process.env.TOKEN_OPTIMIZER_HOLDOUT = '0.1';
    // Stratification: the comparison becomes within-file rather than across.
    const arms = new Set();
    for (let day = 0; day < 60; day++) arms.add(inHoldout('/a.ts', day * 86_400_000));
    expect(arms.size).toBe(2);
  });

  test('a held-out touch injects nothing -- the arm must look like an empty graph', () => {
    const path = write('a.ts', 'x');
    indexFile(dir, path);
    seedFinding(path, 'something known about this file');

    // Force the holdout arm. A cache-busting query gives a fresh module, since
    // the fraction is read once at load time.
    process.env.TOKEN_OPTIMIZER_HOLDOUT = '1';
    return import('../../hooks-core/inject.mjs?holdout=1').then(({ forTouch: touch }) => {
      // If the withheld arm leaked anything, it would no longer be a control
      // and the whole measurement would be meaningless.
      expect(touch(dir, load(dir), path, { sessionId: 's1' })).toBeNull();
      delete process.env.TOKEN_OPTIMIZER_HOLDOUT;
    });
  });

  test('no ratio is reported before the data can support one', () => {
    record(dir, { kind: 'inject', holdout: false, tokens: 100, downstream: 500 });
    const out = report(dir);
    expect(out.sufficientData).toBe(false);
    expect(out.estimatedTokensAvoided).toBeNull();
    expect(out.verdict).toContain('insufficient data');
  });

  test('with enough data it reports a net balance, including harvest cost', () => {
    for (let i = 0; i < 25; i++) record(dir, { kind: 'inject', holdout: false, tokens: 100, downstream: 200 });
    for (let i = 0; i < 8; i++) record(dir, { kind: 'inject', holdout: true, tokens: 0, downstream: 2000 });
    record(dir, { kind: 'harvest', tokens: 500 });

    const out = report(dir);
    expect(out.sufficientData).toBe(true);
    expect(out.estimatedTokensAvoided).toBeGreaterThan(0);
    // The cost side must include harvest, or the balance flatters itself.
    expect(out.netTokens).toBe(out.estimatedTokensAvoided - out.injectedTokens - 500);
  });

  test('it will say plainly when the graph is NOT paying for itself', () => {
    for (let i = 0; i < 25; i++) record(dir, { kind: 'inject', holdout: false, tokens: 400, downstream: 500 });
    for (let i = 0; i < 8; i++) record(dir, { kind: 'inject', holdout: true, tokens: 0, downstream: 505 });
    expect(report(dir).verdict).toContain('NOT');
  });

  test('the index budget is earned, and bounded at both ends', () => {
    expect(indexBudget(dir)).toBe(300);

    // A graph whose index never leads to a query shrinks toward the floor.
    for (let i = 0; i < 20; i++) record(dir, { kind: 'index', count: 5 });
    expect(indexBudget(dir)).toBe(150);

    // One that does gets a bigger allowance, capped.
    for (let i = 0; i < 20; i++) record(dir, { kind: 'query' });
    const earned = indexBudget(dir);
    expect(earned).toBeGreaterThan(300);
    expect(earned).toBeLessThanOrEqual(1200);
  });
});
