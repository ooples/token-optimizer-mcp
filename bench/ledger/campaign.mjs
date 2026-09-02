/**
 * One command: run the arms, on both tracks, and report.
 *
 * The orchestration is deliberately dull. Everything with an opinion in it --
 * when to stop sampling, what a run is worth, whether a comparison may be
 * published -- lives in modules this file calls, each of which is tested
 * without spending anything. What is left here is sequencing and bookkeeping,
 * and the two places it could still go wrong are guarded:
 *
 *   RESUMPTION IS BUILD-SCOPED   a rep only counts if it came from this image
 *                                and this commit, so a rebuild restarts an arm
 *                                rather than blending two products.
 *   ROWS ARE WRITTEN AS THEY     a campaign that dies halfway has still
 *   HAPPEN                       recorded what it spent. Buffering rows until
 *                                the end means a crash loses the money.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runColdTask, runWarmSequence, campaignProvenance } from './run.mjs';
import { appendRows, loadRows, completedReps, nextRep } from './store.mjs';
import { report } from './rank.mjs';
import { forTrack } from './tasks/index.mjs';
import { discardWorkspace } from './executor.mjs';
import { buildKey } from './provenance.mjs';

/**
 * Wraps an executor so every finished run is scored, stored, and its workspace
 * released before the next one starts.
 *
 * The workspace is discarded HERE rather than in the executor because only this
 * layer knows the scoring has happened. Freeing it earlier would leave the
 * verifier nothing to read; freeing it later fills the disk over a campaign.
 */
function recording(execute, { storePath, onRow }) {
  return async (args) => {
    const outcome = await execute(args);
    // The runner scores from `workspace`; it is released once the row exists.
    //
    // Not attached at all when the executor asked for the workspace to be kept,
    // which is how `--keep-workspaces` survives: a release that is never
    // attached cannot be called by mistake, whereas a flag checked at the call
    // site is one refactor away from being dropped.
    if (!outcome.keepWorkspace) {
      outcome._release = () => discardWorkspace(outcome.workspace);
    }
    if (onRow) onRow(outcome);
    return outcome;
  };
}

/**
 * Runs up to `limit` jobs at once, preserving result order.
 *
 * Deliberately hand-rolled and tiny rather than a dependency: the whole
 * behaviour worth having is "never more than N in flight", and a benchmark
 * harness that pulls in a package to get it has widened its own trusted set for
 * nine lines.
 */
async function pooled(items, limit, run) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) results[i] = await run(items[i], i);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/**
 * Runs one arm on the cold track, skipping tasks already complete for this build.
 *
 * WHY TASKS MAY OVERLAP AND REPS MAY NOT. Cold tasks are independent by
 * construction -- each rep gets its own container and its own fresh state
 * directory -- so running several at once changes nothing a row records. Reps
 * within a task cannot overlap, because the stopping rule reads the reps so far
 * to decide whether another is needed; issuing them in parallel would buy reps
 * the precision rule had already ruled unnecessary, and the cap would stop
 * meaning what it says.
 *
 * Contention slows a run down but does not move what is measured: the endpoint
 * is dollars and tokens, not wall-clock. The one way it could bite is the
 * executor's 900-second kill turning into a charged failure, so the default
 * stays 1 and the ceiling is small relative to the host.
 */
export async function coldArm(
  arm,
  { tasks, execute, provenance, storePath, precision, log, concurrency = 1 }
) {
  const existing = loadRows(storePath);
  const build = buildKey(provenance);
  const written = [];

  const runOne = async (task) => {
    const done = completedReps(existing, { arm, track: 'cold', task: task.id, build });
    if (done >= (precision?.fixedReps || precision?.maxReps || 12)) {
      log?.(`  cold/${arm}/${task.id}: ${done} reps already recorded for this build, skipping`);
      return;
    }

    // RESUMPTION TOPS UP TO THE TARGET, it does not add a fresh batch on top.
    // Observed: a fixed-n run of 30 was interrupted with 13 reps banked, and
    // resuming ran 30 MORE for a total of 43 -- the adaptive rule tolerated
    // that because it stops on precision, but under a fixed design the count
    // IS the pre-registration, so overshooting silently breaks the very
    // guarantee fixed-n exists to provide.
    const target = precision?.fixedReps;
    const remaining = target ? { ...precision, fixedReps: target - done } : precision;

    const { rows, verdict } = await runColdTask(task, {
      arm,
      // Labelled past the HIGHEST rep on disk, not past the count of usable
      // ones. A harness-failure row is excluded from `done` -- it is not a
      // measurement -- but it still occupies its label, so `done + 1` could
      // collide with a real run and the reader, keeping only the newest row per
      // key, would drop that measurement.
      startRep: nextRep(existing, { arm, track: 'cold', task: task.id, build }),
      execute,
      freshStateDir: async () => mkdtempSync(join(tmpdir(), `ledger-cold-${arm}-`)),
      provenance,
      precision: remaining,
      // Each rep hits disk the moment it exists, so an interrupted campaign
      // keeps what it paid for.
      onRow: (row) => {
        const { rejected } = appendRows(storePath, [row]);
        if (rejected.length) log?.(`  !! row rejected: ${rejected[0].problem}`);
      },
    });

    written.push(...rows);
    log?.(
      `  cold/${arm}/${task.id}: ${rows.length} rep(s), ${verdict.state}` +
        (verdict.width && Number.isFinite(verdict.width)
          ? ` (interval ${(verdict.width * 100).toFixed(0)}%)`
          : '')
    );
  };

  await pooled(tasks, concurrency, runOne);
  return written;
}

