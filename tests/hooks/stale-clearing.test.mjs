/**
 * NOTHING EVER CLEARED A STALE FLAG.
 *
 * `stale` is written by two eager paths (`invalidateOnWrite`, with a real diff,
 * and `invalidateChangedAnchors`, with a hash pair and no diff) and read by
 * `serve`, `disclose` and `utility`. No code path anywhere removed it. That was
 * harmless while eager invalidation was dead code; it fires now, so every
 * finding on an edited file was becoming permanently stale and the graph
 * degrades toward all-stale.
 *
 * THE PROPERTY UNDER TEST IS NOT "A FLAG CAN BE REMOVED" -- that is trivial and
 * would be satisfied by a laundering route. It is that the flag comes off ONLY
 * on evidence that the content now matches what the claim was actually made
 * against: the frozen `derivation.anchors` hashes recorded at claim time.
 *
 * WHY NOT `checkAnchor`, WHICH IS THE OBVIOUS REUSE. `checkAnchor` compares disk
 * against the anchor NODE's stored hash -- and both eager paths call `indexFile`
 * immediately after marking, which re-points that hash at the bytes that just
 * caused the mark. So `checkAnchor` reports "fresh" for precisely the finding
 * that was just marked stale, and a `reverify` built on it would clear every
 * flag it was ever handed. That is the laundering route, and the
 * "still differs" tests below are the ones that catch it.
 */

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load, nodeId, putNode, putEdge, putNodeWithEdges } from '../../hooks-core/wiki.mjs';
import {
  clearStale,
  indexFile,
  invalidateChangedAnchors,
  invalidateOnWrite,
  reverify,
  serve,
} from '../../hooks-core/staleness.mjs';
import {
  audit,
  contradict,
  correct,
  hasOutstandingContradiction,
  retire,
} from '../../hooks-core/curate.mjs';
import { writeHarvested } from '../../hooks-core/harvest-write.mjs';
import { create } from '../../hooks-core/curate.mjs';
import { forTouch } from '../../hooks-core/inject.mjs';
import { canonicalPath } from '../../hooks-core/paths.mjs';

const ORIGINAL = 'export function parse(x) {\n  return x.trim();\n}\n';
const CHANGED = 'export function parse(x) {\n  return String(x).trim();\n}\n';

