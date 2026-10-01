/**
 * DOES ANYTHING ACTUALLY RUN THE INSTRUMENT CHECKS?
 *
 * Every other file beside this one asks whether a scoring instrument is right.
 * This one asks the question underneath that: whether the check exists in a list
 * something executes. A check nothing runs is not a check, and the repository
 * had three of them.
 *
 * THE DEFECT THAT PUT THIS HERE. The roster lived twice -- once in the
 * `bench:instruments` npm script, once hand-enumerated in the CI job -- and the
 * two had drifted. `conservation.check.mjs`, `replicate-agreement.check.mjs` and
 * `ratchet.check.mjs` ran locally and nowhere in CI, so the content-conservation
 * oracle, the two-recording agreement rule and the ratchet's provenance rules
 * were all unguarded on every push. Nothing announced it: the CI job printed
 * fifteen green checks and exited 0, and fifteen green checks out of eighteen
 * looks exactly like eighteen unless you count them.
 *
 * SO THE ROSTER IS DERIVED, NOT WRITTEN DOWN. `bench:instruments` is the one
 * list; CI runs that script rather than a copy of it; and this check walks the
 * tree and refuses any `*.check.mjs` that list does not reach. A check added
 * tomorrow is therefore run by both without anybody remembering to add it, and a
 * check deliberately left out has to say where it runs instead -- a claim this
 * file verifies rather than repeats.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '../..');
const WORKFLOW = '.github/workflows/quality-gates.yml';
const RUNNER = 'bench:instruments';

/**
 * A check the roster deliberately does not carry, and the runner that carries it
 * instead. The value must appear in the workflow beside the path, so the excuse
 * is checked against CI and not merely asserted here.
 */
const RUNS_ELSEWHERE = {
  'bench/compression/must-win.check.mjs': 'must-win',
  'bench/compression/known-answer/capture.check.mjs': 'known-answer',
  'bench/compression/known-answer/scorer.check.mjs': 'known-answer-scorer',
  'bench/compression/proof-metrics.check.mjs': 'bench-proof',
  'bench/compression/readme-table.check.mjs': 'bench-proof',
  'bench/compression/readme-prose.check.mjs': 'bench-proof',
  // Moved out of the roster because they need a dependency the install-free job
  // does not have: `pretoken-proxy` tokenises with tiktoken AND imports dist/,
  // `bench/tools/reduction` tokenises with tiktoken. Both were green on a laptop
  // with a populated node_modules and ERR_MODULE_NOT_FOUND on a clean checkout.
  'bench/compression/pretoken-proxy.check.mjs': 'bench-proof',
  'bench/tools/reduction.check.mjs': 'bench-proof',
};

/**
 * A check that runs nowhere automatically, with the reason. This is the only
 * entry it is honest to have and it is printed on every run, because the cost of
 * forgetting one is a published figure nothing guards.
 */
const NOT_IN_CI = {
  'bench/compression/readme-headroom.check.mjs':
    'red today by design, on three counts -- 27 of the table figures and all 25 ' +
    'of the corpus figures are absent from the record, and the table does not name ' +
    'the record it was read from. All three need the README rewritten, and that ' +
    'edit is being held until the claims settle',
};

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.check.mjs'))
      out.push(relative(ROOT, full).split(String.fromCharCode(92)).join('/'));
  }
  return out;
};

let failed = 0;
const fail = (msg) => {
  failed++;
  console.log(`  FAIL ${msg}`);
};
const ok = (msg) => console.log(`  ok   ${msg}`);

const found = walk(join(ROOT, 'bench')).sort();
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const script = pkg.scripts?.[RUNNER] ?? '';
const listed = [...script.matchAll(/bench\/[\w./-]*\.check\.mjs/g)].map((m) => m[0]);
const workflow = readFileSync(join(ROOT, WORKFLOW), 'utf8');

// A DISCOVERY THAT FINDS NOTHING PASSES EVERY RULE BELOW. It has to find at
// least this file, since this file is one of the things it is looking for.
const SELF = 'bench/compression/instrument-roster.check.mjs';
if (!found.includes(SELF))
  fail(`the walk did not find this file -- it found ${found.length}, so the roster is not being read`);
