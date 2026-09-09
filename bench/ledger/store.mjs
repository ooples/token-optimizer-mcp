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
  const lines = readFileSync(path, 'utf8').split('\n');
  // The index of the last line with content: only THAT one may be torn.
  let lastContent = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim()) {
      lastContent = i;
      break;
    }
  }

  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      // ONLY THE FINAL RECORD MAY BE FORGIVEN, and the reason is the one this
      // ledger exists to enforce: a run that happened and was paid for must
      // appear. A crash mid-append can tear the last line and nothing else, so
      // that case is recoverable and costs one row. A corrupt record ANYWHERE
      // EARLIER is a different event -- disk damage, an interleaved writer, a
      // bad hand-edit -- and swallowing it silently deletes a paid run from
      // the totals, publishing a cost-per-unit computed over fewer runs than
      // were actually bought. That is the same class of defect as the
      // status-filtered leaderboard this whole ledger replaces.
      if (i !== lastContent) {
        throw new Error(
          `${path}: record ${i + 1} of ${lines.length} is not valid JSON (${error.message}). ` +
            'Only a torn FINAL record is recoverable; an earlier one means the store is ' +
            'damaged and silently dropping it would publish a total over fewer runs than were paid for.'
        );
      }
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
  // COUNTS DISTINCT REP LABELS, NOT ROWS, because the reader counts distinct
  // labels and these two must agree.
  //
  // It counted rows until a campaign was accidentally launched twice against
  // one store. Both processes resumed from the same point, so labels 5..48 were
  // each written twice: 94 rows carrying 50 distinct reps. `report` deduped to
  // n=50, while this function returned 94 and therefore declared a 60-rep cell
  // finished. The run could not be topped up -- every remaining rep was skipped
  // as already done -- and a cell 10 reps short of its pre-registered n looked
  // complete. Row count and rep count are only equal while nothing ever writes
  // a label twice, which is an assumption about the world, not about the data.
  const seen = new Set();
  for (const r of rows) {
    if (r.arm !== arm || r.track !== track || r.task !== task) continue;
    if (buildKey(r) !== build) continue;
    // A RUN THE HARNESS NEVER STARTED DOES NOT SATISFY THE REP COUNT. It is
    // excluded from every figure in the report, so counting it as complete
    // here would leave a cell permanently one rep short of its pre-registered
    // n with no way to top it up -- observed: a cell sat at 29 real reps of 30
    // and the runner declined to add the last one because a killed container
    // occupied the slot.
    if (isHarnessFailure(r)) continue;
    const rep = Number(r.rep);
    if (!Number.isFinite(rep)) continue;
    seen.add(rep);
  }
  return seen.size;
}

/**
 * The next rep label that is certainly unused for this cell.
 *
 * SEPARATE FROM `completedReps`, AND THE SEPARATION IS THE POINT. That function
 * answers "how many measurements do I have" and therefore excludes harness
 * failures, which are not measurements. This one answers "what may I call the
 * next row", which is a different question: a harness-failure row still
 * OCCUPIES its label on disk.
 *
 * Conflating them lost data. With reps 1, 2 (harness failure) and 3 recorded,
 * `completedReps` returns 2, so numbering resumed at 3 -- colliding with a real
 * run -- and the reader, which keeps only the newest row per key, then dropped
 * the earlier measurement entirely. Two fixes that were each correct alone
 * combined into silent deletion.
 */
export function nextRep(rows, { arm, track, task, build }) {
  let highest = 0;
  for (const r of rows) {
    if (r.arm !== arm || r.track !== track || r.task !== task) continue;
    if (buildKey(r) !== build) continue;
    const rep = Number(r.rep);
    if (Number.isFinite(rep) && rep > highest) highest = rep;
  }
  return highest + 1;
}

/**
 * A run that failed having SPENT NOTHING, which means the agent never worked.
 *
 * KEYED ON COST, NOT ON TURN COUNT. This required `turns === 0` and `status ===
 * 'error'`, and both halves were too narrow. Credentials expiring mid-campaign
 * produces `status: 'failed'` with `usd: 0` and `turns: 1` -- the agent burns one
 * turn receiving an auth rejection -- so ten such rows were classified as real
 * failures of the arm that happened to be running. That arm then showed 67%
 * completion and a score of 0.00 on a third of its cell, which reads as a
 * devastating product result and is actually our expired token.
 *
 * Worse, it was unrecoverable: the rows occupy their rep labels, `completedReps`
 * counted them, and the cell looked full at 30, so a top-up ran nothing and the
 * arm was permanently stuck at 67%.
 *
 * A run that cost $0 cannot have done any work, whatever its turn count says.
 * That is the invariant worth keying on, and it does not misclassify a genuine
 * failure: an arm that really fails a task still pays for the attempt.
 */
export function isHarnessFailure(row) {
  if (row.harness_failure === true) return true;
  const spentNothing = (row.usd || 0) === 0;
  return spentNothing && (row.status === 'error' || row.status === 'failed');
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
