/**
 * The README's head-to-head table must be reproducible by the harness it cites.
 *
 * WHY THIS EXISTS. The table in README.md credited
 * `node bench/compression/proof.mjs` for eight rows, and six of those rows'
 * figures appeared ZERO times in that command's output. Nobody noticed because
 * nothing checked. This is the third time a benchmark figure in this
 * repository's prose has drifted away from the code that produced it, and the
 * previous two attempts to prevent it were greps over prose -- which give false
 * negatives, because each surface spells the same claim differently ("6 of 8"
 * against "six of six").
 *
 * So this check does not compare sentences. It extracts every NUMBER from the
 * marked table block and requires each one to appear literally in the harness's
 * own stdout. A number is the one part of a claim that cannot be paraphrased.
 *
 *   node bench/compression/readme-table.check.mjs
 *
 * Exits non-zero, naming each figure it could not find, when they disagree.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const README = join(repo, 'README.md');
const PROOF = join(here, 'proof.mjs');

const START = '<!-- PROOF-TABLE:START';
const END = '<!-- PROOF-TABLE:END -->';

const readme = readFileSync(README, 'utf8');
const from = readme.indexOf(START);
const to = readme.indexOf(END);
if (from === -1 || to === -1 || to < from) {
  console.error(
    'readme-table.check: the PROOF-TABLE markers are missing from README.md.\n' +
      'They are what makes this check possible -- restore them around the\n' +
      'head-to-head table rather than removing the check.'
  );
  process.exit(1);
}
const block = readme.slice(from, to);

// Only the table rows. The prose between the markers is allowed to carry
// numbers that are conclusions rather than measurements (the 0.8 of a point,
// the 13.9 this table once overstated by), and those are not the harness's to
// produce.
const rows = block
  .split(/\r?\n/)
  .filter((l) => /^\|/.test(l.trim()))
  .filter((l) => !/^\|[\s:|-]+\|$/.test(l.trim()));

if (rows.length < 3) {
  console.error(
    `readme-table.check: found ${rows.length} table rows between the markers, ` +
      'which is too few to be the head-to-head table. Refusing to pass vacuously.'
  );
  process.exit(1);
}

// Header row contributes no figures; drop it.
const dataRows = rows.slice(1);

const figures = [];
for (const row of dataRows) {
  const workload = (row.split('|')[1] || '').trim();
  for (const m of row.matchAll(/\d+(?:\.\d+)?%?/g)) {
    figures.push({ workload, figure: m[0] });
  }
}

if (!figures.length) {
  console.error('readme-table.check: no figures in the table. Refusing to pass vacuously.');
  process.exit(1);
}

let out;
// A DEGRADED PROOF RUN MAY NOT CERTIFY A PUBLISHED TABLE. The comparison
// below still runs on whatever a failing harness printed, because knowing
// WHICH figures moved is the useful diagnostic -- but the exit status is
// set here and never cleared, so "the figures match" can never be reported
// as success on numbers that came out of a red gate.
let proofFailed = false;
try {
  out = execFileSync(process.execPath, [PROOF], {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (err) {
  proofFailed = true;
  out = `${err.stdout || ''}${err.stderr || ''}`;
  console.error(
    'readme-table.check: proof.mjs EXITED NON-ZERO. Its output is compared ' +
      'below for diagnosis, but this check fails regardless of agreement.'
  );
  if (!out.trim()) {
    console.error('readme-table.check: ...and it produced nothing. Cannot check.');
    process.exit(1);
  }
}

/**
 * The harness output, split into one chunk per workload.
 *
 * WHOLE-OUTPUT MATCHING IS NOT A CHECK. Testing each figure as a substring
 * of everything proof.mjs printed passes a stale value whenever the same
 * digits appear anywhere else -- another workload, or another metric on the
 * same workload. `47.4%` and `46.0%` both occur several times across twelve
 * workloads and six arms, so the loosest possible match is also the one
 * most likely to be satisfied by coincidence.
 */
const sections = new Map();
{
  let current = null;
  for (const line of out.split(/\r?\n/)) {
    const head = line.match(/^===\s*(\S+)/);
    if (head) {
      current = head[1];
      sections.set(current, []);
      continue;
    }
    if (current) sections.get(current).push(line);
  }
}

const missing = figures.filter(({ workload, figure }) => {
  const body = sections.get(workload);
  // No section at all is a miss, not a pass: a row naming a workload the
  // harness does not run is exactly the drift this exists to catch.
  if (!body) return true;
  return !body.join('\n').includes(figure);
});

console.log(
  `readme-table.check: ${figures.length} figures across ${dataRows.length} rows.`
);

if (proofFailed) {
  console.error(
    '\nreadme-table.check FAILED: the harness that produces these figures is red.'
  );
  process.exitCode = 1;
}

if (missing.length) {
  console.error(
    'README TABLE DRIFT -- these figures are absent from their own workload:'
  );
  for (const { workload, figure } of missing) {
    console.error(`  ${workload}: ${figure}`);
  }
  console.error(
    '\nRegenerate the table from `node bench/compression/proof.mjs` rather than\n' +
      'editing the figures by hand.'
  );
  process.exit(1);
}

if (!proofFailed) console.log('README TABLE AGREES with the harness.');
