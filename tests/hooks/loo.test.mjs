/**
 * Layer 2 -- per-finding causal value by leave-one-out.
 *
 * FIXTURES ARE BUILT WITH THE REAL PRODUCERS, and that is not a style
 * preference. `record` writes the inject rows, `recordToolOutcome` performs the
 * real (episodeId, toolCallId) join, and `record` writes the `read` rows -- so
 * these tests exercise the same event shapes production writes. Three tasks on
 * these plans shipped code whose tests passed against fixtures that did not
 * match production, and the shapes below were checked field by field against
 * this repository's own `metrics.jsonl`:
 *
 *   inject        { schemaVersion, id, kind, episodeId, sessionId, toolCallId,
 *                   surface, anchor, holdout, tokens, deliveredTokens,
 *                   shadowTokens, count, candidateCount, findingIds,
 *                   shadowFindingIds, stale, injectionId, at }
 *   tool-outcome  { ..., toolName, success, durationMs, injectionId,
 *                   findingIds, joinMethod, at }
 *   read          { kind, anchor, sessionId, tokens, at }
 *
 * THREE CORRECTIONS TO THE BRIEF'S SNIPPET, each of which would have made a
 * test pass for the wrong reason:
 *
 *   1. Its pinned-finding test passes a SINGLE key. Layer 2 refuses to withhold
 *      the only finding on a touch (that is `inHoldout`, not a leave-one-out),
 *      so that assertion would have held with the pinned guard deleted. Every
 *      guard below is tested against a candidate set where withholding is
 *      otherwise possible, and each such test also asserts that the mechanism
 *      still fires for the unprotected key.
 *   2. Its kill-switch test has the same shape, so it too is written against a
 *      set that yields a non-null answer with the switch on.
 *   3. `graphWith` needs `origin` and `pinned` per key rather than one shared
 *      shape, or "never a human-origin finding" cannot be told apart from
 *      "never any finding".
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { record, recordToolOutcome, readEvidence } from '../../hooks-core/metrics.mjs';
import { classify, referenceRate } from '../../hooks-core/usage.mjs';
import {
  withheldFor,
  exploreOrder,
  observations,
  effects,
  looNote,
  servingPolicyVersion,
  LOO_ENABLED,
  MIN_PRIOR_INJECTIONS,
  MIN_SERVED,
  MIN_WITHHELD,
  EPSILON,
  FDR_Q,
  WITHHOLD_FRACTION,
  MAX_WITHHELD_PER_SESSION,
  SHRINKAGE_K,
} from '../../hooks-core/loo.mjs';
import { forTouch } from '../../hooks-core/inject.mjs';
import { renderAudit } from '../../hooks-core/audit.mjs';
import { load, putNode, putEdge, nodeId } from '../../hooks-core/wiki.mjs';
import { canonicalPath } from '../../hooks-core/paths.mjs';
import { indexFile } from '../../hooks-core/staleness.mjs';

let workspace;
let dir;
let clock;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'loo-'));
  dir = join(workspace, 'wiki');
  clock = 1;
  delete process.env.TOKEN_OPTIMIZER_LOO;
  // Pinned OFF so a random workspace path cannot drop a test into the
  // all-findings control arm -- the flakiness injection.test.mjs documents.
  process.env.TOKEN_OPTIMIZER_HOLDOUT = '0';
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  delete process.env.TOKEN_OPTIMIZER_LOO;
  delete process.env.TOKEN_OPTIMIZER_HOLDOUT;
});

const trialsFloor = (n) => Math.floor(n * 0.7);

/** A graph shaped the way `load()` shapes one: nodes keyed by id. */
const graphWith = (specs) => ({
  nodes: new Map(
    specs.map((spec, index) => {
      const s = typeof spec === 'string' ? { key: spec } : spec;
      return [
        `finding:${index}`,
        { kind: 'finding', key: s.key, pinned: Boolean(s.pinned), origin: s.origin || 'harvested' },
      ];
    })
  ),
});

/** One injection, written by the real recorder. */
function inject({
  keys = ['k1', 'k2'],
  session = 's',
  loo = null,
  anchor = 'a.ts',
  surface = 'file',
  holdout = false,
  policy = 'p1',
  at = null,
} = {}) {
  clock += 10;
  const toolCallId = `tc-${clock}`;
  return record(dir, {
    kind: 'inject',
    episodeId: session,
    sessionId: session,
    toolCallId,
    surface,
    anchor,
    holdout,
    tokens: 10,
    deliveredTokens: 10,
    shadowTokens: 10,
    count: keys.length,
    candidateCount: keys.length,
    findingIds: holdout ? [] : keys,
    shadowFindingIds: keys,
    stale: false,
    looPolicy: policy,
    ...(loo ? { loo } : {}),
    at: at ?? clock,
  });
}

/** The post-tool result that makes the injection attributable, via the real join. */
function outcome(event) {
  return recordToolOutcome(dir, {
    episodeId: event.episodeId,
    sessionId: event.sessionId,
    toolCallId: event.toolCallId,
    surface: event.surface,
    anchor: event.anchor,
    toolName: 'Read',
    success: true,
    at: (event.at || 0) + 1,
  });
}

const readEvent = ({ session = 's', anchor = 'a.ts', tokens, at }) =>
  record(dir, { kind: 'read', anchor, sessionId: session, tokens, at });

