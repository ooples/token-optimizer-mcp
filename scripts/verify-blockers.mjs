/**
 * Proves each pre-plan blocker is actually closed, one check per item.
 *
 * WHY THIS IS A SCRIPT AND NOT A CHECKLIST. Every item below was already
 * "verified" once in prose, and prose does not re-run. Two of those prose
 * verdicts turned out to be wrong when something finally executed them -- the
 * scope leak was narrower than written, and the competitor's missing text model
 * was not the cause it was claimed to be. A claim that cannot be re-run is a
 * memory, so this is the re-runnable form.
 *
 *   node scripts/verify-blockers.mjs
 *
 * Exits non-zero naming every item it cannot prove. Checks that would cost
 * minutes or money (the full jest suite, the paid accuracy run) are reported as
 * DEFERRED with the command that settles them, rather than silently skipped --
 * a skipped check that prints nothing is how a checklist starts lying.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/**
 * Runs a command, returning {ok, out}. Never throws.
 *
 * NEVER `npm` HERE. execFileSync cannot launch it on Windows -- bare `npm`
 * is ENOENT because it is a .cmd shim rather than an executable, and
 * `npm.cmd` is EINVAL under Node 22 without a shell. Both failures arrive
 * as an exception, which this function reports as a failed CHECK, so the
 * first version of this script invented two blocker failures whose
 * underlying commands pass by hand. Call what the package scripts call.
 */
function run(cmd, args) {
  try {
    const out = execFileSync(cmd, args, {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 900_000,
    });
    return { ok: true, out };
  } catch (err) {
    return {
      ok: false,
      out: `${err.stdout || ''}${err.stderr || ''}` || String(err.message),
    };
  }
}

const results = [];
const check = (id, what, fn) => {
  let verdict;
  try {
    verdict = fn();
  } catch (err) {
    verdict = { state: 'FAIL', detail: `check threw: ${err.message}` };
  }
  results.push({ id, what, ...verdict });
};
const pass = (detail) => ({ state: 'PASS', detail });
const fail = (detail) => ({ state: 'FAIL', detail });
const deferred = (detail) => ({ state: 'DEFERRED', detail });

// ---------------------------------------------------------------- B1
check('B1', 'project findings cannot leak across repos', () => {
  const inject = read('hooks-core/inject.mjs');
  if (!inject.includes('TRANSFERABLE_SCOPES')) {
    return fail('hooks-core/inject.mjs has no scope gate');
  }
  // A hooks-core fix does not ship until the vendored copies match it: each
  // client executes its own copy, and the fix was inert for all of them until
  // sync:hooks ran. This is the check that caught that.
  // Exactly what `npm run sync:hooks:check` chains, without npm.
  for (const script of [
    'sync-hook-core.mjs',
    'generate-client-entries.mjs',
    'generate-client-configs.mjs',
    'pin-mcp-version.mjs',
  ]) {
    const r = run(process.execPath, [join('scripts', script), '--check']);
    if (!r.ok) return fail(`${script} --check reports drift`);
  }
  const vendored = read('plugin/hooks/lib/inject.mjs');
  if (!vendored.includes('TRANSFERABLE_SCOPES')) {
    return fail('the vendored core does not carry the gate');
  }
  return pass('gate present in hooks-core and every vendored copy; sync check clean');
});

// ---------------------------------------------------------------- B2
check('B2', 'the cache-weighted gate is green and not vacuous', () => {
  const proof = run(process.execPath, ['bench/compression/proof.mjs']);
  if (!proof.ok) return fail('proof.mjs exits non-zero');
  const gates = [
    'NEEDLE GATE PASSED',
    'RELEVANCE GATE PASSED',
    'STEADY GATE PASSED',
    'GATE PASSED on all workloads',
  ].filter((g) => !proof.out.includes(g));
  if (gates.length) return fail(`missing: ${gates.join(', ')}`);
  const src = read('bench/compression/proof.mjs');
  if (!src.includes('strictWins')) {
    return fail('the relaxed comparison has no strict-win guard, so it can pass on an inert engine');
  }
  return pass('all five gates pass; the tie relaxation is paid for by a strict-win guard');
});

// ---------------------------------------------------------------- B3
check('B3', 'the published table is reproducible by its harness', () => {
  const t = run(process.execPath, ['bench/compression/readme-table.check.mjs']);
  if (!t.ok) return fail('README figures disagree with the harness');
  if (!t.out.includes('README TABLE AGREES')) return fail('check did not confirm agreement');
  return pass(t.out.trim().split('\n').slice(-2).join(' | '));
});

