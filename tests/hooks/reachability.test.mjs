/**
 * Nothing ships dead.
 *
 * The most expensive defect this project has produced twice is not wrong code.
 * It is CORRECT code that nothing calls. `forTouch` -- the just-in-time
 * injection the design calls "where the win lands" -- had 27 passing tests and
 * zero production call sites. The semantic harvest before it had the same shape:
 * implemented, validated, imported by no hook.
 *
 * NO OTHER TEST TECHNIQUE SEES THIS. Unit tests exercise the function directly,
 * so they pass. Mutation testing is actively misleading here: break an
 * unreachable function and its own tests fail, so the mutation is dutifully
 * scored as "caught" while the feature delivers nothing. Measured on this
 * repository, the suite scored 100% on ten realistic mutations during a period
 * when two whole features were unreachable.
 *
 * So this asks the one question those techniques cannot: is anything referenced
 * ONLY by its tests?
 *
 * SCOPE IS DELIBERATELY hooks-core AND plugin/hooks. Those are the live hook
 * path, where every verified instance of this defect has occurred, and where
 * every export is called by ordinary imports. `src/tools` is excluded because
 * its tools are dispatched by NAME through a registry, so a name-based scan
 * reports false positives there and a blocking check built on false positives
 * gets disabled within a week.
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join, relative } from 'path';
import {
  DECLARE_DIRS,
  USAGE_DIRS,
  walk,
  stripComments,
  stripSpecifiers,
} from '../fixtures/source-scan.mjs';

const REPO = process.cwd();

const TEST_DIRS = ['tests'];

/**
 * Exports that legitimately have no in-repo caller.
 *
 * EVERY ENTRY NEEDS A REASON. An allowlist without one becomes a place to
 * silence the check, which is how the thing it guards against happened in the
 * first place. If the reason is "we might use it later", the honest action is
 * to delete the function and write it again when that day comes.
 */
const ALLOWED = new Map([
  // ------------------------------------------------------------------
  // TRIAGE BACKLOG -- investigated, with the evidence recorded.
  //
  // The first pass listed 21. Widening USAGE_DIRS to scripts/ and to all of
  // plugin/ cleared four of them: wirePlan and unwire are called by
  // scripts/wire-hooks.mjs and scripts/uninstall.mjs, and writeManifest and
  // touchedPaths resolved too -- the latter by being DELETED, since it was a
  // compatibility shim over touchedFiles with no caller but its own test.
  //
  // The first correction attempt over-generalised from that discovery and
  // assumed auditFindings, recordRefresh and manifestSize were also
  // script-called. They are not: each appears exactly once, as its own
  // declaration. They are listed below as the orphans they are.
  //
  // Each survivor was then traced to find whether its OUTPUT has a consumer,
  // which is the question that separates "unwired feature" from "dead code".
  // The guard blocks anything new joining this list.
  // ------------------------------------------------------------------

  // The forTouch entry lived here and said "WIRED by the injection PR ... leaves
  // this list when that PR merges". The PR merged -- adapter.mjs and the
  // PreToolUse router both call it -- and the entry stayed for however long
  // after, which is what the assertion at the bottom of this file now prevents:
  // an excuse that outlives its defect reads as a live one.

  // THE FORECAST IS WIRED, so nothing from it is listed here any more.
  // logForecast and calibrate are called by forecastPanel; forecastPanel and
  // worthSurfacing by surface.mjs; observeOutcome by surface.closeForecast; and
  // surface itself by the PreToolUse router and the PreCompact hook. Five
  // entries left this list at once, which is what wiring a whole feature looks
  // like -- and is why it was worth doing rather than annotating.

  // WHAT IS LEFT IS PLAN 2'S, AND ONLY PLAN 2'S.
  //
  // renderStanding and manifestSize left this list by being WIRED, not by being
  // re-described: renderStanding renders the standing-context panel inside
  // renderAudit, and manifestSize reports the install footprint in the doctor's
  // manifest check. Both have tests asserting a reader reaches the output,
  // because this guard can only see that the NAME is referenced.
  //
  // The five below are owned by Plan 2 (production and measurement), in
  // progress in parallel, and are attributed rather than triaged again. The
  // assertion at the bottom of this file holds the count to a ceiling that can
  // only fall, and refuses any entry that is neither one of these five nor
  // genuine public API.

  // THE FOUR THAT REMAIN HAVE NO PRODUCING ACTION TO ATTACH TO, and that is a
  // measured statement rather than a deferral. Each was checked against the
  // codebase before being left here.
  //
  // CONSOLIDATION. forecast.mjs calls aggregateConsolidation, so the module is
  // partly live -- but `grep` finds no caller anywhere that decides WHAT to
  // consolidate or WHEN a consolidation pass runs. `selectForConsolidation`
  // chooses candidates for a pass that does not exist; `consolidationRatio`
  // reports what that pass bought and would return null forever without it.
  // Plan 2's derive.mjs, running at Stop, is that pass. Wiring either here
  // would mean building it twice.
  ['selectForConsolidation', 'UNWIRED, PLAN 2 TASK 4: chooses what to promote into the graph; verified -- no caller anywhere decides when a consolidation pass runs.'],
  ['consolidationRatio', 'UNWIRED, PLAN 2 TASK 8: reports what consolidation bought, and cannot report on a selection that never happens.'],

  // HALF A FEEDBACK LOOP, and the missing half is an ACTION, not a reader.
  // shouldKeepWarm is called by cache-tool.ts and prints its verdict; nothing
  // in this repository ever performs a keep-warm ping. So `recordRefresh`
  // records an event that never occurs, and calling it at the DECISION point --
  // the only place a caller exists today -- would write refreshes that never
  // happened into the ledger `tripwire` reads to decide whether keep-warm is
  // losing money. Fabricated evidence in a backstop is worse than a dead
  // function, so these stay until the refresh itself exists (Plan 2 Task 9).
  ['recordRefresh', 'UNWIRED, PLAN 2 TASK 9: records a keep-warm refresh; verified -- nothing in the repository performs one, so a caller would fabricate the event.'],
  ['recordRefreshOutcome', 'UNWIRED, PLAN 2 TASK 9: scores whether a refresh paid off; same missing producer, and it feeds the tripwire ledger.'],

  // ------------------------------------------------------------------
  // The policyText entry lived here as "GENUINE PUBLIC API", and it was stale
  // in the same way forTouch was: adapter.mjs and the SessionStart hook both
  // call it, so it was never an orphan needing an excuse. Being public API and
  // having an in-repo caller are independent, and only the second is what this
  // list is for.
  // ------------------------------------------------------------------
]);


