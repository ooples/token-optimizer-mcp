/**
 * Progressive disclosure, and the pointer that follows it.
 *
 * The properties under test are the ones a size-threshold truncator cannot have:
 * the answer replaces the output entirely when we already hold it, selection is
 * structural AND question-driven rather than positional, every cut is named,
 * expansion serves from the store instead of re-running, staleness is a
 * three-way decision rather than a boolean, and the expansion itself teaches the
 * next preview.
 *
 * MOST CASES BELOW PASS `holdRate: 1`, AND THAT IS A PREMISE, NOT BOILERPLATE.
 * A preview is priced at itself plus the remainder at the rate this shape is
 * actually expanded, so every case has to say which caller it is about. One
 * holds the preview and never follows the handle -- rate 1, the remainder never
 * charged -- and under that premise the rule is the preview-only test it grew
 * from, which leaves the preview's own mechanics on their own here. The rate
 * itself is what 'a preview is priced at the rate this shape is expanded' tests,
 * with the cold-start case that charges the remainder in full.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  disclose,
  parseShape,
  rankSections,
  verdictFor,
  DISCLOSE_THRESHOLD,
  withheldLines,
} from '../../hooks-core/disclose.mjs';
import {
  capture,
  resolve,
  freshness,
  refreshDecision,
  recordExpansion,
  previewPolicy,
  promote,
  previewQuality,
  CHEAP_REGEN_MS,
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
  for (let i = 0; i < 400; i++)
    lines.push(
      `  PASS  ShardTests.Case${i} elapsed 12ms and some padding text`
    );
  lines.splice(
    120,
    0,
    '  FAILED  DBNetTests.BceOnRelu -- expected 0.0 got NaN'
  );
  lines.splice(
    300,
    0,
    '  FAILED  TftGradientFlow -- gradient did not reach the encoder'
  );
  lines.push('Tests: 2 failed, 400 passed, 402 total');
  return lines.join('\n');
}

describe('shape is parsed before anything is selected', () => {
  test('a test report separates failures from the passing noise', () => {
    const { shape, sections } = parseShape(bigTestReport());
    expect(shape).toBe('test-report');
    expect(sections.find((s) => s.label === 'failures').lines).toHaveLength(2);
    expect(
      sections.find((s) => s.label === 'passing tests').lines.length
    ).toBeGreaterThan(300);
  });

  test('a diff becomes one section per file, so 39 of 40 can be dropped by name', () => {
    const text = [
      'diff --git a/src/a.ts b/src/a.ts',
      '+one',
      'diff --git a/src/b.ts b/src/b.ts',
      '+two',
    ].join('\n');
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
    expect(
      sections.find((s) => s.label === 'frames in this project').lines
    ).toHaveLength(1);
  });

  test('an unrecognised output still yields one section rather than throwing', () => {
    expect(parseShape('just words').shape).toBe('plain');
  });

  test('a large string inside a JSON field is parsed for its OWN shape', () => {
    // The case that matters most: every tool this product ships returns a JSON
    // envelope, so a build log arrives as one enormous escaped string on a
    // single line. Selecting inside a single line is not selection at all.
    const body = JSON.stringify({
      output: bigTestReport(),
      path: 'x.ts',
      tokensSaved: 12,
    });
    const { shape, sections } = parseShape(body);

    expect(shape).toBe('json');
    expect(sections.map((s) => s.label)).toContain('output > failures');
    expect(
      sections.find((s) => s.label === 'output > failures').lines
    ).toHaveLength(2);
    // Small fields stay whole -- nesting is for payloads, not for metadata.
    expect(sections.map((s) => s.label)).toContain('tokensSaved');
  });

  test('the failures inside a JSON envelope survive the preview', () => {
    const body = JSON.stringify({ output: bigTestReport(), path: 'x.ts' });
    const out = disclose(dir, body, {
      holdRate: 1,
      question: 'which shard fails?',
    });
    expect(out.text).toContain('DBNetTests.BceOnRelu');
    expect(out.omissions.map((o) => o.label)).toContain(
      'output > passing tests'
    );
  });
});

describe('selection is driven by the question, not by position', () => {
  test('the section naming the question outranks a heavier generic one', () => {
    const sections = parseShape(bigTestReport()).sections;
    const ranked = rankSections(sections, {
      question: 'why is BceOnRelu producing NaN?',
    });
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
    const out = disclose(dir, bigTestReport(), {
      holdRate: 1,
      question: 'which shard fails?',
      ref: 'abc123',
    });
    expect(out.mode).toBe('preview');
    // A model reasoning over a silent truncation cannot know it is missing
    // something; one told what was dropped can ask for it.
    expect(out.text).toMatch(/omitted: .*lines of passing tests/);
    expect(out.text).toContain('expand abc123');
  });

  test('the failures survive and the passes do not', () => {
    const out = disclose(dir, bigTestReport(), {
      holdRate: 1,
      question: 'which shard fails?',
    });
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
    const out = disclose(dir, `{"blob":"${'x'.repeat(60_000)}"}`, {
      holdRate: 1,
    });
    expect(out.text).toMatch(/^x{100,}/m);
    expect(out.text).toMatch(/55,\d{3} more characters on one line/);
    // And it is never empty, because an empty preview forces the very
    // expansion the preview exists to avoid.
    expect(out.kept.length).toBeGreaterThan(0);
  });

  test('the preview stays inside the earned budget', () => {
    const out = disclose(dir, bigTestReport(), { holdRate: 1 });
    expect(out.tokens).toBeLessThanOrEqual(3000);
  });
});

describe('the strongest disclosure is none of the output at all', () => {
  test('a confident fresh finding replaces the output entirely', () => {
    const path = join(workspace, 'auth.ts');
    writeFileSync(path, 'export function verify() { return 1; }');
    indexFile(dir, path);
    const finding = putNode(dir, {
      kind: 'finding',
      key: 'f1',
      confidence: 0.9,
      derivedCost: 12_400,
      claim: 'the 401s come from clock skew on the server, not token signing',
    });
    putEdge(dir, finding, 'derived_from', nodeId('file', path));

    const out = disclose(dir, bigTestReport(), {
      graph: graph(),
      anchors: [path],
      question: 'is the clock skew causing the 401s?',
      ref: 'r1',
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
    const finding = putNode(dir, {
      kind: 'finding',
      key: 'f1',
      confidence: 0.9,
      claim: 'skew explains the 401s',
    });
    putEdge(dir, finding, 'derived_from', nodeId('file', path));
    writeFileSync(path, 'export function verify() { return 2; }');

    expect(
      verdictFor(graph(), { anchors: [path], question: 'skew?' })
    ).toBeNull();
  });

  test('a low-confidence finding does not get to answer either', () => {
    const path = join(workspace, 'auth.ts');
    writeFileSync(path, 'export function verify() { return 1; }');
    indexFile(dir, path);
    const finding = putNode(dir, {
      kind: 'finding',
      key: 'f1',
      confidence: 0.2,
      claim: 'skew explains the 401s',
    });
    putEdge(dir, finding, 'derived_from', nodeId('file', path));

    expect(
      verdictFor(graph(), { anchors: [path], question: 'skew?' })
    ).toBeNull();
  });
});

describe('the pointer serves; it does not re-run', () => {
  test('expansion returns the original with nothing re-earned', () => {
    const ref = capture(dir, bigTestReport(), {
      tool: 'smart_test',
      shape: 'test-report',
    });
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
    const ref = capture(dir, bigTestReport(), {
      tool: 'smart_test',
      command: 'dotnet test',
      costMs,
      anchors: [path],
    });
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
    for (let i = 0; i < 5; i++)
      capture(dir, `${bigTestReport()}${i}`, {
        tool: 't',
        shape: 'test-report',
      });
    const policy = previewPolicy(dir, { shape: 'test-report' });
    expect(policy.holdRate).toBe(1);
    expect(Object.keys(policy.boosts)).toHaveLength(0);
  });

  test('a shape that keeps getting expanded boosts what people asked for', () => {
    for (let i = 0; i < 4; i++)
      capture(dir, `${bigTestReport()}${i}`, {
        tool: 't',
        shape: 'test-report',
      });
    for (let i = 0; i < 3; i++)
      recordExpansion(dir, {
        tool: 't',
        shape: 'test-report',
        asked: 'passing tests',
      });

    const policy = previewPolicy(dir, { shape: 'test-report' });
    expect(policy.holdRate).toBeLessThan(0.3);
    // Not "previews are 8% wrong" but "wrong specifically by dropping this".
    expect(policy.boosts['passing tests']).toBeGreaterThan(0);
  });

  test('the correction is proportional to how badly the shape is doing', () => {
    for (let i = 0; i < 20; i++)
      capture(dir, `${bigTestReport()}${i}`, { shape: 'log' });
    recordExpansion(dir, { shape: 'log', asked: 'routine log lines' });
    const gentle = previewPolicy(dir, { shape: 'log' }).boosts[
      'routine log lines'
    ];

    for (let i = 0; i < 12; i++)
      recordExpansion(dir, { shape: 'log', asked: 'routine log lines' });
    const firm = previewPolicy(dir, { shape: 'log' }).boosts[
      'routine log lines'
    ];

    expect(firm).toBeGreaterThan(gentle);
  });

  test('the refit closes the loop: the boosted section survives the next preview', () => {
    for (let i = 0; i < 4; i++)
      capture(dir, `${bigTestReport()}${i}`, { shape: 'test-report' });
    for (let i = 0; i < 4; i++)
      recordExpansion(dir, { shape: 'test-report', asked: 'passing tests' });

    const { boosts } = previewPolicy(dir, { shape: 'test-report' });
    const ranked = rankSections(parseShape(bigTestReport()).sections, {
      boosts,
    });
    expect(ranked[0].label).toBe('passing tests');
  });
});

describe('expanding promotes, so the second expansion never happens', () => {
  test('what somebody asked for once becomes a finding on the file', () => {
    const path = join(workspace, 'auth.ts');
    writeFileSync(path, 'export function verify() { return 1; }');
    indexFile(dir, path);

    const ref = capture(dir, bigTestReport(), { anchors: [path] });
    promote(dir, {
      ref,
      anchor: path,
      claim: 'BceOnRelu goes NaN because the ReLU head feeds BCE',
      derivedCost: 6000,
    });

    // Surfaced on the next touch of that file, without anyone asking again.
    const verdict = verdictFor(graph(), {
      anchors: [path],
      question: 'why does BceOnRelu produce NaN?',
    });
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
    for (let i = 0; i < 10; i++)
      capture(dir, `${bigTestReport()}${i}`, { shape: 'test-report' });
    for (let i = 0; i < 5; i++)
      capture(dir, `log output ${i}`.repeat(500), { shape: 'log' });
    for (let i = 0; i < 4; i++)
      recordExpansion(dir, { shape: 'log', asked: 'routine log lines' });

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
        '../../../etc/passwd',
        windowsTraversal,
        'not-hex-at-all',
        'ABCDEF0123456789', // uppercase hex: right shape, wrong case, still refused
        '',
        null,
        42,
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
      const ref = capture(dir, 'some captured output', {
        anchors: [],
        tool: 'Bash',
        shape: 'log',
      });
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
      const body = JSON.stringify(
        Array.from({ length: 500 }, (_, i) => ({
          id: i,
          name: `item-${i}`,
          detail: 'x'.repeat(20),
        }))
      );
      const out = disclose(dir, body, { holdRate: 1, ref: 'abc123def4567890' });
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
      const report = Array.from(
        { length: 3000 },
        (_, i) => `  ok ${i} - passing test`
      ).join('\n');
      const out = disclose(
        dir,
        JSON.stringify({ output: report, path: 'x.ts' }),
        { holdRate: 1, ref: 'r9' }
      );
      expect(out).toBeTruthy();
      const stated = Number(
        /output, ([\d,]+) lines/.exec(out.text)?.[1]?.replace(/,/g, '') ?? '0'
      );
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
      const out = disclose(
        dir,
        Array.from({ length: 1100 }, () => 'abcd').join('\n'),
        { ref: 'r1' }
      );
      if (out)
        for (const o of out.omissions) expect(o.lines).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a preview costs less than the output it replaces', () => {
  /**
   * A body past the threshold whose sections are many and tiny.
   *
   * The budget admits nearly all of them, so the preview carries almost every
   * line AND adds a header, a label per section and an omission tail. Measured
   * against the code before WORTHWHILE_PREVIEW existed, this body previewed at
   * 1.63x the cost of sending it -- the tax the refusal exists to refuse.
   */
  function manyTinySections(count) {
    const out = {};
    for (let k = 0; k < count; k += 1) {
      out['section' + k] = Array.from({ length: 6 }, (_, i) => k * 10 + i);
    }
    return JSON.stringify(out);
  }

  const estimate = (text) => Math.ceil(text.length / 4);

  test('refuses outright when the markers cost more than the elision saves', () => {
    const raw = manyTinySections(112);
    // Not the size floor: this body is over the threshold and still refused,
    // which is the whole point -- size was never the question.
    expect(raw.length).toBeGreaterThan(DISCLOSE_THRESHOLD);
    expect(disclose(dir, raw, { holdRate: 1, ref: 'r1' })).toBeNull();
  });

  test('still discloses when the elision buys something', () => {
    // THE CONTROL ARM. The same construction at a size where dropping sections
    // is a real saving: without this, a disclose() that had simply stopped
    // working would pass the test above.
    const raw = manyTinySections(400);
    const out = disclose(dir, raw, { holdRate: 1, ref: 'r1' });
    expect(out).not.toBeNull();
    expect(estimate(out.text)).toBeLessThan(estimate(raw));
  });
});

