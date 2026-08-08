/**
 * Progressive disclosure, and the pointer that follows it.
 *
 * The properties under test are the ones a size-threshold truncator cannot have:
 * the answer replaces the output entirely when we already hold it, selection is
 * structural AND question-driven rather than positional, every cut is named,
 * expansion serves from the store instead of re-running, staleness is a
 * three-way decision rather than a boolean, and the expansion itself teaches the
 * next preview.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  disclose, parseShape, rankSections, verdictFor, DISCLOSE_THRESHOLD,
} from '../../hooks-core/disclose.mjs';
import {
  capture, resolve, freshness, refreshDecision, recordExpansion,
  previewPolicy, promote, previewQuality, CHEAP_REGEN_MS,
} from '../../hooks-core/expand.mjs';
import { load, putNode, putEdge, nodeId } from '../../hooks-core/wiki.mjs';
import { indexFile } from '../../hooks-core/staleness.mjs';

let workspace;
let dir;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'disclose-'));
  dir = join(workspace, 'wiki');
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

const graph = () => load(dir);

/** A test report far past the disclosure threshold, mostly passes. */
function bigTestReport() {
  const lines = [];
  for (let i = 0; i < 400; i++) lines.push(`  PASS  ShardTests.Case${i} elapsed 12ms and some padding text`);
  lines.splice(120, 0, '  FAILED  DBNetTests.BceOnRelu -- expected 0.0 got NaN');
  lines.splice(300, 0, '  FAILED  TftGradientFlow -- gradient did not reach the encoder');
  lines.push('Tests: 2 failed, 400 passed, 402 total');
  return lines.join('\n');
}