/**
 * `n` injections of `keys`, each in its own session with its own joined
 * outcome and a downstream read of `cost` tokens.
 *
 * ONE SESSION PER TOUCH, because `observations` splits a (session, anchor)
 * read total across the injections that share it -- exactly as `buildReport`
 * does. Separate sessions keep the fixture's arithmetic the arithmetic under
 * test rather than the split's.
 */
function touches(
  n,
  { keys, loo = null, cost = 0, tag = 't', policy = 'p1', joined = true, anchor = 'a.ts' } = {}
) {
  const made = [];
  for (let i = 0; i < n; i += 1) {
    const session = `${tag}-${i}`;
    const event = inject({ keys, session, loo, policy, anchor });
    if (joined) outcome(event);
    if (cost) readEvent({ session, anchor, tokens: cost, at: (event.at || 0) + 5 });
    made.push(event);
  }
  return made;
}

/** MIN_PRIOR_INJECTIONS ordinary injections, so `keys` are enrolled afterwards. */
const warmup = (keys) => touches(MIN_PRIOR_INJECTIONS, { keys, tag: 'warm', cost: 0 });

/** A session id whose arm for `key` is the one asked for. Deterministic, not random. */
function sessionWhere(key, wantWithheld, { keys = null, graph = null } = {}) {
  const list = keys || [key, 'other'];
  const g = graph || graphWith(list);
  for (let i = 0; i < 400; i += 1) {
    const session = `probe-${i}`;
    const chosen = withheldFor(list, session, g, dir, { surface: 'file', anchor: 'a.ts' });
    if (wantWithheld ? chosen === key : chosen === null) return session;
  }
  throw new Error(`no session found with arm ${wantWithheld ? 'withheld' : 'served'} for ${key}`);
}

