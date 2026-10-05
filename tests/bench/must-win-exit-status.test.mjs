import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

/**
 * THE GATE'S EXIT STATUS IS THE ONLY PART OF IT A BUILD READS.
 *
 * must-win.check.mjs has two output modes. The human one prints a summary and
 * exits non-zero when an enforced pair regresses. The --json one printed the
 * same verdict as a report and then exited zero unconditionally, so anything
 * that ran the gate for its machine-readable output -- which is the mode a
 * build step reaches for -- was told the run passed while the report it had
 * just been handed recorded an enforced pair losing.
 *
 * These cases drive the real gate over a mutated copy of the published record.
 * The mutation multiplies our own session cost by a thousand and calls our
 * reduction worse than the input it was given, so enforced pairs have to lose.
 * The control arm runs the same two modes over an unmutated copy through the
 * same temporary paths, so a non-zero status below is the mutation and not the
 * plumbing.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const GATE = join(repo, 'bench', 'compression', 'must-win.check.mjs');
const RECORDS = join(repo, 'bench', 'compression', 'headroom', 'results');
const RUN_MS = 180000;

let dir;
let clean;
let replicate;
let regressed;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'must-win-exit-'));
  const published = JSON.parse(
    readFileSync(join(RECORDS, 'head-to-head.json'), 'utf8')
  );
  clean = join(dir, 'clean.json');
  writeFileSync(clean, JSON.stringify(published));
  // The replicate is copied unmutated into BOTH arms. A speed pair whose two
  // recordings come from different captures is refused before it is ever
  // scored, and that refusal would fail the control arm for a reason that has
  // nothing to do with the mutation under test.
  replicate = join(dir, 'replicate.json');
  writeFileSync(
    replicate,
    readFileSync(join(RECORDS, 'head-to-head.replicate.json'), 'utf8')
  );

  const worse = JSON.parse(JSON.stringify(published));
  for (const workload of worse.workloads) {
    workload.tokens.ours = '199.9%';
    for (const point of ['p0', 'p1']) {
      for (const arm of Object.keys(workload.cost.session[point])) {
        if (arm === 'ours' || arm === 'proxy')
          workload.cost.session[point][arm] = String(
            Number(workload.cost.session[point][arm]) * 1000
          );
      }
    }
  }
  regressed = join(dir, 'regressed.json');
  writeFileSync(regressed, JSON.stringify(worse));
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const gate = (results, ...flags) =>
  spawnSync(
    process.execPath,
    [GATE, '--results', results, '--replicate', replicate, ...flags],
    { cwd: repo, encoding: 'utf8' }
  );

const regressedCount = (stdout) => {
  const found = /(\d+) regressed/.exec(stdout);
  if (found === null) throw new Error('the gate printed no regressed count');
  return Number(found[1]);
};

describe('the must-win gate exits on its own verdict in every mode', () => {
  it(
    'fails in --json mode when an enforced pair regresses',
    () => {
      expect(gate(regressed, '--json').status).toBe(1);
    },
    RUN_MS
  );

  it(
    'still prints the whole report on the run it fails',
    () => {
      const run = gate(regressed, '--json');
      const report = JSON.parse(run.stdout);
      expect(Object.keys(report).length).toBeGreaterThan(0);
    },
    RUN_MS
  );

  it(
    'fails the same way without --json',
    () => {
      expect(gate(regressed).status).toBe(1);
    },
    RUN_MS
  );

  it(
    'control: the unmutated record passes in both modes',
    () => {
      expect(gate(clean).status).toBe(0);
      expect(gate(clean, '--json').status).toBe(0);
    },
    RUN_MS
  );

  it(
    'control: a regression is what the gate objected to',
    () => {
      expect(regressedCount(gate(regressed).stdout)).toBeGreaterThan(0);
      expect(regressedCount(gate(clean).stdout)).toBe(0);
    },
    RUN_MS
  );
});