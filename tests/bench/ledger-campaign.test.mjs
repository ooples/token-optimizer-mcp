/**
 * The campaign layer, driven end to end with a fake agent.
 *
 * The properties pinned here are the ones whose absence produced wrong,
 * confidently-reported numbers in the harness this replaces.
 */

import { describe, expect, test, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import { appendRows, loadRows, completedReps, nextRep, buildsPresent } from '../../bench/ledger/store.mjs';
import { runCampaign, coldArm, warmArm } from '../../bench/ledger/campaign.mjs';
import { renderReport, headline } from '../../bench/ledger/render.mjs';
import { report } from '../../bench/ledger/rank.mjs';
import { ARMS, loadArms } from '../../bench/ledger/arms.mjs';
import { parseArgs, detectProvenance } from '../../bench/ledger/cli.mjs';
import { buildKey } from '../../bench/ledger/provenance.mjs';

let dir;
let store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ledger-camp-'));
  store = join(dir, 'rows.jsonl');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * WELL-FORMED PLACEHOLDER PROVENANCE, named rather than inlined.
 *
 * `rowProblem` requires a 40-hex commit and a sha256:<64 hex> digest: a short
 * value is the shape a hand-typed sha takes, and a row that cannot identify its
 * build cannot be checked by anyone. These were 'abc1234' and 'sha256:new'.
 *
 * Padded rather than randomised so the placeholder stays legible -- DIGEST_OLD
 * reads `sha256:d000...`, DIGEST_NEW `sha256:e000...` -- because several tests
 * here exist to prove two builds are never averaged, and a failing assertion
 * must still say which build it meant.
 */
const pad = (label, len) => (label + '0'.repeat(len)).slice(0, len);
const COMMIT = pad('abc1234', 40);
const COMMIT_C1 = pad('c1', 40);
const DIGEST_A = pad('a', 64);
const DIGEST_AAA = pad('aaa', 64);
const DIGEST_BBB = pad('bbb', 64);
const DIGEST_OLD = pad('d', 64);
const DIGEST_NEW = pad('e', 64);

const row = (over = {}) => ({
  task: 'single-shot-extract',
  arm: 'assist',
  rep: 1,
  track: 'cold',
  status: 'ok',
  usd: 0.1,
  turns: 3,
  score: 1,
  image_digest: `sha256:${DIGEST_NEW}`,
  commit_sha: COMMIT,
  started_at: '2026-08-31T22:05:00Z',
  ...over,
});

describe('the store', () => {
  test('round-trips rows and rejects unusable ones without hiding them', () => {
    const { accepted, rejected } = appendRows(store, [row(), { task: 'broken' }]);
    expect(accepted).toBe(1);
    expect(rejected).toHaveLength(1);
    expect(loadRows(store)).toHaveLength(1);
  });

  test('a torn final line costs one row, not the file', () => {
    appendRows(store, [row(), row({ rep: 2 })]);
    writeFileSync(store, readFileSync(store, 'utf8') + '{"task":"half');
    expect(loadRows(store)).toHaveLength(2);
  });

  test('a corrupt record in the MIDDLE is refused, not silently dropped', () => {
    // A torn last line is a crash mid-append and costs one row. A damaged
    // record anywhere earlier is a different event, and swallowing it deletes
    // a paid run from the totals -- publishing a cost-per-unit computed over
    // fewer runs than were actually bought, which is the same class of defect
    // as the status-filtered leaderboard this ledger replaces.
    appendRows(store, [row(), row({ rep: 2 }), row({ rep: 3 })]);
    const lines = readFileSync(store, 'utf8').trim().split('\n');
    lines[1] = '{"task":"corrupt';
    writeFileSync(store, lines.join('\n') + '\n');
    expect(() => loadRows(store)).toThrow(/record 2 of/);
  });

  test('a trailing blank line does not make the last record look interior', () => {
    // appendRows ends every write with a newline, so the torn record is not
    // the last ARRAY element -- an index-based check that ignored blank lines
    // would reject the very case it is meant to forgive.
    appendRows(store, [row(), row({ rep: 2 })]);
    writeFileSync(store, readFileSync(store, 'utf8') + '{"task":"half\n\n');
    expect(loadRows(store)).toHaveLength(2);
  });

  test('resumption counts only reps from the SAME build', () => {
    // THE DEFECT THIS REPLACES. The old harness skipped any run already
    // recorded, so after a rebuild it topped an arm up with new-build reps and
    // averaged them with old-build ones under one name.
    appendRows(store, [
      row({ image_digest: `sha256:${DIGEST_OLD}`, rep: 1 }),
      row({ image_digest: `sha256:${DIGEST_OLD}`, rep: 2 }),
      row({ image_digest: `sha256:${DIGEST_NEW}`, rep: 1 }),
    ]);
    const rows = loadRows(store);
    const args = { arm: 'assist', track: 'cold', task: 'single-shot-extract' };
    expect(completedReps(rows, { ...args, build: buildKey({ image_digest: `sha256:${DIGEST_NEW}`, commit_sha: COMMIT }) })).toBe(1);
    expect(completedReps(rows, { ...args, build: buildKey({ image_digest: `sha256:${DIGEST_OLD}`, commit_sha: COMMIT }) })).toBe(2);
  });

  test('a rep written twice counts once, so a cell cannot look finished early', () => {
    // FROM A REAL INCIDENT. A campaign was launched twice against one store --
    // the first process was still alive because `pkill` on Git Bash had not
    // actually killed it -- so both resumed from the same point and wrote the
    // same labels. The store held 94 rows carrying 50 distinct reps. `report`
    // dedupes and saw n=50; this function counted rows and returned 94, so a
    // 60-rep target was declared already met and the cell could never be topped
    // up. Counting rows is only equal to counting reps while nothing ever writes
    // a label twice.
    appendRows(store, [
      row({ rep: 1 }),
      row({ rep: 2 }),
      row({ rep: 2 }), // the duplicate a second writer produced
      row({ rep: 3 }),
      row({ rep: 3 }),
    ]);
    const rows = loadRows(store);
    expect(rows).toHaveLength(5);
    const done = completedReps(rows, {
      arm: 'assist',
      track: 'cold',
      task: 'single-shot-extract',
      build: buildKey({ image_digest: `sha256:${DIGEST_NEW}`, commit_sha: COMMIT }),
    });
    expect(done).toBe(3);
  });

  test('a failure that cost nothing is the harness, not the arm', () => {
    // FROM A REAL CAMPAIGN. Credentials expired mid-run and produced
    // `status: 'failed'`, `usd: 0`, `turns: 1` -- the agent burns one turn
    // receiving an auth rejection. The classifier required `status === 'error'`
    // AND `turns === 0`, so ten such rows were scored as genuine failures of the
    // arm that happened to be running last. That arm showed 67% completion and
    // 0.00 on a third of its cell, which reads as a devastating product result
    // and was actually our expired token.
    //
    // It was also unrecoverable: the rows hold their rep labels, completedReps
    // counted them, the cell looked full, and a top-up ran nothing.
    const rows = [
      row({ rep: 1 }),
      row({ rep: 2, status: 'failed', usd: 0, turns: 1, score: 0 }),
      row({ rep: 3, status: 'error', usd: 0, turns: 0 }),
      // A REAL failure pays for its attempt, and must still count as a rep.
      row({ rep: 4, status: 'failed', usd: 0.05, turns: 6, score: 0 }),
    ];
    appendRows(store, rows);
    const loaded = loadRows(store);
    const args = {
      arm: 'assist',
      track: 'cold',
      task: 'single-shot-extract',
      build: buildKey({ image_digest: `sha256:${DIGEST_NEW}`, commit_sha: COMMIT }),
    };
    // reps 1 and 4 are real work; 2 and 3 cost nothing.
    expect(completedReps(loaded, args)).toBe(2);
    // Labels stay occupied so a top-up cannot collide with them.
    expect(nextRep(loaded, args)).toBe(5);
  });

  test('a rep whose only row is a harness failure still does not count', () => {
    // The distinct-label fix must not quietly promote a killed container into a
    // completed rep: the exclusion and the de-duplication have to compose.
    appendRows(store, [
      row({ rep: 1 }),
      row({ rep: 2, status: 'error', usd: 0, turns: 0 }),
      row({ rep: 3, status: 'error', usd: 0, turns: 0 }),
      row({ rep: 3 }), // same label, but this one is a real measurement
    ]);
    const rows = loadRows(store);
    const done = completedReps(rows, {
      arm: 'assist',
      track: 'cold',
      task: 'single-shot-extract',
      build: buildKey({ image_digest: `sha256:${DIGEST_NEW}`, commit_sha: COMMIT }),
    });
    // rep 1 and rep 3 are real; rep 2 is only a harness failure.
    expect(done).toBe(2);
  });

  test('builds present are listed newest first', () => {
    appendRows(store, [
      row({ image_digest: `sha256:${DIGEST_OLD}`, started_at: '2026-08-30T10:00:00Z' }),
      row({ image_digest: `sha256:${DIGEST_NEW}`, started_at: '2026-08-31T22:00:00Z' }),
    ]);
    expect(buildsPresent(loadRows(store))[0].build).toContain(DIGEST_NEW);
  });
});

describe('the campaign', () => {
  const execute = ({ task, arm }) => {
    // assist is cheaper on the reuse task, identical on the adversarial ones --
    // the shape a real improvement would have.
    const cheap = arm !== 'control' && task.family === 'debug';
    return Promise.resolve({
      status: 'ok',
      usd: cheap ? 0.05 : 0.1,
      turns: 5,
      workspace: { pass: true },
    });
  };

  // Tasks whose checks read a plain object rather than a directory, so the
  // campaign can be exercised without a filesystem fixture.
  const fakeTasks = (ids) =>
    ids.map((id) => ({
      id,
      family: id.includes('debug') ? 'debug' : 'single-shot',
      adversarial: !id.includes('debug'),
      tracks: ['cold'],
      prompt: 'p',
      setup: () => {},
      checks: [{ name: 'ok', weight: 1, run: (ws) => ws?.pass === true }],
    }));

  test('control is always run first, on every track', async () => {
    const order = [];
    const spy = async (args) => {
      order.push(args.arm);
      return execute(args);
    };
    await coldArm('control', {
      tasks: fakeTasks(['debug-x']),
      execute: spy,
      provenance: { image_digest: `sha256:${DIGEST_A}`, commit_sha: COMMIT_C1 },
      storePath: store,
      precision: { minReps: 3, maxReps: 3 },
    });
    expect(order.every((a) => a === 'control')).toBe(true);
  });

  describe('overlapping tasks', () => {
    /** An executor that records how many runs were in flight when each started. */
    const tracking = (state) => async (args) => {
      state.live += 1;
      state.peak = Math.max(state.peak, state.live);
      state.peakPerTask[args.task.id] = Math.max(
        state.peakPerTask[args.task.id] || 0,
        state.livePerTask[args.task.id] = (state.livePerTask[args.task.id] || 0) + 1
      );
      await new Promise((r) => setTimeout(r, 5));
      state.live -= 1;
      state.livePerTask[args.task.id] -= 1;
      return execute(args);
    };
    const freshState = () => ({ live: 0, peak: 0, livePerTask: {}, peakPerTask: {} });

    test('tasks run at once, up to the limit and no further', async () => {
      const state = freshState();
      await coldArm('control', {
        tasks: fakeTasks(['debug-a', 'debug-b', 'debug-c', 'debug-d', 'debug-e']),
        execute: tracking(state),
        provenance: { image_digest: `sha256:${DIGEST_A}`, commit_sha: COMMIT_C1 },
        storePath: store,
        precision: { minReps: 3, maxReps: 3 },
        concurrency: 3,
      });
      expect(state.peak).toBeGreaterThan(1);
      expect(state.peak).toBeLessThanOrEqual(3);
    });

    test('reps within one task never overlap, whatever the limit', async () => {
      // THE INVARIANT THAT PROTECTS THE STOPPING RULE. Whether another rep is
      // needed is decided from the reps so far; issuing them in parallel would
      // buy reps the precision rule had already ruled unnecessary and the cap
      // would stop meaning what it says.
      const state = freshState();
      await coldArm('control', {
        tasks: fakeTasks(['debug-a', 'debug-b', 'debug-c']),
        execute: tracking(state),
        provenance: { image_digest: `sha256:${DIGEST_A}`, commit_sha: COMMIT_C1 },
        storePath: store,
        precision: { minReps: 4, maxReps: 4 },
        concurrency: 6,
      });
      for (const [task, peak] of Object.entries(state.peakPerTask)) {
        expect([task, peak]).toEqual([task, 1]);
      }
    });

    test('a fixed n runs exactly that many reps, however tight the sample', async () => {
      // End to end, because the count is enforced by the loop in run.mjs and
      // the verdict in stats.mjs together -- either one alone would let an arm
      // stop early and reintroduce optional stopping.
      const state = freshState();
      const counts = {};
      const counting = async (args) => {
        counts[args.task.id] = (counts[args.task.id] || 0) + 1;
        return { status: 'ok', usd: 0.1, turns: 5, workspace: { pass: true } };
      };
      void state;
      await coldArm('control', {
        tasks: fakeTasks(['debug-a', 'debug-b']),
        execute: counting,
        provenance: { image_digest: `sha256:${DIGEST_A}`, commit_sha: COMMIT_C1 },
        storePath: store,
        // Identical costs every run: the adaptive rule would stop at its floor
        // of 6 on a zero-width interval. A fixed design must still run 15.
        precision: { fixedReps: 15 },
      });
      expect(counts).toEqual({ 'debug-a': 15, 'debug-b': 15 });
    });

    test('resuming a fixed-n run tops up to the target, it does not add a batch', async () => {
      // Observed for real: a fixed-n 30 run was interrupted with 13 banked,
      // and resuming ran 30 MORE for 43 total. Under a fixed design the count
      // IS the pre-registration, so overshooting breaks the guarantee the
      // design exists to give.
      let calls = 0;
      const execute = async () => {
        calls += 1;
        return { status: 'ok', usd: 0.1, turns: 3, workspace: { pass: true } };
      };
      appendRows(store, [
        row({
          arm: 'control',
          task: 'debug-a',
          track: 'cold',
          rep: 1,
          image_digest: `sha256:${DIGEST_A}`,
          commit_sha: COMMIT_C1,
        }),
      ]);
      await coldArm('control', {
        tasks: fakeTasks(['debug-a']),
        execute,
        provenance: { image_digest: `sha256:${DIGEST_A}`, commit_sha: COMMIT_C1 },
        storePath: store,
        precision: { fixedReps: 4 },
      });
      expect(calls).toBe(3);
      expect(readFileSync(store, 'utf8').trim().split('\n')).toHaveLength(4);
    });

    test('rep numbers stay unique across a resumption', async () => {
      // The loop restarted at 1 on every resume, so a cell interrupted at rep 1
      // and resumed produced a SECOND rep 1 and `rep` stopped identifying a run
      // within (arm, task, build). No measurement was double-counted -- the runs
      // are distinct -- but a reviewer reading the store could not tell a
      // collided label from a duplicated row without deduping on timestamps.
      const execute = async () => ({ status: 'ok', usd: 0.1, turns: 3, workspace: { pass: true } });
      appendRows(store, [
        row({ arm: 'control', task: 'debug-a', track: 'cold', rep: 1,
              image_digest: `sha256:${DIGEST_A}`, commit_sha: COMMIT_C1 }),
      ]);
      await coldArm('control', {
        tasks: fakeTasks(['debug-a']),
        execute,
        provenance: { image_digest: `sha256:${DIGEST_A}`, commit_sha: COMMIT_C1 },
        storePath: store,
        precision: { fixedReps: 4 },
      });
      const reps = readFileSync(store, 'utf8').trim().split('\n').map(JSON.parse)
        .filter((r) => r.task === 'debug-a').map((r) => r.rep).sort((a, b) => a - b);
      expect(reps).toEqual([1, 2, 3, 4]);
      expect(new Set(reps).size).toBe(reps.length);
    });

    test('a harness-failure row does not get its label reused', async () => {
      // TWO CORRECT FIXES THAT COMBINED INTO DATA LOSS. completedReps excludes
      // harness failures, because they are not measurements; runColdTask labels
      // sequentially from startRep. With reps 1, 2 (harness failure) and 3 on
      // disk, `done` is 2, numbering resumed at 3, and the reader -- which keeps
      // only the newest row per key -- then dropped the real rep 3 entirely.
      const execute = async () => ({ status: 'ok', usd: 0.1, turns: 3, workspace: { pass: true } });
      appendRows(store, [
        row({ arm: 'control', task: 'debug-a', track: 'cold', rep: 1,
              image_digest: `sha256:${DIGEST_A}`, commit_sha: COMMIT_C1, started_at: '2026-09-02T01:00:00Z' }),
        row({ arm: 'control', task: 'debug-a', track: 'cold', rep: 2,
              image_digest: `sha256:${DIGEST_A}`, commit_sha: COMMIT_C1, started_at: '2026-09-02T02:00:00Z',
              status: 'error', usd: 0, turns: 0, score: 0, harness_failure: true }),
        row({ arm: 'control', task: 'debug-a', track: 'cold', rep: 3,
              image_digest: `sha256:${DIGEST_A}`, commit_sha: COMMIT_C1, started_at: '2026-09-02T03:00:00Z' }),
      ]);
      await coldArm('control', {
        tasks: fakeTasks(['debug-a']),
        execute,
        provenance: { image_digest: `sha256:${DIGEST_A}`, commit_sha: COMMIT_C1 },
        storePath: store,
        precision: { fixedReps: 3 },
      });
      const reps = readFileSync(store, 'utf8').trim().split('\n').map(JSON.parse)
        .filter((r) => r.task === 'debug-a').map((r) => r.rep).sort((a, b) => a - b);
      // No label is used twice, so no real measurement can be superseded.
      expect(new Set(reps).size).toBe(reps.length);
      expect(reps).toContain(4);
    });

    test('the default is still one at a time', async () => {
      const state = freshState();
      await coldArm('control', {
        tasks: fakeTasks(['debug-a', 'debug-b', 'debug-c']),
        execute: tracking(state),
        provenance: { image_digest: `sha256:${DIGEST_A}`, commit_sha: COMMIT_C1 },
        storePath: store,
        precision: { minReps: 2, maxReps: 2 },
      });
      expect(state.peak).toBe(1);
    });

    test('every row still lands, and lands once', async () => {
      // Concurrent appends to one JSONL is the obvious way this breaks. The
      // store is synchronous, which makes each append atomic within the
      // process -- this test is what would notice if that ever stopped
      // being true.
      const state = freshState();
      await coldArm('control', {
        tasks: fakeTasks(['debug-a', 'debug-b', 'debug-c', 'debug-d']),
        execute: tracking(state),
        provenance: { image_digest: `sha256:${DIGEST_A}`, commit_sha: COMMIT_C1 },
        storePath: store,
        precision: { minReps: 3, maxReps: 3 },
        concurrency: 4,
      });
      const written = readFileSync(store, 'utf8').trim().split('\n').map(JSON.parse);
      expect(written).toHaveLength(12);
      const keys = written.map((r) => `${r.task}#${r.rep}`);
      expect(new Set(keys).size).toBe(12);
    });
  });

  describe('workspaces are released', () => {
    test('every run frees its workspace once scoring has read it', async () => {
      // The leak Copilot found on #370: `_release` was attached and never
      // called, so a campaign of hundreds of runs kept every workspace.
      const released = [];
      const execute = async ({ task }) => ({
        status: 'ok',
        usd: 0.1,
        turns: 4,
        workspace: { pass: true, id: task.id },
        _release() {
          released.push(task.id);
        },
      });
      await coldArm('control', {
        tasks: fakeTasks(['debug-a', 'debug-b']),
        execute,
        provenance: { image_digest: `sha256:${DIGEST_A}`, commit_sha: COMMIT_C1 },
        storePath: store,
        precision: { minReps: 3, maxReps: 3 },
      });
      expect(released).toHaveLength(6);
    });

    test('a failed run frees its workspace too', async () => {
      // Failures are the runs nobody inspects, so they leak worst.
      let released = 0;
      const execute = async () => ({
        status: 'failed',
        usd: 0.1,
        turns: 1,
        workspace: { pass: false },
        _release: () => {
          released += 1;
        },
      });
      await coldArm('control', {
        tasks: fakeTasks(['debug-a']),
        execute,
        provenance: { image_digest: `sha256:${DIGEST_A}`, commit_sha: COMMIT_C1 },
        storePath: store,
        precision: { minReps: 2, maxReps: 2 },
      });
      expect(released).toBe(2);
    });

    test('a kept workspace survives on disk, a freed one does not', async () => {
      // keepWorkspaces existed as an option and did nothing: its only use was
      // an empty if-block. Asserted against the real filesystem through the
      // real discardWorkspace, because the bug being fixed was precisely that
      // the intention was expressed everywhere and executed nowhere.
      const dirs = {};
      const execute = async ({ task }) => {
        const failing = task.id === 'debug-keep';
        const ws = mkdtempSync(join(tmpdir(), 'ledger-ws-'));
        writeFileSync(join(ws, 'marker'), 'x');
        dirs[task.id] = ws;
        return {
          status: failing ? 'failed' : 'ok',
          usd: 0.1,
          turns: 2,
          workspace: ws,
          keepWorkspace: failing,
        };
      };
      // THROUGH runCampaign, not coldArm, because the wrapper that decides
      // whether a workspace may be freed lives there. A test that called
      // coldArm directly would never exercise it and would pass on a harness
      // that frees nothing.
      await runCampaign({
        arms: ARMS,
        armNames: ['control'],
        execute,
        storePath: store,
        imageDigest: `sha256:${DIGEST_A}`,
        commitSha: COMMIT_C1,
        tracks: ['cold'],
        precision: { minReps: 1, maxReps: 1 },
        tasksForTrack: () => fakeTasks(['debug-keep', 'debug-ok']),
      });
      expect(existsSync(dirs['debug-keep'])).toBe(true);
      expect(existsSync(dirs['debug-ok'])).toBe(false);
      rmSync(dirs['debug-keep'], { recursive: true, force: true });
    });

    test('the row survives a release that throws', async () => {
      // A workspace that cannot be removed is a disk problem, not a reason to
      // lose a measurement already paid for.
      const execute = async () => ({
        status: 'ok',
        usd: 0.1,
        turns: 4,
        workspace: { pass: true },
        _release() {
          throw new Error('EBUSY');
        },
      });
      await coldArm('control', {
        tasks: fakeTasks(['debug-a']),
        execute,
        provenance: { image_digest: `sha256:${DIGEST_A}`, commit_sha: COMMIT_C1 },
        storePath: store,
        precision: { minReps: 2, maxReps: 2 },
      });
      const rows = readFileSync(store, 'utf8').trim().split('\n').map(JSON.parse);
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.score === 1)).toBe(true);
    });
  });

  test('a dying container is a recorded failed run, not a dead campaign', async () => {
    // A container that explodes is a RESULT -- the arm failed that run and the
    // ledger charges it. Aborting the campaign instead would throw away every
    // row already paid for, which is the opposite of what a cost benchmark
    // should do with money already spent.
    let calls = 0;
    const dying = async (args) => {
      calls += 1;
      if (calls > 4) throw new Error('container exploded');
      return execute(args);
    };
    const { rows } = await runCampaign({
      arms: ARMS,
      armNames: ['assist'],
      execute: dying,
      storePath: store,
      imageDigest: `sha256:${DIGEST_A}`,
      commitSha: COMMIT_C1,
      tracks: ['cold'],
      precision: { minReps: 3, maxReps: 3 },
      tasksForTrack: () => fakeTasks(['debug-x', 'shot-y']),
    });

    const stored = loadRows(store);
    expect(stored.length).toBeGreaterThan(0);
    // The successful runs kept their cost; the dead ones are error rows at zero.
    expect(stored.filter((r) => r.status === 'ok').length).toBeGreaterThan(0);
    expect(stored.filter((r) => r.status === 'error').length).toBeGreaterThan(0);
    expect(rows.every((r) => r.image_digest === `sha256:${DIGEST_A}`)).toBe(true);
  });

  test('every rep hits disk as it happens, not after the task finishes', async () => {
    // OBSERVED COSTING REAL MONEY. Rows were appended only after a task's whole
    // rep loop returned, so a campaign interrupted partway through its FIRST
    // task left no store file at all -- every run it had paid for was
    // discarded. The ledger's rule is that money already spent must be
    // recorded, and that has to hold for the harness itself.
    const seen = [];
    const counting = async (args) => {
      const out = await execute(args);
      // Snapshot the store from INSIDE the run, before the task completes.
      seen.push(loadRows(store).length);
      return out;
    };
    await runCampaign({
      arms: ARMS,
      armNames: [],
      execute: counting,
      storePath: store,
      imageDigest: `sha256:${DIGEST_A}`,
      commitSha: COMMIT_C1,
      tracks: ['cold'],
      precision: { minReps: 3, maxReps: 3 },
      tasksForTrack: () => fakeTasks(['debug-x']),
    });

    // By the third run the store already holds the earlier reps. Under the old
    // per-task write this array was [0, 0, 0].
    expect(seen[0]).toBe(0);
    expect(seen[2]).toBeGreaterThan(0);
    expect(loadRows(store)).toHaveLength(3);
  });

  test('a killed warm track resumes instead of restarting', async () => {
    // WITHOUT THIS A WARM TRACK CANNOT FINISH. A warm rep is the whole
    // sequence, and warmArm previously always started at rep 1 -- so a track
    // killed three times in a row would redo the same reps three times and
    // never converge, however much was spent.
    const tasks = fakeTasks(['w-a', 'w-b']).map((t) => ({ ...t, tracks: ['warm'] }));
    const prov = { image_digest: `sha256:${DIGEST_A}`, commit_sha: COMMIT_C1 };

    // Two COMPLETE reps already banked, plus a torn third missing one task.
    const banked = [];
    for (const rep of [1, 2]) {
      for (const t of tasks) banked.push(row({ ...prov, arm: 'assist', track: 'warm', task: t.id, rep }));
    }
    banked.push(row({ ...prov, arm: 'assist', track: 'warm', task: 'w-a', rep: 3 }));
    appendRows(store, banked);

    const seen = [];
    await warmArm('assist', {
      tasks,
      execute: async (args) => {
        seen.push(args.rep);
        return { status: 'ok', usd: 0.1, turns: 5, workspace: { pass: true } };
      },
      provenance: prov,
      storePath: store,
      precision: { minReps: 3, maxReps: 4 },
    });

    // Reps 1 and 2 are complete and skipped. Rep 3 is TORN -- one task never
    // ran, so its later tasks never saw the state the earlier ones left -- and
    // is therefore redone rather than trusted.
    expect(Math.min(...seen)).toBe(3);
    expect(seen).not.toContain(1);
    expect(seen).not.toContain(2);
  });

  test('the battery is a parameter, so a campaign can be scoped to one task', async () => {
    // Hardcoding forTrack() made this untestable except against the shipped
    // tasks, and left an operator no way to re-run one task after a failure
    // without paying for the whole battery.
    const { rows } = await runCampaign({
      arms: ARMS,
      armNames: ['assist'],
      execute,
      storePath: store,
      imageDigest: `sha256:${DIGEST_A}`,
      commitSha: COMMIT_C1,
      tracks: ['cold'],
      precision: { minReps: 3, maxReps: 3 },
      tasksForTrack: () => fakeTasks(['debug-only']),
    });
    expect(new Set(rows.map((r) => r.task))).toEqual(new Set(['debug-only']));
  });

  test('a campaign without a build identity refuses to start', async () => {
    await expect(
      runCampaign({ arms: ARMS, armNames: ['assist'], execute, storePath: store })
    ).rejects.toThrow(/requires imageDigest and commitSha/);
  });

  test('an unknown arm is refused before anything is spent', async () => {
    await expect(
      runCampaign({
        arms: ARMS,
        armNames: ['nope'],
        execute,
        storePath: store,
        imageDigest: `sha256:${DIGEST_A}`,
        commitSha: COMMIT_C1,
      })
    ).rejects.toThrow(/unknown arm/);
  });
});