describe('Layer 2 -- the withholding decision', () => {
  it('never withholds a pinned finding, and still withholds an unprotected one', () => {
    warmup(['k1', 'k2']);
    const graph = graphWith([{ key: 'k1', pinned: true }, { key: 'k2' }]);
    const chosen = new Set();
    for (let i = 0; i < 200; i += 1)
      chosen.add(withheldFor(['k1', 'k2'], `s${i}`, graph, dir, { surface: 'file', anchor: 'a.ts' }));
    expect(chosen.has('k1')).toBe(false);
    // The mechanism was live: without this the test would pass with every
    // guard in the file deleted.
    expect(chosen.has('k2')).toBe(true);
  });

  it('never withholds a human-origin finding, and still withholds a harvested one', () => {
    warmup(['k1', 'k2']);
    const graph = graphWith([{ key: 'k1', origin: 'human' }, { key: 'k2', origin: 'harvested' }]);
    const chosen = new Set();
    for (let i = 0; i < 200; i += 1)
      chosen.add(withheldFor(['k1', 'k2'], `s${i}`, graph, dir, { surface: 'file', anchor: 'a.ts' }));
    expect(chosen.has('k1')).toBe(false);
    expect(chosen.has('k2')).toBe(true);
  });

  it('refuses a key it cannot find in the graph, because it cannot check pinned or origin', () => {
    warmup(['k1', 'k2']);
    // k2 is absent from the graph: unknown provenance fails CLOSED.
    const graph = graphWith([{ key: 'k1' }]);
    const chosen = new Set();
    for (let i = 0; i < 200; i += 1)
      chosen.add(withheldFor(['k1', 'k2'], `s${i}`, graph, dir, { surface: 'file', anchor: 'a.ts' }));
    expect(chosen.has('k2')).toBe(false);
    expect(chosen.has('k1')).toBe(true);
  });

  it('withholds at most one finding per touch', () => {
    warmup(['k1', 'k2', 'k3']);
    const graph = graphWith(['k1', 'k2', 'k3']);
    let withheldSomething = 0;
    for (let i = 0; i < 200; i += 1) {
      const chosen = withheldFor(['k1', 'k2', 'k3'], `s${i}`, graph, dir, {
        surface: 'file',
        anchor: 'a.ts',
      });
      expect(typeof chosen === 'string' || chosen === null).toBe(true);
      if (chosen) {
        withheldSomething += 1;
        expect(['k1', 'k2', 'k3']).toContain(chosen);
      }
    }
    // A single string can only name one finding; what this really pins is that
    // a session with three armed candidates still yields one.
    expect(withheldSomething).toBeGreaterThan(0);
  });

  it('is stable for a session, so an arm cannot flip mid-session', () => {
    warmup(['k1', 'k2']);
    const graph = graphWith(['k1', 'k2']);
    // ACROSS MANY SESSIONS AND TWO ANCHORS. Checking one session would pass
    // even if the arm were salted with the anchor, because most sessions
    // withhold nothing and `null === null`.
    const arms = new Set();
    let withheldSomewhere = 0;
    for (let i = 0; i < 200; i += 1) {
      const session = `s${i}`;
      const a = withheldFor(['k1', 'k2'], session, graph, dir, { surface: 'file', anchor: 'a.ts' });
      const b = withheldFor(['k1', 'k2'], session, graph, dir, { surface: 'file', anchor: 'b.ts' });
      const c = withheldFor(['k1', 'k2'], session, graph, dir, { surface: 'file', anchor: 'a.ts' });
      expect([session, b]).toEqual([session, a]);
      expect([session, c]).toEqual([session, a]);
      if (a) withheldSomewhere += 1;
      arms.add(a);
    }
    // The arm genuinely varies BETWEEN sessions, or stability would be the
    // trivial kind: a constant.
    expect(arms.size).toBeGreaterThan(1);
    expect(withheldSomewhere).toBeGreaterThan(0);
  });

  it('assigns the arm without consulting the serving policy, so a config change cannot flip it', () => {
    warmup(['k1', 'k2']);
    const graph = graphWith(['k1', 'k2']);
    const before = servingPolicyVersion();
    const armsBefore = [];
    for (let i = 0; i < 40; i += 1)
      armsBefore.push(withheldFor(['k1', 'k2'], `s${i}`, graph, dir, { surface: 'file', anchor: 'a.ts' }));
    process.env.TOKEN_OPTIMIZER_TOUCH_BUDGET = '250';
    try {
      // The policy version MUST move, or this test proves nothing.
      expect(servingPolicyVersion()).not.toBe(before);
      const armsAfter = [];
      for (let i = 0; i < 40; i += 1)
        armsAfter.push(withheldFor(['k1', 'k2'], `s${i}`, graph, dir, { surface: 'file', anchor: 'a.ts' }));
      expect(armsAfter).toEqual(armsBefore);
    } finally {
      delete process.env.TOKEN_OPTIMIZER_TOUCH_BUDGET;
    }
  });

  it('does not enter a finding into the experiment before enough prior injections', () => {
    expect(MIN_PRIOR_INJECTIONS).toBeGreaterThanOrEqual(4);
    const graph = graphWith(['k1', 'k2']);
    // One short of the threshold: nothing may be withheld.
    touches(MIN_PRIOR_INJECTIONS - 1, { keys: ['k1', 'k2'], tag: 'warm' });
    const short = new Set();
    for (let i = 0; i < 200; i += 1)
      short.add(withheldFor(['k1', 'k2'], `s${i}`, graph, dir, { surface: 'file', anchor: 'a.ts' }));
    expect([...short]).toEqual([null]);
    // One more injection and the same sessions start withholding.
    touches(1, { keys: ['k1', 'k2'], tag: 'warm2' });
    const enrolled = new Set();
    for (let i = 0; i < 200; i += 1)
      enrolled.add(withheldFor(['k1', 'k2'], `s${i}`, graph, dir, { surface: 'file', anchor: 'a.ts' }));
    expect(enrolled.size).toBeGreaterThan(1);
  });

  it('never withholds the only finding on a touch, which would be the all-findings holdout', () => {
    warmup(['k1', 'k2']);
    const graph = graphWith(['k1', 'k2']);
    for (let i = 0; i < 200; i += 1)
      expect(withheldFor(['k1'], `s${i}`, graph, dir, { surface: 'file', anchor: 'a.ts' })).toBeNull();
    // Two candidates: the same sessions do withhold.
    const arms = new Set();
    for (let i = 0; i < 200; i += 1)
      arms.add(withheldFor(['k1', 'k2'], `s${i}`, graph, dir, { surface: 'file', anchor: 'a.ts' }));
    expect(arms.size).toBeGreaterThan(1);
  });

  it('never withholds inside the all-findings holdout arm', () => {
    warmup(['k1', 'k2']);
    const graph = graphWith(['k1', 'k2']);
    const session = sessionWhere('k1', true);
    expect(
      withheldFor(['k1', 'k2'], session, graph, dir, { surface: 'file', anchor: 'a.ts', holdout: true })
    ).toBeNull();
    expect(
      withheldFor(['k1', 'k2'], session, graph, dir, { surface: 'file', anchor: 'a.ts', holdout: false })
    ).toBe('k1');
  });

  it('never withholds on a command surface, where no read event can be joined', () => {
    warmup(['k1', 'k2']);
    const graph = graphWith(['k1', 'k2']);
    const session = sessionWhere('k1', true);
    expect(
      withheldFor(['k1', 'k2'], session, graph, dir, { surface: 'command', anchor: 'npm test' })
    ).toBeNull();
    expect(withheldFor(['k1', 'k2'], session, graph, dir, { surface: 'file', anchor: '' })).toBeNull();
    expect(
      withheldFor(['k1', 'k2'], session, graph, dir, { surface: 'file', anchor: 'a.ts' })
    ).toBe('k1');
  });

  it('withholds at most one finding per session', () => {
    warmup(['k1', 'k2']);
    const graph = graphWith(['k1', 'k2']);
    const session = sessionWhere('k1', true);
    expect(MAX_WITHHELD_PER_SESSION).toBe(1);
    // The session has now spent its budget.
    inject({ keys: ['k2'], session, loo: 'k1' });
    expect(
      withheldFor(['k1', 'k2'], session, graph, dir, { surface: 'file', anchor: 'b.ts' })
    ).toBeNull();
    // A different session is unaffected, so the cap is per session and not global.
    const other = sessionWhere('k1', true);
    expect(withheldFor(['k1', 'k2'], other, graph, dir, { surface: 'file', anchor: 'a.ts' })).toBe('k1');
  });

  it('refuses without a usable session id, which would pin one arm forever', () => {
    warmup(['k1', 'k2']);
    const graph = graphWith(['k1', 'k2']);
    expect(withheldFor(['k1', 'k2'], '', graph, dir, { surface: 'file', anchor: 'a.ts' })).toBeNull();
    expect(withheldFor(['k1', 'k2'], null, graph, dir, { surface: 'file', anchor: 'a.ts' })).toBeNull();
  });

  it('is disabled by the kill switch', () => {
    warmup(['k1', 'k2']);
    const graph = graphWith(['k1', 'k2']);
    const session = sessionWhere('k1', true);
    expect(withheldFor(['k1', 'k2'], session, graph, dir, { surface: 'file', anchor: 'a.ts' })).toBe('k1');
    process.env.TOKEN_OPTIMIZER_LOO = 'off';
    try {
      expect(LOO_ENABLED()).toBe(false);
      expect(
        withheldFor(['k1', 'k2'], session, graph, dir, { surface: 'file', anchor: 'a.ts' })
      ).toBeNull();
    } finally {
      delete process.env.TOKEN_OPTIMIZER_LOO;
    }
    expect(LOO_ENABLED()).toBe(true);
  });

  it('withholds roughly WITHHOLD_FRACTION of sessions, not all of them and not none', () => {
    warmup(['k1', 'k2']);
    const graph = graphWith(['k1', 'k2']);
    expect(WITHHOLD_FRACTION).toBe(0.25);
    let withheldK1 = 0;
    const trials = 600;
    for (let i = 0; i < trials; i += 1)
      if (withheldFor(['k1', 'k2'], `frac-${i}`, graph, dir, { surface: 'file', anchor: 'a.ts' }) === 'k1')
        withheldK1 += 1;
    // BOUNDS IN ABSOLUTE NUMBERS, not derived from the constant under test --
    // the first version computed them FROM `WITHHOLD_FRACTION`, so raising the
    // constant to 1 moved the goalposts with it and the assertion could not
    // fail. Expected rate: k1 is armed a quarter of the time and loses the
    // tiebreak to an armed k2 about half of that quarter, so
    // 0.25 * (1 - 0.25/2) = 0.219, with a standard error near 1.7% at n=600.
    expect(withheldK1 / trials).toBeGreaterThan(0.12);
    expect(withheldK1 / trials).toBeLessThan(0.32);
  });
});