const declareFiles = DECLARE_DIRS.flatMap((d) => walk(join(REPO, d)));
const usageFiles = USAGE_DIRS.flatMap((d) => walk(join(REPO, d)));
const testFiles = TEST_DIRS.flatMap((d) => walk(join(REPO, d)));

const declarations = declareFiles.map((f) => ({ file: f, text: readFileSync(f, 'utf8') }));
const usages = usageFiles.map((f) => ({ file: f, text: readFileSync(f, 'utf8') }));
const testText = testFiles.map((f) => readFileSync(f, 'utf8')).join('\n');

/**
 * Every `export function` / `export async function` / `export const` in the live path.
 *
 * CONSTS WERE INVISIBLE, and that is where the second-worst instance hid. The
 * collector matched only `export function`, so 56 exported consts went
 * unchecked -- among them `EDGE_KINDS` in hooks-core/wiki.mjs, which declared
 * `contradicts` and `answers` as edge kinds of this graph while nothing in the
 * repository ever wrote either one. A declaration nothing writes is the same
 * defect as a function nothing calls, and it was outside the scan's model.
 *
 * MEASURED FALLOUT of adding them: zero new orphans. The 56 that were never
 * checked are, as it happens, all reachable -- but they were not KNOWN to be,
 * and now a new one cannot arrive unnoticed.
 */
function exportedNames() {
  const found = [];
  for (const { file, text } of declarations) {
    // Stripped, so a name written only in prose cannot be collected as a
    // declaration either -- the same rule the usage side already follows.
    const code = stripComments(text);
    let m;
    const fnRe = /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g;
    while ((m = fnRe.exec(code)) !== null) found.push({ name: m[1], file });
    const constRe = /export\s+const\s+([A-Za-z_$][\w$]*)/g;
    while ((m = constRe.exec(code)) !== null) found.push({ name: m[1], file });
  }
  return found;
}

/**
 * Referenced anywhere that ships, other than its own declaration?
 *
 * A bare word match over CODE, deliberately. Anything cleverer would need to
 * resolve the dynamic `mods.<module>.<fn>` handles that src/server uses, and a
 * check that is wrong in the permissive direction is merely useless -- one that
 * is wrong in the strict direction fails CI on working code and gets deleted.
 * COMMENTS are removed first, because prose is not a caller. Strings are NOT --
 * see stripComments in tests/fixtures/source-scan.mjs for the two measurements
 * IMPORT SPECIFIERS are removed too, because an import is not a call site --
 * see stripSpecifiers there.
 *
 * STRIPPED ONCE PER FILE, not once per name: this runs over ~300 files times
 * ~350 exported names, and re-stripping per name is the difference between a
 * suite that runs in under a second and one nobody waits for.
 */
const codeOnly = new Map();
function shippedCode(file, text) {
  if (!codeOnly.has(file)) codeOnly.set(file, stripSpecifiers(stripComments(text)));
  return codeOnly.get(file);
}