describe('the report a reader sees', () => {
  const build = { image_digest: `sha256:${DIGEST_A}`, commit_sha: COMMIT_C1 };
  const rows = [];
  for (let rep = 1; rep <= 8; rep++) {
    rows.push(row({ ...build, arm: 'control', task: 'debug-pipeline-py', rep, usd: 0.1 }));
    rows.push(row({ ...build, arm: 'assist', task: 'debug-pipeline-py', rep, usd: 0.05 }));
    rows.push(row({ ...build, arm: 'control', task: 'single-shot-extract', rep, usd: 0.1 }));
    rows.push(row({ ...build, arm: 'assist', task: 'single-shot-extract', rep, usd: 0.12 }));
  }

  test('adversarial families are printed before the headline', () => {
    const text = renderReport(report(rows), {
      adversarialTasks: new Set(['single-shot-extract']),
    });
    const adversarialAt = text.indexOf('single-shot-extract');
    const headlineAt = text.indexOf('cost per unit delivered');
    expect(adversarialAt).toBeGreaterThan(-1);
    expect(adversarialAt).toBeLessThan(headlineAt);
    expect(text).toContain('cannot help');
  });

  test('an empty adversarial set is called out, not passed over', () => {
    // Without it the benchmark has no structural defence against author bias,
    // and silence would read as approval.
    const text = renderReport(report(rows), { adversarialTasks: new Set() });
    expect(text).toContain('NO ADVERSARIAL TASKS RESOLVED');
  });

  test('a withheld headline is printed as withheld, never as a caveated number', () => {
    const bimodal = [];
    for (let rep = 1; rep <= 12; rep++) {
      const usd = rep % 2 ? 0.24 : 0.35;
      bimodal.push(row({ ...build, arm: 'control', task: 'wobble', rep, usd }));
      bimodal.push(row({ ...build, arm: 'assist', task: 'wobble', rep, usd }));
    }
    const text = renderReport(report(bimodal), { adversarialTasks: new Set() });
    expect(text).toContain('HEADLINE WITHHELD');
    expect(text).not.toMatch(/cost per unit delivered: \d/);
  });

  test('headline() returns null rather than a number it cannot support', () => {
    const bimodal = [];
    for (let rep = 1; rep <= 12; rep++) {
      const usd = rep % 2 ? 0.24 : 0.35;
      bimodal.push(row({ ...build, arm: 'control', task: 'wobble', rep, usd }));
      bimodal.push(row({ ...build, arm: 'assist', task: 'wobble', rep, usd }));
    }
    expect(headline(report(bimodal), { track: 'cold', arm: 'assist' })).toBeNull();
    expect(headline(report(rows), { track: 'cold', arm: 'assist' })).toMatch(/of control/);
  });

  test('the headline names the arm it selected, not the word "arm"', () => {
    // With `arm` omitted this picked the first result and labelled it "arm", so
    // a sentence destined for a commit message or PR body carried a real
    // number against a placeholder -- and with several arms present a reader
    // could not tell which one it described.
    const rows = [
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((rep) =>
        row({ arm: 'control', task: 't', rep, usd: 0.1, score: 1 })
      ),
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((rep) =>
        row({ arm: 'assist', task: 't', rep, usd: 0.05, score: 1 })
      ),
    ];
    const line = headline(report(rows), { track: 'cold' });
    expect(line).toMatch(/^assist on cold:/);
    expect(line).not.toMatch(/^arm on/);
  });
});

