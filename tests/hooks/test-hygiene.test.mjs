/**
 * A test that consults the stratified holdout must pin the arm.
 *
 * `inHoldout(anchor)` is deterministic in (anchor, epoch) but not in anything a
 * test controls: a fixture whose anchor happens to land in the WITHHELD arm gets
 * a null injection and the assertion fails, on some runs, in some epochs, for
 * nobody's reason. The convention that fixes it -- set `TOKEN_OPTIMIZER_HOLDOUT`
 * and restore it -- is copy-pasted per suite in several variants, and until now
 * nothing enforced it. One newly-added test on the Plan 1 branch omitted it and
 * produced exactly that flake, which cost a diagnosis.
 *
 * WHY A GUARD RATHER THAN A NOTE IN A CONTRIBUTING FILE. This is the same defect
 * shape as everything else in this directory: a convention that is correct,
 * written down, and unenforced is indistinguishable from one nobody follows,
 * until a Tuesday when CI goes red on an unrelated PR and somebody reruns the
 * job until it passes.
 *
 * THE ENTRY POINTS ARE DERIVED, NOT LISTED. A hard-coded list of four names
 * would be correct today and silently wrong the first time a fifth function
 * starts consulting the holdout -- which is precisely how this class of defect
 * gets in. The guard finds every `inHoldout(` call site in the live hook path
 * and attributes it to its enclosing exported function.
 */

import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join, relative } from 'path';
import {
  DECLARE_DIRS,
  walk,
  stripComments,
} from '../fixtures/source-scan.mjs';

const REPO = process.cwd();

/** Every exported function in the live hook path whose body calls `inHoldout`. */
function holdoutConsumingEntryPoints() {
  const names = new Set();
  for (const file of DECLARE_DIRS.flatMap((d) => walk(join(REPO, d)))) {
    const code = stripComments(readFileSync(file, 'utf8'));
    const call = /\binHoldout\s*\(/g;
    let m;
    while ((m = call.exec(code)) !== null) {
      // The nearest PRECEDING export is the enclosing one. A heuristic, and the
      // right kind: it can name a function that no longer encloses the call
      // after a refactor, which over-reports and merely asks a suite to pin an
      // arm it did not need to. It cannot miss one, which is the direction that
      // would let the flake back in.
      const before = code.slice(0, m.index);
      const decl = [...before.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)].pop();
      if (decl) names.add(decl[1]);
    }
  }
  return names;
}

/** Test files that CALL one of those, as opposed to mentioning one in prose. */
function suitesConsultingTheHoldout(entryPoints) {
  const shape = new RegExp(`\\b(${[...entryPoints].join('|')})\\s*\\(`);
  return walk(join(REPO, 'tests'))
    .filter((file) => /\.test\.(mjs|ts)$/.test(file))
    .map((file) => ({ file: relative(REPO, file), text: readFileSync(file, 'utf8') }))
    // Comments stripped, so the four suites that DISCUSS forTouch and forCommand
    // in their docstrings -- and this very file, which names them throughout --
    // are not asked to pin an arm they never consult.
    .filter(({ text }) => shape.test(stripComments(text)));
}

/**
 * Both spellings of the convention count.
 *
 * `process.env.TOKEN_OPTIMIZER_HOLDOUT = '0'` is what an in-process suite uses;
 * `TOKEN_OPTIMIZER_HOLDOUT: '0'` inside an env object is what the three suites
 * that spawn a real hook subprocess use. Insisting on one spelling would fail
 * three working suites, and a guard that fails working code gets deleted.
 */
const PINS_THE_ARM = /TOKEN_OPTIMIZER_HOLDOUT\s*[:=]\s*['"`]/;

/** The pin must be live code, not a commented-out one. */
const pinsTheArm = (text) => PINS_THE_ARM.test(stripComments(text));

describe('suites that consult the stratified holdout pin the arm', () => {
  const entryPoints = holdoutConsumingEntryPoints();

  it('finds the entry points to reason about', () => {
    // A derivation that found nothing would pass this file forever while
    // enforcing nothing -- the failure mode every guard here is built against.
    expect(entryPoints.size).toBeGreaterThan(2);
    expect([...entryPoints]).toContain('forTouch');
  });

  it('finds suites that actually call them', () => {
    expect(suitesConsultingTheHoldout(entryPoints).length).toBeGreaterThan(5);
  });

  it('has no suite that calls one without pinning', () => {
    const unpinned = suitesConsultingTheHoldout(entryPoints)
      .filter(({ text }) => !pinsTheArm(text))
      .map(({ file }) => file);

    // If this fails: set TOKEN_OPTIMIZER_HOLDOUT in the suite's setup and
    // restore it afterwards. '0' asserts on the DELIVERED arm, '1' on the
    // withheld one. Leaving it unset asserts on whichever arm the anchor
    // happens to hash into this epoch, which is not a test.
    expect(unpinned).toEqual([]);
  });

  it('does not accept a commented-out pin', () => {
    // The first version matched raw text, so a suite whose pin had been
    // commented out during debugging still satisfied the guard -- and a
    // commented-out pin is exactly the state that produces the flake this file
    // exists to prevent. Prose alone never matched, because the pattern
    // requires an assignment; a commented-out ASSIGNMENT did.
    expect(pinsTheArm('// remember to set TOKEN_OPTIMIZER_HOLDOUT')).toBe(false);
    expect(pinsTheArm("// process.env.TOKEN_OPTIMIZER_HOLDOUT = '0';")).toBe(false);
    expect(pinsTheArm("/* process.env.TOKEN_OPTIMIZER_HOLDOUT = '0'; */")).toBe(false);
    expect(pinsTheArm("process.env.TOKEN_OPTIMIZER_HOLDOUT = '0';")).toBe(true);
    expect(pinsTheArm("env: { TOKEN_OPTIMIZER_HOLDOUT: '1' }")).toBe(true);
  });
});
