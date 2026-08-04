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
 */
const USAGE_DIRS = ['hooks-core', 'plugin/hooks', 'src'];
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
  // TRIAGE BACKLOG -- the state of the repository when this guard landed.
  //
  // Every entry here is a feature that is implemented, mostly tested, and
  // reachable from nothing. They are listed rather than silently ignored so
  // the number is visible and can only go down: the guard blocks anything NEW
  // joining this list, which is what stops the forTouch shape recurring while
  // the existing cases are worked through.
  //
  // Each carries the verdict, not just a description. "Investigate" is a
  // verdict too, but a dated one -- an entry that says nothing is how an
  // allowlist turns into a silencer.
  // ------------------------------------------------------------------

  // WIRE -- the feature is wanted and the delivery path is the missing half.
  ['forTouch', 'WIRE: just-in-time injection, the design calls it "where the win lands". Wired by the injection PR; this entry goes when that merges.'],
  ['linkCoOccurrence', 'WIRE: builds the `related` edges that EDGE_KINDS declares and nothing produces, so traversal has no semantic neighbourhood.'],
  ['invalidateOnWrite', 'WIRE: the eager staleness path. Without it a finding is only invalidated lazily, on the next touch of its anchor.'],

  // INVESTIGATE -- plausible features whose intended caller is not obvious.
  ['selectForConsolidation', 'INVESTIGATE: promotes findings into the graph under a budget. Needs a decision on when consolidation should run at all.'],
  ['consolidationRatio', 'INVESTIGATE: reports what consolidation bought. Useless until selectForConsolidation has a caller.'],
  ['contentAnchor', 'INVESTIGATE: content-based anchoring, additive to path anchoring. Unclear whether it was finished.'],
  ['logForecast', 'INVESTIGATE: half of the forecast calibration loop; observeOutcome is the other half and is equally unreachable.'],
  ['observeOutcome', 'INVESTIGATE: records what actually happened against a forecast. Calibration cannot work while neither half runs.'],
  ['forecastPanel', 'INVESTIGATE: renders the forecast. Depends on the same unrun calibration loop.'],
  ['worthSurfacing', 'INVESTIGATE: decides whether a forecast change is worth showing. Same loop.'],
  ['recordRefresh', 'INVESTIGATE: keep-warm accounting, and untested as well as unreachable.'],
  ['recordRefreshOutcome', 'INVESTIGATE: records whether a keep-warm refresh bought anything.'],
  ['cacheOrdered', 'INVESTIGATE: confines cache invalidation to the tail. Real optimisation, no caller.'],
  ['touchedPaths', 'INVESTIGATE: superseded in practice by touchedFiles, which carries sizes. Likely a delete.'],
  ['restorationPlan', 'INVESTIGATE: builds the restoration block after a compaction.'],
  ['auditFindings', 'INVESTIGATE: untested and unreachable, which is the weakest combination in the list.'],
  ['manifestSize', 'INVESTIGATE: untested and unreachable.'],
  ['writeManifest', 'INVESTIGATE: records an installation. Probably belongs to an install path that calls it from a script rather than source.'],
  ['renderStanding', 'INVESTIGATE: renders the standing-context audit. auditStanding IS reachable, so only the renderer is orphaned -- likely a real gap.'],
  ['wirePlan', 'INVESTIGATE: installer planning. May be invoked from a bin script outside the scanned tree.'],
  ['unwire', 'INVESTIGATE: installer teardown, same question as wirePlan.'],

  // ------------------------------------------------------------------
  // GENUINE PUBLIC API -- consumed by other clients or by the MCP server.
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
 * Referenced anywhere that ships, other than its own declaration?
 *
 * A bare word match, deliberately. Anything cleverer would need to resolve the
 * dynamic `mods.<module>.<fn>` handles that src/server uses, and a check that
 * is wrong in the permissive direction is merely useless -- one that is wrong in
 * the strict direction fails CI on working code and gets deleted.
 */
function usedInShippedCode(name, declaringFile) {
  const word = new RegExp(`\\b${name}\\b`, 'g');
  const decl = new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b`, 'g');
  for (const { file, text } of usages) {
    const uses = (text.match(word) || []).length;
    const declared = file === declaringFile ? (text.match(decl) || []).length : 0;
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