describe('the handle names what was withheld, not the whole output', () => {
  const estimate = (text) => Math.ceil(text.length / 4);

  /** The store callback the server supplies, plus a record of what it saw. */
  function withStore() {
    const seen = [];
    return {
      seen,
      captureWithheld: (withheld) => {
        seen.push(withheld);
        return capture(dir, withheld, {
          tool: 't',
          shape: 'json',
          anchors: [],
        });
      },
    };
  }

  test('an expansion serves the remainder rather than the preview again', () => {
    const raw = JSON.stringify({
      rows: Array.from({ length: 300 }, (_, i) => ({
        a: i,
        b: i * 2,
        c: i * 3,
      })),
    });
    const ref = capture(dir, raw, { tool: 't', shape: 'json', anchors: [] });
    const store = withStore();
    const out = disclose(dir, raw, { holdRate: 1, ref, ...store });

    expect(out.mode).toBe('preview');
    // The reference the tail printed is NOT the body's own: that is the defect.
    // A 1,270-token file read through smart_read cost 1,192 tokens to preview
    // and then 1,778 to expand, because expanding re-sent what the preview had
    // already delivered.
    expect(out.handle).not.toBe(ref);
    expect(out.text).toContain(`(expand ${out.handle})`);
    expect(store.seen).toHaveLength(1);

    const served = resolve(dir, out.handle);
    expect(served).not.toBeNull();
    // Cheaper than the body it is a part of, which is the property that makes
    // following the handle worth doing at all.
    expect(estimate(served.text)).toBeLessThan(estimate(raw));
  });

  test('falls back to the body when the remainder is not the cheaper thing', () => {
    // A single huge section: the preview keeps a few lines and withholds the
    // rest, so the remainder is the body over again with a label on top. There
    // is nothing to gain, and storing a near-duplicate artifact to serve it
    // would cost more than the reference already in hand.
    const raw = JSON.stringify({
      summary: { files: 3, findings: 2 },
      detail: Array.from({ length: 400 }, (_, i) => 'finding number ' + i),
    });
    const ref = capture(dir, raw, { tool: 't', shape: 'json', anchors: [] });
    const store = withStore();
    const out = disclose(dir, raw, { holdRate: 1, ref, ...store });

    expect(out.handle).toBe(ref);
    expect(store.seen).toHaveLength(0);
  });
});