describe('shape is parsed before anything is selected', () => {
  test('a test report separates failures from the passing noise', () => {
    const { shape, sections } = parseShape(bigTestReport());
    expect(shape).toBe('test-report');
    expect(sections.find((s) => s.label === 'failures').lines).toHaveLength(2);
    expect(sections.find((s) => s.label === 'passing tests').lines.length).toBeGreaterThan(300);
  });

  test('a diff becomes one section per file, so 39 of 40 can be dropped by name', () => {
    const text = ['diff --git a/src/a.ts b/src/a.ts', '+one', 'diff --git a/src/b.ts b/src/b.ts', '+two'].join('\n');
    const { shape, sections } = parseShape(text);
    expect(shape).toBe('diff');
    expect(sections.map((s) => s.label)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  test('a stack trace separates our frames from the library ones', () => {
    const text = [
      'TypeError: cannot read x of undefined',
      '    at verify (C:/repo/src/auth.ts:41:9)',
      '    at Object.run (C:/repo/node_modules/jest/index.js:12:1)',
    ].join('\n');
    const { shape, sections } = parseShape(text);
    expect(shape).toBe('stack-trace');
    expect(sections.find((s) => s.label === 'frames in this project').lines).toHaveLength(1);
  });

  test('an unrecognised output still yields one section rather than throwing', () => {
    expect(parseShape('just words').shape).toBe('plain');
  });

  test('a large string inside a JSON field is parsed for its OWN shape', () => {
    // The case that matters most: every tool this product ships returns a JSON
    // envelope, so a build log arrives as one enormous escaped string on a
    // single line. Selecting inside a single line is not selection at all.
    const body = JSON.stringify({ output: bigTestReport(), path: 'x.ts', tokensSaved: 12 });
    const { shape, sections } = parseShape(body);

    expect(shape).toBe('json');
    expect(sections.map((s) => s.label)).toContain('output > failures');
    expect(sections.find((s) => s.label === 'output > failures').lines).toHaveLength(2);
    // Small fields stay whole -- nesting is for payloads, not for metadata.
    expect(sections.map((s) => s.label)).toContain('tokensSaved');
  });

  test('the failures inside a JSON envelope survive the preview', () => {
    const body = JSON.stringify({ output: bigTestReport(), path: 'x.ts' });
    const out = disclose(dir, body, { question: 'which shard fails?' });
    expect(out.text).toContain('DBNetTests.BceOnRelu');
    expect(out.omissions.map((o) => o.label)).toContain('output > passing tests');
  });
});

describe('selection is driven by the question, not by position', () => {
  test('the section naming the question outranks a heavier generic one', () => {
    const sections = parseShape(bigTestReport()).sections;
    const ranked = rankSections(sections, { question: 'why is BceOnRelu producing NaN?' });
    expect(ranked[0].label).toBe('failures');
  });

  test('an important section still wins when nobody asked about anything', () => {
    // Intrinsic weight and relevance ADD, so a failure nobody asked about is
    // not buried under a routine section that happens to share a word.
    const ranked = rankSections(parseShape(bigTestReport()).sections, {});
    expect(ranked[0].label).toBe('failures');
  });

  test('a learned boost can lift a section the policy has seen people ask for', () => {
    const plain = rankSections(parseShape(bigTestReport()).sections, {});
    const boosted = rankSections(parseShape(bigTestReport()).sections, {
      boosts: { 'passing tests': 50 },
    });
    expect(plain[0].label).toBe('failures');
    expect(boosted[0].label).toBe('passing tests');
  });
});

describe('the preview names every cut', () => {
  test('what was dropped is stated, with how much of it', () => {
    const out = disclose(dir, bigTestReport(), { question: 'which shard fails?', ref: 'abc123' });
    expect(out.mode).toBe('preview');
    // A model reasoning over a silent truncation cannot know it is missing
    // something; one told what was dropped can ask for it.
    expect(out.text).toMatch(/omitted: .*lines of passing tests/);
    expect(out.text).toContain('expand abc123');
  });

  test('the failures survive and the passes do not', () => {
    const out = disclose(dir, bigTestReport(), { question: 'which shard fails?' });
    expect(out.text).toContain('DBNetTests.BceOnRelu');
    expect(out.omissions.map((o) => o.label)).toContain('passing tests');
  });

  test('a small output is passed through untouched rather than taxed', () => {
    // Disclosing a 200-byte result costs more than it saves.
    expect(disclose(dir, 'x'.repeat(DISCLOSE_THRESHOLD - 1), {})).toBeNull();
  });

  test('a single unsplittable line is cut by character rather than dropped', () => {
    // A minified bundle, or JSON with no newlines at all. Nothing can split it,
    // so returning none of it is worse than returning the front of it -- and
    // the cut is still named, because a silent one is the actual harm.
    const out = disclose(dir, `{"blob":"${'x'.repeat(60_000)}"}`, {});
    expect(out.text).toMatch(/^x{100,}/m);
    expect(out.text).toMatch(/55,\d{3} more characters on one line/);
    // And it is never empty, because an empty preview forces the very
    // expansion the preview exists to avoid.
    expect(out.kept.length).toBeGreaterThan(0);
  });

  test('the preview stays inside the earned budget', () => {
    const out = disclose(dir, bigTestReport(), {});
    expect(out.tokens).toBeLessThanOrEqual(3000);
  });
});

describe('the strongest disclosure is none of the output at all', () => {
  test('a confident fresh finding replaces the output entirely', () => {
    const path = join(workspace, 'auth.ts');
    writeFileSync(path, 'export function verify() { return 1; }');
    indexFile(dir, path);
    const finding = putNode(dir, {
      kind: 'finding', key: 'f1', confidence: 0.9, derivedCost: 12_400,
      claim: 'the 401s come from clock skew on the server, not token signing',
    });
    putEdge(dir, finding, 'derived_from', nodeId('file', path));

    const out = disclose(dir, bigTestReport(), {
      graph: graph(), anchors: [path], question: 'is the clock skew causing the 401s?', ref: 'r1',
    });

    expect(out.mode).toBe('verdict');
    expect(out.text).toContain('Already established');
    expect(out.text).toContain('12,400');
    // The raw output is reachable, but it never entered context.
    expect(out.text).toContain('expand r1');
  });

  test('a stale finding does not get to answer', () => {
    const path = join(workspace, 'auth.ts');
    writeFileSync(path, 'export function verify() { return 1; }');
    indexFile(dir, path);
    const finding = putNode(dir, { kind: 'finding', key: 'f1', confidence: 0.9, claim: 'skew explains the 401s' });
    putEdge(dir, finding, 'derived_from', nodeId('file', path));
    writeFileSync(path, 'export function verify() { return 2; }');

    expect(verdictFor(graph(), { anchors: [path], question: 'skew?' })).toBeNull();
  });

  test('a low-confidence finding does not get to answer either', () => {
    const path = join(workspace, 'auth.ts');
    writeFileSync(path, 'export function verify() { return 1; }');
    indexFile(dir, path);
    const finding = putNode(dir, { kind: 'finding', key: 'f1', confidence: 0.2, claim: 'skew explains the 401s' });
    putEdge(dir, finding, 'derived_from', nodeId('file', path));

    expect(verdictFor(graph(), { anchors: [path], question: 'skew?' })).toBeNull();
  });
});

describe('the pointer serves; it does not re-run', () => {
  test('expansion returns the original with nothing re-earned', () => {
    const ref = capture(dir, bigTestReport(), { tool: 'smart_test', shape: 'test-report' });
    const out = resolve(dir, ref);
    expect(out.text).toContain('DBNetTests.BceOnRelu');
    expect(out.reEarnedTokens).toBe(0);
  });

  test('identical content captured twice is one artifact', () => {
    // The same build log from three sessions, or three projects, is one entry.
    const a = capture(dir, bigTestReport(), { tool: 'smart_test' });
    const b = capture(dir, bigTestReport(), { tool: 'other' });
    expect(a).toBe(b);
  });

  test('an unknown reference yields nothing rather than a guess', () => {
    expect(resolve(dir, 'deadbeef')).toBeNull();
  });
});

describe('staleness is a three-way decision, not a boolean', () => {
  const seed = (costMs) => {
    const path = join(workspace, 'auth.ts');
    writeFileSync(path, 'before');
    const ref = capture(dir, bigTestReport(), { tool: 'smart_test', command: 'dotnet test', costMs, anchors: [path] });
    return { path, ref };
  };

  test('unchanged serves for free', () => {
    const { ref } = seed(500);
    expect(refreshDecision(freshness(dir, ref)).action).toBe('serve');
  });

  test('changed and cheap to reproduce is refreshed, with the command', () => {
    // Correctness beats a saved second.
    const { path, ref } = seed(CHEAP_REGEN_MS - 1);
    writeFileSync(path, 'after');
    const decision = refreshDecision(freshness(dir, ref));
    expect(decision.action).toBe('refresh');
    expect(decision.command).toBe('dotnet test');
  });

  test('changed and expensive is served marked, naming what moved', () => {
    // Paying minutes to re-run is the waste this exists to stop; handing back a
    // confident answer about code that changed is the harm it must not do. The
    // third option is the honest one.
    const { path, ref } = seed(400_000);
    writeFileSync(path, 'after');
    const decision = refreshDecision(freshness(dir, ref));
    expect(decision.action).toBe('serve-stale');
    expect(decision.changed[0]).toMatch(/auth\.ts$/i);

    const out = resolve(dir, ref);
    expect(out.stale).toBe(true);
    expect(out.text).toMatch(/! STALE/);
  });
});

describe('an expansion is labelled data, and is used as such', () => {
  test('a shape whose previews hold produces no corrections', () => {
    for (let i = 0; i < 5; i++) capture(dir, `${bigTestReport()}${i}`, { tool: 't', shape: 'test-report' });
    const policy = previewPolicy(dir, { shape: 'test-report' });
    expect(policy.holdRate).toBe(1);
    expect(Object.keys(policy.boosts)).toHaveLength(0);
  });

  test('a shape that keeps getting expanded boosts what people asked for', () => {
    for (let i = 0; i < 4; i++) capture(dir, `${bigTestReport()}${i}`, { tool: 't', shape: 'test-report' });
    for (let i = 0; i < 3; i++) recordExpansion(dir, { tool: 't', shape: 'test-report', asked: 'passing tests' });

    const policy = previewPolicy(dir, { shape: 'test-report' });
    expect(policy.holdRate).toBeLessThan(0.3);
    // Not "previews are 8% wrong" but "wrong specifically by dropping this".
    expect(policy.boosts['passing tests']).toBeGreaterThan(0);
  });

  test('the correction is proportional to how badly the shape is doing', () => {
    for (let i = 0; i < 20; i++) capture(dir, `${bigTestReport()}${i}`, { shape: 'log' });
    recordExpansion(dir, { shape: 'log', asked: 'routine log lines' });
    const gentle = previewPolicy(dir, { shape: 'log' }).boosts['routine log lines'];

    for (let i = 0; i < 12; i++) recordExpansion(dir, { shape: 'log', asked: 'routine log lines' });
    const firm = previewPolicy(dir, { shape: 'log' }).boosts['routine log lines'];

    expect(firm).toBeGreaterThan(gentle);
  });

  test('the refit closes the loop: the boosted section survives the next preview', () => {
    for (let i = 0; i < 4; i++) capture(dir, `${bigTestReport()}${i}`, { shape: 'test-report' });
    for (let i = 0; i < 4; i++) recordExpansion(dir, { shape: 'test-report', asked: 'passing tests' });

    const { boosts } = previewPolicy(dir, { shape: 'test-report' });
    const ranked = rankSections(parseShape(bigTestReport()).sections, { boosts });
    expect(ranked[0].label).toBe('passing tests');
  });
});

describe('expanding promotes, so the second expansion never happens', () => {
  test('what somebody asked for once becomes a finding on the file', () => {
    const path = join(workspace, 'auth.ts');
    writeFileSync(path, 'export function verify() { return 1; }');
    indexFile(dir, path);

    const ref = capture(dir, bigTestReport(), { anchors: [path] });
    promote(dir, { ref, anchor: path, claim: 'BceOnRelu goes NaN because the ReLU head feeds BCE', derivedCost: 6000 });

    // Surfaced on the next touch of that file, without anyone asking again.
    const verdict = verdictFor(graph(), { anchors: [path], question: 'why does BceOnRelu produce NaN?' });
    expect(verdict.claim).toContain('ReLU head feeds BCE');
  });

  test('promotion without an anchor is refused rather than orphaned', () => {
    expect(promote(dir, { claim: 'something true' })).toBeNull();
  });
});

describe('preview quality is reported, not buried', () => {
  test('nothing captured reports nothing rather than a perfect score', () => {
    expect(previewQuality(dir)).toBeNull();
  });

  test('the hold rate and the worst shape are both named', () => {
    for (let i = 0; i < 10; i++) capture(dir, `${bigTestReport()}${i}`, { shape: 'test-report' });
    for (let i = 0; i < 5; i++) capture(dir, `log output ${i}`.repeat(500), { shape: 'log' });
    for (let i = 0; i < 4; i++) recordExpansion(dir, { shape: 'log', asked: 'routine log lines' });

    const quality = previewQuality(dir);
    expect(quality.text).toMatch(/previews held \d+% of the time/);
    expect(quality.worst.shape).toBe('log');
    expect(quality.healthy).toBe(false);
  });
});

describe('expand serves what it claims to serve', () => {
  test('a ref that is not a digest is refused, not joined into a path', async () => {
    // The ref arrives straight from a model-supplied tool argument -- index.ts dispatches
    // `expand` with request.params.arguments unvalidated and the schema declares a bare string.
    // `join` resolves `..`, so '../../notes' read notes.txt from anywhere on disk and returned it
    // as the expansion of the pointer the caller was holding.
    const { resolve } = await import('../../hooks-core/expand.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'exp-ref-'));
    try {
      // String.raw for the Windows case. Written as '..\..\notes' it collapsed to '....notes' --
      // `\.` is not an escape sequence, so the backslashes vanished and the input duplicated the
      // 'not-hex-at-all' case. The test still passed, so the gap was silent: the traversal shape
      // this guard exists to refuse was never actually passed to it.
      const windowsTraversal = String.raw`..\..\notes`;
      expect(windowsTraversal).toContain('\\');

      for (const bad of [
        '../../../etc/passwd', windowsTraversal, 'not-hex-at-all',
        'ABCDEF0123456789', // uppercase hex: right shape, wrong case, still refused
        '', null, 42,
      ]) {
        expect(resolve(dir, bad)).toBeNull();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a well-formed but unknown digest is still null, not an adjacent file', async () => {
    const { resolve } = await import('../../hooks-core/expand.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'exp-miss-'));
    try {
      expect(resolve(dir, '0123456789abcdef')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an expansion whose capture record is gone is marked unverified, not served as fresh', async () => {
    // The artifact store is never pruned while metrics is a bounded tail, so artifacts routinely
    // outlive their capture records. Staleness is then unanswerable -- and unanswerable rendered
    // as fresh, which the module header calls worse than serving nothing.
    const { capture, resolve } = await import('../../hooks-core/expand.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'exp-unver-'));
    try {
      // Capture writes the artifact AND a metrics record; delete the metrics so only the
      // artifact survives, which is exactly the steady state being reproduced.
      const ref = capture(dir, 'some captured output', { anchors: [], tool: 'Bash', shape: 'log' });
      rmSync(join(dir, 'metrics.jsonl'), { force: true });
      const out = resolve(dir, ref);
      expect(out).toBeTruthy();
      expect(out.text).toMatch(/UNVERIFIED/);
      expect(out.known).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the artifact TTL is exported so the bound is not silent', async () => {
    const { ARTIFACT_TTL_MS } = await import('../../hooks-core/expand.mjs');
    expect(ARTIFACT_TTL_MS).toBeGreaterThan(0);
  });
});

describe('an omission is never silent, and never invented', () => {
  test('a large array reports the elements it withheld, with an expand ref', () => {
    // MEASURED before the fix: a 30,281-byte array of 500 objects returned mode 'preview',
    // `omissions: []`, ~150 bytes of text, and out.text did not contain the ref -- so 30 KB
    // vanished, the machine-readable contract asserted nothing was omitted, and there was no
    // pointer to recover it. Every other splitter partitions all of its input; this one did not.
    const dir = mkdtempSync(join(tmpdir(), 'disc-arr-'));
    try {
      const body = JSON.stringify(Array.from({ length: 500 }, (_, i) => ({
        id: i, name: `item-${i}`, detail: 'x'.repeat(20),
      })));
      const out = disclose(dir, body, { ref: 'abc123def4567890' });
      expect(out).toBeTruthy();
      expect(out.omissions.length).toBeGreaterThan(0);
      expect(out.text).toContain('abc123def4567890');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an empty array does not throw', () => {
    // JSON.stringify(undefined) returns undefined, so `.split` threw and aborted the whole
    // disclosure/capture block for any tool returning [].
    expect(() => parseShape('[]')).not.toThrow();
  });

  test('the header line count agrees with the omission counts below it', () => {
    // A JSON envelope is one physical line however large its payload, so the header read
    // "1 lines" directly above a tail reporting thousands omitted.
    const dir = mkdtempSync(join(tmpdir(), 'disc-hdr-'));
    try {
      const report = Array.from({ length: 3000 }, (_, i) => `  ok ${i} - passing test`).join('\n');
      const out = disclose(dir, JSON.stringify({ output: report, path: 'x.ts' }), { ref: 'r9' });
      expect(out).toBeTruthy();
      const stated = Number(/output, ([\d,]+) lines/.exec(out.text)?.[1]?.replace(/,/g, '') ?? '0');
      expect(stated).toBeGreaterThan(100);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a section kept in full is not labelled partial with zero lines omitted', () => {
    // The budget check and the slice loop round differently, so the loop could consume every
    // line of a section the check rejected -- reporting "omitted: 0 lines" and inviting the
    // reader to spend an expand call on nothing.
    const dir = mkdtempSync(join(tmpdir(), 'disc-zero-'));
    try {
      const out = disclose(dir, Array.from({ length: 1100 }, () => 'abcd').join('\n'), { ref: 'r1' });
      if (out) for (const o of out.omissions) expect(o.lines).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