/**
 * Runs one arm on the warm track: an ordered sequence sharing one state
 * directory per rep.
 */
export async function warmArm(arm, { tasks, execute, provenance, storePath, precision, log }) {
  if (!tasks.length) return [];

  // WHERE A KILLED CAMPAIGN PICKS UP. A warm rep is the whole sequence, so a
  // rep counts as done only when every task in it has a row for this build --
  // a sequence interrupted halfway is redone, because its later tasks never saw
  // the state the earlier ones would have left.
  const build = buildKey(provenance);
  const mine = loadRows(storePath).filter(
    (r) => r.arm === arm && r.track === 'warm' && buildKey(r) === build
  );
  const complete = new Set();
  for (const rep of new Set(mine.map((r) => r.rep))) {
    const inRep = new Set(mine.filter((r) => r.rep === rep).map((r) => r.task));
    if (tasks.every((t) => inRep.has(t.id))) complete.add(rep);
  }
  const startRep = complete.size ? Math.max(...complete) + 1 : 1;
  const priorRows = mine.filter((r) => complete.has(r.rep));
  if (startRep > 1) log?.(`  warm/${arm}: resuming at rep ${startRep} (${priorRows.length} row(s) banked)`);

  const { rows, unresolved } = await runWarmSequence(tasks, {
    arm,
    startRep,
    priorRows,
    execute,
    freshStateDir: async () => mkdtempSync(join(tmpdir(), `ledger-warm-${arm}-`)),
    provenance,
    precision,
    onRow: (row) => {
      const { rejected } = appendRows(storePath, [row]);
      if (rejected.length) log?.(`  !! row rejected: ${rejected[0].problem}`);
    },
  });
  log?.(
    `  warm/${arm}: ${rows.length} row(s) over ${tasks.length} task(s)` +
      (unresolved.length ? `, unresolved: ${unresolved.join(', ')}` : '')
  );
  return rows;
}

/**
 * The whole campaign.
 *
 * `control` is always run first and on every track: without it there is nothing
 * to compare against, and discovering that after spending on the other arms is
 * the kind of avoidable waste this harness exists to stop.
 */
export async function runCampaign({
  arms,
  armNames,
  execute,
  storePath,
  imageDigest,
  commitSha,
  tracks = ['cold', 'warm'],
  precision,
  concurrency = 1,
  log = () => {},
  // THE BATTERY IS A PARAMETER, defaulting to the shipped set. Hardcoding
  // `forTrack` here made the campaign untestable except against the real tasks
  // -- a test that passed its own fixtures silently got the shipped ones
  // instead, and its assertions were about runs it never configured. It also
  // left an operator no way to re-run a single task after a failure without
  // paying for the whole battery.
  tasksForTrack = forTrack,
} = {}) {
  const provenance = campaignProvenance({ imageDigest, commitSha });
  const ordered = ['control', ...armNames.filter((a) => a !== 'control')];

  for (const name of ordered) {
    if (!arms[name]) throw new Error(`unknown arm: ${name}`);
  }

  const wrapped = recording(execute, {
    storePath,
    onRow: (outcome) => outcome.workspace && null,
  });

  for (const track of tracks) {
    const tasks = tasksForTrack(track);
    if (!tasks.length) continue;
    log(`\nTRACK ${track} -- ${tasks.length} task(s)`);
    for (const name of ordered) {
      if (track === 'cold') {
        await coldArm(name, {
          tasks,
          execute: wrapped,
          provenance,
          storePath,
          precision,
          log,
          concurrency,
        });
      } else {
        await warmArm(name, { tasks, execute: wrapped, provenance, storePath, precision, log });
      }
    }
  }

  const rows = loadRows(storePath);
  // Only this build's rows are summarised. Older rows stay in the file as
  // evidence; `report` would throw if they were mixed in, which is the
  // behaviour we want if this filter is ever removed.
  const mine = rows.filter((r) => buildKey(r) === buildKey(provenance));
  return { rows: mine, report: report(mine, { precision }) };
}
