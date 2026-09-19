#!/usr/bin/env node
/**
 * Are the published provenance claims still true of the committed rows?
 *
 * WHY THIS EXISTS. `README.md` answers a reviewer who asked which rows the published numbers came
 * from. The answer is a table of stores, row counts and integrity claims -- "364 rows", "zero
 * identical rows", "30 real reps in every one of 12 cells" -- and every one of those is prose. Prose
 * does not fail when someone appends a row, re-runs a campaign into an existing store, or merges two
 * stores. The numbers in a results file would then disagree with the rows behind them and nothing
 * would say so.
 *
 * That is the specific failure a vendor-written benchmark cannot afford, because it is
 * indistinguishable from the dishonest version of itself. So the claims are checked here instead of
 * asserted there.
 *
 * WHAT IT DOES NOT DO. It does not re-derive the published ratios -- that needs the full `report()`
 * path and belongs in a follow-up. This checks the layer underneath: that the evidence is the shape
 * the documentation says it is.
 *
 * Usage: node bench/ledger/verify-provenance.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { organise } from './rank.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const failures = [];
const notes = [];
const check = (ok, what, detail = '') => {
  if (ok) console.log(`  ok    ${what}`);
  else {
    console.log(`  FAIL  ${what}${detail ? ` -- ${detail}` : ''}`);
    failures.push(what);
  }
};

/** One JSONL store as an array of rows, with the blank-line tolerance a hand-appended file needs. */
function readStore(name) {
  const path = join(here, `${name}.jsonl`);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        failures.push(`${name}.jsonl line ${index + 1} is not JSON`);
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * The build a row belongs to.
 *
 * Rows carry both a commit and an image digest, and the README is explicit that results are never
 * averaged across builds -- so the identity of a cell includes the build, not just arm and task.
 */
const buildOf = (row) => `${row.commit_sha ?? '?'}@${row.image_digest ?? '?'}`;

// THE STORE GROUPS THE README NAMES, with the count it publishes for each. Parsed from the table
// rather than duplicated here would be better; the table mixes prose into its cells ("30 real reps
// in every one of 12 cells"), so the mapping is declared and the README is checked against IT.
const GROUPS = [
  {
    stores: ['largecontext'],
    rows: 364,
    cells: 12,
    usablePerCell: 30,
    backs: 'RESULTS-LARGECONTEXT.md',
  },
  {
    stores: ['confirmatory', 'confirmatory-build2'],
    rows: 329,
    backs: 'RESULTS.md',
  },
];

console.log('provenance of the published ledger results\n');

for (const group of GROUPS) {
  const rows = group.stores.flatMap((name) => readStore(name) ?? []);
  const label = group.stores.join(' + ');
  check(
    rows.length === group.rows,
    `${label}: ${group.rows} rows, as published for ${group.backs}`,
    rows.length === group.rows ? '' : `found ${rows.length}`
  );

  // ZERO IDENTICAL ROWS. The README states this outright, having been asked about repeated `rep`
  // values. A duplicate here means one measurement was counted twice, which moves every aggregate
  // built on it.
  const seen = new Map();
  const duplicates = [];
  for (const row of rows) {
    const key = [
      row.arm,
      row.task,
      row.rep,
      buildOf(row),
      row.started_at,
      row.usd,
    ].join('|');
    if (seen.has(key)) duplicates.push(key);
    else seen.set(key, true);
  }
  check(
    duplicates.length === 0,
    `${label}: no two rows share (arm, task, rep, build) and started_at and cost`,
    duplicates.length
      ? `${duplicates.length} duplicate(s), e.g. ${duplicates[0]}`
      : ''
  );

  // THE ROWS THE ANALYSIS ACTUALLY SEES, obtained by calling `organise()` rather than
  // reimplementing it. Raw row counts are the wrong instrument and I had it wrong twice before
  // landing here: rows-per-cell ignores that harness failures are bucketed out, and distinct-`rep`
  // counts flag a labelling quirk that cannot move a number. `organise()` is the front of the real
  // report path, so asserting on its output cannot drift from what gets published.
  //
  // It applies two reductions. Harness failures are separated -- an infrastructure fault is not a
  // measurement. Then rows sharing (build, arm, track, task, rep) collapse to the newest by
  // `started_at`, which exists so a redone warm rep does not get counted alongside the partial self
  // it replaced. That second rule assumes cold reps are uniquely numbered, and in a store written
  // before the `nextRep` fix they are not: a top-up restarted at 1 over labels already in use, so
  // supersession silently discards the OLDER paid run. RESULTS-LARGECONTEXT.md discloses this and
  // puts it at three shadowed runs in one cell.
  const organised = organise(rows);
  const cells = new Map();
  for (const [track, arms] of organised.tracks)
    for (const [arm, tasks] of arms)
      for (const [task, cellRows] of tasks)
        cells.set(`${track}|${arm}|${task}`, cellRows.length);

  if (group.cells !== undefined) {
    check(
      cells.size === group.cells,
      `${label}: ${group.cells} cells`,
      cells.size === group.cells ? '' : `found ${cells.size}`
    );
  }
  if (group.usablePerCell !== undefined) {
    const off = [...cells.entries()].filter(
      ([, n]) => n !== group.usablePerCell
    );
    check(
      off.length === 0,
      `${label}: ${group.usablePerCell} usable rows in every cell, as published`,
      off.map(([cell, n]) => `${cell}=${n}`).join(', ')
    );
  }

  notes.push(
    `${label}: ${organised.harnessFailures.length} harness failure(s) excluded, ${organised.superseded} row(s) superseded by a newer row at the same (build, arm, track, task, rep)`
  );
}

// The README's own numbers must match the declared groups, so editing one without the other fails.
const readme = readFileSync(join(here, 'README.md'), 'utf8');
for (const group of GROUPS) {
  check(
    readme.includes(`| ${group.rows} |`),
    `README still publishes ${group.rows} rows for ${group.backs}`,
    'the table and this checker disagree'
  );
}

console.log('');
for (const note of notes) console.log(`  note  ${note}`);
console.log('');
if (failures.length) {
  console.error(`provenance verification FAILED: ${failures.length} check(s)`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    'provenance verification passed: the rows are the shape the README claims.'
  );
}