// AN IN-FILE CALLER STILL COUNTS, and the attempt to change that is worth recording. Excluding
// the declaring file outright -- on the reasoning that `reliability` passed only because
// `calibrate` calls it from the same module -- reported 40+ false orphans in one run, among them
// burnRate, runway and shadowAvoided, which forecastPanel calls from inside forecast.mjs. Those
// are genuinely reached; reachability propagates THROUGH an in-file caller. The real defect in the
// reliability case was that its whole module had no importer, which is a module-level question
// this function cannot answer and should not try to.
function usedInShippedCode(name, declaringFile) {
  const word = new RegExp(`\\b${name}\\b`, 'g');
  // Subtracts the declaration itself, in BOTH forms -- a const that discounted
  // only `export function NAME` would be credited with a use by its own
  // declaration line and could never be reported, which would make collecting
  // consts at all a no-op dressed as coverage.
  const decl = new RegExp(
    `export\\s+(?:(?:async\\s+)?function|const)\\s+${name}\\b`,
    'g'
  );
  for (const { file, text } of usages) {
    const code = shippedCode(file, text);
    const uses = (code.match(word) || []).length;
    const declared = file === declaringFile ? (code.match(decl) || []).length : 0;
    if (uses - declared > 0) return true;
  }
  return false;
}

describe('every exported function in the live hook path is reachable', () => {
  const exports = exportedNames();

  it('found something to check, so a broken scan cannot pass silently', () => {
    // A scan that matches nothing would report a clean bill of health forever.
    expect(declareFiles.length).toBeGreaterThan(10);
    expect(usageFiles.length).toBeGreaterThan(declareFiles.length);
    expect(exports.length).toBeGreaterThan(30);
    expect(testFiles.length).toBeGreaterThan(10);
  });

  it('has no function that only its own tests call', () => {
    const orphans = exports
      .filter(({ name }) => !ALLOWED.has(name))
      .filter(({ name, file }) => !usedInShippedCode(name, file))
      .filter(({ name }) => new RegExp(`\\b${name}\\b`).test(testText))
      .map(({ name, file }) => `${relative(REPO, file)}: ${name}`);

    // This is the forTouch shape exactly: tested, correct, and called by
    // nothing that ships. If this fails, either wire the function up or delete
    // it -- and if it is genuinely public API, add it to ALLOWED with a reason.
    expect(orphans).toEqual([]);
  });

  it('has no function that nothing references at all', () => {
    const dead = exports
      .filter(({ name }) => !ALLOWED.has(name))
      .filter(({ name, file }) => !usedInShippedCode(name, file))
      .filter(({ name }) => !new RegExp(`\\b${name}\\b`).test(testText))
      .map(({ name, file }) => `${relative(REPO, file)}: ${name}`);

    // Worse than the above: not even a test claims to want it.
    expect(dead).toEqual([]);
  });

  it('keeps the allowlist honest', () => {
    // An entry that no longer exists is a stale excuse, and a reason that says
    // nothing is not a reason.
    const declaredAt = new Map(exports.map((e) => [e.name, e.file]));
    for (const [name, reason] of ALLOWED) {
      expect(typeof reason).toBe('string');
      expect(reason.length).toBeGreaterThan(20);
      expect(declaredAt.has(name) || /constant|API/i.test(reason)).toBe(true);

      // AND THE LIST ONLY SHRINKS. An entry for a function that shipped code
      // now calls is exactly as stale as one for a function that no longer
      // exists, and nothing removed it -- so the excuse outlives the defect it
      // described and the list grows monotonically, which is how "the guard
      // blocks anything new joining this list" stops being true.
      const file = declaredAt.get(name);
      if (file) expect([name, usedInShippedCode(name, file)]).toEqual([name, false]);
    }
  });

  it('keeps the allowlist shrinking, and refuses a new backlog entry', () => {
    // THE LIST IS NOT A BACKLOG. Round 1 built this detector, it found ~21
    // unreachable capabilities, four were wired and sixteen were parked here
    // with accurate descriptions of what was wrong with them -- and an accurate
    // description of a defect felt like resolution. Plan 1 took it to seven.
    //
    // A CEILING RATHER THAN ZERO, and the difference is deliberate. Four of the
    // seven are owned by Plan 2 (production and measurement), which is in
    // progress in parallel: selectForConsolidation by its Task 4,
    // consolidationRatio by its Task 8, recordRefresh and recordRefreshOutcome
    // by its Task 9 -- and each was verified to have no producing ACTION to
    // attach to, not merely no caller. Asserting zero here would ship a test
    // that is RED until someone else's PR merges, and a suite that is expected
    // to be red teaches everyone to ignore it -- the same disease in a new
    // organ. So this asserts the number can only fall, and names who owes what.
    // When Plan 2 lands, this drops to 0 and the ceiling comes with it.
    expect(ALLOWED.size).toBeLessThanOrEqual(4);

    const PLAN_2 = [
      'selectForConsolidation',
      'consolidationRatio',
      'recordRefresh',
      'recordRefreshOutcome',
    ];
    // Everything still listed must be attributable. An entry that is neither
    // Plan 2's nor genuine public API is a backlog entry, which is the thing
    // this whole file exists to refuse.
    const unattributed = [...ALLOWED.entries()]
      .filter(([name]) => !PLAN_2.includes(name))
      .filter(([, reason]) => !/^PUBLIC API/.test(reason))
      .map(([name]) => name);
    expect(unattributed).toEqual([]);
  });
});