describe('a head-to-head between two candidates', () => {
  const rowsFor = (arm, task, usds) =>
    usds.map((usd, i) => ({
      task,
      arm,
      track: 'cold',
      rep: i + 1,
      usd,
      score: 1,
      turns: 4,
      status: 'ok',
      image_digest: `sha256:${DIGEST_AAA}`,
      commit_sha: COMMIT_C1,
      started_at: '2026-09-01T00:00:00Z',
    }));

  const both = [
    ...rowsFor('theirs', 't1', [0.10, 0.10, 0.10, 0.10, 0.10, 0.10, 0.10, 0.10]),
    ...rowsFor('ours', 't1', [0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05]),
  ];

  test('any arm can be the comparator, not only control', () => {
    const out = report(both, { baseline: 'theirs' });
    expect(out.tracks.cold.arms.ours.costRatio).toBeCloseTo(0.5, 3);
    expect(out.tracks.cold.arms.theirs).toBeUndefined();
  });

  test('the default comparator is unchanged', () => {
    expect(report(both).baseline).toBe('control');
  });

  test('the rendered line names the comparator it actually used', () => {
    // THE FAILURE THAT WOULD BE WORST. "0.500 of control" printed from a
    // tokenade baseline is a false sentence in the one line most likely to be
    // quoted alone -- and it would look entirely normal.
    const text = renderReport(report(both, { baseline: 'theirs' }), {
      adversarialTasks: new Set(),
    });
    expect(text).toContain('of theirs');
    expect(text).not.toContain('of control');
    expect(text).toContain('baseline: theirs');
  });

  test('the build guard still covers a non-control baseline', () => {
    // The baseline arm previously went through assertSingleBuild only by way
    // of being named `control`; a mixed-build comparator would otherwise sail
    // straight through and become the denominator of every ratio.
    const mixed = [
      ...both,
      ...rowsFor('theirs', 't1', [0.2]).map((r) => ({ ...r, rep: 9, image_digest: `sha256:${DIGEST_BBB}` })),
    ];
    expect(() => report(mixed, { baseline: 'theirs' })).toThrow(/spans 2 builds/);
  });
});

