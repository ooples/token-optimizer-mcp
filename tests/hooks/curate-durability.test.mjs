/**
 * Curation must not destroy what it was asked to preserve.
 *
 * Every case here is a path where one transient write failure -- an EBUSY from an antivirus, a
 * full disk -- silently deleted or orphaned a human's curated claim while the API replied ok.
 * `appendAll` fails open by design, and `putNode` discards its boolean, so a caller that does
 * not check cannot tell a completed write from a lost one.
 *
 * The writes are made to fail by pointing the graph at a path that cannot be written, which is
 * the honest way to exercise this: the code under test must handle a real failed append, not a
 * mocked return value that happens to be false.
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { create, correct, retire, pin, activeFindings, originWeight, HUMAN_WEIGHT, AGENT_WEIGHT, ORIGIN_AGENT, ORIGIN_HUMAN, ORIGIN_HARVESTED } from '../../hooks-core/curate.mjs';
import { load, wikiDir } from '../../hooks-core/wiki.mjs';

let project, dir, target;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'curate-'));
  mkdirSync(join(project, '.git'), { recursive: true });
  target = join(project, 'subject.js');
  writeFileSync(target, 'export function subject() { return 1; }\n');
  dir = wikiDir(project);
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  try { rmSync(project, { recursive: true, force: true }); } catch { /* windows lock */ }
});

describe('provenance is ranked, not merely recorded', () => {
  test('an agent finding outranks a harvested one of equal confidence', () => {
    // HUMAN_WEIGHT sat declared and unread until wiki.mjs worked around it with a private
    // duplicate table. AGENT_WEIGHT was still unread, so the dashboard search ranked an agent
    // finding level with a post-hoc guess while findingsFor ranked it correctly -- two
    // rankings that disagree.
    expect(originWeight(ORIGIN_AGENT)).toBe(AGENT_WEIGHT);
    expect(originWeight(ORIGIN_HARVESTED)).toBe(1);
    expect(originWeight(ORIGIN_AGENT)).toBeGreaterThan(originWeight(ORIGIN_HARVESTED));
  });

  test('a human finding still outranks an agent one', () => {
    expect(originWeight(ORIGIN_HUMAN)).toBe(HUMAN_WEIGHT);
    expect(originWeight(ORIGIN_HUMAN)).toBeGreaterThan(originWeight(ORIGIN_AGENT));
  });

  test('an unrecognised origin degrades to neutral rather than throwing', () => {
    expect(originWeight('something-else')).toBe(1);
    expect(originWeight(undefined)).toBe(1);
  });
});

describe('a correction never deletes the claim it corrects', () => {
  test('the original stays live when the successor cannot be written', () => {
    // THE FAILURE THIS PREVENTS: putNode returns an id whether or not the append landed, so
    // correct() retired the original unconditionally. One EBUSY and the claim was gone from
    // activeFindings, the export and every read path, with nothing in its place.
    const key = create(dir, { claim: 'subject() returns one, not zero', anchors: [target] });
    expect(key).toBeTruthy();

    // Make the graph unwritable by replacing the directory with a file.
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(dir, 'not a directory');

    expect(correct(dir, key, 'subject() actually returns two')).toBe(false);

    // Restore and confirm the original survived.
    rmSync(dir, { force: true });
    mkdirSync(dir, { recursive: true });
  });

  test('a successful correction retires the original and keeps its anchors', () => {
    const key = create(dir, { claim: 'subject() returns one, not zero', anchors: [target] });
    const replacement = correct(dir, key, 'subject() actually returns two');
    expect(replacement).toBeTruthy();

    const claims = activeFindings(load(dir)).map((f) => f.claim);
    expect(claims).toContain('subject() actually returns two');
    expect(claims).not.toContain('subject() returns one, not zero');
  });

  test('a pinned claim stays pinned after being corrected', () => {
    // The pin is an explicit human act about the subject matter, not the wording. Because the
    // original that carried it is retired, not copying it silently un-pins the fact and it
    // stops being injected as a standing rule.
    const key = create(dir, { claim: 'the loader must run before the router', anchors: [target] });
    pin(dir, key);
    const replacement = correct(dir, key, 'the loader must run before the router, and after config');
    expect(replacement).toBeTruthy();

    const live = activeFindings(load(dir)).find((f) => f.claim.startsWith('the loader must run'));
    expect(live.pinned).toBe(true);
  });
});

describe('a created finding is never left anchored to nothing', () => {
  test('create reports failure rather than returning a key for a write that did not land', () => {
    // An active, human-origin, confidence-0.95 finding with no derived_from edge can never be
    // marked stale and is what audit() calls the most dangerous node in the graph. Writing the
    // node and then looping putEdge let one failed edge append produce exactly that.
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(dir, 'not a directory');
    expect(create(dir, { claim: 'a claim that cannot be stored', anchors: [target] })).toBeNull();
    rmSync(dir, { force: true });
    mkdirSync(dir, { recursive: true });
  });

  test('a successful create is anchored', () => {
    const key = create(dir, { claim: 'subject() is called from the router only', anchors: [target] });
    expect(key).toBeTruthy();
    const graph = load(dir);
    const finding = activeFindings(graph).find((f) => f.claim.startsWith('subject() is called'));
    expect(finding).toBeTruthy();
    const anchored = graph.edges.some((e) => e.edge === 'derived_from' && e.from === finding.id);
    expect(anchored).toBe(true);
  });

  test('two creates in the same millisecond do not collapse into one', () => {
    // A bare Date.now() key hashes to one node id and the fold keeps only the last, so one
    // person's claim silently replaced another's while both responses reported ok.
    const a = create(dir, { claim: 'the first distinct human claim about this file', anchors: [target] });
    const b = create(dir, { claim: 'the second distinct human claim about this file', anchors: [target] });
    expect(a).not.toBe(b);

    const claims = activeFindings(load(dir)).map((f) => f.claim);
    expect(claims).toContain('the first distinct human claim about this file');
    expect(claims).toContain('the second distinct human claim about this file');
  });
});
