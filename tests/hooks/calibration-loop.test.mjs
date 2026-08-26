/**
 * The calibration loop -- does Layer 1's cheap LABEL predict Layer 2's
 * expensive EFFECT?
 *
 * FIXTURES ARE BUILT WITH THE REAL PRODUCERS, following `loo.test.mjs`: `record`
 * writes the `inject` and `read` rows, `recordToolOutcome` performs the real
 * (episodeId, toolCallId) join, and Layer 1's reference channel is driven by
 * real `query` events. Nothing here hand-writes an event shape that production
 * does not write.
 *
 * TWO THINGS THIS FILE IS WATCHING FOR, both of which are the reason it exists:
 *
 *   1. A CALIBRATION THAT PUBLISHES WHEN IT CANNOT. Every refusal below asserts
 *      the ABSENCE of a `gap` field, not `gap === 0`. A permanent zero reads as
 *      "measured, and the two agree", which is the opposite of "nothing was
 *      measured" -- and it is the shape that would let this project quote a
 *      reference rate as a saving.
 *   2. CIRCULARITY. The whole comparison is worthless if a quantity common to
 *      both layers leaks in. Two tests pin it from opposite sides: flipping the
 *      LABELS while holding the effects fixed must flip the gap, and moving
 *      Layer 1's RATE without moving any label must leave the gap identical.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  record,
  recordToolOutcome,
  readMetrics,
  readTruncation,
} from '../../hooks-core/metrics.mjs';
import { referenceRate } from '../../hooks-core/usage.mjs';
import {
  servingPolicyVersion,
  MIN_PRIOR_INJECTIONS,
  MIN_SERVED,
  MIN_WITHHELD,
} from '../../hooks-core/loo.mjs';
import {
  calibration,
  calibrationNote,
  consolidation,
  graphBalanceSheet,
  labelsByFinding,
  MIN_FINDINGS_PER_ARM,
  MIN_GAP_TOKENS,
} from '../../hooks-core/crosslayer.mjs';
import { renderAudit } from '../../hooks-core/audit.mjs';
import { putNode, load } from '../../hooks-core/wiki.mjs';
import { contradict, hasOutstandingContradiction } from '../../hooks-core/curate.mjs';

let workspace;
let dir;
let clock;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'cal-'));
  dir = join(workspace, 'wiki');
  clock = 1;
  // Pinned, because `servingPolicyVersion()` hashes it: the fixtures must be
  // written under the same policy the assertions compute.
  process.env.TOKEN_OPTIMIZER_HOLDOUT = '0';
  delete process.env.TOKEN_OPTIMIZER_LOO;
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  delete process.env.TOKEN_OPTIMIZER_HOLDOUT;
  delete process.env.TOKEN_OPTIMIZER_LOO;
});

const POLICY = () => servingPolicyVersion();

/** One injection, written by the real recorder. */
function inject({ keys, session, loo = null, anchor, policy }) {
  clock += 10;
  const toolCallId = `tc-${clock}`;
  return record(dir, {
    kind: 'inject',
    episodeId: session,
    sessionId: session,
    toolCallId,
    surface: 'file',
    anchor,
    holdout: false,
    tokens: 10,
    deliveredTokens: 10,
    shadowTokens: 10,
    count: keys.length,
    candidateCount: keys.length,
    findingIds: keys,
    shadowFindingIds: keys,
    stale: false,
    looPolicy: policy,
    ...(loo ? { loo } : {}),
    at: clock,
  });
}

/** The post-tool result that makes the injection attributable, via the real join. */
const outcome = (event) =>
  recordToolOutcome(dir, {
    episodeId: event.episodeId,
    sessionId: event.sessionId,
    toolCallId: event.toolCallId,
    surface: event.surface,
    anchor: event.anchor,
    toolName: 'Read',
    success: true,
    at: (event.at || 0) + 1,
  });

/** `n` touches, one session each, each with its joined outcome and a later read. */
function touches(n, { keys, loo = null, cost = 0, tag, anchor, policy = null }) {
  for (let i = 0; i < n; i += 1) {
    const session = `${tag}-${i}`;
    const event = inject({ keys, session, loo, anchor, policy: policy || POLICY() });
    outcome(event);
    if (cost)
      record(dir, {
        kind: 'read',
        anchor,
        sessionId: session,
        tokens: cost,
        at: (event.at || 0) + 5,
      });
  }
}