describe('the remainder is de-indented, but only where whitespace is not content', () => {
  test('a JSON-rendered section loses the indentation stringify added', () => {
    // splitJson renders every value with JSON.stringify(value, null, 2) so the
    // budget loop has lines to admit or drop. Those spaces mean nothing in the
    // remainder an expand serves, and on a dense numeric payload they are most
    // of it: measured on smart-complexity.ts, the indented remainder came to
    // 7,204 characters where the whole compact body was 5,371.
    const s = { json: true, lines: ['  {', '    "a": 1', '  }'] };
    expect(withheldLines(s, s.lines)).toEqual(['{', '"a": 1', '}']);
  });

  test('a nested string field keeps its own leading spaces', () => {
    // The other branch of splitJson: a file's contents arriving as one escaped
    // JSON string are parsed for their OWN shape, and there the indentation is
    // the content. Trimming it would hand back source that is not the source.
    const s = { lines: ['function f() {', '  return 1;', '}'] };
    expect(withheldLines(s, s.lines)).toEqual(s.lines);
  });
});

describe('a long string gets its own shape however deep it sits', () => {
  /**
   * THE RULE USED TO STOP AT ONE LEVEL. It covered the tools whose payload is
   * `{ content: <the file> }` and missed every tool that wraps its answer: the
   * smart_pretty family returns the formatted file at `data.format.code`, so
   * `data` was rendered with JSON.stringify and the file stayed one escaped
   * line inside it. Measured through the reduction bench, that one line cost
   * smart_pretty 13-25% of the file it was formatting, and it was long enough
   * that the bench read the fixture's own source as a published saving.
   *
   * The pair below is the point: the shallow case is the control, and without
   * it a rule that had reverted to depth 1 would still pass the deep case's
   * sibling assertions by accident.
   */
  const SOURCE = Array.from(
    { length: 120 },
    (_, i) => `export const name${i} = { k: 'v' };`
  ).join('\n');

  function labels(payload) {
    return parseShape(JSON.stringify(payload)).sections.map((s) => s.label);
  }

  test('at the top level, where it always did', () => {
    expect(labels({ path: '/tmp/x.ts', content: SOURCE })).toContain(
      'content > output'
    );
  });

  test('two levels in, named by its whole path', () => {
    expect(
      labels({
        success: true,
        data: { format: { code: SOURCE, changed: true } },
      })
    ).toContain('data.format.code > output');
  });

  test('and the object it came out of is rendered without it', () => {
    // A preview that printed the stripped object AND the string would charge
    // the caller twice for the biggest thing in the reply.
    const sections = parseShape(
      JSON.stringify({ data: { format: { code: SOURCE, changed: true } } })
    ).sections;
    const data = sections.find((s) => s.label === 'data');

    expect(data).toBeDefined();
    // PARSED, NOT MATCHED AS TEXT. An earlier version of this looked for the
    // spelling `"changed": true`, which pinned the renderer's padding rather
    // than the property under test -- so switching the section renderer to one
    // compact entry per line failed it while the behaviour it describes was
    // unchanged. What has to hold is that the siblings survived and the lifted
    // string did not, and that is a fact about the value, not about its spacing.
    const rebuilt = JSON.parse(data.lines.join('\n'));

    expect(rebuilt).toEqual({ format: { changed: true } });
  });

  test('a short nested string stays in the object', () => {
    // The threshold is what makes this a saving rather than a shredder: a
    // one-line field lifted into its own section costs a label and saves
    // nothing.
    const sections = parseShape(
      JSON.stringify({ data: { format: { code: 'const a = 1;' } } })
    ).sections;

    expect(sections.map((s) => s.label)).not.toContain(
      'data.format.code > output'
    );
    expect(sections.find((s) => s.label === 'data').lines.join('\n')).toContain(
      'const a = 1;'
    );
  });

  test('a long array element is left where it is', () => {
    // Removing one shifts every index after it, so a label naming an element
    // would describe a payload that does not exist.
    expect(labels({ data: { lines: [SOURCE] } })).not.toContain(
      'data.lines[0] > output'
    );
  });
});