else ok(`the walk found ${found.length} check file(s), including itself`);
if (!listed.length) fail(`the ${RUNNER} script names no check files at all`);

// RULE 1: every check on disk is reached by the runner, or says where else.
for (const path of found) {
  const where = listed.includes(path);
  const elsewhere = path in RUNS_ELSEWHERE;
  const excluded = path in NOT_IN_CI;
  if (Number(where) + Number(elsewhere) + Number(excluded) === 1) continue;
  if (where) fail(`${path} is in ${RUNNER} AND in one of the exception maps -- pick one`);
  else fail(`${path} is run by nothing: add it to ${RUNNER}, or name its runner`);
}
if (!failed) ok(`every check on disk is reached by ${RUNNER} or accounted for`);

// RULE 2: CI runs THE script, not a copy of the list. A hand-enumerated path in
// the workflow is how the two rosters drifted the first time.
const enumerated = [...workflow.matchAll(/bench\/[\w./-]*\.check\.mjs/g)]
  .map((m) => m[0])
  .filter((p) => listed.includes(p));
if (enumerated.length)
  fail(
    `${WORKFLOW} names ${enumerated.length} check file(s) that ${RUNNER} already ` +
      `runs (${enumerated[0]}...) -- run the script instead, or the two lists drift`
  );
else ok(`${WORKFLOW} does not re-enumerate the roster`);
if (!workflow.includes(`npm run -s ${RUNNER}`))
  fail(`${WORKFLOW} never runs \`npm run -s ${RUNNER}\``);
else ok(`${WORKFLOW} runs the roster through the script`);

/**
 * The lines of one top-level job, from its `  <id>:` header to the next one. The
 * exception map names a job, and the point of naming it is that the claim can be
 * checked -- which it cannot be against the whole file, where a path mentioned in
 * a comment, or run by a different job entirely, reads as covered.
 */
const jobBlock = (job) => {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => line === `  ${job}:`);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^  [\w-]+:$/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
};

// RULE 3: an exception must name a runner that exists and covers it. All three
// parts matter -- a job name with no such job, a job that no longer mentions the
// file, and a file named SOMEWHERE ELSE in the workflow than the job claimed, are
// the same failure as no runner at all. The last of those is why this reads one
// job's block and not the whole file: the map is an excuse, and an excuse checked
// against the wrong job is not checked.
for (const [path, job] of Object.entries(RUNS_ELSEWHERE)) {
  if (!existsSync(join(ROOT, path))) {
    fail(`${path} is claimed to run in \`${job}\` but is not on disk`);
    continue;
  }
  const block = jobBlock(job);
  if (block === null)
    fail(`${path} names job \`${job}\`, which ${WORKFLOW} does not define`);
  else if (!block.includes(path))
    fail(
      `${path} names job \`${job}\`, but that job does not run it` +
        (workflow.includes(path) ? ' -- the file is named elsewhere in the workflow' : '')
    );
}
if (!failed) ok(`every exception names a job in ${WORKFLOW} that runs it`);

// RULE 4: a check nothing runs is stated, not discovered. It must be real, must
// really be absent from CI, and must carry a reason.
for (const [path, reason] of Object.entries(NOT_IN_CI)) {
  if (!existsSync(join(ROOT, path))) fail(`${path} is listed as unrun but is not on disk`);
  else if (workflow.includes(path)) fail(`${path} is listed as unrun but ${WORKFLOW} runs it`);
  else if (!reason || reason.length < 20) fail(`${path} is unrun with no reason given`);
}

// RULE 5: a path in the runner that is not on disk is a check that stopped
// existing without anybody noticing the list still calls for it.
for (const path of listed)
  if (!found.includes(path)) fail(`${RUNNER} runs ${path}, which is not on disk`);

for (const [path, reason] of Object.entries(NOT_IN_CI))
  console.log(`  NOTE ${path} runs in no CI job -- ${reason}`);

console.log(
  failed === 0
    ? `instrument roster: ${found.length} check file(s), ${listed.length} in ${RUNNER}, ` +
        `${Object.keys(RUNS_ELSEWHERE).length} elsewhere, ${Object.keys(NOT_IN_CI).length} unrun`
    : `instrument roster: ${failed} problem(s)`
);
process.exit(failed === 0 ? 0 : 1);
