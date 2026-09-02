/**
 * Where rows live, and what "already done" means.
 *
 * APPEND-ONLY JSONL, because the raw rows are the product. The credibility
 * argument for a vendor-authored benchmark rests on publishing every run, so
 * the store is a format anyone can read with `cat`, not a database whose schema
 * we control and whose contents nobody can check.
 *
 * RESUMPTION IS SCOPED TO THE BUILD, and that is the whole point of this file.
 * The harness this replaces skipped any run already recorded for a campaign
 * label -- so after a code change it topped up an arm with new-build reps and
 * averaged them with old-build ones under a single name. Nothing in its rows
 * could tell them apart. Here a row only counts as done if it came from the
 * SAME image digest and commit, so a rebuild starts that arm over instead of
 * silently blending two products.
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { rowProblem, buildKey } from './provenance.mjs';

/** Appends rows, refusing any that would be unusable later. */
export function appendRows(path, rows) {
  const accepted = [];
  const rejected = [];
  for (const row of rows) {
    const problem = rowProblem(row);
    if (problem) rejected.push({ row, problem });
    else accepted.push(row);
  }
  if (accepted.length) {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, accepted.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  // REJECTED ROWS ARE RETURNED, NOT SWALLOWED. A run that happened but could
  // not be stored is a hole in the ledger, and a caller that cannot see it will
  // report a total that does not match what it spent.
  return { accepted: accepted.length, rejected };
}

/** Every row in the store. A torn final line is skipped, not fatal. */
export function loadRows(path) {
  if (!existsSync(path)) return [];
  const rows = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* a partially written last line costs one row, not the campaign */
    }
  }
  return rows;
}

/**
 * How many reps of this (arm, track, task) already exist FOR THIS BUILD.
 *
 * Rows from another build are not counted, so they neither satisfy a rep target
 * nor get mixed into one. They stay in the file -- deleting evidence is not
 * this harness's job -- and `report` refuses to summarise across builds, so a
 * stale row can only ever cause a loud failure, never a quiet average.
 */
export function completedReps(rows, { arm, track, task, build }) {
  return rows.filter(
    (r) =>
      r.arm === arm &&
      r.track === track &&
      r.task === task &&
      buildKey(r) === build &&
      // A RUN THE HARNESS NEVER STARTED DOES NOT SATISFY THE REP COUNT. It is
      // excluded from every figure in the report, so counting it as complete
      // here would leave a cell permanently one rep short of its
      // pre-registered n with no way to top it up -- observed: a cell sat at
      // 29 real reps of 30 and the runner declined to add the last one because
      // a killed container occupied the slot.
      !isHarnessFailure(r)
  ).length;
}

/** A run that errored having cost nothing and attempted nothing. */
function isHarnessFailure(row) {
  if (row.harness_failure === true) return true;
  return row.status === 'error' && (row.usd || 0) === 0 && (row.turns || 0) === 0;
}

/** The builds present in a store, newest activity first. Used by the CLI to warn. */
export function buildsPresent(rows) {
  const seen = new Map();
  for (const row of rows) {
    const key = buildKey(row);
    const at = String(row.started_at || '');
    const entry = seen.get(key) || { build: key, rows: 0, latest: '' };
    entry.rows += 1;
    if (at > entry.latest) entry.latest = at;
    seen.set(key, entry);
  }
  return [...seen.values()].sort((a, b) => (a.latest < b.latest ? 1 : -1));
}