describe('a section is rendered one compact entry per line', () => {
  /**
   * Sections are chosen, trimmed and counted by the line, so the renderer has
   * to produce lines -- and it produced them with
   * JSON.stringify(value, null, 2), which bills the caller a brace on its own
   * line per container plus two spaces per level on every line. Measured
   * through bench/tools/reduction.mjs against the same payloads:
   *
   *   smart_refactor   tool-profile.ts      -87.2% -> -43.1%
   *   smart_refactor   smart-complexity.ts   41.4% ->  51.5%
   *   smart_complexity smart-complexity.ts   31.5% ->  44.9%
   *
   * Two things have to hold together, and either alone is worthless: the lines
   * must be cheaper, and they must still BE lines, or the budget loop loses the
   * granularity it selects with.
   */
  const ROWS = Array.from({ length: 40 }, (_, i) => ({
    type: 'improve-naming',
    severity: 'info',
    at: [
      [i, 13],
      [i + 100, 31],
    ],
    message: 'Inconsistent naming convention in ' + 'NAME_' + i,
    effort: 'low',
  }));

  function sectionFor(payload, label) {
    return parseShape(JSON.stringify(payload)).sections.find(
      (s) => s.label === label
    );
  }

  test('costs less than the indented rendering it replaced', () => {
    const payload = { rows: ROWS };
    const s = sectionFor(payload, 'rows');
    const indented = JSON.stringify(ROWS, null, 2);

    expect(s.lines.join('\n').length).toBeLessThan(indented.length);
  });

  test('but is still many lines, so a budget can cut it', () => {
    // THE CONTROL ARM. Cheaper on its own is satisfied by returning the whole
    // thing on one line, which would silently turn every preview of a JSON
    // payload into all-or-nothing.
    const s = sectionFor({ rows: ROWS }, 'rows');

    expect(s.lines.length).toBeGreaterThan(ROWS.length);
  });

  test('and each line is a whole record, not one field of one', () => {
    const s = sectionFor({ rows: ROWS }, 'rows');
    const records = s.lines.filter((line) => line.startsWith('{'));

    expect(records).toHaveLength(ROWS.length);
    expect(JSON.parse(records[0].replace(/,$/, ''))).toEqual(ROWS[0]);
  });

  test('and the whole section still parses back to the value', () => {
    // The lines are a rendering of the payload, not a lossy summary of it.
    const s = sectionFor({ rows: ROWS }, 'rows');

    expect(JSON.parse(s.lines.join('\n'))).toEqual(ROWS);
  });

  test('a value that already fits stays on one line', () => {
    // Opening up a shape that is small enough to read whole would spend lines
    // for nothing -- and the omission counts would then count braces.
    const s = sectionFor({ summary: { files: 3, errors: 0 } }, 'summary');

    expect(s.lines).toEqual(['{"files":3,"errors":0}']);
  });
});