// ---------------------------------------------------------------- B4 / B5
check('B4', 'codebase-exploration is not claimed as a win', () => {
  const r = read('README.md');
  // THE PROPERTY, NOT THE VERDICT. This first asserted the row reads
  // "parity", which was true of the branch this work began on and false on
  // master, where the figure is 46.0% against their 47.4%. A check pinned to
  // one verdict breaks on an honest re-measurement, so it pins the two things
  // that hold whichever way the number moves: the row is never in the win
  // column, and the tally is never counted over workloads.
  const row = r.match(/^\|\s*codebase-exploration\s*\|.*$/im);
  if (!row) return fail('the row is not in the table at all');
  if (/\|\s*ours\s*\|/i.test(row[0])) {
    return fail(`claimed as a win: ${row[0].trim()}`);
  }
  if (!/\|\s*(parity|theirs)\s*\|/i.test(row[0])) {
    return fail(`verdict is neither parity nor theirs: ${row[0].trim()}`);
  }
  if (/ours on 7 of 8|ours on 8 of 8/.test(r)) {
    return fail('the old over-workload tally is still published');
  }
  if (!/published comparators/.test(r)) {
    return fail('the tally does not say it counts over comparators');
  }
  return pass(`not a win (${row[0].trim()}); tally reads over comparators`);
});

check('B5', 'every reduction claim carries the retention claim', () => {
  const r = read('README.md');
  const hasReduction = r.includes('91.5%') || /97\.\d%/.test(r);
  if (!hasReduction) return fail('no reduction figure found to qualify');
  if (!(r.includes('1,890') && r.includes('345'))) {
    return fail('the retention counts are not beside it');
  }
  if (!/0\.94x/.test(r)) return fail('the spill size is not disclosed');
  return pass('retention counts and spill size published next to the reduction');
});

// ---------------------------------------------------------------- B6
check('B6', 'task accuracy is measured against a baseline arm', () => {
  if (!existsSync(join(ROOT, 'bench/accuracy/squad-eval.mjs'))) {
    return fail('no accuracy harness');
  }
  const src = read('bench/accuracy/squad-eval.mjs');
  const needs = [
    ['baseline arm', 'baselineOk'],
    ['a vacuity gate on compression', 'MIN_MEAN_REDUCTION'],
    ['ground-truth scoring', 'function correct'],
    ['article diversity', 'byTitle'],
  ].filter(([, token]) => !src.includes(token));
  if (needs.length) {
    return fail(`harness lacks: ${needs.map(([n]) => n).join(', ')}`);
  }
  return deferred(
    'harness present with all four safeguards. Last measured n=30: 53.8% mean ' +
      'reduction, baseline 0.933, ours 0.967. Re-run: node bench/accuracy/squad-eval.mjs --n 30'
  );
});

// ---------------------------------------------------------------- B7
check('B7', 'the false control-arm claim is gone', () => {
  const g = read('docs/COMPETITIVE_GAPS.md');
  if (g.includes('claim they cannot make')) return fail('the false line is still there');
  if (!g.includes('HEADROOM_OUTPUT_HOLDOUT')) {
    return fail('the correction does not name their holdout');
  }
  if (!/COMPETITOR_HEADROOM\.md/.test(g)) {
    return fail('nothing points a reader at the actual HeadRoom analysis');
  }
  return pass('false line removed, their holdout named, cross-reference in place');
});

// ---------------------------------------------------------------- B8
check('B8', 'the retracted competitor caveat is retracted where it is read', () => {
  const f = read('bench/compression/fixtures.mjs');
  if (!f.includes('CORRECTION, 2026-09-21')) {
    return fail('fixtures.mjs still presents the warning as a setup error');
  }
  const doc = read('docs/COMPETITOR_HEADROOM.md');
  if (!doc.includes('RETRACTED')) {
    return fail('the report still hands a reader the withdrawn caveat');
  }
  return pass('corrected in the fixtures and retracted in place in the report');
});