describe('Layer 2 -- exploration', () => {
  const items = (keys) => keys.map((key) => ({ finding: { key } }));

  it('promotes the least-served candidate on about EPSILON of touches', () => {
    // k1 well served, k2 never: exploration must promote k2.
    touches(6, { keys: ['k1'], tag: 'warm' });
    let explored = 0;
    const trials = 600;
    for (let i = 0; i < trials; i += 1) {
      const out = exploreOrder(items(['k1', 'k2']), dir, { sessionId: 's', anchor: `a${i}.ts` });
      if (out[0].finding.key === 'k2') explored += 1;
      else expect(out.map((o) => o.finding.key)).toEqual(['k1', 'k2']);
    }
    expect(explored / trials).toBeGreaterThan(EPSILON / 3);
    expect(explored / trials).toBeLessThan(EPSILON * 2);
  });

  it('leaves the utility order alone when it is not exploring', () => {
    touches(6, { keys: ['k1'], tag: 'warm' });
    const anchors = [];
    for (let i = 0; i < 600; i += 1) anchors.push(`a${i}.ts`);
    const unchanged = anchors.filter(
      (anchor) =>
        exploreOrder(items(['k1', 'k2']), dir, { sessionId: 's', anchor })[0].finding.key === 'k1'
    );
    expect(unchanged.length).toBeGreaterThan(trialsFloor(anchors.length));
  });

  it('explores nothing when the kill switch is off or there is one candidate', () => {
    touches(6, { keys: ['k1'], tag: 'warm' });
    process.env.TOKEN_OPTIMIZER_LOO = 'off';
    try {
      let moved = 0;
      for (let i = 0; i < 300; i += 1)
        if (exploreOrder(items(['k1', 'k2']), dir, { sessionId: 's', anchor: `a${i}.ts` })[0].finding.key === 'k2')
          moved += 1;
      expect(moved).toBe(0);
    } finally {
      delete process.env.TOKEN_OPTIMIZER_LOO;
    }
    expect(exploreOrder(items(['k1']), dir, { sessionId: 's', anchor: 'a.ts' })).toHaveLength(1);
  });
});