let dir;
let workspace;
let file;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stale-clear-'));
  workspace = mkdtempSync(join(tmpdir(), 'stale-clear-ws-'));
  file = canonicalPath(join(workspace, 'parse.ts'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

const findingByKey = (key) => load(dir).nodes.get(nodeId('finding', key));

/**
 * A finding written the way the product writes one, so it carries the
 * `derivation.anchors` record `reverify` checks against. Seeding with a bare
 * `putNodeWithEdges` would produce a finding with no claim-time hashes, which
 * is a different (and separately tested) case.
 */
function seedFinding(claim = 'parse trims its argument') {
  const keys = writeHarvested(dir, [
    { claim, type: 'finding', confidence: 0.85, anchors: [file] },
  ]);
  expect(keys).toHaveLength(1);
  return keys[0];
}

/** The eager path with a before/after pair: a real diff is captured. */
const markStaleWithDiff = (before, after) =>
  invalidateOnWrite(dir, load(dir), file, before, after);

/** The eager path with no before side: a hash pair, and `diff: ''`. */
const markStaleByHash = () => invalidateChangedAnchors(dir, load(dir), file);

describe('reverify clears a stale flag, but only on evidence', () => {
  test('clears the flag when the anchor returns to its recorded content', () => {
    writeFileSync(file, ORIGINAL);
    indexFile(dir, file, ORIGINAL);
    const key = seedFinding();

    writeFileSync(file, CHANGED);
    expect(markStaleWithDiff(ORIGINAL, CHANGED)).toEqual([key]);
    expect(findingByKey(key).stale).toBe(true);

    writeFileSync(file, ORIGINAL); // reverted
    expect(reverify(dir, key)).toBe('cleared');

    const after = findingByKey(key);
    expect(after.stale).toBeFalsy();
    expect(after.diff).toBeFalsy();
    expect(after.staleReason).toBeFalsy();
  });

  test('leaves the flag set when the content genuinely still differs', () => {
    writeFileSync(file, ORIGINAL);
    indexFile(dir, file, ORIGINAL);
    const key = seedFinding();

    writeFileSync(file, CHANGED);
    markStaleWithDiff(ORIGINAL, CHANGED);

    // NOT reverted. The anchor really did change, so the claim stays discounted
    // until someone re-records it against the new content. This is the
    // assertion that stops `reverify` becoming a way to launder a stale finding
    // back to fresh on request.
    expect(reverify(dir, key)).toBe('still-stale');
    const after = findingByKey(key);
    expect(after.stale).toBe(true);
    expect(after.staleReason).toBe('edited during this session');
  });

  test('clears a hash-only mark, which carries no diff at all', () => {
    // The whole-file `Write` shape: `invalidateChangedAnchors` compares stored
    // hashes against disk and marks with `diff: ''`. Clearing must not assume a
    // diff exists to remove.
    writeFileSync(file, ORIGINAL);
    indexFile(dir, file, ORIGINAL);
    const key = seedFinding();

    writeFileSync(file, CHANGED);
    expect(markStaleByHash()).toEqual([key]);
    expect(findingByKey(key).stale).toBe(true);
    expect(findingByKey(key).diff).toBe('');

    writeFileSync(file, ORIGINAL);
    expect(reverify(dir, key)).toBe('cleared');
    expect(findingByKey(key).stale).toBeFalsy();
  });

  test('leaves a hash-only mark set when the content still differs', () => {
    writeFileSync(file, ORIGINAL);
    indexFile(dir, file, ORIGINAL);
    const key = seedFinding();

    writeFileSync(file, CHANGED);
    markStaleByHash();

    expect(reverify(dir, key)).toBe('still-stale');
    expect(findingByKey(key).stale).toBe(true);
  });

  test('clears a mark left by a write that changed nothing at all', () => {
    // `invalidateOnWrite` marks every finding anchored to the FILE node on any
    // observed write to that file, whether or not the bytes moved. That is a
    // real over-mark, it is permanent today, and it is exactly the case where
    // the evidence for clearing is unambiguous.
    writeFileSync(file, ORIGINAL);
    indexFile(dir, file, ORIGINAL);
    const key = seedFinding();

    expect(markStaleWithDiff(ORIGINAL, ORIGINAL)).toEqual([key]);
    expect(findingByKey(key).stale).toBe(true);

    expect(reverify(dir, key)).toBe('cleared');
    expect(findingByKey(key).stale).toBeFalsy();
  });

  test('reports still-stale when the anchored file has been deleted', () => {
    writeFileSync(file, ORIGINAL);
    indexFile(dir, file, ORIGINAL);
    const key = seedFinding();

    writeFileSync(file, CHANGED);
    markStaleWithDiff(ORIGINAL, CHANGED);
    rmSync(file);

    // A file that is gone cannot match the content the claim was made against.
    expect(reverify(dir, key)).toBe('still-stale');
    expect(findingByKey(key).stale).toBe(true);
  });

  test('a deleted anchor never matches, even when it was EMPTY at claim time', () => {
    // Found by mutation, not by reading: making `anchorHashNow` return hash('')
    // for an unreadable anchor instead of null survived every other test here,
    // because a deleted file's empty hash differs from any real content. It does
    // NOT differ when the file was empty when the claim was made -- a stub, a
    // placeholder, a generated file not yet written -- and then a DELETION would
    // re-hash to exactly the recorded value and clear the flag. "The file is
    // gone" must never read as "the content is unchanged".
    writeFileSync(file, '');
    indexFile(dir, file, '');
    const key = seedFinding('parse.ts is still a stub');

    writeFileSync(file, ORIGINAL);
    markStaleWithDiff('', ORIGINAL);
    expect(findingByKey(key).stale).toBe(true);

    rmSync(file);
    expect(reverify(dir, key)).toBe('still-stale');
    expect(findingByKey(key).stale).toBe(true);
  });

  test('refuses to clear a finding with no claim-time record to check against', () => {
    // Findings written before `derivation` existed, and every hand-written one,
    // carry no frozen anchor hashes. There is nothing to compare disk to, so
    // there is no evidence -- and "no evidence" must not resolve to "clear it".
    writeFileSync(file, ORIGINAL);
    indexFile(dir, file, ORIGINAL);
    putNodeWithEdges(
      dir,
      { kind: 'finding', key: 'legacy', claim: 'parse trims', confidence: 0.9 },
      [{ edge: 'derived_from', to: nodeId('file', file) }]
    );

    writeFileSync(file, CHANGED);
    markStaleWithDiff(ORIGINAL, CHANGED);
    expect(findingByKey('legacy').stale).toBe(true);

    // Even after a revert: the flag stays, because nothing recorded what this
    // claim was originally derived from.
    writeFileSync(file, ORIGINAL);
    expect(reverify(dir, 'legacy')).toBe('unknown');
    expect(findingByKey('legacy').stale).toBe(true);
  });

  test('reports unknown for a key that names no finding, and writes nothing', () => {
    const before = load(dir).nodes.size;
    expect(reverify(dir, 'nope')).toBe('unknown');
    expect(load(dir).nodes.size).toBe(before);
  });

  test('is idempotent on a finding that is not stale', () => {
    writeFileSync(file, ORIGINAL);
    indexFile(dir, file, ORIGINAL);
    const key = seedFinding();

    expect(findingByKey(key).stale).toBeUndefined();
    expect(reverify(dir, key)).toBe('cleared');
    expect(findingByKey(key).stale).toBeFalsy();
    expect(findingByKey(key).claim).toBe('parse trims its argument');
  });

  test('a cleared finding is served clean, with no staleness vocabulary left', () => {
    writeFileSync(file, ORIGINAL);
    indexFile(dir, file, ORIGINAL);
    const key = seedFinding();

    writeFileSync(file, CHANGED);
    markStaleWithDiff(ORIGINAL, CHANGED);
    writeFileSync(file, ORIGINAL);
    // The eager mark re-indexed the anchor to CHANGED, so the revert also has
    // to be re-indexed before the LAZY check agrees -- otherwise `serve` would
    // recompute staleness from the anchor node and the clear would be invisible.
    indexFile(dir, file, ORIGINAL);
    expect(reverify(dir, key)).toBe('cleared');

    const graph = load(dir);
    const served = serve(graph, [graph.nodes.get(nodeId('finding', key))]);
    expect(served[0].stale).toBe(false);
    expect(served[0].staleReason).toBeUndefined();
    expect(served[0].diff).toBeUndefined();
  });
});

describe('clearStale rewrites the whole node', () => {
  test('preserves every other field when clearing', () => {
    writeFileSync(file, ORIGINAL);
    indexFile(dir, file, ORIGINAL);
    const key = seedFinding();
    writeFileSync(file, CHANGED);
    markStaleWithDiff(ORIGINAL, CHANGED);

    const before = findingByKey(key);
    expect(before.stale).toBe(true);
    expect(clearStale(dir, key)).toBe(true);
    const after = findingByKey(key);

    // putNode does NOT merge -- it writes the record it is handed and `load`
    // replaces the node wholesale. A partial write here would silently blank
    // the claim, the confidence and the provenance.
    expect(after.claim).toBe(before.claim);
    expect(after.confidence).toBe(before.confidence);
    expect(after.origin).toBe(before.origin);
    expect(after.type).toBe(before.type);
    expect(after.derivation).toEqual(before.derivation);
    expect(after.stale).toBeUndefined();
    expect(after.staleReason).toBeUndefined();
    expect(after.diff).toBeUndefined();
  });

  test('keeps the anchors, so a cleared finding can go stale again', () => {
    writeFileSync(file, ORIGINAL);
    indexFile(dir, file, ORIGINAL);
    const key = seedFinding();
    writeFileSync(file, CHANGED);
    markStaleWithDiff(ORIGINAL, CHANGED);
    clearStale(dir, key);

    const id = nodeId('finding', key);
    expect(load(dir).edges.some((e) => e.edge === 'derived_from' && e.from === id)).toBe(true);

    // And it really can be marked again -- an un-invalidatable finding would be
    // a worse outcome than a permanently stale one.
    writeFileSync(file, CHANGED + '\n// more\n');
    expect(markStaleWithDiff(CHANGED, CHANGED + '\n// more\n')).toEqual([key]);
    expect(findingByKey(key).stale).toBe(true);
  });

  test('returns false for a key that names no finding', () => {
    expect(clearStale(dir, 'nope')).toBe(false);
  });
});

describe('a correction is not born stale', () => {
  test('does not let a correction inherit its predecessor stale flag', () => {
    writeFileSync(file, ORIGINAL);
    indexFile(dir, file, ORIGINAL);
    const key = seedFinding();
    writeFileSync(file, CHANGED);
    markStaleWithDiff(ORIGINAL, CHANGED);
    expect(findingByKey(key).stale).toBe(true);

    const corrected = correct(dir, key, 're-derived against the new code');
    expect(typeof corrected).toBe('string');

    const node = findingByKey(corrected);
    expect(node.stale).toBeFalsy();
    expect(node.staleReason).toBeFalsy();
    expect(node.diff).toBeFalsy();
    // The original keeps its flag AND is retired: the record of what was
    // believed, and why it stopped being believed, both survive.
    expect(findingByKey(key).stale).toBe(true);
    expect(findingByKey(key).retired).toBe(true);
  });
});

/**
 * A RETIRED COUNTERPART IS A RESOLVED DISPUTE.
 *
 * `hasOutstandingContradiction` read edges only, so retiring one end of a
 * contradiction left the survivor gated against confidence promotion forever
 * and disclosed as DISPUTED by a key `serve` refuses to hand anybody. The gate's
 * own justification is `audit`'s "until one looks, BOTH are being served" -- a
 * retired claim is served to nobody, so the premise is gone and retiring one end
 * IS a person looking.
 */
describe('a retired counterpart no longer counts as an open dispute', () => {
  beforeEach(() => {
    putNodeWithEdges(dir, { kind: 'finding', key: 'old', claim: 'f returns 1', confidence: 0.9 });
    putNodeWithEdges(dir, { kind: 'finding', key: 'new', claim: 'f returns 2', confidence: 0.9 });
    contradict(dir, { key: 'old', byKey: 'new', reason: 're-derived' });
  });

  test('the gate opens for the survivor once the other end is retired', () => {
    expect(hasOutstandingContradiction(load(dir), 'old')).toBe(true);
    expect(retire(dir, 'new')).toBe(true);

    const graph = load(dir);
    expect(hasOutstandingContradiction(graph, 'old')).toBe(false);
    // Symmetric, as before: the retired end is not being served either.
    expect(hasOutstandingContradiction(graph, 'new')).toBe(false);
  });

  test('a LIVE counterpart still gates, so the test above is not vacuous', () => {
    const graph = load(dir);
    expect(hasOutstandingContradiction(graph, 'old')).toBe(true);
    expect(hasOutstandingContradiction(graph, 'new')).toBe(true);
  });

  test('serve stops disclosing a dispute whose only disputant is retired', () => {
    retire(dir, 'new');
    const graph = load(dir);
    const served = serve(graph, [graph.nodes.get(nodeId('finding', 'old'))]);
    expect(served[0].contradicted).toBeUndefined();
    expect(served[0].contradictedBy).toBeUndefined();
  });

  test('serve never names a retired disputant alongside a live one', () => {
    putNodeWithEdges(dir, { kind: 'finding', key: 'third', claim: 'f returns 3', confidence: 0.9 });
    contradict(dir, { key: 'old', byKey: 'third', reason: 'again' });
    retire(dir, 'new');

    const graph = load(dir);
    const served = serve(graph, [graph.nodes.get(nodeId('finding', 'old'))]);
    expect(served[0].contradicted).toBe(true);
    // Pointing a reader at a key `serve` refuses to return is worse than saying
    // nothing: the disclosure tells them to `wiki_query` it and they get nothing.
    expect(served[0].contradictedBy).toBe('third');
  });

  test('audit agrees with the gate -- one definition of an open dispute', () => {
    retire(dir, 'new');
    expect(audit(load(dir)).contradicted.map((f) => f.key)).toEqual([]);
  });

  test('an unresolvable counterpart still counts, because it cannot be shown retired', () => {
    // A `contradicts` edge whose other end resolves to no node at all. Nothing
    // proves that claim was withdrawn, so the conservative reading stands.
    const id = putNode(dir, { kind: 'finding', key: 'lonely', claim: 'h returns 1', confidence: 0.9 });
    putEdge(dir, nodeId('finding', 'ghost'), 'contradicts', id);
    expect(hasOutstandingContradiction(load(dir), 'lonely')).toBe(true);
  });
});

/**
 * AUTOMATIC CLEARING, ON THE SAME EVIDENCE.
 *
 * Clearing reachable only through a dashboard button leaves the rot path fully
 * open on every install where nobody opens the dashboard -- which is most of
 * them. The evidence test is what makes clearing safe and it does not care who
 * triggered it, so `serve` runs the same `claimTimeVerdict` when handed a `dir`.
 *
 * THE ASSERTIONS THAT MATTER ARE THE NEGATIVE ONES. An automatic path that
 * cleared more freely than the button would be a laundering route firing on
 * every tool call, so each "clears automatically" test below is paired with a
 * "still differs" test on the identical setup.
 */
describe('serve clears a stale flag automatically, on the same evidence', () => {
  const staleFinding = () => {
    writeFileSync(file, ORIGINAL);
    indexFile(dir, file, ORIGINAL);
    const key = seedFinding();
    writeFileSync(file, CHANGED);
    markStaleWithDiff(ORIGINAL, CHANGED);
    expect(findingByKey(key).stale).toBe(true);
    return key;
  };

  const serveOne = (key, opts) => {
    const graph = load(dir);
    return serve(graph, [graph.nodes.get(nodeId('finding', key))], opts)[0];
  };

  test('clears the STORED flag when the content is back to what was claimed', () => {
    const key = staleFinding();
    writeFileSync(file, ORIGINAL); // reverted
    indexFile(dir, file, ORIGINAL); // and observed, so the lazy check agrees too

    const served = serveOne(key, { dir });
    expect(served.stale).toBe(false);
    // Gone from the STORE, not merely from this response -- disclose.mjs and
    // utility.mjs read the stored node, never the served copy.
    expect(findingByKey(key).stale).toBeUndefined();
  });

  test('does NOT clear when the content genuinely still differs', () => {
    const key = staleFinding();
    // Not reverted. This is the mutation-facing assertion: an automatic path
    // that cleared unconditionally would fire here on every tool call.
    const served = serveOne(key, { dir });
    expect(served.stale).toBe(true);
    expect(findingByKey(key).stale).toBe(true);
  });

  test('does not render as both stale and fresh', () => {
    const key = staleFinding();
    writeFileSync(file, ORIGINAL);
    indexFile(dir, file, ORIGINAL);

    const served = serveOne(key, { dir });
    // `serve` spreads the record, so a cleared flag with staleReason and diff
    // still attached hands back a finding that reads fresh and stale at once --
    // and different renderers key off different fields.
    expect(served.stale).toBe(false);
    expect(served.staleReason).toBeUndefined();
    expect(served.diff).toBeUndefined();
    expect(served.staleEvidence).toBeUndefined();
  });

  test('keeps the other two disclosures on a finding cleared mid-serve', () => {
    const key = staleFinding();
    putNodeWithEdges(dir, {
      kind: 'finding', key: 'rebuttal', claim: 'parse does not trim', confidence: 0.9,
    });
    contradict(dir, { key, byKey: 'rebuttal', reason: 'read it again' });
    writeFileSync(file, ORIGINAL);
    indexFile(dir, file, ORIGINAL);

    const served = serveOne(key, { dir });
    expect(served.stale).toBe(false);
    // A dispute is not staleness and must survive the clear.
    expect(served.contradicted).toBe(true);
    expect(served.contradictedBy).toBe('rebuttal');
    // And so must the derivation verdict, which is what clearing was decided on.
    expect(served.derivationHolds).toBe(true);
    expect(served.derivationCheckedAgainst).toBe('index');
  });

  test('is read-only without a dir', () => {
    const key = staleFinding();
    writeFileSync(file, ORIGINAL);
    indexFile(dir, file, ORIGINAL);

    // No `dir`: the flag is still reported, and still stored.
    const served = serveOne(key);
    expect(served.stale).toBe(true);
    expect(findingByKey(key).stale).toBe(true);
  });

  test('refuses to clear automatically with no claim-time record, exactly as reverify does', () => {
    writeFileSync(file, ORIGINAL);
    indexFile(dir, file, ORIGINAL);
    putNodeWithEdges(
      dir,
      { kind: 'finding', key: 'legacy2', claim: 'parse trims', confidence: 0.9 },
      [{ edge: 'derived_from', to: nodeId('file', file) }]
    );
    writeFileSync(file, CHANGED);
    markStaleWithDiff(ORIGINAL, CHANGED);
    writeFileSync(file, ORIGINAL);
    indexFile(dir, file, ORIGINAL);

    expect(serveOne('legacy2', { dir }).stale).toBe(true);
    expect(findingByKey('legacy2').stale).toBe(true);
  });

  test('the lazy check still works after a clear -- on a LATER change', () => {
    // THIS TEST USED TO ASSERT THE DEFECT. It reverted without re-indexing and
    // then required `served.stale === true` with `staleReason: 'file changed'` on
    // the very object whose flag had just been cleared for matching its
    // claim-time content -- stale and fresh in one response, written down as
    // intended behaviour. The clear now re-points the anchor, so the two cannot
    // disagree about the same bytes.
    //
    // WHAT IS ACTUALLY WORTH ASSERTING is that clearing did not switch the lazy
    // path off: a change arriving AFTER the clear, from outside our hooks and
    // therefore never indexed, is still caught.
    const key = staleFinding();
    writeFileSync(file, ORIGINAL); // reverted, but NOT re-indexed
    expect(serveOne(key, { dir }).stale).toBe(false);
    expect(findingByKey(key).stale).toBeUndefined();

    // Now something outside the session edits the file again -- a git pull, a
    // teammate, a build step. No hook observed it, so nothing re-indexed.
    writeFileSync(file, CHANGED);
    const served = serveOne(key, { dir });
    expect(served.stale).toBe(true);
    expect(served.staleReason).toBe('file changed');
    // `derivationHolds: true` ALONGSIDE `stale: true` IS NOT THE CONTRADICTION
    // this fix was about, and the difference is worth stating. These two answer
    // different questions: the last indexed state does still agree with what the
    // claim was made against, and disk has since moved away from both. That is
    // exactly the complementary pair `derivationCheck` documents. The defect was
    // the OTHER combination -- a clear decided on claim-time evidence served
    // beside `derivationHolds: false` claiming that same evidence had moved.
    expect(served.derivationHolds).toBe(true);
    expect(served.derivationCheckedAgainst).toBe('index');
  });

  test('the injection path clears it, so no dashboard visit is required', () => {
    process.env.TOKEN_OPTIMIZER_HOLDOUT = '0';
    try {
      const key = staleFinding();
      writeFileSync(file, ORIGINAL);
      indexFile(dir, file, ORIGINAL);

      const out = forTouch(dir, load(dir), file, { sessionId: 's1' });
      expect(out).toContain('parse trims its argument');
      expect(out).not.toContain('STALE');
      expect(findingByKey(key).stale).toBeUndefined();
    } finally {
      delete process.env.TOKEN_OPTIMIZER_HOLDOUT;
    }
  });
});

/**
 * Every writer records the claim-time hashes, not just the harvester.
 *
 * The asymmetry ran the wrong way: a hand-created or hand-corrected finding had
 * no `derivation`, so it was the ONLY kind that could never have a stale flag
 * cleared once marked. Findings that predate the record stay unclearable -- that
 * is honest, and self-correcting as they are superseded.
 */
describe('curate writes claim-time anchor hashes too', () => {
  test('create records the hashes, so its finding is re-verifiable', () => {
    writeFileSync(file, ORIGINAL);
    const key = create(dir, { claim: 'parse trims, asserted by hand', anchors: [file] });
    expect(typeof key).toBe('string');

    const node = findingByKey(key);
    expect(node.derivation.anchors[nodeId('file', file)])
      .toBe(load(dir).nodes.get(nodeId('file', file)).hash);
    // The operations half is declared incomplete rather than asserted empty:
    // curation performs no evidence-log join at all.
    expect(node.derivation.operations).toEqual([]);
    expect(node.derivation.operationsComplete).toBe(false);

    writeFileSync(file, CHANGED);
    markStaleWithDiff(ORIGINAL, CHANGED);
    expect(findingByKey(key).stale).toBe(true);
    expect(reverify(dir, key)).toBe('still-stale');

    writeFileSync(file, ORIGINAL);
    expect(reverify(dir, key)).toBe('cleared');
  });

  test('a correction records hashes against the code it was re-derived from', () => {
    writeFileSync(file, ORIGINAL);
    indexFile(dir, file, ORIGINAL);
    const key = seedFinding();
    writeFileSync(file, CHANGED);
    markStaleWithDiff(ORIGINAL, CHANGED);

    // The eager path re-indexed the anchor to CHANGED, which is what a person
    // correcting the claim now reads -- so the correction's claim-time hash is
    // CHANGED's, not its predecessor's.
    const corrected = correct(dir, key, 'parse coerces then trims');
    const fileHashNow = load(dir).nodes.get(nodeId('file', file)).hash;
    expect(findingByKey(corrected).derivation.anchors[nodeId('file', file)]).toBe(fileHashNow);
    expect(findingByKey(corrected).derivation.anchors[nodeId('file', file)])
      .not.toBe(findingByKey(key).derivation.anchors[nodeId('file', file)]);

    // Move the file away from the correction's own claim time, then back.
    writeFileSync(file, ORIGINAL);
    markStaleWithDiff(CHANGED, ORIGINAL);
    expect(findingByKey(corrected).stale).toBe(true);
    expect(reverify(dir, corrected)).toBe('still-stale');

    writeFileSync(file, CHANGED);
    expect(reverify(dir, corrected)).toBe('cleared');
  });
});

/**
 * THE THREE DISCLOSURES MUST NOT CONTRADICT EACH OTHER.
 *
 * A served finding carries three independent verdicts, each computed from a
 * different comparison:
 *
 *   `stale`/`staleReason`  -- disk against the anchor NODE's stored hash
 *   `derivationHolds`      -- the anchor node's stored hash against the hash
 *                             frozen into this finding at claim time
 *   the clear decision     -- disk against that same claim-time hash
 *
 * Two of those three read the node's stored hash, and the EAGER path moves it.
 * So on the revert path -- index at H1, claim against H1, edit and re-index to
 * H2, eager-mark, then revert the file to H1 -- the clear fired (disk H1 equals
 * claim H1) while the same returned object said `stale: true, staleReason: 'file
 * changed'` and `derivationHolds: false`. The model was shown STALE and
 * DERIVATION CHANGED at the exact moment the code's own evidence test had
 * concluded the derivation holds, and it recurred on every serve until something
 * unrelated re-indexed the anchor.
 *
 * EVERY EXISTING TEST OF THIS PATH RE-INDEXED AFTER REVERTING, which is what hid
 * it: `indexFile(dir, file, ORIGINAL)` moves the node hash back to H1 by hand and
 * all three agree for a reason the product does not supply. Nothing below calls
 * `indexFile` after the revert. That omission is the test.
 */
describe('a mid-serve clear leaves all three disclosures agreeing', () => {
  const staleFinding = () => {
    writeFileSync(file, ORIGINAL);
    indexFile(dir, file, ORIGINAL);
    const key = seedFinding();
    writeFileSync(file, CHANGED);
    markStaleWithDiff(ORIGINAL, CHANGED);
    expect(findingByKey(key).stale).toBe(true);
    return key;
  };

  const serveOne = (key, opts) => {
    const graph = load(dir);
    return serve(graph, [graph.nodes.get(nodeId('finding', key))], opts)[0];
  };

  const fileHash = () => load(dir).nodes.get(nodeId('file', file)).hash;

  test('the revert path serves fresh, not stale-and-fresh at once', () => {
    const key = staleFinding();
    const claimHash = findingByKey(key).derivation.anchors[nodeId('file', file)];
    // The eager path re-pointed the node at the POST-edit bytes, which is the
    // whole reason the two derived disclosures disagreed with the clear.
    expect(fileHash()).not.toBe(claimHash);

    writeFileSync(file, ORIGINAL); // reverted on disk, and NOT re-indexed

    const served = serveOne(key, { dir });
    // The clear happened...
    expect(served.stale).toBe(false);
    expect(findingByKey(key).stale).toBeUndefined();
    // ...and neither derived disclosure contradicts it.
    expect(served.staleReason).toBeUndefined();
    expect(served.diff).toBeUndefined();
    expect(served.staleEvidence).toBeUndefined();
    expect(served.derivationHolds).toBe(true);
    expect(served.derivationChanged).toBeUndefined();
  });

  test('the anchor is re-indexed from the bytes the evidence test already read', () => {
    const key = staleFinding();
    const claimHash = findingByKey(key).derivation.anchors[nodeId('file', file)];
    writeFileSync(file, ORIGINAL);

    serveOne(key, { dir });
    // The stored hash is the claim-time hash again, so the NEXT reader -- and
    // every other finding anchored to this file -- sees the same content this
    // clear was decided on. Suppressing the disclosures instead would have left
    // the graph holding a hash matching no version of the file that exists.
    expect(fileHash()).toBe(claimHash);
  });

  test('a second serve says the same thing, and pays nothing to say it', () => {
    const key = staleFinding();
    writeFileSync(file, ORIGINAL);
    serveOne(key, { dir });

    const again = serveOne(key, { dir });
    expect(again.stale).toBe(false);
    expect(again.staleReason).toBeUndefined();
    expect(again.derivationHolds).toBe(true);
  });

  test('a genuine change still disagrees with nothing, and stays stale', () => {
    // The paired negative: the fix must not make everything agree by making
    // everything read fresh. Not reverted, so the verdict is `differs`, no
    // re-index happens, and all three disclosures agree that it is stale.
    const key = staleFinding();
    const claimHash = findingByKey(key).derivation.anchors[nodeId('file', file)];

    const served = serveOne(key, { dir });
    expect(served.stale).toBe(true);
    expect(findingByKey(key).stale).toBe(true);
    expect(served.derivationHolds).toBe(false);
    expect(served.derivationChanged).toEqual([file]);
    // And the anchor is NOT quietly moved back to the claim-time hash, which
    // would be the laundering route wearing a re-index for a hat.
    expect(fileHash()).not.toBe(claimHash);
  });

  test('reverify agrees with serve, because both re-index what they verified', () => {
    const key = staleFinding();
    const claimHash = findingByKey(key).derivation.anchors[nodeId('file', file)];
    writeFileSync(file, ORIGINAL);

    expect(reverify(dir, key)).toBe('cleared');
    expect(fileHash()).toBe(claimHash);

    const served = serveOne(key, { dir });
    expect(served.stale).toBe(false);
    expect(served.derivationHolds).toBe(true);
  });
});

/**
 * ONE CLEAR IS ONE RECORD.
 *
 * `clearStale`'s no-op guard reads the graph its CALLER handed it, not disk. So a
 * second `serve` over the same in-memory graph object -- two touched files
 * anchored to one finding, or a lifecycle branch that serves twice from a graph
 * it loaded once, which is exactly the shape SessionStart has -- still saw
 * `stale: true`, re-ran the evidence test and appended a byte-identical clear
 * record. The store is append-only, so that is permanent growth for no change of
 * state.
 */
describe('clearing twice from one graph object writes once', () => {
  const clearRecordCount = (key) => {
    const id = nodeId('finding', key);
    return readFileSync(join(dir, 'graph.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.includes(`"${id}"`) && line.includes('"t":"n"'))
      .filter((line) => !JSON.parse(line).stale)
      .length;
  };

  test('the second serve on the same graph appends no duplicate', () => {
    writeFileSync(file, ORIGINAL);
    indexFile(dir, file, ORIGINAL);
    const key = seedFinding();
    writeFileSync(file, CHANGED);
    markStaleWithDiff(ORIGINAL, CHANGED);
    writeFileSync(file, ORIGINAL);

    // ONE graph object, served twice -- the SessionStart shape.
    const graph = load(dir);
    const findings = () => [graph.nodes.get(nodeId('finding', key))];
    const before = clearRecordCount(key);
    serve(graph, findings(), { dir });
    const afterFirst = clearRecordCount(key);
    serve(graph, findings(), { dir });
    const afterSecond = clearRecordCount(key);

    expect(afterFirst).toBe(before + 1);
    expect(afterSecond).toBe(afterFirst);
    // And the finding is still cleared -- writing once must not mean clearing
    // once and then reporting it stale again.
    expect(findingByKey(key).stale).toBeUndefined();
  });
});