/** One finding node, by key, from the graph on disk. */
const findingNode = (key) =>
  [...load(dir).nodes.values()].find((n) => n.kind === 'finding' && n.key === key);

/** A `query` naming a finding key -- Layer 1's only reference producer. */
const query = (key, at) =>
  record(dir, { kind: 'query', operation: 'get', key, sessionId: 'q', at });

/**
 * `n` findings, each with a served and a withheld arm, and an effect of its own.
 *
 * `effectFor(i)` is the extra read cost the WITHHELD arm carries, so a positive
 * value means the finding suppressed that much reading. Each finding gets its
 * own anchor and its own pad key, so one finding's arms cannot borrow another's
 * read total through the (session, anchor) split.
 */
function findings(n, { effectFor, withheldCount = MIN_WITHHELD, policy = null } = {}) {
  for (let i = 0; i < n; i += 1) {
    const keys = [`f${i}`, `p${i}`];
    const anchor = `src/f${i}.ts`;
    touches(MIN_PRIOR_INJECTIONS, { keys, tag: `w${i}`, anchor, policy });
    touches(MIN_SERVED, { keys, tag: `s${i}`, cost: 100, anchor, policy });
    touches(withheldCount, {
      keys: [`p${i}`],
      loo: `f${i}`,
      tag: `x${i}`,
      cost: 100 + effectFor(i),
      anchor,
      policy,
    });
  }
}

/** Names f0..f2 in a later `query`, so Layer 1 labels exactly those referenced. */
function referenceFirstThree(offset = 0) {
  for (let i = 0; i < 3; i += 1) query(`f${i + offset}`, 10_000 + i);
}

/** Six findings where the REFERENCED ones show no read-suppression at all. */
function dirWhereReferencedFindingsShowNoEffect() {
  findings(6, { effectFor: (i) => (i < 3 ? 0 : 4900) });
  referenceFirstThree();
}

/** Six findings where the REFERENCED ones are the ones that suppress reads. */
function dirWhereReferencedFindingsShowEffect() {
  findings(6, { effectFor: (i) => (i < 3 ? 4900 : 0) });
  referenceFirstThree();
}