describe('Layer 2 -- observations', () => {
  it('gates every observation on the existing tool-outcome join', () => {
    warmup(['k1', 'k2']);
    touches(2, { keys: ['k1', 'k2'], tag: 'joined', cost: 100 });
    touches(3, { keys: ['k1', 'k2'], tag: 'orphan', cost: 100, joined: false });
    const obs = observations(dir);
    expect(obs.rows.filter((row) => row.findingKey === 'k1')).toHaveLength(2);
    // Unattributable rows are reported, never folded into an arm.
    expect(obs.unattributable).toBe(6);
  });

  it('excludes a command injection, a holdout injection and a fixture anchor', () => {
    warmup(['k1', 'k2']);
    outcome(inject({ keys: ['k1', 'k2'], session: 'c', surface: 'command', anchor: 'npm test' }));
    outcome(inject({ keys: ['k1', 'k2'], session: 'h', holdout: true }));
    outcome(inject({ keys: ['k1', 'k2'], session: 'f', anchor: join(tmpdir(), 'holdout-x', 'a.ts') }));
    const obs = observations(dir);
    expect(obs.excluded.command).toBe(1);
    expect(obs.excluded.holdout).toBe(1);
    expect(obs.excluded.fixture).toBe(1);
    expect(obs.rows).toHaveLength(0);
  });

  it('counts only reads that happened after the injection', () => {
    warmup(['k1', 'k2']);
    const event = inject({ keys: ['k1', 'k2'], session: 'after' });
    outcome(event);
    readEvent({ session: 'after', tokens: 900, at: (event.at || 0) - 5 });
    expect(observations(dir).rows.every((row) => row.cost === 0)).toBe(true);
    readEvent({ session: 'after', tokens: 700, at: (event.at || 0) + 5 });
    expect(observations(dir).rows.every((row) => row.cost === 700)).toBe(true);
  });

  it('splits one anchor read total across the injections that share it', () => {
    warmup(['k1', 'k2']);
    const a = inject({ keys: ['k1', 'k2'], session: 'share' });
    outcome(a);
    const b = inject({ keys: ['k1', 'k2'], session: 'share' });
    outcome(b);
    readEvent({ session: 'share', tokens: 400, at: (b.at || 0) + 5 });
    // 400 tokens, two touches of one anchor: 200 each, not 400 each.
    expect(observations(dir).rows.map((row) => row.cost)).toEqual([200, 200, 200, 200]);
  });

  it('does not observe a finding before it is enrolled', () => {
    touches(2, { keys: ['k1'], tag: 'early', cost: 50 });
    expect(observations(dir).rows).toHaveLength(0);
    touches(MIN_PRIOR_INJECTIONS, { keys: ['k1'], tag: 'more', cost: 50 });
    expect(observations(dir).rows.length).toBeGreaterThan(0);
  });
});