describe('ranking on output tokens instead of dollars', () => {
  const tokenRow = (arm, usd, output, over = {}) => ({
    task: 't1',
    arm,
    track: 'cold',
    usd,
    score: 1,
    turns: 4,
    status: 'ok',
    tokens: { output },
    image_digest: `sha256:${DIGEST_AAA}`,
    commit_sha: COMMIT_C1,
    started_at: '2026-09-01T00:00:00Z',
    ...over,
  });

  // Dollars identical, output halved: the shape of a real output-only effect,
  // and the case where ranking on usd would report nothing at all.
  const rows = [
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((rep) => tokenRow('control', 0.1, 1000, { rep })),
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((rep) => tokenRow('cand', 0.1, 500, { rep })),
  ];

  test('an output-only effect is invisible on dollars and plain on tokens', () => {
    expect(report(rows).tracks.cold.arms.cand.costRatio).toBeCloseTo(1, 3);
    expect(report(rows, { endpoint: 'output' }).tracks.cold.arms.cand.costRatio).toBeCloseTo(0.5, 3);
  });

  test('dollars stay the default', () => {
    expect(report(rows).tracks.cold.arms.cand.costRatio).toBeCloseTo(1, 3);
  });

  test('a row with no token breakdown is dropped, not counted as zero', () => {
    // THE FAILURE THAT WOULD LOOK LIKE A WIN. Rows predate token capture;
    // reading a missing breakdown as 0 output would drag an arm's median
    // toward zero and manufacture the largest effect in the table.
    const withGap = [
      ...rows,
      ...[9, 10].map((rep) => tokenRow('cand', 0.1, undefined, { rep, tokens: undefined })),
    ];
    const out = report(withGap, { endpoint: 'output' });
    expect(out.tracks.cold.arms.cand.costRatio).toBeCloseTo(0.5, 3);
    expect(out.tracks.cold.arms.cand.perTask[0].arm.n).toBe(8);
  });

  test('a ratio is never taken between two different units', () => {
    // If only one side had a breakdown, a fallback to usd would divide tokens
    // by dollars and print a plausible-looking number.
    const oneSided = [
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((rep) => tokenRow('control', 0.1, undefined, { rep, tokens: undefined })),
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((rep) => tokenRow('cand', 0.1, 500, { rep })),
    ];
    const out = report(oneSided, { endpoint: 'output' });
    expect(Number.isFinite(out.tracks.cold.arms.cand.costRatio)).toBe(false);
  });
});