describe('the calibration loop', () => {
  it('refuses to publish Layer 1 when its label does not predict Layer 2', () => {
    dirWhereReferencedFindingsShowNoEffect();
    const result = calibration(dir);
    expect(result.publishable).toBe(false);
    expect(result.verdict).toMatch(/does not predict|uncalibrated/i);
    // MEASURED, so a gap exists and is reported: this is a refusal on the
    // evidence, not for want of it.
    expect(result.gap).toBeLessThan(0);
    expect(result.arms).toEqual({ referenced: 3, notReferenced: 3 });
  });

  it('publishes when referenced findings show a larger causal effect', () => {
    dirWhereReferencedFindingsShowEffect();
    const result = calibration(dir);
    expect(result.publishable).toBe(true);
    expect(result.gap).toBeGreaterThan(0);
    expect(result.verdict).toMatch(/calibrated: referenced findings suppress/);
  });

  it('refuses with NO gap field when Layer 1 has published no rate', () => {
    // Layer 2 is fully populated; nothing ever named a finding.
    findings(6, { effectFor: (i) => (i < 3 ? 4900 : 0) });
    const result = calibration(dir);
    expect(result.publishable).toBe(false);
    // Layer 1 has rows -- 138 of them -- and every one is `not-referenced`
    // because its numerator's producer never fired. A 0% rate there would be
    // measuring the absence of a producer, so Layer 1 publishes no rate and the
    // refusal quotes both halves of why.
    expect(result.verdict).toMatch(
      /Layer 1 has \d+ classifiable observation\(s\) and 0 reference event\(s\), so it publishes no rate/
    );
    expect(result.layer1.rate).toBeNull();
    // A PERMANENT ZERO WOULD READ AS "measured, and they agree". Task 7 removed
    // a field rather than zero it for exactly this reason.
    expect('gap' in result).toBe(false);
    expect(result.verdict).toMatch(/not the same as a gap of zero/);
  });

  it('refuses with NO gap field when Layer 2 has no observations', () => {
    // Layer 1 has a real rate; the leave-one-out has never run.
    const anchor = 'src/only.ts';
    touches(2, { keys: ['f0', 'p0'], tag: 'l1', anchor });
    query('f0', 9_000);
    const result = calibration(dir);
    expect(result.layer1.rate).not.toBeNull();
    expect(result.publishable).toBe(false);
    expect(result.verdict).toMatch(/Layer 2 has 0 observation/);
    expect('gap' in result).toBe(false);
  });

  it('names BOTH sides when both are silent, and reports no gap', () => {
    const result = calibration(dir);
    expect(result.publishable).toBe(false);
    expect(result.verdict).toMatch(/Layer 1 has 0 classifiable observation/);
    expect(result.verdict).toMatch(/Layer 2 has 0 observation/);
    expect('gap' in result).toBe(false);
  });

  it('refuses when Layer 2 has observations but no published effect', () => {
    // One withheld observation short of the floor: every row still carries an
    // estimate, so a mean of them exists -- and is noise.
    findings(6, {
      effectFor: (i) => (i < 3 ? 4900 : 0),
      withheldCount: MIN_WITHHELD - 1,
    });
    referenceFirstThree();
    const result = calibration(dir);
    expect(result.layer2.observations).toBeGreaterThan(0);
    expect(result.layer2.published).toBe(0);
    expect(result.publishable).toBe(false);
    expect(result.verdict).toMatch(/no published effect/);
    expect('gap' in result).toBe(false);
  });

  it('refuses when an arm is below the per-arm floor', () => {
    findings(4, { effectFor: (i) => (i < 3 ? 4900 : 0) });
    // Only two findings are ever named, so the referenced arm holds two.
    query('f0', 10_000);
    query('f1', 10_001);
    const result = calibration(dir);
    expect(result.arms.referenced).toBe(2);
    expect(result.publishable).toBe(false);
    expect(result.verdict).toMatch(
      new RegExp(`below the floor of ${MIN_FINDINGS_PER_ARM} per arm`)
    );
    expect('gap' in result).toBe(false);
  });

  it('refuses a gap that only floating point can see', () => {
    // Both arms carry the SAME mean effect, spread differently across findings,
    // so one finding in each arm publishes and the gap is zero up to arithmetic
    // noise. Publishing that would print "suppress 0 more tokens/touch".
    findings(6, { effectFor: (i) => (i === 0 || i === 3 ? 4900 : 0) });
    referenceFirstThree();
    const result = calibration(dir);
    expect(result.layer2.published).toBeGreaterThan(0);
    expect(Math.abs(result.gap)).toBeLessThan(MIN_GAP_TOKENS);
    expect(result.publishable).toBe(false);
    expect(result.verdict).toMatch(/does not predict/);
  });

  it('refuses rather than pooling arms measured under another serving policy', () => {
    findings(6, { effectFor: (i) => (i < 3 ? 4900 : 0), policy: 'some-older-policy' });
    referenceFirstThree();
    const result = calibration(dir);
    expect(result.layer2.rows).toBeGreaterThan(0);
    expect(result.layer2.inPolicy).toBe(0);
    expect(result.verdict).toMatch(/different serving policy/);
    expect('gap' in result).toBe(false);
  });
});