describe('Layer 2 -- effects', () => {
  /** 6 served / 3 withheld for k1, with the withheld arm reading far more. */
  function publishable({ servedCost = 100, withheldCost = 5000 } = {}) {
    warmup(['k1', 'k2']);
    touches(MIN_SERVED, { keys: ['k1', 'k2'], tag: 'srv', cost: servedCost });
    touches(MIN_WITHHELD, { keys: ['k2'], loo: 'k1', tag: 'wth', cost: withheldCost });
  }

  it('publishes no verdict below the observation floor', () => {
    warmup(['k1', 'k2']);
    touches(MIN_SERVED - 1, { keys: ['k1', 'k2'], tag: 'srv', cost: 100 });
    touches(MIN_WITHHELD - 1, { keys: ['k2'], loo: 'k1', tag: 'wth', cost: 5000 });
    const rows = effects(dir);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.published === false)).toBe(true);
    expect(rows.every((row) => row.p === null)).toBe(true);
    // And a below-floor row is not a zero: the estimate exists, unpublished.
    const k1 = rows.find((row) => row.findingKey === 'k1');
    expect(k1.raw).toBeGreaterThan(0);
  });

  it('publishes a verdict once the floor and the FDR are both cleared', () => {
    publishable();
    const k1 = effects(dir).find((row) => row.findingKey === 'k1');
    expect(k1.served).toBe(MIN_SERVED);
    expect(k1.withheld).toBe(MIN_WITHHELD);
    expect(k1.p).toBeLessThan(0.1);
    expect(k1.published).toBe(true);
    expect(k1.raw).toBeCloseTo(4900, 6);
  });

  it('cannot publish when no read cost was ever observed, by the arithmetic itself', () => {
    // Same design, same counts, but the read channel never fired. There is no
    // separate guard for this and there must not be one: with every cost zero
    // the permutation statistic is zero for every relabelling, so p is exactly
    // 1 and no FDR threshold can pass it. Pinning p here is what makes that
    // claim checkable rather than a comment.
    publishable({ servedCost: 0, withheldCost: 0 });
    const rows = effects(dir);
    const k1 = rows.find((row) => row.findingKey === 'k1');
    expect(k1.served).toBe(MIN_SERVED);
    expect(k1.withheld).toBe(MIN_WITHHELD);
    expect(k1.raw).toBe(0);
    expect(k1.p).toBe(1);
    expect(rows.every((row) => row.published === false)).toBe(true);
    expect(observations(dir).costObservations).toBe(0);
  });

  it('shrinks a low-observation effect toward the population mean', () => {
    // A well-observed small effect and a barely-observed large one.
    warmup(['k1', 'k2']);
    touches(12, { keys: ['k1'], tag: 'asrv', cost: 100 });
    touches(6, { keys: ['k2'], loo: 'k1', tag: 'awth', cost: 200 });
    warmup(['k3', 'k4']);
    touches(MIN_SERVED, { keys: ['k3'], tag: 'bsrv', cost: 100 });
    touches(MIN_WITHHELD, { keys: ['k4'], loo: 'k3', tag: 'bwth', cost: 5000 });

    const rows = effects(dir);
    const low = rows.find((row) => row.served + row.withheld < 10 && row.raw !== null);
    expect(low.findingKey).toBe('k3');
    expect(Math.abs(low.shrunk)).toBeLessThan(Math.abs(low.raw));
    // The general property, which holds whatever the population mean is.
    const prior =
      rows.filter((r) => r.raw !== null).reduce((sum, r) => sum + r.raw, 0) /
      rows.filter((r) => r.raw !== null).length;
    expect(Math.abs(low.shrunk - prior)).toBeLessThan(Math.abs(low.raw - prior));
  });

  it('estimates the shrinkage weight from the data rather than always using the fallback', () => {
    // Costs VARY inside each arm, so the within-finding variance is non-zero
    // and the empirical weight is estimable.
    warmup(['k1', 'k2']);
    for (let i = 0; i < 8; i += 1)
      touches(1, { keys: ['k1'], tag: `v${i}`, cost: 100 + i * 40 });
    for (let i = 0; i < 4; i += 1)
      touches(1, { keys: ['k2'], loo: 'k1', tag: `w${i}`, cost: 900 + i * 60 });
    warmup(['k3', 'k4']);
    for (let i = 0; i < 8; i += 1)
      touches(1, { keys: ['k3'], tag: `x${i}`, cost: 3000 + i * 50 });
    for (let i = 0; i < 4; i += 1)
      touches(1, { keys: ['k4'], loo: 'k3', tag: `y${i}`, cost: 100 + i * 30 });

    const rows = effects(dir).filter((row) => row.raw !== null);
    expect(rows).toHaveLength(2);
    const prior = rows.reduce((sum, row) => sum + row.raw, 0) / rows.length;
    for (const row of rows) {
      const n = row.served + row.withheld;
      const fallback = (n * row.raw + SHRINKAGE_K * prior) / (n + SHRINKAGE_K);
      // Between-finding spread here is large relative to the within-arm noise,
      // so the estimated weight is far below the fallback and the shrunk value
      // stays much closer to the finding's own data.
      expect(Math.abs(row.shrunk - row.raw)).toBeLessThan(Math.abs(fallback - row.raw));
    }
  });

  it('never pools observations across serving-policy versions', () => {
    warmup(['k1', 'k2']);
    touches(MIN_SERVED, { keys: ['k1', 'k2'], tag: 'p1s', cost: 100, policy: 'p1' });
    touches(MIN_WITHHELD, { keys: ['k2'], loo: 'k1', tag: 'p1w', cost: 5000, policy: 'p1' });
    touches(MIN_SERVED, { keys: ['k1', 'k2'], tag: 'p2s', cost: 100, policy: 'p2' });
    const rows = effects(dir).filter((row) => row.findingKey === 'k1');
    expect(rows.map((row) => row.policy).sort()).toEqual(['p1', 'p2']);
    expect(rows.find((row) => row.policy === 'p1').withheld).toBe(MIN_WITHHELD);
    expect(rows.find((row) => row.policy === 'p2').withheld).toBe(0);
  });

  /** `n` findings whose two arms read identically: a true null, p = 1. */
  function nulls(n) {
    for (let i = 0; i < n; i += 1) {
      const keys = [`n${i}`, `m${i}`];
      touches(MIN_PRIOR_INJECTIONS, { keys, tag: `nw${i}` });
      touches(MIN_SERVED, { keys, tag: `ns${i}`, cost: 100 });
      touches(MIN_WITHHELD, { keys: [`m${i}`], loo: `n${i}`, tag: `nx${i}`, cost: 100 });
    }
  }

  it('publishes the one real effect among a handful of null findings', () => {
    publishable();
    nulls(5);
    const rows = effects(dir);
    expect(rows.filter((row) => row.published).map((row) => row.findingKey)).toEqual(['k1']);
    // The null findings have an estimate and no verdict, which is the point.
    expect(rows.find((row) => row.findingKey === 'n0').raw).toBe(0);
    expect(rows.find((row) => row.findingKey === 'n0').published).toBe(false);
    expect(rows.find((row) => row.findingKey === 'n0').p).toBeCloseTo(1, 6);
  });

  it('withholds the verdict when the same p-value is tested against enough findings', () => {
    // THE MULTIPLICITY CORRECTION, shown binding rather than asserted. The
    // strongest effect 6 served and 3 withheld observations can produce has an
    // exact permutation p of 1/84 = 0.0119, which clears q = 0.10 alone and
    // clears q/m for six candidates -- and does NOT clear it for thirteen.
    // Without Benjamini-Hochberg this row would publish either way.
    publishable();
    nulls(12);
    const rows = effects(dir);
    const k1 = rows.find((row) => row.findingKey === 'k1');
    expect(k1.p).toBeLessThan(FDR_Q);
    expect(k1.published).toBe(false);
    expect(rows.filter((row) => row.published)).toEqual([]);
  });
});

