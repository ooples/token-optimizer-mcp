/**
 * #546 review: a project with both a per-user and an in-repo store, and the
 * identity rules that let a moved repository find its store.
 */

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { migrate, readTombstone, recover } from '../../hooks-core/migrate.mjs';
import { projectStore, readState, storeId } from '../../hooks-core/maintenance.mjs';

const ROOT = process.cwd();
const quiet = () => ({ complete: true, found: [] });

let work;
let repo;
let env;
let id;
let dest;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'store-merge-'));
  repo = join(work, 'repo');
  env = { TOKEN_OPTIMIZER_HOME: join(work, 'home') };
  mkdirSync(join(repo, '.git', 'info'), { recursive: true });
  id = storeId(join(repo, '.token-optimizer'));
  dest = join(work, 'home', 'projects', id, 'store');
  // The per-user store a current release wrote...
  mkdirSync(join(dest, 'wiki', 'artifacts'), { recursive: true });
  writeFileSync(
    join(dest, 'wiki', 'graph.jsonl'),
    `${JSON.stringify({ t: 'n', id: 'file:shared', at: 50, rid: 'r-new' })}\n${JSON.stringify({ t: 'n', id: 'file:only-new', at: 5, rid: 'r-x' })}\n`
  );
  writeFileSync(join(dest, 'wiki', 'artifacts', 'same.txt'), 'per-user copy');
  // ...and the in-repo store an older client created afterwards.
  mkdirSync(join(repo, '.token-optimizer', 'wiki', 'artifacts'), { recursive: true });
  writeFileSync(
    join(repo, '.token-optimizer', 'wiki', 'graph.jsonl'),
    [
      { t: 'n', id: 'file:shared', at: 10, rid: 'r-old' }, // older than the per-user copy
      { t: 'n', id: 'file:only-old', at: 7, rid: 'r-y' },
      { t: 'n', id: 'file:legacy', at: 8 }, // an older release wrote no rid
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n'
  );
  writeFileSync(join(repo, '.token-optimizer', 'wiki', 'metrics.jsonl'), '{"kind":"read","id":"m1"}\n');
  writeFileSync(join(repo, '.token-optimizer', 'wiki', 'artifacts', 'same.txt'), 'in-repo copy');
  writeFileSync(join(repo, '.token-optimizer', 'wiki', 'artifacts', 'other.txt'), 'only in repo');
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const graph = () =>
  readFileSync(join(dest, 'wiki', 'graph.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

describe('an in-repo store beside an existing per-user store', () => {
  test('is merged into it instead of refused', () => {
    const result = migrate(repo, { env, processes: quiet });
    expect(result.ok).toBe(true);
    expect(readTombstone(repo)?.movedTo).toBe(result.report.movedTo);
    const ids = graph().map((r) => r.id);
    // Both stores' records are present, each once.
    expect(ids.filter((x) => x === 'file:only-new')).toHaveLength(1);
    expect(ids.filter((x) => x === 'file:only-old')).toHaveLength(1);
    expect(ids.filter((x) => x === 'file:legacy')).toHaveLength(1);
    // The older in-repo record for a shared id did not come back after the newer one.
    expect(graph().filter((r) => r.id === 'file:shared').map((r) => r.at)).toEqual([50]);
    // A log only the in-repo store had is carried over.
    expect(readFileSync(join(dest, 'wiki', 'metrics.jsonl'), 'utf8')).toContain('"m1"');
    // Whole files: kept where the per-user store has one, added where it has none.
    expect(readFileSync(join(dest, 'wiki', 'artifacts', 'same.txt'), 'utf8')).toBe('per-user copy');
    expect(readFileSync(join(dest, 'wiki', 'artifacts', 'other.txt'), 'utf8')).toBe('only in repo');
  });

  test('a migrator killed mid-merge is completed by recovery, not rolled back', () => {
    const r = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { migrate } from ${JSON.stringify(pathToFileURL(join(ROOT, 'hooks-core', 'migrate.mjs')).href)};
         migrate(${JSON.stringify(repo)}, {
           processes: () => ({ complete: true, found: [] }),
           faultAt: (at) => { if (at === 'merged') process.exit(137); },
         });`,
      ],
      { encoding: 'utf8', env: { ...process.env, ...env } }
    );
    expect(r.status).toBe(137);
    const done = recover(repo, { env });
    expect(done).toMatchObject({ recovered: true, completed: true });
    expect(readState(id, env).state).toBe('normal');
    expect(readTombstone(repo)?.movedTo).toBe(dest);
    // Running the merge again during recovery added nothing twice.
    const ids = graph().map((x) => x.id);
    expect(ids.filter((x) => x === 'file:only-old')).toHaveLength(1);
    expect(ids.filter((x) => x === 'file:legacy')).toHaveLength(1);
  });

  test('an error after the merge rolls back without deleting the per-user store', () => {
    // E.g. ENOSPC writing meta.json, thrown in the same process after the merge.
    const result = migrate(repo, {
      env,
      processes: quiet,
      faultAt: (at) => {
        if (at === 'renamed') throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' });
      },
    });
    expect(result.ok).toBe(false);
    // The per-user store survives with its own records...
    expect(graph().some((r) => r.id === 'file:only-new')).toBe(true);
    // ...the in-repo store is back where it was...
    expect(statSync(join(repo, '.token-optimizer')).isDirectory()).toBe(true);
    // ...and a retry merges again without duplicating anything.
    expect(migrate(repo, { env, processes: quiet }).ok).toBe(true);
    const ids = graph().map((r) => r.id);
    expect(ids.filter((x) => x === 'file:only-old')).toHaveLength(1);
    expect(ids.filter((x) => x === 'file:only-new')).toHaveLength(1);
  });

  test("the migration keeps the store record's other fields", () => {
    const control = join(work, 'home', 'projects', id);
    writeFileSync(join(control, 'meta.json'), JSON.stringify({ root: repo, storeId: id, rootCommit: 'abc123' }));
    migrate(repo, { env, processes: quiet });
    const meta = JSON.parse(readFileSync(join(control, 'meta.json'), 'utf8'));
    expect(meta.rootCommit).toBe('abc123');
    expect(meta.manifest).toBeTruthy();
  });
});

describe('a store is only adopted by its own repository', () => {
  test('a subdirectory of another repository does not inherit its first commit', () => {
    const outer = join(work, 'outer');
    mkdirSync(outer, { recursive: true });
    const git = (...args) => spawnSync('git', args, { cwd: outer, encoding: 'utf8' });
    git('init', '-q');
    writeFileSync(join(outer, 'a.txt'), 'a');
    git('add', 'a.txt');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'root');
    const sub = join(outer, 'packages', 'inner');
    mkdirSync(sub, { recursive: true });
    const store = projectStore(sub, env);
    const meta = JSON.parse(readFileSync(join(store, '..', 'meta.json'), 'utf8'));
    expect(meta.rootCommit ?? null).toBeNull();
    // The repository's own top level does record it.
    const top = projectStore(outer, env);
    expect(JSON.parse(readFileSync(join(top, '..', 'meta.json'), 'utf8')).rootCommit).toMatch(/^[0-9a-f]{40}/);
    expect(existsSync(join(sub, '.token-optimizer'))).toBe(false);
    expect(statSync(work).isDirectory()).toBe(true);
  });
});