describe('independence of the two layers', () => {
  it('flips the gap when the LABELS move and the effects do not', () => {
    // Identical Layer 2 data in both dirs; only which findings were named
    // changes. If the gap did not move, Layer 1's label is not an input.
    findings(6, { effectFor: (i) => (i < 3 ? 4900 : 0) });
    referenceFirstThree(0);
    const naming012 = calibration(dir);

    const second = mkdtempSync(join(tmpdir(), 'cal2-'));
    const saved = dir;
    dir = join(second, 'wiki');
    clock = 1;
    findings(6, { effectFor: (i) => (i < 3 ? 4900 : 0) });
    referenceFirstThree(3);
    const naming345 = calibration(dir);
    dir = saved;
    rmSync(second, { recursive: true, force: true });

    expect(naming012.gap).toBeGreaterThan(0);
    expect(naming345.gap).toBeLessThan(0);
    expect(naming012.gap).toBeCloseTo(-naming345.gap, 6);
  });

  it('leaves the gap identical when Layer 1s RATE moves and no label does', () => {
    dirWhereReferencedFindingsShowEffect();
    const before = calibration(dir);
    const rateBefore = referenceRate(dir).rate;

    // Five more references, all naming a pad key that carries no Layer 2
    // effect. Layer 1's rate moves; no finding with an effect changes label.
    for (let i = 0; i < 5; i += 1) query('p0', 20_000 + i);

    const after = calibration(dir);
    expect(referenceRate(dir).rate).not.toBeCloseTo(rateBefore, 6);
    // BYTE-IDENTICAL. Any Layer 1 magnitude feeding the gap would move it.
    expect(after.gap).toBe(before.gap);
    expect(after.referencedMean).toBe(before.referencedMean);
    expect(after.notReferencedMean).toBe(before.notReferencedMean);
  });

  it('does not claim a truncated window when the caller supplied its own events', () => {
    // The bounds of a caller's read are the caller's to describe. Claiming
    // truncation over someone else's array would attach a caveat to a figure
    // that does not carry the risk it warns about.
    // A GENUINELY TRUNCATED READ FIRST, in another graph, so `readTruncation()`
    // is armed. Without this the assertion below holds whether the flag is
    // consulted or not, which is the vacuous version of it.
    const noisy = join(workspace, 'noisy');
    mkdirSync(noisy, { recursive: true });
    writeFileSync(
      join(noisy, 'metrics.jsonl'),
      Array.from({ length: 5_100 }, (_, i) =>
        JSON.stringify({ kind: 'read', at: i })
      )
        .map((line) => line + String.fromCharCode(10))
        .join('')
    );
    readMetrics(noisy);
    expect(readTruncation().byEvents).toBe(true);

    const events = [
      { kind: 'inject', findingIds: ['k1'], injectionId: 'i', sessionId: 's', at: 1 },
      { kind: 'query', operation: 'get', key: 'k1', sessionId: 's', at: 2 },
    ];
    const result = calibration(dir, { events });
    expect(result.windowed).toBe(false);
    expect(result.verdict).not.toMatch(/truncated/);
  });

  it('takes only the label from Layer 1: any reference makes a finding referenced', () => {
    // BOTH ORDERS. `classify` emits rows in time order, so a finding injected
    // AGAIN after the model named it has a `referenced` row followed by a
    // `not-referenced` one -- and a fold that let the later row win would put a
    // finding the model demonstrably reads into the arm it is meant to predict.
    const rows = [
      { findingKey: 'a', label: 'not-referenced' },
      { findingKey: 'a', label: 'referenced' },
      { findingKey: 'd', label: 'referenced' },
      { findingKey: 'd', label: 'not-referenced' },
      { findingKey: 'b', label: 'unknown' },
      { findingKey: 'c', label: 'not-referenced' },
    ];
    const labels = labelsByFinding(rows);
    expect(labels.get('a')).toBe('referenced');
    expect(labels.get('d')).toBe('referenced');
    expect(labels.get('c')).toBe('not-referenced');
    // `unknown` is dropped rather than defaulted into an arm.
    expect(labels.has('b')).toBe(false);
  });
});

describe('measured utility ranks a finding and never raises its confidence', () => {
  /**
   * THE GATE THE PLAN ASKED FOR DOES NOT EXIST, AND MUST NOT BE INVENTED.
   *
   * Step 6 called for `mayPromote(graph, key)` over
   * `hasOutstandingContradiction`. There is no promotion path to gate: every
   * write of `confidence` in `hooks-core` happens at CREATION, and nothing
   * updates a stored finding's confidence afterwards. An unreachable gate is
   * the defect class this plan exists to close, so what is asserted here is the
   * invariant itself -- from both directions.
   */
  it('does not change a contradicted findings confidence when its measured effect is large', () => {
    putNode(dir, { kind: 'finding', key: 'f0', claim: 'suppressor', confidence: 0.6 });
    putNode(dir, { kind: 'finding', key: 'rebuttal', claim: 'rebuttal', confidence: 0.9 });
    expect(
      contradict(dir, { key: 'f0', byKey: 'rebuttal', reason: 're-derived differently' })
    ).toBe(true);
    const before = findingNode('f0');
    expect(hasOutstandingContradiction(load(dir), 'f0')).toBe(true);

    // A large measured win for that exact key, then every reader of it.
    findings(6, { effectFor: () => 4900 });
    for (let i = 0; i < 3; i += 1) query(`f${i}`, 10_000 + i);
    const effect = calibration(dir).layer2;
    expect(effect.observations).toBeGreaterThan(0);
    graphBalanceSheet(dir);
    calibrationNote(dir);
    renderAudit(dir, []);

    // UNCHANGED. Utility ranked it; nothing promoted it.
    expect(findingNode('f0').confidence).toBe(before.confidence);
  });

  it('never writes confidence from any module that measures utility', () => {
    // STRUCTURAL, in the spirit of the reachability guard: utility RANKS, and a
    // module that measures it must not be able to promote what it measured.
    for (const file of ['crosslayer.mjs', 'loo.mjs', 'usage.mjs']) {
      const text = readFileSync(new URL(`../../hooks-core/${file}`, import.meta.url), 'utf8')
        // Comments name `confidence` on purpose; only code counts.
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect([file, /confidence/.test(text)]).toEqual([file, false]);
    }
  });
});