describe('Layer 2 is independent of Layer 1', () => {
  it('ignores the explicit-reference channel Layer 1 is built on', () => {
    warmup(['k1', 'k2']);
    touches(MIN_SERVED, { keys: ['k1', 'k2'], tag: 'srv', cost: 100 });
    touches(MIN_WITHHELD, { keys: ['k2'], loo: 'k1', tag: 'wth', cost: 5000 });
    const before = effects(dir);

    // Queries naming the finding: the ONLY thing Layer 1 counts.
    for (let i = 0; i < 20; i += 1)
      record(dir, { kind: 'query', operation: 'get', key: 'k1', sessionId: `srv-${i}`, at: 900_000 + i });

    // Layer 1 moves...
    expect(classify(dir).some((row) => row.label === 'referenced')).toBe(true);
    expect(referenceRate(dir).referenced).toBeGreaterThan(0);
    // ...and Layer 2 does not, at all.
    expect(effects(dir)).toEqual(before);
  });

  it('moves on read cost, which Layer 1 ignores', () => {
    warmup(['k1', 'k2']);
    touches(MIN_SERVED, { keys: ['k1', 'k2'], tag: 'srv', cost: 100 });
    const withheldTouches = touches(MIN_WITHHELD, { keys: ['k2'], loo: 'k1', tag: 'wth', cost: 100 });
    const flatRate = referenceRate(dir);
    const flat = effects(dir).find((row) => row.findingKey === 'k1');
    expect(flat.raw).toBe(0);

    // A big read in the withheld arm only.
    for (const event of withheldTouches)
      readEvent({ session: event.sessionId, tokens: 4000, at: (event.at || 0) + 9 });

    const moved = effects(dir).find((row) => row.findingKey === 'k1');
    expect(moved.raw).toBeGreaterThan(0);
    // Layer 1's arithmetic is untouched by the read channel.
    expect(referenceRate(dir)).toEqual(flatRate);
  });
});

describe('Layer 2 -- what the audit prints', () => {
  it('says nothing at all when the experiment has collected nothing', () => {
    expect(looNote(dir)).toBeNull();
    warmup(['k1', 'k2']);
    expect(looNote(dir)).toBeNull();
  });

  it('refuses with counts, rather than a number, below the floor', () => {
    warmup(['k1', 'k2']);
    touches(2, { keys: ['k1', 'k2'], tag: 'srv', cost: 100 });
    touches(1, { keys: ['k2'], loo: 'k1', tag: 'wth', cost: 5000 });
    const note = looNote(dir);
    expect(note).toContain('NOT MEASURABLE YET');
    expect(note).toContain('not the same as an effect of zero');
    expect(note).not.toMatch(/saves ~/);
    // Read cost WAS observed here, so the absent-channel clause must not appear.
    expect(note).not.toContain('no read cost has been observed');
  });

  it('says the read channel never fired, rather than implying no effect', () => {
    warmup(['k1', 'k2']);
    touches(2, { keys: ['k1', 'k2'], tag: 'srv', cost: 0 });
    touches(1, { keys: ['k2'], loo: 'k1', tag: 'wth', cost: 0 });
    const note = looNote(dir);
    expect(note).toContain('no read cost has been observed in either arm');
    expect(note).toContain('NOT MEASURABLE YET');
  });

  it('quotes the shrunk effect once a verdict is published', () => {
    warmup(['k1', 'k2']);
    touches(MIN_SERVED, { keys: ['k1', 'k2'], tag: 'srv', cost: 100 });
    touches(MIN_WITHHELD, { keys: ['k2'], loo: 'k1', tag: 'wth', cost: 5000 });
    const note = looNote(dir);
    // NAMES THE FINDING AND THE SIZE, not just a count of verdicts: a reader
    // who cannot see which finding earned its place cannot act on the number.
    expect(note).toContain('k1 saves ~');
    expect(note).toMatch(/saves ~\d+ tokens\/touch/);
    expect(note).toContain('6 served, 3 withheld');
    expect(note).toContain('p=');
    expect(note).not.toContain('NOT MEASURABLE');
  });

  it('discloses unattributable observations and exempt findings', () => {
    warmup(['k1', 'k2']);
    touches(2, { keys: ['k1', 'k2'], tag: 'orphan', cost: 100, joined: false });
    touches(1, { keys: ['k2'], loo: 'k1', tag: 'wth', cost: 10 });
    const note = looNote(dir, { graph: graphWith([{ key: 'k9', pinned: true }, { key: 'k1' }]) });
    expect(note).toContain('unattributable');
    expect(note).toContain('exempt from withholding');
  });

  it('reaches a human through renderAudit', () => {
    warmup(['k1', 'k2']);
    touches(MIN_SERVED, { keys: ['k1', 'k2'], tag: 'srv', cost: 100 });
    touches(MIN_WITHHELD, { keys: ['k2'], loo: 'k1', tag: 'wth', cost: 5000 });
    expect(renderAudit(dir, []).text).toContain('leave-one-out');
  });
});

