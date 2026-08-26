/**
 * The recall probe -- is the no-embeddings stance falsifiable yet?
 *
 * THE ONE THING THIS FILE EXISTS TO PREVENT is a probe that cannot fail.
 * `docs/WIKI_GRAPH.md` says embeddings get added "if measurement shows real
 * recall loss", and a measurement whose only possible answer is 1.0 turns that
 * into a claim nothing can contradict -- worse than no measurement, because a
 * permanent 1.0 published as a recall rate reads as "retrieval is perfect".
 *
 * So the plan's own first test -- `expect(recallProbe(dir).rate).toBe(1)` -- is
 * NOT here as written. It asserted the tautology: `findingsFor(graph, A)` walks
 * `derived_from` edges backwards into A, and the edge F -> A is what makes A an
 * anchor of F, so F comes back by CONSTRUCTION for every graph, forever. That
 * check is kept, and it is asserted below on `integrity`, whose own `what`
 * string says it is not a recall rate. `rate` is asserted to be capable of 0,
 * 0.5 and 1 over the SAME by-construction-perfect graphs, which is the whole
 * difference between a measurement and a slogan.
 *
 * FIXTURES ARE BUILT WITH THE REAL PRODUCERS -- `putNode`, `putEdge`,
 * `putNodeWithEdges` -- and read back through the real `load`, so nothing here
 * hand-writes a graph shape production does not write. The anchor keys use NATO
 * words and the opaque claims use Jabberwocky nonsense for one measured reason:
 * the first draft of the miss fixture used `module0.ts` against a claim
 * `zqxwv0 ...` and scored a HIT, because `tokenize` splits `zqxwv0` into
 * `zqxwv` + `0` and `module0` into `module` + `0`, so the digit matched. A
 * fixture that accidentally overlaps proves the probe cannot miss when in fact
 * it can.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  putNode,
  putEdge,
  putNodeWithEdges,
  load,
  findingsFor,
} from '../../hooks-core/wiki.mjs';
import { recallProbe, MIN_PROBED, MAX_FINDINGS } from '../../hooks-core/recall.mjs';
import { graphBalanceSheet } from '../../hooks-core/crosslayer.mjs';

let workspace;
let dir;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'recall-'));
  dir = join(workspace, 'wiki');
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const WORDS = [
  'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel',
  'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa',
  'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey', 'xray',
  'yankee', 'zulu', 'apple', 'banana', 'cherry', 'grape', 'melon', 'peach',
];

/** Nonsense with no token in common with any anchor path this file builds. */
const OPAQUE = [
  'zqxwv', 'qzjhb', 'plurgh', 'snicker', 'frumious', 'bandersnatch', 'mimsy',
  'borogove', 'slithy', 'toves', 'gimble', 'wabe', 'jubjub', 'tulgey', 'uffish',
  'galumph', 'beamish', 'frabjous', 'callooh', 'callay', 'chortle', 'brillig',
  'outgrabe', 'momerath', 'vorpalled', 'snickersnack', 'manxome', 'whiffling',
  'burbled', 'gyre', 'raths', 'wabbling',
];

/**
 * `count` findings, each anchored to its own file. The first `naming` of them
 * mention their own file in the claim, so BM25 from the anchor's key can find
 * them; the rest are opaque, so nothing but the deleted edge ever could.
 */
function corpusOf(target, count, naming) {
  for (let i = 0; i < count; i += 1) {
    const word = WORDS[i % WORDS.length];
    const file = putNode(target, {
      kind: 'file',
      key: `C:/repo/src/${word}.ts`,
      hash: `hash-${word}`,
    });
    putNodeWithEdges(
      target,
      {
        kind: 'finding',
        key: `${OPAQUE[i % OPAQUE.length]}-${i}`,
        claim:
          i < naming
            ? `${word}.ts rejects an empty payload`
            : `${OPAQUE[i % OPAQUE.length]} ${OPAQUE[(i + 3) % OPAQUE.length]}`,
        confidence: 0.7,
        origin: 'harvested',
      },
      [{ edge: 'derived_from', to: file }]
    );
  }
}