// ---------------------------------------------------------------- B9
check('B9', 'the frozen comparators carry provenance', () => {
  const f = read('bench/compression/fixtures.mjs');
  if (!f.includes('PROVENANCE OF EVERY')) return fail('no provenance block');
  if (!f.includes('capture date is NOT RECORDED')) {
    return fail('provenance does not admit the unknown capture date');
  }
  const seen = (f.match(/`theirs` provenance: see the note/g) || []).length;
  if (seen < 3) return fail(`only ${seen} of the other comparators point at it`);
  return pass('provenance block plus pointers on every other comparator');
});

// ---------------------------------------------------------------- B10
check('B10', 'ndjson is compressed, and damaged json still refused', () => {
  const probe = `
    import('./dist/compress/json.js').then(j => {
      const rows = Array.from({length:300},(_,i)=>({ts:'t'+i,level:i===7?'ERROR':'INFO',
        logger:'scheduler',message:'job_'+i,service:'bench',host:'w'+(i%8),trace:'tr'+i}));
      const nd = rows.map(r=>JSON.stringify(r)).join('\\n');
      const spill = (c,h) => '.spill/'+h;
      const out = j.compressJson(nd, { spill, query:'which host errored?' });
      const ratio = 1 - out.text.length / nd.length;
      const lines = nd.split('\\n'); lines[57] = '{"ts":"broken';
      const damaged = lines.join('\\n');
      const refused = j.compressJson(damaged,{spill,query:'x'}).text === damaged;
      console.log(JSON.stringify({ ratio, kept: out.text.includes('ERROR'), refused }));
    });`;
  const r = run(process.execPath, ['-e', probe]);
  if (!r.ok) return fail(`probe failed: ${r.out.slice(0, 200)}`);
  const m = r.out.match(/\{.*\}/);
  if (!m) return fail(`probe printed nothing usable: ${r.out.slice(0, 200)}`);
  const { ratio, kept, refused } = JSON.parse(m[0]);
  if (ratio < 0.5) return fail(`ndjson reduction only ${(ratio * 100).toFixed(1)}%`);
  if (!kept) return fail('the anomalous ERROR row was destroyed');
  if (!refused) return fail('a damaged document was rewritten — the guard is gone');
  return pass(
    `ndjson ${(ratio * 100).toFixed(1)}% reduction, ERROR row kept, damaged document refused`
  );
});

// ---------------------------------------------------------------- B11
check('B11', "the competitor clone is out of our test run", () => {
  const cfg = read('jest.config.js');
  if (!cfg.includes('.codex/')) return fail('.codex/ is not ignored by jest');
  return pass('<rootDir>/.codex/ is in testPathIgnorePatterns');
});

// ---------------------------------------------------------------- B12
check('B12', 'the launch suite is hermetic and green', () => {
  const src = read('tests/hooks/launch-version-pin.test.mjs');
  if (!src.includes('scrubbedEnv')) {
    return fail('the suite still inherits TOKEN_OPTIMIZER_* from the shell');
  }
  if (!src.includes('an inherited pin from the developer shell does not reach the shim')) {
    return fail('nothing guards the hermeticity, so the leak can return unnoticed');
  }
  // Run it WITH the leak present, which is the condition that used to fail.
  // jest directly, with the flag package.json's `test` script passes --
  // without it more than half this repo's suites cannot even load.
  const r = run(process.execPath, [
    '--experimental-vm-modules',
    join('node_modules', 'jest', 'bin', 'jest.js'),
    'tests/hooks/launch-version-pin.test.mjs',
  ]);
  if (!r.ok) return fail(`the suite is red: ${r.out.slice(-300)}`);
  return pass('green, with a guard that exports a pin and requires it to be ignored');
});

// ---------------------------------------------------------------- report
const w = Math.max(...results.map((r) => r.what.length));
console.log('Pre-plan blockers — verification\n');
for (const r of results) {
  const tag =
    r.state === 'PASS' ? 'PASS    ' : r.state === 'FAIL' ? 'FAIL    ' : 'DEFERRED';
  console.log(`${tag}  ${r.id.padEnd(4)} ${r.what.padEnd(w)}  ${r.detail}`);
}

const failures = results.filter((r) => r.state === 'FAIL');
const defers = results.filter((r) => r.state === 'DEFERRED');
console.log(
  `\n${results.length - failures.length - defers.length} proved, ` +
    `${defers.length} deferred, ${failures.length} failed`
);
console.log(
  'Not covered here, because it needs the whole suite: run `npm test` and require zero failures.'
);
if (failures.length) process.exitCode = 1;
