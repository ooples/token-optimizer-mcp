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

  // WIRED ELSEWHERE -- leaves this list when that PR merges.
  ['forTouch', 'WIRED by the injection PR: just-in-time delivery, imported by nothing before it.'],

  // CALIBRATION, HALF-RESOLVED. logForecast and calibrate are now called by
  // forecastPanel, so the prediction side of the loop runs and those two have
  // left this list. observeOutcome has not: nothing observes the ground truth,
  // which arrives when compaction fires. The natural caller is the PreCompact
  // hook, which needs a turn count it does not currently compute.
  ['observeOutcome', 'UNWIRED HALF: records the outcome half. The prediction half now runs; the PreCompact hook does not yet supply actualTurns.'],

  // FORECAST DISPLAY. The calibration behind it now runs, but the panel itself
  // still has no shipped caller -- so nothing renders it and nothing decides
  // when to. Wiring the loop did not change that, and saying otherwise would be
  // the exact failure this file exists to catch.
  ['forecastPanel', 'UNWIRED: the calibration loop behind it now runs, but no hook or tool renders the panel.'],
  ['worthSurfacing', 'UNWIRED: decides whether a forecast change is worth showing; nothing shows it yet.'],

  // SURFACED BY TIGHTENING THE SCAN. Previously counted as reachable only
  // because the bare word match read comment prose as a call site. Verified
  // orphaned: in shipped code it appears as its own declaration plus two
  // mentions in comments, and its only importer is a test.
  ['sessionIndex', 'UNWIRED: lists graph keys and truncated claims for a session. Found by the comment-stripping fix; only a test imports it.'],

  // CONSOLIDATION. forecast.mjs imports aggregateConsolidation from this module,
  // so it is partly live -- but the selection, the ratio and the content anchor
  // are not reached, meaning nothing ever decides WHAT to consolidate.
  ['selectForConsolidation', 'UNWIRED: chooses what to promote into the graph; no caller decides when consolidation runs.'],
  ['consolidationRatio', 'UNWIRED: reports what consolidation bought, and cannot report on a selection that never happens.'],
  ['contentAnchor', 'UNWIRED: content-based anchoring, additive to path anchoring; no caller.'],

  // HALF A FEEDBACK LOOP. shouldKeepWarm and keepWarmDecision are reachable;
  // the outcome half that would tell them whether a refresh ever paid off is
  // not, so the decision can never learn.
  ['recordRefreshOutcome', 'UNWIRED: records whether a keep-warm refresh was worth it; the deciding half runs without it.'],

  // SINGLETONS still to be traced.
  ['cacheOrdered', 'UNWIRED: confines cache invalidation to the tail. A real optimisation with no caller.'],
  ['invalidateOnWrite', 'UNWIRED: the eager staleness path; invalidation currently happens only lazily, on the next touch.'],
  ['renderStanding', 'UNWIRED: renders the standing-context audit. auditStanding IS reachable, so only the report is orphaned.'],
  ['auditFindings', 'UNWIRED: audits stored findings. Verified orphaned -- appears once, as its own declaration.'],
  ['recordRefresh', 'UNWIRED: records that a keep-warm refresh happened; pairs with recordRefreshOutcome, and neither is reached.'],
  ['manifestSize', 'UNWIRED: measures the installation manifest. Verified orphaned, and untested as well.'],

  // ------------------------------------------------------------------
  // GENUINE PUBLIC API.
  // ------------------------------------------------------------------
  ['policyText', 'PUBLIC API: shared client briefing, consumed by every non-Claude adapter.'],
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
 * Comments and strings are removed first: they are prose, and prose is not a
 * caller.
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
    const names = new Set(exports.map((e) => e.name));
    for (const [name, reason] of ALLOWED) {
      expect(typeof reason).toBe('string');
      expect(reason.length).toBeGreaterThan(20);
      expect(names.has(name) || /constant|API/i.test(reason)).toBe(true);
    }
  });
});