/**
 * `count` findings with opaque claims, each anchored BOTH to a file and to a
 * symbol that file contains -- so deleting either edge leaves the other, and
 * traversal alone recovers it.
 */
function doubleAnchored(target, count) {
  for (let i = 0; i < count; i += 1) {
    const word = WORDS[i % WORDS.length];
    const file = putNode(target, {
      kind: 'file',
      key: `C:/repo/src/${word}.ts`,
      hash: `hash-${word}`,
    });
    const symbol = putNode(target, {
      kind: 'symbol',
      key: `C:/repo/src/${word}.ts#Thing${i}`,
    });
    putEdge(target, file, 'contains', symbol);
    putNodeWithEdges(
      target,
      {
        kind: 'finding',
        key: `${OPAQUE[i % OPAQUE.length]}-d${i}`,
        claim: `${OPAQUE[i % OPAQUE.length]} ${OPAQUE[(i + 5) % OPAQUE.length]}`,
        confidence: 0.7,
      },
      [
        { edge: 'derived_from', to: file },
        { edge: 'derived_from', to: symbol },
      ]
    );
  }
}

// A corpus big enough to clear BOTH publication gates: more than MIN_PROBED
// findings, and more than the retrieval limit the probe is run at.
const LIMIT = 5;
const BIG = 26;

describe('the probe is a measurement, not a tautology', () => {
  it('can report a rate of ZERO on a graph whose by-construction check is perfect', () => {
    // THE CENTRAL TEST. Every finding here is anchored, so the plan's original
    // assertion (`rate === 1`) would hold on this graph -- and retrieval
    // recovers NOTHING once the anchor edge it was told to follow is gone.
    corpusOf(dir, BIG, 0);
    const result = recallProbe(dir, { limit: LIMIT });

    expect(result.rate).toBe(0);
    expect(result.retrieved).toBe(0);
    expect(result.probed).toBe(BIG);
    expect(result.misses).toHaveLength(BIG);

    // The tautology, on the same graph, at the same moment.
    expect(result.integrity.rate).toBe(1);
    expect(result.integrity.ok).toBe(true);
  });

  it('can report a rate between zero and one, so the number carries information', () => {
    corpusOf(dir, BIG, BIG / 2);
    const result = recallProbe(dir, { limit: LIMIT });

    expect(result.rate).toBe(0.5);
    expect(result.retrieved).toBe(BIG / 2);
    expect(result.integrity.rate).toBe(1);
  });

  it('reports one when retrieval really does recover every finding', () => {
    corpusOf(dir, BIG, BIG);
    const result = recallProbe(dir, { limit: LIMIT });

    expect(result.rate).toBe(1);
    expect(result.byArm.lexical).toBe(BIG);
    expect(result.byArm.traversal).toBe(0);
  });

  it('never publishes the by-construction check as the recall rate', () => {
    corpusOf(dir, BIG, 0);
    const result = recallProbe(dir, { limit: LIMIT });

    // A rate of 0 beside an integrity of 1 is the whole point: they are
    // different questions and this asserts they cannot be confused.
    expect(result.rate).not.toBe(result.integrity.rate);
    expect(result.integrity.what).toMatch(/NOT a recall rate/);
  });

  it('proves the tautology directly: findingsFor always returns a finding from its own anchor', () => {
    // Not an assertion about this module -- an assertion about the primitive the
    // plan's Step 3 would have measured. If this ever fails, the reasoning above
    // is wrong and the integrity check has become a real test.
    corpusOf(dir, 8, 0);
    const graph = load(dir);
    const findings = [...graph.nodes.values()].filter((n) => n.kind === 'finding');
    expect(findings).toHaveLength(8);
    for (const finding of findings) {
      const anchors = graph.edges
        .filter((e) => e.edge === 'derived_from' && e.from === finding.id)
        .map((e) => e.to);
      expect(anchors.length).toBeGreaterThan(0);
      for (const anchor of anchors) {
        expect(findingsFor(graph, anchor).map((f) => f.id)).toContain(finding.id);
      }
    }
  });
});

