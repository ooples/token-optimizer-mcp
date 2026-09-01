/**
 * The campaign layer, driven end to end with a fake agent.
 *
 * The properties pinned here are the ones whose absence produced wrong,
 * confidently-reported numbers in the harness this replaces.
 */

import { describe, expect, test, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendRows, loadRows, completedReps, buildsPresent } from '../../bench/ledger/store.mjs';
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

const row = (over = {}) => ({
  task: 'single-shot-extract',
  arm: 'assist',
  rep: 1,
  track: 'cold',
  status: 'ok',
  usd: 0.1,
  turns: 3,
  score: 1,
  image_digest: 'sha256:new',
  commit_sha: 'abc1234',
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

  test('resumption counts only reps from the SAME build', () => {
    // THE DEFECT THIS REPLACES. The old harness skipped any run already
    // recorded, so after a rebuild it topped an arm up with new-build reps and
    // averaged them with old-build ones under one name.
    appendRows(store, [
      row({ image_digest: 'sha256:old', rep: 1 }),
      row({ image_digest: 'sha256:old', rep: 2 }),
      row({ image_digest: 'sha256:new', rep: 1 }),
    ]);
    const rows = loadRows(store);
    const args = { arm: 'assist', track: 'cold', task: 'single-shot-extract' };
    expect(completedReps(rows, { ...args, build: buildKey({ image_digest: 'sha256:new', commit_sha: 'abc1234' }) })).toBe(1);
    expect(completedReps(rows, { ...args, build: buildKey({ image_digest: 'sha256:old', commit_sha: 'abc1234' }) })).toBe(2);
  });

  test('builds present are listed newest first', () => {
    appendRows(store, [
      row({ image_digest: 'sha256:old', started_at: '2026-08-30T10:00:00Z' }),
      row({ image_digest: 'sha256:new', started_at: '2026-08-31T22:00:00Z' }),
    ]);
    expect(buildsPresent(loadRows(store))[0].build).toContain('sha256:new');
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
      provenance: { image_digest: 'sha256:a', commit_sha: 'c1' },
      storePath: store,
      precision: { minReps: 3, maxReps: 3 },
    });
    expect(order.every((a) => a === 'control')).toBe(true);
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
      imageDigest: 'sha256:a',
      commitSha: 'c1',
      tracks: ['cold'],
      precision: { minReps: 3, maxReps: 3 },
      tasksForTrack: () => fakeTasks(['debug-x', 'shot-y']),
    });

    const stored = loadRows(store);
    expect(stored.length).toBeGreaterThan(0);
    // The successful runs kept their cost; the dead ones are error rows at zero.
    expect(stored.filter((r) => r.status === 'ok').length).toBeGreaterThan(0);
    expect(stored.filter((r) => r.status === 'error').length).toBeGreaterThan(0);
    expect(rows.every((r) => r.image_digest === 'sha256:a')).toBe(true);
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
      imageDigest: 'sha256:a',
      commitSha: 'c1',
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
    const prov = { image_digest: 'sha256:a', commit_sha: 'c1' };

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
      imageDigest: 'sha256:a',
      commitSha: 'c1',
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
        imageDigest: 'sha256:a',
        commitSha: 'c1',
      })
    ).rejects.toThrow(/unknown arm/);
  });
});

describe('the report a reader sees', () => {
  const build = { image_digest: 'sha256:a', commit_sha: 'c1' };
  const rows = [];
  for (let rep = 1; rep <= 4; rep++) {
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
});

describe('arms are data, not code', () => {
  test('the shipped arms differ only in settings and environment', () => {
    expect(Object.keys(ARMS)).toEqual(expect.arrayContaining(['control', 'assist', 'assist-noseed']));
    for (const arm of Object.values(ARMS)) {
      expect(Object.keys(arm).sort()).toEqual(['env', 'name', 'settings']);
    }
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
});

describe('the command line', () => {
  test('defaults are the safe ones', () => {
    const o = parseArgs([]);
    expect(o.arms).toEqual(['assist']);
    expect(o.tracks).toEqual(['cold', 'warm']);
    expect(o.reportOnly).toBe(false);
  });

  test('unknown flags are refused rather than ignored', () => {
    expect(() => parseArgs(['--wat'])).toThrow(/unknown argument/);
  });

  test('provenance is read from the machine, never from a flag', () => {
    // A digest an operator could type is a digest they could mistype, and a
    // mistyped digest is the silent build-mixing this harness exists to end.
    const calls = [];
    const run = (cmd, args) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      return cmd === 'docker' ? 'sha256:deadbeef\n' : 'c0ffee123\n';
    };
    const p = detectProvenance({ image: 'img', cwd: '/repo', run });
    expect(p).toEqual({ imageDigest: 'sha256:deadbeef', commitSha: 'c0ffee123' });
    expect(calls[0]).toContain('docker image inspect');
    expect(parseArgs([])).not.toHaveProperty('imageDigest');
  });
});