describe('arms are data, not code', () => {
  test('every hook an arm configures actually exists on disk', () => {
    // An arm named a PreCompact hook, `pre-compact.mjs`, that is not in the
    // package -- the real file is `precompact-optimize.mjs`. It changed no
    // result, because no benchmark task ever reached the context window and
    // PreCompact never fired, but an arm that quietly runs the product with a
    // feature missing and reports it as the product is the worst kind of
    // measurement error: invisible, and in whichever direction the missing
    // feature would have moved things.
    const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
    const named = new Set();
    for (const arm of Object.values(ARMS)) {
      for (const entries of Object.values(arm.settings?.hooks || {})) {
        for (const entry of entries) {
          for (const hook of entry.hooks || []) {
            const match = /plugin\/hooks\/([A-Za-z0-9._-]+\.mjs)/.exec(hook.command || '');
            if (match) named.add(match[1]);
          }
        }
      }
    }
    expect(named.size).toBeGreaterThan(3);
    for (const file of named) {
      expect([file, existsSync(join(root, 'plugin/hooks', file))]).toEqual([file, true]);
    }
  });

  test('the documented character counts match the arms they describe', () => {
    // THE COUNTS ARE THE COMPARISON. "510 against 2,667" is the headline claim
    // this whole head-to-head rests on, and it was stated three times in one
    // file as 2,669, 2,667 and 471 -- two of which were wrong, because the
    // block gained a header line after the number was written. A figure that
    // cannot be reproduced from the arm it describes is worse than no figure.
    //
    // Both are measured the same way, as the WHOLE delivered claudeMd, so they
    // are comparable. If either text changes on purpose, this fails and the
    // prose has to be updated with it -- which is the point.
    const ours = ARMS['ours-rules'].claudeMd;
    const theirs = ARMS['tokenade-rules'].claudeMd;
    expect(ours).toHaveLength(510);
    expect(theirs).toHaveLength(2667);

    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../bench/ledger/arms.mjs'),
      'utf8'
    );
    // Every count the file states about these two arms must be one of the two
    // real lengths -- no stale third number surviving in a comment.
    for (const stated of source.match(/\b\d,\d{3}\b|\b\d{3}\b(?= characters)/g) || []) {
      const n = Number(stated.replace(',', ''));
      expect([510, 2667]).toContain(n);
    }
  });

  test('the shipped arms are data: settings, environment and an optional rules file', () => {
    // claudeMd was added because the leader cannot be represented without it --
    // their CLI runs 0.38 times per task while their rules file does the work,
    // so hooks-and-environment could not express them at all. It stays OPTIONAL
    // so the constraint that an arm is data rather than code still holds.
    expect(Object.keys(ARMS)).toEqual(
      expect.arrayContaining(['control', 'assist', 'assist-noseed', 'assist-norules', 'tokenade-rules'])
    );
    // `scaffold` was added for the same reason and under the same restriction.
    // A competitor whose hooks live in the PROJECT rather than at an absolute
    // path in the image -- claude-token-optimizer writes twelve scripts into
    // .claude/hooks/ and invokes them relatively -- could otherwise only be
    // represented by its rules file, which is the understatement the tokenade
    // arm already carries. A scaffold is a PATH TO FILES, so the arm stays data:
    // it cannot express behaviour, only content, and the assertions below hold
    // it to that.
    const allowed = new Set(['env', 'name', 'settings', 'claudeMd', 'scaffold']);
    for (const arm of Object.values(ARMS)) {
      for (const key of Object.keys(arm)) expect(allowed.has(key)).toBe(true);
      expect(arm.name).toBeTruthy();
      if (arm.scaffold !== undefined) {
        // Data, and data that exists: a scaffold naming a directory that is not
        // there fails at run time, mid-campaign, after earlier arms have already
        // been paid for.
        expect(typeof arm.scaffold).toBe('string');
        expect(isAbsolute(arm.scaffold)).toBe(true);
        expect(existsSync(arm.scaffold)).toBe(true);
        expect(statSync(arm.scaffold).isDirectory()).toBe(true);
      }
    }
  });
  test('the posture arms differ from assist in the mode and nothing else', () => {
    // THE COMPARISON IS ONLY MEANINGFUL IF ONE VARIABLE MOVES. `enforce` against
    // `assist` is meant to price refusals plus the routing advisory; if some
    // future change adds an env var or a hook to one arm and not the other, that
    // number silently starts pricing something else too, and nothing in the
    // report would say so.
    //
    // `enforce` also matters more than an ordinary arm: mode() returns
    // MODE_ENFORCE for any unrecognised value, so it is what a user gets out of
    // the box, and it is the posture #357's target is denominated on.
    const base = ARMS['assist-mcp'];
    const { enforce, advise } = ARMS;
    expect(enforce.env.TOKEN_OPTIMIZER_MODE).toBe('enforce');
    expect(advise.env.TOKEN_OPTIMIZER_MODE).toBe('advise');
    expect(base.env.TOKEN_OPTIMIZER_MODE).toBe('assist');

    for (const arm of [enforce, advise]) {
      // Same settings, byte for byte -- hooks AND the MCP server.
      expect(JSON.stringify(arm.settings)).toEqual(JSON.stringify(base.settings));
      // Exactly one environment key may differ, and it must be the mode.
      const differing = Object.keys({ ...base.env, ...arm.env }).filter(
        (k) => base.env[k] !== arm.env[k]
      );
      expect(differing).toEqual(['TOKEN_OPTIMIZER_MODE']);
      // A rules file would be a second variable wearing a different name.
      expect(arm.claudeMd).toBeUndefined();
      // The scaffold must be the SAME one, not absent. All three postures need
      // the MCP server installed -- without it an enforcing arm refuses a call
      // and points at a tool that is not there -- so what keeps the comparison
      // single-variable is that they share it, not that they lack it.
      expect(arm.scaffold).toBe(base.scaffold);
    }
  });

  test('the enforcing arm registers the MCP server, or it cannot refuse anything', () => {
    // NOT A STYLE CHECK. `refusalsEnabled()` is necessary but not sufficient: a
    // refusal only fires when the replacement tool has positive registration
    // evidence. Measured through the real hook -- the same 200 KB Read payload
    // gives NO output under mode=enforce with capabilities empty, and a
    // smart_read redirect with them present. An enforce arm that inherited
    // `TOKEN_OPTIMIZER_MCP_CAPABILITIES: ''` from `assist` would therefore never
    // refuse, would measure identically to assist, and would be reported as
    // "enforcement costs nothing" -- which is the opposite of true.
    for (const name of ['enforce', 'advise', 'assist-mcp']) {
      const arm = ARMS[name];
      // THROUGH THE SCAFFOLD, NOT settings.mcpServers. The executor runs
      // `claude -p ... --settings /arm/settings.json` with no --mcp-config, and
      // --settings does not carry MCP servers. An arm declaring them there
      // produced a transcript with zero mcp__ tools while its refusals still
      // fired: the agent was told to call smart_read, found no such tool, and
      // fell back to Bash. A project .mcp.json in the workspace registers it.
      expect(arm.settings.mcpServers).toBeUndefined();
      expect(arm.scaffold).toBeTruthy();
      const cfg = join(arm.scaffold, '.mcp.json');
      expect(existsSync(cfg)).toBe(true);
      const servers = JSON.parse(readFileSync(cfg, 'utf8')).mcpServers;
      expect(Object.keys(servers)).toContain('token-optimizer');
      // Absolute: the workspace has no plugin root, so ${CLAUDE_PLUGIN_ROOT}
      // would not expand.
      const args = servers['token-optimizer'].args.join(' ');
      expect(args).toMatch(/^\/.*launch\.mjs$/);
      expect(args).not.toContain('${');
      // Capabilities must NOT be blanked, or the host's real inventory is
      // overridden with "nothing is registered" and refusals die silently.
      expect(arm.env.TOKEN_OPTIMIZER_MCP_CAPABILITIES).toBeUndefined();
    }
    // The historical assist arm is the opposite case and must stay that way:
    // no server, capabilities explicitly blanked.
    expect(ARMS.assist.settings.mcpServers).toBeUndefined();
    expect(ARMS.assist.env.TOKEN_OPTIMIZER_MCP_CAPABILITIES).toBe('');
  });


  test('a competitor arm is the competitor, not a paraphrase of it', () => {
    // Both were captured by running the vendor's own installer in a container.
    // The check that matters is that their INTERCEPTION is present, because a
    // competitor represented by its rules file alone is a weaker opponent than
    // the one we name -- which is exactly the caveat the tokenade arm carries.
    const cto = ARMS.cto;
    const ctoCommands = JSON.stringify(cto.settings.hooks.PreToolUse);
    expect(ctoCommands).toContain('pre-tool-read-guard.sh');
    expect(ctoCommands).toContain('pre-tool-bash-guard.sh');
    // Their hooks are invoked relative to the project, which is why the arm
    // needs a scaffold at all -- if this ever becomes absolute, the scaffold is
    // no longer what makes the arm work and the coupling should be revisited.
    expect(ctoCommands).toContain('.claude/hooks/');
    expect(existsSync(join(cto.scaffold, 'CLAUDE.md'))).toBe(true);

    // EVERY hook the settings name must be in the scaffold, not just a sample.
    // This is the tripwire for a packaging mistake rather than a code one: the
    // repository's own `.gitignore` excludes `.claude/` at any depth, so the
    // first commit of this scaffold silently dropped all twelve hook scripts and
    // kept the rules file -- 5 of 20 files, no warning. An arm missing its hooks
    // still runs, still scores, and loses to us for reasons that have nothing to
    // do with their product. It passes on this machine, where the files exist
    // untracked, and fails on a fresh clone, which is exactly what CI is for.
    const referenced = [...JSON.stringify(cto.settings).matchAll(/\.claude\/hooks\/([\w.-]+\.sh)/g)]
      .map((m) => m[1]);
    expect(referenced.length).toBeGreaterThanOrEqual(8);
    for (const script of new Set(referenced)) {
      expect({
        script,
        present: existsSync(join(cto.scaffold, '.claude', 'hooks', script)),
      }).toEqual({ script, present: true });
    }

    // tokenjuice needs no scaffold: its installer writes only a settings block
    // pointing at the globally installed binary.
    const tj = ARMS.tokenjuice;
    expect(tj.scaffold).toBeUndefined();
    expect(JSON.stringify(tj.settings.hooks.PreToolUse)).toContain('tokenjuice');

    // Neither may leave our own optimizer running, or the arm measures two
    // products at once and attributes both to the competitor.
    for (const arm of [cto, tj]) {
      expect(arm.env.TOKEN_OPTIMIZER_MODE).toBe('off');
      expect(JSON.stringify(arm.settings)).not.toContain('token-optimizer-mcp');
    }
  });

  test('the leader arm carries their rules file and no hooks of ours', () => {
    const tk = ARMS['tokenade-rules'];
    expect(tk.claudeMd).toMatch(/Keep output lean/);
    expect(tk.claudeMd.length).toBeGreaterThan(2000);
    expect(tk.settings).toEqual({});
    expect(tk.env.TOKEN_OPTIMIZER_MODE).toBe('off');
  });

  test('control declares an empty inventory rather than assuming one', () => {
    expect(ARMS.control.env.TOKEN_OPTIMIZER_MCP_CAPABILITIES).toBe('');
    expect(ARMS.control.settings).toEqual({});
  });

  test('assist-noseed differs from assist by exactly one variable', () => {
    const a = ARMS.assist.env;
    const b = ARMS['assist-noseed'].env;
    const changed = Object.keys({ ...a, ...b }).filter((k) => a[k] !== b[k]);
    expect(changed).toEqual(['TOKEN_OPTIMIZER_SEED']);
    expect(ARMS['assist-noseed'].settings).toBe(ARMS.assist.settings);
  });

  test('an outsider can add arms from a file', () => {
    const path = join(dir, 'arms.json');
    writeFileSync(path, JSON.stringify({ mine: { settings: { hooks: {} }, env: { X: '1' } } }));
    expect(loadArms(path).mine.env.X).toBe('1');
  });

  test('an outsider can bring a rules file, like every competitor here does', () => {
    // loadArms rebuilt each arm from name/settings/env and silently dropped
    // claudeMd, so the external path could not express the one thing this
    // harness compares: every competitor reduces to a rules file. Their own
    // CLI runs 0.38 times per task while their claudeMd does the work. An
    // outsider could define one, have it discarded without a word, and measure
    // their tool as though it shipped no instructions.
    const path = join(dir, 'arms-md.json');
    writeFileSync(
      path,
      JSON.stringify({ theirs: { env: {}, claudeMd: '# rules\n\nBe terse.\n' } })
    );
    expect(loadArms(path).theirs.claudeMd).toBe('# rules\n\nBe terse.\n');
  });

  test('an arm without a rules file does not gain an empty one', () => {
    // The executor writes claudeMd when present; materialising an empty file
    // would give a no-rules arm a CLAUDE.md it never asked for.
    const path = join(dir, 'arms-none.json');
    writeFileSync(path, JSON.stringify({ bare: { env: {} } }));
    expect('claudeMd' in loadArms(path).bare).toBe(false);
  });

  test('a non-string rules file is refused, not coerced', () => {
    const path = join(dir, 'arms-bad.json');
    writeFileSync(path, JSON.stringify({ bad: { claudeMd: { oops: true } } }));
    expect(() => loadArms(path)).toThrow(/non-string claudeMd/);
  });
});