describe('the two arms are independent and each can carry a hit alone', () => {
  it('recovers by TRAVERSAL when a second anchor survives the deletion', () => {
    doubleAnchored(dir, BIG);
    const result = recallProbe(dir, { limit: LIMIT });

    expect(result.rate).toBe(1);
    expect(result.byArm.traversal).toBe(BIG * 2);
    expect(result.byArm.lexical).toBe(0);
  });

  it('recovers by LEXICAL rank when no structural route survives', () => {
    corpusOf(dir, BIG, BIG);
    const result = recallProbe(dir, { limit: LIMIT });

    expect(result.byArm.traversal).toBe(0);
    expect(result.byArm.lexical).toBeGreaterThan(0);
  });

  it('finds a sibling-symbol finding through the shared parent file', () => {
    // The neighbourhood is [anchor, ...contains-parents]; children need no call
    // because findingsFor expands them itself. This pins the parent hop.
    corpusOf(dir, BIG, 0);
    const file = putNode(dir, { kind: 'file', key: 'C:/repo/src/shared.ts', hash: 'h' });
    const one = putNode(dir, { kind: 'symbol', key: 'C:/repo/src/shared.ts#One' });
    const two = putNode(dir, { kind: 'symbol', key: 'C:/repo/src/shared.ts#Two' });
    putEdge(dir, file, 'contains', one);
    putEdge(dir, file, 'contains', two);
    putNodeWithEdges(
      dir,
      { kind: 'finding', key: 'sibling-claim', claim: 'zqxwv qzjhb plurgh', confidence: 0.9 },
      [
        { edge: 'derived_from', to: one },
        { edge: 'derived_from', to: two },
      ]
    );

    const result = recallProbe(dir, { limit: LIMIT });
    expect(result.misses.map((m) => m.key)).not.toContain('sibling-claim');
    expect(result.byArm.traversal).toBe(2);
  });
});

describe('misses are named, with a reason', () => {
  it('reports a finding reachable by neither traversal nor lexical rank as a miss', () => {
    corpusOf(dir, BIG, BIG);
    const lonely = putNode(dir, { kind: 'file', key: 'C:/repo/src/lonely.ts', hash: 'h' });
    putNodeWithEdges(
      dir,
      { kind: 'finding', key: 'orphan', claim: 'zqxwv unrelated bandersnatch', confidence: 0.8 },
      [{ edge: 'derived_from', to: lonely }]
    );

    const result = recallProbe(dir, { limit: LIMIT });
    expect(result.misses.map((m) => m.key)).toContain('orphan');
  });

  it('reports an UNANCHORED finding as a miss and as an integrity failure', () => {
    corpusOf(dir, BIG, BIG);
    putNodeWithEdges(dir, {
      kind: 'finding',
      key: 'unanchored',
      claim: 'zqxwv unrelated bandersnatch',
      confidence: 0.8,
    });

    const result = recallProbe(dir, { limit: LIMIT });
    expect(result.misses.map((m) => m.key)).toContain('unanchored');
    expect(result.misses.find((m) => m.key === 'unanchored').reason).toMatch(/no anchor/);
    // And the integrity check stops being 1.0, because an active finding with
    // no anchor is the record `writeHarvested` refuses to create.
    expect(result.integrity.ok).toBe(false);
    expect(result.integrity.rate).toBeLessThan(1);
  });

  it('excludes retired findings from both the probe and the corpus', () => {
    corpusOf(dir, BIG, BIG);
    const file = putNode(dir, { kind: 'file', key: 'C:/repo/src/gone.ts', hash: 'h' });
    putNodeWithEdges(
      dir,
      { kind: 'finding', key: 'withdrawn', claim: 'zqxwv gone', retired: true },
      [{ edge: 'derived_from', to: file }]
    );

    const result = recallProbe(dir, { limit: LIMIT });
    expect(result.probed).toBe(BIG);
    expect(result.corpus).toBe(BIG);
    expect(result.misses.map((m) => m.key)).not.toContain('withdrawn');
  });

  it('counts a finding lost from ANY of its anchors as a miss, and names that anchor', () => {
    // Strict aggregation. This finding is recoverable from the symbol (its file
    // sibling survives) but not from a second, unrelated file with an opaque
    // claim -- so it is a miss, biasing the rate DOWN.
    corpusOf(dir, BIG, 0);
    const near = putNode(dir, { kind: 'file', key: 'C:/repo/src/near.ts', hash: 'h1' });
    const symbol = putNode(dir, { kind: 'symbol', key: 'C:/repo/src/near.ts#Thing' });
    putEdge(dir, near, 'contains', symbol);
    const far = putNode(dir, { kind: 'file', key: 'C:/repo/src/far.ts', hash: 'h2' });
    putNodeWithEdges(
      dir,
      { kind: 'finding', key: 'partial', claim: 'zqxwv qzjhb plurgh', confidence: 0.9 },
      [
        { edge: 'derived_from', to: near },
        { edge: 'derived_from', to: symbol },
        { edge: 'derived_from', to: far },
      ]
    );

    const result = recallProbe(dir, { limit: LIMIT });
    const miss = result.misses.find((m) => m.key === 'partial');
    expect(miss).toBeDefined();
    expect(miss.reason).toContain('far.ts');
    // The edge-level counts still show the two that WERE recovered.
    expect(result.recoveredEdges).toBeGreaterThan(0);
  });
});