describe('a caller who names a section pays for that section', () => {
  /**
   * EXPAND_TOOL has always told callers to "pass `section` to say which named
   * part of the preview you needed". `resolve` took the argument, passed it to
   * recordExpansion as a learning signal, and served the whole artifact
   * regardless -- so naming the one section you were missing cost you every
   * section there was.
   */
  const stored = [
    '--- summary ---',
    '{ "files": 3 }',
    '--- findings (partial) ---',
    'first finding',
    'second finding',
    '--- timings ---',
    '{ "ms": 12 }',
  ].join('\n');

  test('selects the named section and reports that it narrowed', () => {
    const ref = capture(dir, stored, { tool: 't', shape: 'json', anchors: [] });
    const out = resolve(dir, ref, { section: 'findings' });

    expect(out.text).toContain('first finding');
    expect(out.text).not.toContain('{ "ms": 12 }');
    expect(out.narrowed).toBe(true);
    expect(out.section).toBe('findings');
  });

  test('a label the preview printed in full is matched either way round', () => {
    // A preview labels a nested field `content > output`, and a caller asking
    // for `output` means that one -- so matching is a substring in either
    // direction rather than equality.
    const text = [
      '--- content > output ---',
      'the output',
      '--- other ---',
      'x',
    ].join('\n');
    const ref = capture(dir, text, { tool: 't', shape: 'json', anchors: [] });
    expect(resolve(dir, ref, { section: 'output' }).text).toContain(
      'the output'
    );
  });

  test('a name this artifact does not have serves the whole thing, not nothing', () => {
    // The one answer that cannot be recovered from: an empty expansion tells
    // the caller neither what it asked for nor that it asked wrongly.
    const ref = capture(dir, stored, { tool: 't', shape: 'json', anchors: [] });
    const out = resolve(dir, ref, { section: 'no such part' });

    expect(out.text).toBe(stored);
    expect(out.narrowed).toBe(false);
  });

  test('no section named at all is unchanged behaviour', () => {
    const ref = capture(dir, stored, { tool: 't', shape: 'json', anchors: [] });
    const out = resolve(dir, ref);
    expect(out.text).toBe(stored);
    expect(out.narrowed).toBe(false);
    expect(out.section).toBeNull();
  });
});