describe('Layer 2 inside the injection path', () => {
  const write = (name, text) => {
    const path = join(workspace, name);
    writeFileSync(path, text);
    return path;
  };

  function seed(path, key, claim, confidence = 0.9) {
    const id = putNode(dir, { kind: 'finding', key, claim, confidence, type: 'finding' });
    putEdge(dir, id, 'derived_from', nodeId('file', path));
    return id;
  }

  function twoFindings() {
    const path = write('auth.ts', 'export function verify() {}');
    indexFile(dir, path);
    seed(path, 'k1', 'expired tokens are rejected in verify');
    seed(path, 'k2', 'the refresh path shares one retry budget');
    // Enrol both.
    touches(MIN_PRIOR_INJECTIONS, { keys: ['k1', 'k2'], tag: 'warm', anchor: path });
    return path;
  }

  it('withholds one finding, delivers the rest, and records which', () => {
    const path = twoFindings();
    const graph = load(dir);
    const session = sessionWhere('k1', true, { keys: ['k1', 'k2'], graph });
    const out = forTouch(dir, graph, path, { sessionId: session });
    expect(out).toContain('refresh path');
    expect(out).not.toContain('expired tokens');

    const injects = injectsIn(session);
    expect(injects).toHaveLength(1);
    expect(injects[0].loo).toBe('k1');
    expect(injects[0].findingIds).toEqual(['k2']);
    expect(injects[0].count).toBe(1);
    expect(injects[0].looPolicy).toBe(servingPolicyVersion());
    // RE-PRICED: the recorded cost is the delivered text, not the kept set.
    expect(injects[0].tokens).toBeLessThan(injects[0].shadowTokens);
    expect(injects[0].shadowFindingIds.sort()).toEqual(['k1', 'k2']);
  });

  it('delivers everything when the kill switch is off', () => {
    const path = twoFindings();
    const graph = load(dir);
    const session = sessionWhere('k1', true, { keys: ['k1', 'k2'], graph });
    process.env.TOKEN_OPTIMIZER_LOO = 'off';
    try {
      const out = forTouch(dir, graph, path, { sessionId: session });
      expect(out).toContain('refresh path');
      expect(out).toContain('expired tokens');
      const injects = injectsIn(session);
      expect(injects[0].loo).toBeUndefined();
      expect(injects[0].looPolicy).toBeUndefined();
      expect(injects[0].tokens).toBe(injects[0].shadowTokens);
    } finally {
      delete process.env.TOKEN_OPTIMIZER_LOO;
    }
  });

  it('records no leave-one-out arm inside the all-findings holdout', () => {
    const path = twoFindings();
    const graph = load(dir);
    const session = sessionWhere('k1', true, { keys: ['k1', 'k2'], graph });
    process.env.TOKEN_OPTIMIZER_HOLDOUT = '1';
    try {
      expect(forTouch(dir, graph, path, { sessionId: session })).toBeNull();
      const injects = injectsIn(session);
      expect(injects[0].holdout).toBe(true);
      expect(injects[0].loo).toBeUndefined();
      expect(injects[0].findingIds).toEqual([]);
    } finally {
      process.env.TOKEN_OPTIMIZER_HOLDOUT = '0';
    }
  });

  it('lets exploration change what a tight budget actually serves', () => {
    // THE WIRING TEST FOR EXPLORATION. Three findings, a budget that fits one,
    // and a utility order that would always keep the same one: without
    // `exploreOrder` in `forTouch`, the least-served finding could never be
    // served at all, and its score could never improve.
    const path = write('explore.ts', 'export const a = 1;');
    indexFile(dir, path);
    seed(path, 'top', 'the top ranked claim about explore', 0.95);
    seed(path, 'mid', 'the middle ranked claim about explore', 0.9);
    seed(path, 'rare', 'the never served claim about explore', 0.85);
    // `top` is well served; `rare` has never been served at all.
    touches(6, { keys: ['top', 'mid'], tag: 'expwarm', anchor: path });
    const graph = load(dir);
    const budget = 20;

    const exploring = sessionWhereExploring(path, true);
    const notExploring = sessionWhereExploring(path, false);
    const explored = forTouch(dir, graph, path, { sessionId: exploring, budget });
    const ordinary = forTouch(dir, graph, path, {
      sessionId: notExploring,
      budget,
      alreadyInjected: new Set(),
    });
    expect(ordinary).toContain('top ranked');
    expect(explored).toContain('never served');
    expect(explored).not.toContain('top ranked');
  });

  /**
   * A session id for which `exploreOrder` does (or does not) fire on `anchor`.
   *
   * CANONICALISED, because `forTouch` hashes `canonicalPath(rawPath)` and
   * `join()` produces backslashes on Windows -- probing with the raw spelling
   * finds sessions for a different bucket entirely, which is this repository's
   * oldest defect shape and cost this test one red run.
   */
  function sessionWhereExploring(rawAnchor, want) {
    const anchor = canonicalPath(rawAnchor);
    const probe = [{ finding: { key: 'top' } }, { finding: { key: 'rare' } }];
    for (let i = 0; i < 400; i += 1) {
      const sessionId = `exp-${i}`;
      const fired =
        exploreOrder(probe, dir, { sessionId, anchor })[0].finding.key === 'rare';
      if (fired === want) return sessionId;
    }
    throw new Error('no session found with the requested exploration state');
  }

  it('serves both findings in a session whose arm is served', () => {
    const path = twoFindings();
    const graph = load(dir);
    const session = sessionWhere('k1', false, { keys: ['k1', 'k2'], graph });
    const out = forTouch(dir, graph, path, { sessionId: session });
    expect(out).toContain('expired tokens');
    expect(out).toContain('refresh path');
    const injects = injectsIn(session);
    expect(injects[0].loo).toBeUndefined();
    expect(injects[0].findingIds.sort()).toEqual(['k1', 'k2']);
  });

  /** The inject rows this session wrote, read back through the real reader. */
  function injectsIn(session) {
    return readEvidence(dir).filter(
      (event) => event.kind === 'inject' && event.sessionId === session
    );
  }
});