describe('it refuses rather than publishing a number it cannot support', () => {
  it('returns a null rate with a reason on an empty graph', () => {
    writeFileSync(join(dir, 'graph.jsonl'), '');
    const result = recallProbe(dir);

    expect(result.rate).toBeNull();
    expect(result.reason).toMatch(/not measured/);
    expect(result.integrity.rate).toBeNull();
  });

  it('returns a null rate below the observation floor, and says what the count was', () => {
    // n = 1 is this machine's real graph. A rate over one observation is not a
    // rate, and this is the branch the Definition of done exercises here.
    corpusOf(dir, 1, 1);
    const result = recallProbe(dir, { limit: LIMIT });

    expect(result.probed).toBe(1);
    expect(result.retrieved).toBe(1);
    expect(result.rate).toBeNull();
    expect(result.reason).toMatch(/below the floor of 10/);
    expect(result.reason).toMatch(/count and not a rate/);
    // The tautology would have published 1.0 right here.
    expect(result.integrity.rate).toBe(1);
  });

  it('refuses a rate when the corpus is no larger than the retrieval limit', () => {
    // MIN_PROBED is cleared -- 12 probeable findings -- but at limit 20 nothing
    // is ever cut for budget, so the lexical arm is more permissive than
    // production and the rate is withheld anyway.
    corpusOf(dir, 12, 12);
    const result = recallProbe(dir, { limit: 20 });

    expect(result.probed).toBeGreaterThanOrEqual(MIN_PROBED);
    expect(result.discriminating).toBe(false);
    expect(result.rate).toBeNull();
    expect(result.reason).toMatch(/nothing is ever cut for budget/);
    expect(result.retrieved).toBe(12);
  });

  it('does not count an anchor edge with no node as a miss', () => {
    // `expand.promote` writes anchor edges to file ids that were never indexed,
    // and this machine's shared graph holds 14 active findings in exactly that
    // state. There is no anchor key to query BM25 with, so the question could
    // not be asked -- scoring it a miss would manufacture a recall loss out of
    // a graph-integrity defect.
    putNodeWithEdges(
      dir,
      { kind: 'finding', key: 'dangling', claim: 'zqxwv qzjhb', confidence: 0.6 },
      [{ edge: 'derived_from', to: 'file:deadbeefdeadbeef' }]
    );

    const result = recallProbe(dir);
    expect(result.probed).toBe(0);
    expect(result.misses).toHaveLength(0);
    expect(result.unprobeable.map((u) => u.key)).toContain('dangling');
    expect(result.unprobeable[0].reason).toMatch(/no node in the graph/);
    expect(result.rate).toBeNull();
    expect(result.reason).toMatch(/not the same as a rate of zero/);
  });

  it('fails open when the graph log CANNOT BE READ rather than throwing', () => {
    // THIS ASSERTION WAS VACUOUS IN ITS FIRST FORM and a mutation found it: it
    // passed a nonexistent directory, and `load` returns an EMPTY graph for a
    // missing log rather than throwing, so the catch it meant to exercise never
    // ran and replacing the refusal with `throw` survived. A directory where
    // the log file should be makes `readFileSync` throw for real.
    mkdirSync(join(dir, 'graph.jsonl'), { recursive: true });
    const result = recallProbe(dir);

    expect(result.rate).toBeNull();
    expect(result.probed).toBe(0);
    expect(result.reason).toMatch(/could not be read/);
  });

  it('fails open when the probe itself throws on a malformed graph', () => {
    // The second catch, pinned separately: a caller-supplied graph whose
    // `nodes` is not a Map. A report path must lose a section, never throw.
    const result = recallProbe(dir, { graph: { nodes: null, edges: [] } });

    expect(result.rate).toBeNull();
    expect(result.reason).toMatch(/the probe failed/);
  });

  it('caps the number of findings probed, says when the cap bit, and still ranks against the whole corpus', () => {
    // The default cap is bigger than any graph a unit test should build, so the
    // MECHANISM is exercised through the option and the DEFAULT is pinned as a
    // constant. `corpus` must stay at the full size: the cap is a sample of
    // which findings are probed, never of what they compete against, or a
    // truncated run would report an easier ranking problem than the real one.
    // The `corpus` field reads the SAME variable BM25 ranks over, so this
    // assertion is behavioural -- reading a parallel `all.length` instead let a
    // mutation shrink the ranking corpus and survive.
    expect(MAX_FINDINGS).toBe(200);
    expect(MAX_FINDINGS).toBeGreaterThan(MIN_PROBED);

    corpusOf(dir, 26, 26);
    const capped = recallProbe(dir, { limit: LIMIT, maxFindings: 12 });
    expect(capped.truncated).toBe(true);
    expect(capped.probed).toBe(12);
    expect(capped.corpus).toBe(26);
    expect(capped.integrity.probed).toBe(12);

    const uncapped = recallProbe(dir, { limit: LIMIT });
    expect(uncapped.truncated).toBe(false);
    expect(uncapped.probed).toBe(26);
  });
});

describe('it is wired into the balance sheet, labelled as an offline probe', () => {
  it('graphBalanceSheet carries the probe and its basis', () => {
    corpusOf(dir, BIG, BIG / 2);
    const sheet = graphBalanceSheet(dir, { limit: LIMIT });

    expect(sheet.recall).toBeDefined();
    expect(sheet.recall.basis).toBe('offline probe over the current graph');
    expect(sheet.recall.rate).toBe(0.5);
  });

  it('the probe writes nothing to the graph', () => {
    corpusOf(dir, BIG, BIG / 2);
    const before = load(dir);
    recallProbe(dir, { limit: LIMIT });
    const after = load(dir);

    expect(after.nodes.size).toBe(before.nodes.size);
    expect(after.edges.length).toBe(before.edges.length);
  });

  it('does not mutate the graph object it was handed', () => {
    corpusOf(dir, BIG, 0);
    const graph = load(dir);
    const edges = graph.edges.length;
    const nodes = graph.nodes.size;
    recallProbe(dir, { graph, limit: LIMIT });

    expect(graph.edges.length).toBe(edges);
    expect(graph.nodes.size).toBe(nodes);
  });
});
