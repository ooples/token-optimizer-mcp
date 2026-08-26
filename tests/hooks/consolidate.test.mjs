/**
 * Compaction as consolidation, and restoration as continuation.
 *
 * The properties under test are the ones that make this different from a
 * checkpoint: selection is DERIVED rather than a category list, dead ends
 * survive on a floor because cheap-to-find is not cheap-to-find-again,
 * restoration adapts to the situation within measured bounds, and the
 * consolidation ratio reports something only session instrumentation can know.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  selectForConsolidation, irrecoverability, reuseProbability,
  consolidationRatio, aggregateConsolidation, costToRederive,
} from '../../hooks-core/consolidate.mjs';
import { classifySituation, restorationPlan } from '../../hooks-core/restore.mjs';
import { load, putNode, putEdge, nodeId } from '../../hooks-core/wiki.mjs';
import { indexFile } from '../../hooks-core/staleness.mjs';

let workspace;
let dir;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'consolidate-'));
  dir = join(workspace, 'wiki');
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

const graph = () => load(dir);

describe('irrecoverability weights how hard something is to reproduce', () => {
  test('a flaky reproduction outranks a plain analysis', () => {
    // Token cost alone understates this: reproducing an intermittent failure may
    // take three runs and an hour while consuming very few tokens.
    const flaky = { summary: 'only fails intermittently under load' };
    const analysis = { summary: 'the handler returns early' };
    expect(irrecoverability(flaky)).toBeGreaterThan(irrecoverability(analysis));
  });

  test('something that had to be RUN outranks something that was read', () => {
    expect(irrecoverability({ summary: 'benchmarked at 1.4x' }))
      .toBeGreaterThan(irrecoverability({ summary: 'imports the logger' }));
  });
});

describe('reuse probability comes from the edges we already have', () => {
  test('a well-connected anchor scores above an isolated one', () => {
    const hot = putNode(dir, { kind: 'file', key: '/hot.ts' });
    const cold = putNode(dir, { kind: 'file', key: '/cold.ts' });
    for (let i = 0; i < 10; i++) {
      const other = putNode(dir, { kind: 'file', key: `/n${i}.ts` });
      putEdge(dir, hot, 'related', other);
    }
    const g = graph();
    expect(reuseProbability(g, [hot])).toBeGreaterThan(reuseProbability(g, [cold]));
  });
});

describe('selection is derived, with a floor for dead ends', () => {
  test('an expensive conclusion outranks a cheap one', () => {
    const { kept } = selectForConsolidation(graph(), [
      { type: 'finding', summary: 'cheap aside', anchors: ['/a.ts'], tokensSpent: 200 },
      { type: 'finding', summary: 'expensive conclusion', anchors: ['/a.ts'], tokensSpent: 20_000 },
    ], { budget: 4000 });

    // Order is the assertion, not count: with room for both, both are kept, and
    // rank is what decides which survives when there is not room.
    expect(kept[0].summary).toBe('expensive conclusion');
  });

  test('and the cheap one is dropped when only one fits', () => {
    const { kept, dropped } = selectForConsolidation(graph(), [
      { type: 'finding', summary: 'cheap aside here', anchors: ['/a.ts'], tokensSpent: 200 },
      { type: 'finding', summary: 'expensive conclusion', anchors: ['/a.ts'], tokensSpent: 20_000 },
    ], { budget: 6 });

    expect(kept).toHaveLength(1);
    expect(kept[0].summary).toBe('expensive conclusion');
    expect(dropped).toBe(1);
  });

  test('a CHEAP dead end survives against expensive findings', () => {
    // The floor. Cheap to find is not the same as cheap to find again, and a
    // negative result exists nowhere else -- not in the code, not in the commit
    // log. Pure ranking would drop this.
    const { kept } = selectForConsolidation(graph(), [
      { type: 'finding', summary: 'a very expensive analysis indeed', anchors: ['/a.ts'], tokensSpent: 90_000 },
      { type: 'failure', summary: 'shared retry budget deadlocks', anchors: ['/a.ts'], tokensSpent: 100 },
    ], { budget: 12 });

    expect(kept.map((k) => k.type)).toContain('failure');
  });

  test('decisions are on the floor too', () => {
    // THE TWO SUMMARIES ARE THE SAME LENGTH, and the budget holds exactly one of
    // them. The previous fixture gave the decision a much SHORTER summary than
    // the finding, so the finding did not fit the budget at all and the decision
    // was kept by ranking -- the test passed with the floor deleted. Equal carry
    // cost is what makes this a test of the floor rather than of arithmetic: on
    // rank alone the 80,000-token finding wins every time.
    const { kept } = selectForConsolidation(graph(), [
      { type: 'finding', summary: 'an expensive analysis of the retry path', anchors: ['/a.ts'], tokensSpent: 80_000 },
      { type: 'decision', summary: 'chose per-host retry budgets, not one', anchors: ['/a.ts'], tokensSpent: 50 },
    ], { budget: 10 });

    expect(kept).toHaveLength(1);
    expect(kept.map((k) => k.type)).toContain('decision');
  });

  test('the budget is respected and the shortfall reported', () => {
    const candidates = Array.from({ length: 30 }, (_, i) => ({
      type: 'finding', summary: `conclusion number ${i} with a reasonably long claim`,
      anchors: ['/a.ts'], tokensSpent: 1000 * i,
    }));
    const out = selectForConsolidation(graph(), candidates, { budget: 40 });
    expect(out.tokens).toBeLessThanOrEqual(40);
    expect(out.dropped).toBeGreaterThan(0);
  });
});

describe('the consolidation ratio -- the metric that needs session instrumentation', () => {
  test('an expensive conclusion carried cheaply reports a large multiple', () => {
    // 12,000 tokens to reach, ~10 to carry. Nobody without the producing session
    // can compute this at all.
    const ratio = consolidationRatio({ claim: 'exp is compared to the local clock', derivedCost: 12_000 });
    expect(ratio).toBeGreaterThan(50);
  });

  test('a finding with no measured cost reports nothing rather than guessing', () => {
    expect(consolidationRatio({ claim: 'something' })).toBeNull();
  });

  test('the aggregate ignores findings without a cost', () => {
    const out = aggregateConsolidation([
      { claim: 'a'.repeat(40), derivedCost: 8000 },
      { claim: 'b'.repeat(40), derivedCost: 4000 },
      { claim: 'no cost recorded' },
    ]);
    expect(out.derived).toBe(12_000);
    expect(out.ratio).toBeGreaterThan(1);
  });
});

describe('restoration adapts to the situation', () => {
  test('an unresolved question makes it mid-problem', () => {
    expect(classifySituation({ openQuestion: 'is the skew fix correct?' })).toBe('mid-problem');
  });

  test('a long gap makes it a cold resume, even with an open question', () => {
    // Days later nothing in the fresh context connects to anything, so
    // continuation has nothing to continue from.
    expect(classifySituation({ openQuestion: 'x', idleMs: 24 * 60 * 60 * 1000 })).toBe('cold-resume');
  });

  test('several recent files with nothing outstanding is in-flow', () => {
    expect(classifySituation({ recentAnchors: ['/a.ts', '/b.ts', '/c.ts'] })).toBe('in-flow');
  });

  test('the frontier is restored first when mid-problem', () => {
    const path = join(workspace, 'auth.ts');
    writeFileSync(path, 'export function verify() { return 1; }');
    indexFile(dir, path);

    const plan = restorationPlan(dir, graph(), {
      openQuestion: 'does clock skew explain the 401s?',
      ruledOut: ['token signing', 'clock drift on the client'],
      untested: ['NTP skew on the server'],
      recentAnchors: [path],
    });

    expect(plan.situation).toBe('mid-problem');
    // Resuming a thought, not reloading a transcript.
    expect(plan.text).toContain('Where you were');
    expect(plan.text).toContain('ruled out: token signing');
    expect(plan.text).toContain('untested: NTP skew');
  });

  test('a cold resume leads with orientation instead', () => {
    const path = join(workspace, 'auth.ts');
    writeFileSync(path, 'export function verify() { return 1; }');
    indexFile(dir, path);
    const id = putNode(dir, { kind: 'finding', key: 'f1', claim: 'verify compares exp to the local clock', confidence: 0.9 });
    putEdge(dir, id, 'derived_from', nodeId('file', path));

    const plan = restorationPlan(dir, graph(), { idleMs: 24 * 60 * 60 * 1000, recentAnchors: [path] });
    expect(plan.situation).toBe('cold-resume');
    expect(plan.text).toContain('Established');
  });

  test('an empty graph restores nothing rather than an empty shell', () => {
    expect(restorationPlan(dir, graph(), {})).toBeNull();
  });

  test('the plan stays within the earned budget', () => {
    const path = join(workspace, 'auth.ts');
    writeFileSync(path, 'export function verify() { return 1; }');
    indexFile(dir, path);
    for (let i = 0; i < 40; i++) {
      const id = putNode(dir, { kind: 'finding', key: `f${i}`, claim: `finding ${i} `.repeat(12), confidence: 0.9 });
      putEdge(dir, id, 'derived_from', nodeId('file', path));
    }
    const plan = restorationPlan(dir, graph(), { openQuestion: 'x', recentAnchors: [path] });
    // A misread situation can shift the mix; it can never overspend, because the
    // ceiling is measured rather than situational.
    expect(plan.tokens).toBeLessThanOrEqual(1200);
  });
});

describe('scoring inputs are the ones the module claims to use', () => {
  test('an anchor reaches the graph, so a well-connected file outranks an isolated one', () => {
    // The defect: anchors were canonical PATHS while graph edges hold nodeId hashes, so degree
    // was zero for every candidate and the reuse term was a constant. Worse, an EMPTY anchor
    // list scores 0.5 while a resolved-but-unmatched one scores 0.25 -- so every anchored
    // candidate was penalised 2x against every unanchored aside, and budget pressure dropped
    // the anchored findings first.
    const dir = mkdtempSync(join(tmpdir(), 'consol-'));
    try {
      const hot = putNode(dir, { kind: 'file', key: '/hot.ts' });
      const cold = putNode(dir, { kind: 'file', key: '/cold.ts' });
      for (let i = 0; i < 8; i += 1) {
        const other = putNode(dir, { kind: 'file', key: `/n${i}.ts` });
        putEdge(dir, hot, 'related', other);
      }
      const graph = load(dir);

      const entry = (anchor) => ({ type: 'finding', summary: 'the same claim, differently anchored', anchors: [anchor] });
      // Budgeted so only one survives: the ranking, not the budget, decides which.
      const { kept } = selectForConsolidation(graph, [entry('/cold.ts'), entry('/hot.ts')], { budget: 12 });
      expect(kept).toHaveLength(1);
      expect(kept[0].anchors[0]).toBe('/hot.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a stack trace does not score as an irrecoverable observation', () => {
    // `race` matched "stack trace", putting an ordinary reasoned finding in the top tier.
    const traced = irrecoverability({ summary: 'the stack trace shows the handler returns early because the guard is inverted' });
    const flaky = irrecoverability({ summary: 'only fails intermittently under load' });
    expect(traced).toBeLessThan(flaky);
    expect(traced).toBe(2);
  });

  test('a profile in the non-performance sense does not score as a measurement', () => {
    expect(irrecoverability({ summary: 'the user profile page renders the wrong avatar' })).toBeLessThan(3);
  });

  test('a genuine reproduction still scores at the top', () => {
    // The word-anchoring must not disarm the detector it belongs to.
    expect(irrecoverability({ summary: 'reproduced only under a race between the two writers' })).toBe(4);
  });

  test('costToRederive depends only on the entry, not on a dead previousAt', () => {
    // `window > 0 ? 0 : 0` returned zero on both branches, so previousAt never affected
    // anything while the docstring claimed cost was measured from the transcript.
    const entry = { type: 'finding', summary: 'a claim', evidence: 'some evidence text' };
    expect(costToRederive(entry, null)).toBe(costToRederive(entry, Date.now() - 50_000));
  });

  test('an explicitly measured spend still wins over the evidence-size fallback', () => {
    expect(costToRederive({ summary: 'x', evidence: 'y', tokensSpent: 4242 })).toBe(4242);
  });

  test('scores the `claim` field, which is what every layer that stores a finding calls it', () => {
    // THE MISMATCH WAS SILENT AND TOTAL. This module was written against an
    // extractor producing `summary`; the graph node, `consolidationRatio` in this
    // same file, and the renderer all call the text `claim`. So for a
    // claim-shaped candidate `estimate(entry.summary)` was 0, `spent + 0 > budget`
    // was never true, and the budget admitted EVERYTHING while reporting a tidy
    // `tokens: 0`. A bound that cannot bind is worse than no bound.
    const candidates = Array.from({ length: 30 }, (_, i) => ({
      type: 'command', claim: `conclusion number ${i} with a reasonably long claim`,
      anchors: ['/a.ts'], tokensSpent: 1000 * i,
    }));
    const out = selectForConsolidation(graph(), candidates, { budget: 40 });
    expect(out.tokens).toBeGreaterThan(0);
    expect(out.tokens).toBeLessThanOrEqual(40);
    expect(out.kept.length).toBeLessThan(candidates.length);
  });

  test('irrecoverability reads a `claim` too, so the multiplier is not a constant', () => {
    expect(irrecoverability({ claim: 'only fails intermittently under load' }))
      .toBeGreaterThan(irrecoverability({ claim: 'the handler returns early' }));
  });

  test('the evidence-size fallback works off a `claim` when there is no evidence', () => {
    expect(costToRederive({ type: 'command', claim: 'a claim with some length to it' }))
      .toBeGreaterThan(0);
  });
});