describe('the consolidation section', () => {
  it('reports nothing rather than a ratio when no finding carries a derivation cost', () => {
    putNode(dir, { kind: 'finding', key: 'nocost', claim: 'no cost recorded', confidence: 0.9 });
    const out = consolidation(dir);
    expect(out.withDerivedCost).toBe(0);
    expect(out.aggregate).toBeNull();
    expect(out.best).toEqual([]);
    // ALWAYS LABELLED AN ESTIMATE, in the data and not only in a comment.
    expect(out.basis).toBe('estimate');
    expect(out.priced).toBe(false);
  });

  it('reports the per-finding ratio for a finding that does carry one', () => {
    putNode(dir, {
      kind: 'finding',
      key: 'expand:one',
      claim: 'x'.repeat(200), // 50 tokens to carry
      derivedCost: 5_000,
      confidence: 0.7,
    });
    const out = consolidation(dir);
    expect(out.withDerivedCost).toBe(1);
    expect(out.best[0].key).toBe('expand:one');
    expect(out.best[0].ratio).toBeCloseTo(100, 6);
    expect(out.aggregate.ratio).toBeCloseTo(100, 6);
  });
});

describe('the balance sheet the report serves', () => {
  it('carries layer1, layer2, calibration and consolidation beside the measured lines', () => {
    dirWhereReferencedFindingsShowEffect();
    const sheet = graphBalanceSheet(dir);
    expect(sheet.measuredCounterfactual).toBeDefined();
    expect(sheet.estimatedCausal).toBeDefined();
    expect(sheet.layer1).not.toBeNull();
    expect(sheet.layer2).not.toBeNull();
    expect(sheet.layer2.published).toBeGreaterThan(0);
    expect(sheet.calibration.publishable).toBe(true);
    expect(sheet.consolidation.basis).toBe('estimate');
  });
});

describe('the audit is the note the human reads', () => {
  it('says nothing at all while both layers are silent', () => {
    expect(calibrationNote(dir)).toBeNull();
    expect(renderAudit(dir, []).text).not.toMatch(/Layer 1 against Layer 2/);
  });

  it('prints the refusal once one side has spoken', () => {
    const anchor = 'src/only.ts';
    touches(2, { keys: ['f0', 'p0'], tag: 'l1', anchor });
    query('f0', 9_000);
    const note = calibrationNote(dir);
    expect(note).toMatch(/Layer 1 against Layer 2: not calibrated/);
    expect(note).toMatch(/Layer 2 has 0 observation/);
  });

  it('reaches a human through renderAudit, which is its production reader', () => {
    dirWhereReferencedFindingsShowEffect();
    const text = renderAudit(dir, []).text;
    expect(text).toMatch(/Layer 1 against Layer 2: calibrated/);
  });

  it('does not headline "Nothing addressable found." above a real verdict', () => {
    dirWhereReferencedFindingsShowEffect();
    const text = renderAudit(dir, []).text;
    // The queue is empty and a causal verdict is printed below it. The old
    // headline told the reader nothing was found immediately above a finding.
    expect(text).toContain('Nothing addressable found in the remediation queue.');
    expect(text).not.toContain('Nothing addressable found.');
    expect(text).toMatch(/Layer 1 against Layer 2/);
  });
});