describe('a preview is priced at the rate this shape is expanded', () => {
  /**
   * A body the preview-only rule would disclose, and by a small enough margin.
   *
   * Four hundred tiny sections: the budget admits most of them, so the preview
   * is nearly the whole body plus a header, a label per section and an omission
   * tail. It clears the preview-only test, and clears it by little enough that
   * the remainder decides -- which is the case the rate exists for. A body that
   * previewed at a tenth of its size would be disclosed at every rate and would
   * say nothing about which rate had been applied.
   */
  function manySections(count) {
    const body = {};
    for (let i = 0; i < count; i += 1)
      body['section' + i] = { note: 'line ' + i, level: 'low' };
    return JSON.stringify(body, null, 2);
  }

  const raw = manySections(400);

  test('a proven hold record discloses, which is the control for the rest', () => {
    expect(disclose(dir, raw, { holdRate: 1, ref: 'r1' })).not.toBeNull();
  });

  test('a shape nobody has held yet is charged for the remainder in full', () => {
    // No history is not evidence of holding. The benchmark charges every
    // expansion on every row, so until the store says otherwise the preview has
    // to beat the body outright -- and this body does not.
    expect(disclose(dir, raw, { holdRate: null, ref: 'r1' })).toBeNull();
    expect(disclose(dir, raw, { ref: 'r1' })).toBeNull();
  });

  test('a shape that is always expanded is refused however good the preview', () => {
    expect(disclose(dir, raw, { holdRate: 0, ref: 'r1' })).toBeNull();
  });

  test('the rate moves the verdict rather than switching it on and off', () => {
    // Between the two ends there is a rate at which this body stops paying, and
    // it is inside (0, 1): without that, 'priced at the rate' would be two
    // thresholds wearing a number.
    const verdicts = [0.2, 0.5, 0.8, 0.95].map(
      (holdRate) => disclose(dir, raw, { holdRate, ref: 'r1' }) !== null
    );
    expect(new Set(verdicts).size).toBe(2);
    // And it moves one way: a shape held more often is never refused where one
    // held less often was allowed.
    expect([...verdicts].sort()).toEqual(verdicts);
  });
});

