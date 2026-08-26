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
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const REPO = process.cwd();

/**
 * Where DECLARATIONS are collected: the live hook path only.
 *
 * `src/tools` is not scanned for declarations because its tools are dispatched
 * by NAME through a registry, so a name-based scan reports false positives
 * there, and a blocking check built on false positives gets disabled within a
 * week.
 */
const DECLARE_DIRS = ['hooks-core', 'plugin/hooks'];

/**
 * Where USAGES are searched: everything that ships.
 *
 * THIS MUST BE WIDER THAN THE DECLARATION SET. `src/server/*` reaches into
 * hooks-core through a dynamic `mods.<module>.<fn>` handle rather than a static
 * import, so scanning only the hook path reported `diagnose`, `renderFleet`,
 * `renderAudit` and `exportMarkdown` as unreachable while four MCP tools were
 * calling them. That first draft would have failed CI on working code -- the
 * fastest possible way to get a guard like this switched off.
 *
 * `scripts` is here for the same reason and was missed on the first pass:
 * wire-hooks and uninstall consume hooks-core/wire.mjs, so wirePlan and unwire
 * were reported dead while the installer and the uninstaller both called them.
 * Eleven files under scripts/ reference hooks-core. A check that scans only
 * where its author expected the callers to be measures the author, not the
 * code.
 */
