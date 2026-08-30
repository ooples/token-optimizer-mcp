/**
 * The project registry must not be rescanned on every call.
 *
 * WHAT THIS COSTS WHEN IT REGRESSES. `registerProject` runs on every MCP tool
 * call, and it called `registeredProjects()` to answer one question: have I
 * already registered this project for this client in the last hour? That fold
 * reads the whole append-only registry and runs TWO `existsSync` per record --
 * one on the root, one on the graph file.
 *
 * Measured on the author's machine with 4,033 records: a trivial `get_cached`
 * tool call took 127ms, of which a leaf CPU profile attributed 48.8% to
 * `existsSync` and 20.0% to the path normaliser feeding it. Truncating the
 * registry to 50 records took the same call to 10ms -- a 12.7x speedup, which
 * is the causal proof that the scan, not the tool, was the cost.
 *
 * It also degrades forever: the registry is append-only, so every project ever
 * touched makes every future tool call slower. That is why it presented as
 * "it got slow" rather than "it is slow".
 *
 * These tests assert the PROPERTY (syscalls must not scale with registry size)
 * rather than a millisecond budget, which would be machine-dependent and flaky.
 */

import { mkdtempSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as fs from 'node:fs';

let home;
let registry;
let repo;

const PROJECT_REGISTRY_VERSION = 1;

/** Writes `count` registry records naming real, existing roots. */
function seedRegistry(count) {
  for (let i = 0; i < count; i++) {
    const root = join(home, 'repo');
    appendFileSync(
      registry,
      JSON.stringify({
        v: PROJECT_REGISTRY_VERSION,
        id: 'id-' + i,
        name: 'p' + i,
        root,
        graphDir: join(root, '.token-optimizer', 'wiki'),
        client: 'seed',
        at: Date.now(),
      }) + '\n'
    );
  }
}

/**
 * Wall time of one call, median of a few, because an ESM module namespace is
 * FROZEN -- `fs.existsSync` cannot be monkey-patched to count syscalls, which
 * the first version of this test tried and failed on with "Cannot assign to
 * read only property". Time is the honest proxy here anyway: it is the symptom
 * users reported.
 */
function medianMs(fn, reps = 5) {
  const times = [];
  for (let i = 0; i < reps; i++) {
    const t0 = Number(process.hrtime.bigint());
    fn();
    times.push((Number(process.hrtime.bigint()) - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'registry-cost-'));
  repo = join(home, 'repo');
  fs.mkdirSync(join(repo, '.git'), { recursive: true });
  fs.mkdirSync(join(repo, '.token-optimizer', 'wiki'), { recursive: true });
  registry = join(home, 'projects.jsonl');
  writeFileSync(registry, '');
  // The registry path override, NOT a home override -- without this the test
  // would silently exercise the developer's real 4,000-record registry.
  process.env.TOKEN_OPTIMIZER_PROJECT_REGISTRY = registry;
});

afterEach(() => {
  delete process.env.TOKEN_OPTIMIZER_PROJECT_REGISTRY;
  rmSync(home, { recursive: true, force: true });
});

describe('registerProject does not scale with registry size', () => {
  test('a large registry costs no more than a small one', async () => {
    const { registerProject } = await import(
      '../../hooks-core/projects.mjs'
    );

    seedRegistry(20);
    const small = medianMs(() =>
      registerProject({ root: repo, graphDir: join(repo, '.token-optimizer', 'wiki'), client: 'a' })
    );

    seedRegistry(400);
    const large = medianMs(() =>
      registerProject({ root: repo, graphDir: join(repo, '.token-optimizer', 'wiki'), client: 'b' })
    );

    // THE PROPERTY: 20x the records must not mean 20x the work. Generous
    // headroom plus a floor, so this measures scaling rather than scheduler
    // noise on a millisecond-scale operation.
    expect(large).toBeLessThan(Math.max(small * 4, 5));
  });

  test('a repeat call within the process does not rescan at all', async () => {
    const { registerProject } = await import(
      '../../hooks-core/projects.mjs'
    );
    seedRegistry(200);

    const args = { root: repo, graphDir: join(repo, '.token-optimizer', 'wiki'), client: 'c' };
    registerProject(args);
    const second = medianMs(() => registerProject(args));

    // The second call answers from memory, so it must be far below the cost of
    // reading a 200-record registry.
    expect(second).toBeLessThan(2);
  });
});

describe('correctness is preserved', () => {
  test('a project is still registered and readable', async () => {
    const { registerProject, registeredProjects } =
      await import('../../hooks-core/projects.mjs');

    registerProject({
      root: repo,
      graphDir: join(repo, '.token-optimizer', 'wiki'),
      client: 'claude-code',
    });

    const found = registeredProjects().find((p) => p.root.endsWith('repo'));
    expect(found).toBeTruthy();
    expect(found.clients).toContain('claude-code');
  });

  test('a non-repository is still refused', async () => {
    const { registerProject } = await import('../../hooks-core/projects.mjs');
    const plain = join(home, 'not-a-repo');
    fs.mkdirSync(plain, { recursive: true });
    expect(
      registerProject({ root: plain, graphDir: join(plain, 'g'), client: 'x' })
    ).toBeNull();
  });
});