describe('what a cut hands back is still a value', () => {
  /** A JSON body whose big section is cut rather than dropped whole. */
  function withLongSection(entries) {
    return JSON.stringify(
      {
        file: 'tool-profile.ts',
        total: entries,
        suggestions: Array.from({ length: entries }, (_, i) => ({
          line: i + 1,
          rule: 'prefer-const',
          message: 'the constant on line ' + (i + 1) + ' is never reassigned',
          severity: 'low',
        })),
      },
      null,
      2
    );
  }

  test('a partially kept JSON section parses', () => {
    // The question is what gets a section to the partial path at all: partial
    // admission needs the score a question's term hits supply, and without one
    // the section is omitted whole and this case tests nothing.
    const out = disclose(dir, withLongSection(800), {
      holdRate: 1,
      question: 'which constant is never reassigned',
      ref: 'r1',
    });

    const partial = out.kept.filter((k) => k.partial);
    expect(partial.length).toBeGreaterThan(0);
    for (const section of partial)
      expect(() => JSON.parse(section.lines.join(''))).not.toThrow();
  });

  test('a cut that is not JSON is handed back exactly as it was', () => {
    // A log has no containers to close, and closing it would corrupt it. Every
    // line of the cut is the body's own line, not one with a closer appended or
    // a trailing comma stripped.
    const lines = Array.from(
      { length: 4000 },
      (_, i) => '2026-10-03 warn retry ' + i + ' failed, backing off'
    );
    const out = disclose(dir, lines.join('\n'), {
      holdRate: 1,
      question: 'which retry warns',
      ref: 'r1',
    });

    // And it IS a cut, so the closer is being declined rather than never
    // reached: a case where nothing was sliced would pass this whole test
    // without ever consulting the guard.
    expect(out.kept.filter((k) => k.partial).length).toBeGreaterThan(0);
    for (const section of out.kept)
      for (const line of section.lines) expect(lines).toContain(line);
  });
});