const USAGE_DIRS = ['hooks-core', 'plugin', 'src', 'scripts'];
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

  // CONSOLIDATION. THREE entries have now left this list, each by a different
  // route. selectForConsolidation is WIRED: derive.mjs runs every candidate
  // through it before writeHarvested, so a session's storage is bounded.
  // contentAnchor was DELETED rather than left dormant -- the idea is preserved
  // as issue #319, because a second anchor identity interacts with the one
  // thing in this codebase that has already caused silent node-splitting, and
  // "we might use it later" is precisely the reason this list is not allowed to
  // hold. consolidationRatio is WIRED: crosslayer.mjs reads it per finding for
  // the graph balance sheet's consolidation section, which get_optimization_report
  // renders and the audit reaches. Its old excuse said "nothing stores the
  // derivedCost it needs" and that had gone stale -- expand.promote persists
  // derivedCost onto the finding node it creates, and src/server/disclosure.ts
  // calls it.

  // HALF A FEEDBACK LOOP, and the half that could be closed has been.
  // recordRefreshOutcome left this list: scoreRefreshes calls it for every
  // recorded refresh whose TTL has elapsed, the Stop hook calls scoreRefreshes,
  // and shouldKeepWarm now bounds both models by the rate that comes back. The
  // turn-arrival signal was already in the log gapDistribution is fitted to.
  //
  // recordRefresh could NOT be closed, and the finding is worth more than a
  // plausible call site would have been: NOTHING IN THIS REPOSITORY ISSUES A
  // REFRESH. cache_audit is the only consumer of the decision and it prints a
  // recommendation; no code sends the ping, because the prompt cache belongs to
  // the client. Calling this at the recommendation site would record refreshes
  // that were never bought, and the hit rate computed over them would make
  // keep-warm look like it pays for itself -- the exact measurement bias this
  // plan has now found nine times, every one flattering. So it stays orphaned,
  // deliberately, until an issuer exists to call it.

  // SINGLETONS still to be traced.
  ['renderStanding', 'UNWIRED: renders the standing-context audit. auditStanding IS reachable, so only the report is orphaned.'],
  ['recordRefresh', 'UNWIRED BY DESIGN: nothing in this repository issues a keep-warm refresh -- cache_audit only recommends one -- so there is no site that spends the money. scoreRefreshes scores whatever an issuer records.'],
  ['manifestSize', 'UNWIRED: measures the installation manifest. Verified orphaned, and untested as well.'],

  // ------------------------------------------------------------------
  // The policyText entry lived here as "GENUINE PUBLIC API", and it was stale
  // in the same way forTouch was: adapter.mjs and the SessionStart hook both
  // call it, so it was never an orphan needing an excuse. Being public API and
  // having an in-repo caller are independent, and only the second is what this
  // list is for.
  // ------------------------------------------------------------------
]);

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      // `lib` holds the GENERATED copies of hooks-core; scanning them would
      // make every function look used by its own duplicate.
      if (['node_modules', 'dist', 'lib', '.git'].includes(entry)) continue;
      walk(full, out);
    } else if (/\.(mjs|js|ts)$/.test(entry) && !/\.d\.ts$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const declareFiles = DECLARE_DIRS.flatMap((d) => walk(join(REPO, d)));
const usageFiles = USAGE_DIRS.flatMap((d) => walk(join(REPO, d)));
const testFiles = TEST_DIRS.flatMap((d) => walk(join(REPO, d)));

const declarations = declareFiles.map((f) => ({ file: f, text: readFileSync(f, 'utf8') }));
const usages = usageFiles.map((f) => ({ file: f, text: readFileSync(f, 'utf8') }));
const testText = testFiles.map((f) => readFileSync(f, 'utf8')).join('\n');

/** Every `export function NAME` / `export async function NAME` in the live path. */
function exportedFunctions() {
  const found = [];
  for (const { file, text } of declarations) {
    const re = /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g;
    let m;
    while ((m = re.exec(text)) !== null) found.push({ name: m[1], file });
  }
  return found;
}

/**
 * Strips comments, so prose cannot be mistaken for a call.
 *
 * THIS IS WHAT LET A DEAD PUBLIC ENTRY POINT THROUGH. `calibrate` counted as
 * reachable because curate.mjs:13 contains the English phrase "the reader's
 * ability to calibrate trust", and `reliability` counted because the word
 * appears in its own file's prose. calibration.mjs had ZERO importers -- no
 * forecast was ever logged, no outcome observed, and the shipped panel printed
 * precisely the uncalibrated number that module's docstring calls "a vibe with
 * a typeface" -- while the check that exists to catch exactly this reported it
 * as wired, on a coincidence of comment wording.
 *
 * A guard that reads documentation as code is worse than none: it is a clean
 * bill of health nobody re-examines. This module's files are heavily commented
 * by design, which makes the false-positive rate high rather than incidental.
 *
 * COMMENTS ONLY, NOT STRING LITERALS -- and that boundary was found the hard
 * way. Stripping quotes as well made `routingReport` and `modelSwitchCost` look
 * orphaned when routing-tool.ts calls both: three independent global passes
 * cannot nest, so an apostrophe inside a DOUBLE-quoted sentence opened a
 * "single-quoted string" that ran to the next apostrophe further down the file
 * and swallowed the real call sites in between.
 *
 * Getting that right needs a scanner, and this guard's own rule says why not to
 * build one: a check wrong in the permissive direction is merely useless, while
 * one wrong in the strict direction fails CI on working code and gets deleted.
 * The observed defect was comment prose, comments nest predictably, and that is
 * where the line belongs.
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')     // block comments, including docblocks
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 '); // line comments, sparing the // in a URL
}

/**
 * Referenced anywhere that ships, other than its own declaration?
 *
 * A bare word match over CODE, deliberately. Anything cleverer would need to
 * resolve the dynamic `mods.<module>.<fn>` handles that src/server uses, and a
 * check that is wrong in the permissive direction is merely useless -- one that
 * is wrong in the strict direction fails CI on working code and gets deleted.
 * COMMENTS are removed first, because prose is not a caller. Strings are NOT --
 * see stripComments above for the measurement that settled that boundary.
 */
const codeOnly = new Map();
function shippedCode(file, text) {
  if (!codeOnly.has(file)) codeOnly.set(file, stripComments(text));
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
  const decl = new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b`, 'g');
  for (const { file, text } of usages) {
    const code = shippedCode(file, text);
    const uses = (code.match(word) || []).length;
    const declared = file === declaringFile ? (code.match(decl) || []).length : 0;
    if (uses - declared > 0) return true;
  }
  return false;
}

describe('every exported function in the live hook path is reachable', () => {
  const exports = exportedFunctions();

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
});