describe('the command line', () => {
  test('a non-numeric guard value is refused, not turned into NaN', () => {
    // THE DEFECT THIS REOPENS IF IT REGRESSES. Number('foo') is NaN and every
    // comparison against NaN is false, so `minutes < NaN` never fired and a
    // campaign could launch on a token about to expire -- the same failure the
    // default's own comment records, arriving from the other side.
    expect(() => parseArgs(['--min-credential-minutes', 'foo'])).toThrow(/must be a number/);
    expect(() => parseArgs(['--min-credential-minutes', '-5'])).toThrow(/must be a number/);
    // Zero is a legitimate "I accept the risk", distinct from a typo.
    expect(parseArgs(['--min-credential-minutes', '0']).minCredentialMinutes).toBe(0);
  });

  test('a non-numeric rep cap is refused rather than silently ignored', () => {
    // NaN and 0 are both falsy where precision is assembled, so the flag looked
    // accepted while the run quietly used the default cap.
    expect(() => parseArgs(['--max-reps', 'foo'])).toThrow(/must be an integer/);
    expect(() => parseArgs(['--max-reps', '0'])).toThrow(/must be an integer/);
    expect(parseArgs(['--max-reps', '9']).maxReps).toBe(9);
  });

  test('defaults are the safe ones', () => {
    const o = parseArgs([]);
    expect(o.arms).toEqual(['assist']);
    expect(o.tracks).toEqual(['cold', 'warm']);
    expect(o.reportOnly).toBe(false);
  });

  test('unknown flags are refused rather than ignored', () => {
    expect(() => parseArgs(['--wat'])).toThrow(/unknown argument/);
  });

  test('provenance is read from the machine when nothing is stated', () => {
    const calls = [];
    const run = (cmd, args) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      return cmd === 'docker' ? 'sha256:deadbeef\n' : 'c0ffee123\n';
    };
    const p = detectProvenance({ image: 'img', cwd: '/repo', run });
    expect(p).toEqual({ imageDigest: 'sha256:deadbeef', commitSha: 'c0ffee123' });
    expect(calls[0]).toContain('docker image inspect');
  });

  test('the image digest can never be stated, only measured', () => {
    // A digest an operator could type is a digest they could mistype, and a
    // mistyped digest is the silent build-mixing this harness exists to end.
    // The commit is different -- see the next test -- but the artifact is not.
    expect(parseArgs([])).not.toHaveProperty('imageDigest');
    expect(() => parseArgs(['--image-digest', 'sha256:whatever'])).toThrow(/unknown argument/);
  });

  test('a stated commit sha replaces git, and nothing else', () => {
    // Why this is allowed at all: a cell can only be topped up by rows sharing
    // its build key, so once the commit moves -- a rebase, an amend, a
    // message-only rewrite over an identical tree -- the only alternative was
    // checking the old commit out and running the harness AS IT WAS THEN. Doing
    // exactly that ran a `coldArm` predating the `nextRep` fix, which labelled a
    // 3-rep top-up 1,2,3 over labels already in use and shadowed three paid runs
    // behind a colliding key.
    const sha = 'a69584024d9d6222449dbe23968615b63012d767';
    const calls = [];
    const run = (cmd, args) => {
      calls.push(cmd);
      if (cmd === 'docker') return 'sha256:deadbeef\n';
      throw new Error('git must not be consulted when the commit is stated');
    };
    const p = detectProvenance({ image: 'img', cwd: '/repo', commitSha: sha, run });
    expect(p).toEqual({ imageDigest: 'sha256:deadbeef', commitSha: sha });
    // The digest is still measured, so stating a commit cannot smuggle in an
    // artifact claim alongside it.
    expect(calls).toEqual(['docker']);
  });

  test('--commit-sha refuses anything but a full sha, before a container starts', () => {
    // An unrecognised sha is not a loud failure on its own: it simply forms a
    // key nothing on disk shares, so the run banks a fresh arm instead of
    // topping up the intended one and the operator sees a campaign that
    // "restarted for no reason".
    expect(() => parseArgs(['--commit-sha', 'a695840'])).toThrow(/full 40-character sha/);
    expect(() => parseArgs(['--commit-sha', 'deadbeef'])).toThrow(/full 40-character sha/);
    expect(() => parseArgs(['--commit-sha', 'A'.repeat(40)])).toThrow(/full 40-character sha/);
    expect(() => parseArgs(['--commit-sha', 'z'.repeat(40)])).toThrow(/full 40-character sha/);
    const ok = 'a69584024d9d6222449dbe23968615b63012d767';
    expect(parseArgs(['--commit-sha', ok]).commitSha).toBe(ok);
    expect(parseArgs([])).not.toHaveProperty('commitSha');
  });
});