describe('how far a hold record can be trusted', () => {
  /** Serve `served` previews of one shape and expand the first `expanded`. */
  function record(served, expanded) {
    const refs = [];
    for (let i = 0; i < served; i += 1)
      refs.push(
        capture(dir, JSON.stringify({ i, pad: 'x'.repeat(40) }), {
          tool: 'probe',
          shape: 'json',
          anchors: [],
        })
      );
    for (let i = 0; i < expanded; i += 1)
      recordExpansion(dir, { ref: refs[i], tool: 'probe', shape: 'json' });
    return previewPolicy(dir, { tool: 'probe', shape: 'json' });
  }

  test('no history reports no rate at all, rather than a perfect one', () => {
    const policy = previewPolicy(dir, { tool: 'probe', shape: 'json' });
    expect(policy.holdRate).toBeNull();
    expect(policy.holdRateLower).toBeNull();
  });

  test('one unexpanded preview reads as a rate of 1 but is barely trusted', () => {
    // The point estimate is the problem the bound solves: a shape served once
    // and not yet followed has a perfect record and no evidence.
    const policy = record(1, 0);
    expect(policy.holdRate).toBe(1);
    expect(policy.holdRateLower).toBeLessThan(0.3);
  });

  test('the bound rises with the sample where the point estimate cannot', () => {
    const one = record(1, 0).holdRateLower;
    const many = record(49, 0);
    expect(many.holdRate).toBe(1);
    expect(many.holdRateLower).toBeGreaterThan(0.9);
    expect(many.holdRateLower).toBeGreaterThan(one);
  });

  test('a shape that gets expanded is bounded below its own rate', () => {
    const policy = record(10, 5);
    expect(policy.holdRate).toBe(0.5);
    expect(policy.holdRateLower).toBeLessThan(0.5);
    expect(policy.holdRateLower).toBeGreaterThan(0);
  });

  test('the bound stays a probability at both ends', () => {
    for (const [served, expanded] of [
      [1, 0],
      [3, 3],
      [40, 1],
    ]) {
      const { holdRateLower } = record(served, expanded);
      expect(holdRateLower).toBeGreaterThanOrEqual(0);
      expect(holdRateLower).toBeLessThanOrEqual(1);
    }
  });
});
