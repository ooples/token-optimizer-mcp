/**
 * The README's twelve-row head-to-head table must agree with the recorded run.
 *
 * WHY THIS IS NOT `readme-table.check.mjs`. That check runs its harness and
 * compares the README against live stdout, which is the stronger arrangement and
 * the one to prefer wherever it is possible. It is not possible here:
 * `head-to-head.mjs` scores against HeadRoom's own output, produced by their
 * Python harness from their clone, so CI has nothing to run. The alternative
 * that was actually on the table was to publish twelve rows with nothing behind
 * them at all, which is the failure mode this repository has already had three
 * times.
 *
 * SO THE CHAIN HAS TWO LINKS AND THIS IS THE CHEAP ONE. Prose against the
 * record, every commit, here. Record against the live harness, by re-running
 * with --record and diffing, for anyone holding the clone. The second link is
 * not free, and the record says exactly how to close it.
 *
 * WHAT IT COMPARES. Numbers, per row, against that row's recorded figures --
 * never against the whole file. Twelve workloads times four arms puts "99.9%" in
 * the record twenty times over, so a whole-file substring test would pass a
 * stale figure on the strength of a coincidence in another row.
 *
 *   node bench/compression/readme-headroom.check.mjs
 *
 * Exits non-zero, naming each figure it could not find, when they disagree.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const README = join(repo, 'README.md');
const RECORD = join(here, 'headroom', 'results', 'head-to-head.json');

const START = '<!-- HEADROOM-TABLE:START';
const END = '<!-- HEADROOM-TABLE:END -->';

const readme = readFileSync(README, 'utf8');
const from = readme.indexOf(START);
const to = readme.indexOf(END);
if (from === -1 || to === -1 || to < from) {
  console.error(
    'readme-headroom.check: the HEADROOM-TABLE markers are missing from\n' +
      'README.md. They are what makes this check possible -- restore them\n' +
      'around the twelve-row table rather than removing the check.'
  );
  process.exit(1);
}
const block = readme.slice(from, to);

const record = JSON.parse(readFileSync(RECORD, 'utf8'));
const byName = new Map(record.workloads.map((w) => [w.name, w]));

// Only the table rows. Prose between the markers may carry numbers that are
// conclusions rather than measurements, and those are not the record's to
// confirm -- but the row a conclusion is drawn from is.
const rows = block
  .split(/\r?\n/)
  .filter((line) => line.trim().startsWith('|'))
  .filter((line) => !/^\s*\|[\s:|-]+\|\s*$/.test(line));

if (rows.length < 3) {
  console.error(
    `readme-headroom.check: found ${rows.length} table rows between the ` +
      'markers, which is too few to be the table. Refusing to pass vacuously.'
  );
  process.exit(1);
}

const dataRows = rows.slice(1);
const figures = [];
for (const row of dataRows) {
  const cells = row.split('|').map((c) => c.trim());
  const workload = cells.find((c) => byName.has(c));
  if (workload === undefined) {
    console.error(
      `readme-headroom.check: no recorded workload named in row: ${row.trim()}`
    );
    process.exit(1);
  }
  for (const figure of row.match(/\d[\d,]*\.?\d*%?/g) ?? [])
    figures.push({ workload, figure });
}

if (!figures.length) {
  console.error(
    'readme-headroom.check: no figures in the table. Refusing to pass vacuously.'
  );
  process.exit(1);
}

/** Every recorded figure for one workload, flattened to a set of strings. */
const flatten = (node, into) => {
  if (node === null || node === undefined) return into;
  if (typeof node === 'string') {
    into.add(node);
    return into;
  }
  for (const value of Object.values(node)) flatten(value, into);
  return into;
};

const missing = figures.filter(({ workload, figure }) => {
  const known = flatten(byName.get(workload), new Set());
  // The payload column is recorded unformatted, so a README that writes it with
  // thousands separators is the same measurement spelled for a reader.
  return !known.has(figure) && !known.has(figure.replace(/,/g, ''));
});

console.log(
  `readme-headroom.check: ${figures.length} figures across ${dataRows.length} ` +
    `rows, against a record from ${record.recordedAt} (${record.commit.slice(0, 8)}).`
);

if (missing.length) {
  console.error('\nreadme-headroom.check FAILED. Not found in the record:');
  for (const { workload, figure } of missing)
    console.error(`  ${workload}: ${figure}`);
  console.error(
    '\nEither the README drifted, or the record is stale. Regenerate it with:\n' +
      `  ${record.regenerate}`
  );
  process.exit(1);
}

console.log('README HEADROOM TABLE AGREES with the recorded run.');