describe('the scan does not mistake prose for a call site', () => {
  // PINNED, not newly fixed. stripComments already did this -- these assertions
  // exist because the boundary is load-bearing and was moved twice, each time
  // by someone reasonable who had not seen the measurement. A guard that reads
  // documentation as code is worse than no guard: it is a clean bill of health
  // nobody re-examines.
  it('ignores a name that appears only in a line comment', () => {
    const text = [
      '// A write the hook observes is invalidated eagerly by someOrphanFn, so',
      'export function other() { return 1; }',
    ].join('\n');
    expect(stripComments(text)).not.toContain('someOrphanFn');
  });

  it('ignores a name inside a block comment', () => {
    expect(stripComments('/* calls someOrphanFn */ const x = 1;')).not.toContain(
      'someOrphanFn'
    );
  });

  it('keeps real code intact, including a URL that contains a double slash', () => {
    // THE TRAP. A naive line-comment regex truncates at the `//` inside
    // `https://`, blinding the scan to everything after any URL in the file --
    // a silent permissive failure, which is exactly the class this guard exists
    // to prevent.
    const code = "const url = 'https://example.com/x'; realCall();";
    const stripped = stripComments(code);
    expect(stripped).toContain('realCall');
    expect(stripped).toContain('example.com');
  });

  it('still sees a name written inside a string literal', () => {
    // THE OTHER SIDE OF THE SAME BOUNDARY, asserted so it cannot drift. Strings
    // are NOT stripped, because src/server dispatches hooks-core through
    // dynamic `mods.<module>.<fn>` handles and a scanner that skips strings
    // desynchronises on the first regex literal containing a quote -- see
    // stripComments for the measurement. Over-counting a name in a string is
    // the permissive direction, and that is the safe one here.
    expect(stripComments("const h = 'realCall';")).toContain('realCall');
  });
});

describe('an import is not a call site', () => {
  it('discounts an import specifier', () => {
    const code = "import { cacheOrdered } from './cache.mjs';\nconst x = 1;";
    expect(stripSpecifiers(code)).not.toContain('cacheOrdered');
  });

  it('discounts a re-export specifier', () => {
    expect(stripSpecifiers("export { cacheOrdered } from './cache.mjs';")).not.toContain(
      'cacheOrdered'
    );
  });

  it('leaves a real call intact, and the module path alone', () => {
    const code = "import { cacheOrdered } from './cache.mjs';\nreturn cacheOrdered(items);";
    const stripped = stripSpecifiers(code);
    expect(stripped).toContain('cacheOrdered(items)');
    // Exactly one survivor: the call. The specifier is gone.
    expect((stripped.match(/\bcacheOrdered\b/g) || []).length).toBe(1);
  });

  it('leaves a default and a namespace import alone', () => {
    // Not the specifier case: both bind a name that ordinary code must then
    // call, so blanking them would move the guard in the strict direction for
    // no measured defect.
    const code = "import os from 'os';\nimport * as wiki from './wiki.mjs';";
    const stripped = stripSpecifiers(code);
    expect(stripped).toContain('os');
    expect(stripped).toContain('wiki');
  });
});

describe('exported consts are checked, not just functions', () => {
  it('collects an exported const', () => {
    const names = exportedNames().map((e) => e.name);
    // EDGE_KINDS is an exported const in hooks-core/wiki.mjs. While the
    // collector saw only `export function`, 56 declarations went unchecked --
    // and that is where `contradicts` and `answers` sat, declared as edge kinds
    // of this graph with zero write sites anywhere in the repository.
    expect(names).toContain('EDGE_KINDS');
  });

  it('collects enough of them that a broken const pattern cannot pass silently', () => {
    const wiki = exportedNames().filter(({ file }) => /wiki\.mjs$/.test(file));
    expect(wiki.length).toBeGreaterThan(1);
    expect(exportedNames().length).toBeGreaterThan(300);
  });
});
