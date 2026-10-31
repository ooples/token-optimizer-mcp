/**
 * #542 part 3: moving a project store, and every way that can go wrong.
 *
 * The acceptance criteria this file covers, by name:
 *  - an uncooperative LEGACY writer: refused by the offline check while it
 *    runs, and blocked by the filesystem fence (ENOTDIR) after cutover;
 *  - an enumeration that cannot be completed is a blocker, not an all-clear;
 *  - competing migrators are serialized;
 *  - injected failures (disk full, EACCES) at every step roll back with the
 *    source intact;
 *  - a process KILLED at every step is recovered -- rolled back before
 *    publish, completed after -- with no acknowledged record lost or
 *    duplicated;
 *  - spooled writes are replayed once, deduplicated by rid;
 *  - gc deletes the backup only after re-validating the moved store.
 * Power loss is not simulated and not claimed.
 */

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname, tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { gc, migrate, recover, offlineBlockers, readTombstone, restore, resumeIfDue, tokenOptimizerProcesses } from '../../hooks-core/migrate.mjs';
import { readState, storeId } from '../../hooks-core/maintenance.mjs';

const ROOT = process.cwd();
const mod = (name) => pathToFileURL(join(ROOT, 'hooks-core', name)).href;

let work;
let repo;
let env;
let id;

const quiet = () => ({ complete: true, found: [] });

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'store-migrate-'));
  repo = join(work, 'repo');
  env = { TOKEN_OPTIMIZER_HOME: join(work, 'home') };
  mkdirSync(join(repo, '.git', 'info'), { recursive: true });
  const wiki = join(repo, '.token-optimizer', 'wiki');
  mkdirSync(join(wiki, 'artifacts'), { recursive: true });
  writeFileSync(join(wiki, 'graph.jsonl'), '{"t":"n","id":"file:a","rid":"aaaaaaaaaaaaaaaa"}\n');
  writeFileSync(join(wiki, 'metrics.jsonl'), '{"kind":"read","id":"m1","rid":"m1"}\n');
  writeFileSync(join(wiki, 'artifacts', 'x.txt'), 'artifact body');
  mkdirSync(join(repo, '.token-optimizer', 'ucr'), { recursive: true });
  writeFileSync(join(repo, '.token-optimizer', 'ucr', 'index.json'), '{}');
  id = storeId(join(repo, '.token-optimizer'));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const graphOf = (dir) => readFileSync(join(dir, 'wiki', 'graph.jsonl'), 'utf8');

describe('a clean migration', () => {
  test('moves every file, leaves a tombstone, keeps a backup, and hides both from git', () => {
    const result = migrate(repo, { env, processes: quiet });
    expect(result.ok).toBe(true);
    const tomb = readTombstone(repo);
    expect(tomb).toMatchObject({ storeId: id, movedTo: result.report.movedTo });
    expect(statSync(join(repo, '.token-optimizer')).isFile()).toBe(true);
    expect(graphOf(tomb.movedTo)).toContain('file:a');
    expect(readFileSync(join(tomb.movedTo, 'ucr', 'index.json'), 'utf8')).toBe('{}');
    expect(existsSync(result.report.backup)).toBe(true);
    const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toContain('/.token-optimizer\n');
    // Nothing but the tombstone is left in the repository (#538): the backup
    // lives in the store's control directory.
    expect(readdirSync(repo).filter((n) => n.startsWith('.token-optimizer'))).toEqual(['.token-optimizer']);
    expect(result.report.backup.replace(/\\/g, '/')).toContain(`/projects/${id}/backup-`);
    expect(readState(id, env).state).toBe('normal');
  });

  test('upgraded writers follow the tombstone afterwards', () => {
    migrate(repo, { env, processes: quiet });
    const r = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `
        import * as wiki from ${JSON.stringify(mod('wiki.mjs'))};
        const dir = wiki.wikiDir(${JSON.stringify(repo)});
        process.stdout.write(JSON.stringify({ dir, w: wiki.writeNode(dir, { kind: 'file', key: '/after.ts' }) }));`],
      { encoding: 'utf8', env: { ...process.env, ...env } }
    );
    const out = JSON.parse(r.stdout);
    expect(out.w.outcome).toBe('persisted');
    expect(out.dir.replace(/\\/g, '/')).toContain('/projects/');
    expect(graphOf(readTombstone(repo).movedTo)).toContain('after.ts');
  });

  test('a legacy writer is blocked by the fence: its append fails with ENOTDIR', () => {
    migrate(repo, { env, processes: quiet });
    // What 7.7.1 does: mkdir the store and append, catching nothing new.
    expect(() => mkdirSync(join(repo, '.token-optimizer', 'wiki'), { recursive: true })).toThrow();
    expect(() => appendFileSync(join(repo, '.token-optimizer', 'wiki', 'graph.jsonl'), 'x\n')).toThrow(/ENOTDIR|ENOENT|EEXIST/);
  });
});

describe('the offline check', () => {
  test('a running legacy writer refuses the migration and changes nothing', () => {
    const legacy = () => ({ complete: true, found: [{ pid: 4242, version: '7.7.1', command: 'node .../token-optimizer/7.7.1/hooks/post-tool.mjs' }] });
    const result = migrate(repo, { env, processes: legacy });
    expect(result.ok).toBe(false);
    expect(result.blockers[0]).toMatch(/pid 4242 runs token-optimizer 7\.7\.1/);
    expect(statSync(join(repo, '.token-optimizer')).isDirectory()).toBe(true);
    expect(JSON.parse(readFileSync(join(work, 'home', 'projects', id, 'intent.json'), 'utf8')).blockers).toHaveLength(1);
  });

  test('an incomplete process list is a blocker, not an all-clear', () => {
    expect(offlineBlockers({ complete: false, reason: 'running in a container' })).toEqual(['running in a container']);
    const result = migrate(repo, { env, processes: () => ({ complete: false, reason: 'process list unreadable: EPERM', found: [] }) });
    expect(result).toMatchObject({ ok: false, blockers: ['process list unreadable: EPERM'] });
  });

  test('only node processes running a token-optimizer script are writers', () => {
    // An installed plugin carrying this branch's maintenance module.
    const leasing = join(work, 'plugins', 'token-optimizer', 'next');
    mkdirSync(join(leasing, 'hooks', 'lib'), { recursive: true });
    writeFileSync(join(leasing, 'hooks', 'post-tool.mjs'), '');
    copyFileSync(join(ROOT, 'hooks-core', 'maintenance.mjs'), join(leasing, 'hooks', 'lib', 'maintenance.mjs'));
    const table = [
      '101\t"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\u\\.token-optimizer\\runtime\\versions\\7.7.1\\node_modules\\@ooples\\token-optimizer-mcp\\dist\\server\\index.js',
      // A version number alone proves nothing: this one is a newer number whose
      // code (a path that does not exist here) cannot be shown to take leases.
      '102\tnode C:/Users/u/.claude/plugins/cache/token-optimizer/token-optimizer/7.8.0/hooks/post-tool.mjs',
      `106\tnode ${join(leasing, 'hooks', 'post-tool.mjs').replace(/\\/g, '/')}`,
      '103\t"C:\\Program Files\\Git\\bin\\bash.exe" -c "cd ~/source/repos/token-optimizer-mcp && npm test"',
      '104\tbash -c node "${CLAUDE_PLUGIN_ROOT}/hooks/post-tool.mjs" # token-optimizer',
      '105\tvim token-optimizer-notes.md',
    ].join('\n');
    const r = tokenOptimizerProcesses({ run: () => table, platform: 'win32' });
    expect(r.complete).toBe(true);
    expect(r.found.map((p) => [p.pid, p.version, p.leases])).toEqual([
      [101, '7.7.1', false],
      [102, '7.8.0', false],
      [106, null, true],
    ]);
    expect(offlineBlockers(r)).toEqual([
      expect.stringMatching(/pid 101 runs token-optimizer 7\.7\.1/),
      expect.stringMatching(/pid 102 runs token-optimizer 7\.8\.0, whose code takes no write leases/),
    ]);
  });

  test('a crafted command line cannot stall the process scan (CodeQL)', () => {
    const crafted = `1\tnode ${'-!\t-'.repeat(20000)} token-optimizer.mjs`;
    const started = Date.now();
    tokenOptimizerProcesses({ run: () => crafted, platform: 'win32' });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('a process list that cannot be read is incomplete', () => {
    const r = tokenOptimizerProcesses({
      run: () => {
        throw Object.assign(new Error('denied'), { code: 'EPERM' });
      },
      platform: 'linux',
    });
    expect(r).toMatchObject({ complete: false, reason: expect.stringContaining('EPERM') });
  });

  test('only code shown to take leases is a safe writer, whatever its version', () => {
    expect(offlineBlockers({ complete: true, found: [{ pid: 7, version: null, leases: false }] })[0]).toMatch(/unknown version/);
    expect(offlineBlockers({ complete: true, found: [{ pid: 7, version: '9.0.0' }] })).toHaveLength(1);
    expect(offlineBlockers({ complete: true, found: [{ pid: 7, version: '7.7.1', leases: true }] })).toEqual([]);
  });
});

describe('coordination', () => {
  test('a second migrator is refused while one is in progress', () => {
    mkdirSync(join(work, 'home', 'projects', id), { recursive: true });
    writeFileSync(join(work, 'home', 'projects', id, 'maintenance.json'), JSON.stringify({ state: 'draining' }));
    expect(migrate(repo, { env, processes: quiet })).toMatchObject({ ok: false, blockers: ['store is already draining'] });
  });

  test('a writer that never releases its lease times the drain out, and the store reopens', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)']);
    try {
      mkdirSync(join(work, 'home', 'projects', id, 'leases'), { recursive: true });
      writeFileSync(join(work, 'home', 'projects', id, 'leases', `${child.pid}-1.lease`), '');
      const result = migrate(repo, { env, processes: quiet, drainTimeoutMs: 300 });
      expect(result).toMatchObject({ ok: false, state: 'normal' });
      expect(result.blockers[0]).toMatch(/drain/);
      expect(statSync(join(repo, '.token-optimizer')).isDirectory()).toBe(true);
    } finally {
      child.kill();
    }
  });

  test('a legacy append that lands in the moved directory mid-copy is copied too', () => {
    // A write opened before the fence rename still lands in the renamed
    // directory. The first copy misses it; the re-hash sees the change and
    // copies again.
    const result = migrate(repo, {
      env,
      processes: quiet,
      faultAt: (at, info) => {
        if (at === 'copied' && info.attempt === 1)
          appendFileSync(join(info.staged, 'wiki', 'graph.jsonl'), '{"t":"n","id":"file:inflight"}\n');
      },
    });
    expect(result.ok).toBe(true);
    expect(graphOf(result.report.movedTo)).toContain('file:inflight');
  });

  test('spooled writes are replayed once, deduplicated by rid', () => {
    const spool = join(work, 'home', 'spool', id);
    mkdirSync(spool, { recursive: true });
    writeFileSync(
      join(spool, '1.jsonl'),
      [
        { file: 'wiki/graph.jsonl', record: { t: 'n', id: 'file:a', rid: 'aaaaaaaaaaaaaaaa' } },
        { file: 'wiki/graph.jsonl', record: { t: 'n', id: 'file:new', rid: 'bbbbbbbbbbbbbbbb' } },
        { file: 'wiki/graph.jsonl', record: { t: 'n', id: 'file:new', rid: 'bbbbbbbbbbbbbbbb' } },
        { file: '../../escape.jsonl', record: { rid: 'cccccccccccccccc' } },
      ].map((e) => JSON.stringify(e)).join('\n') + '\n'
    );
    const result = migrate(repo, { env, processes: quiet });
    expect(result.report).toMatchObject({ replayed: 1, duplicates: 2 });
    const graph = graphOf(result.report.movedTo);
    expect(graph.match(/file:a/g)).toHaveLength(1);
    expect(graph.match(/file:new/g)).toHaveLength(1);
    expect(existsSync(spool)).toBe(false);
    expect(existsSync(join(work, 'home', 'escape.jsonl'))).toBe(false);
  });

  test('a metrics rid (base36-hex) already in the store is a duplicate, not replayed again', () => {
    // nextId() in metrics.mjs makes `<base36>-<hex>`; a hex-only match missed it.
    writeFileSync(join(repo, '.token-optimizer', 'wiki', 'metrics.jsonl'), '{"kind":"read","id":"1z-0a1b2c3d","rid":"1z-0a1b2c3d"}\n');
    const spool = join(work, 'home', 'spool', id);
    mkdirSync(spool, { recursive: true });
    writeFileSync(
      join(spool, '1.jsonl'),
      `${JSON.stringify({ file: 'wiki/metrics.jsonl', record: { kind: 'read', id: '1z-0a1b2c3d', rid: '1z-0a1b2c3d' } })}\n`
    );
    const result = migrate(repo, { env, processes: quiet });
    expect(result.report).toMatchObject({ replayed: 0, duplicates: 1 });
    expect(readFileSync(join(result.report.movedTo, 'wiki', 'metrics.jsonl'), 'utf8').match(/1z-0a1b2c3d","rid/g)).toHaveLength(1);
  });

  test('a spool left after the store reopened is replayed at the next session start', () => {
    const { report } = migrate(repo, { env, processes: quiet });
    // A writer that outlived the final wait spools into a fresh directory.
    const spool = join(work, 'home', 'spool', id);
    mkdirSync(spool, { recursive: true });
    writeFileSync(
      join(spool, '9.jsonl'),
      `${JSON.stringify({ file: 'wiki/graph.jsonl', record: { t: 'n', id: 'file:straggler', rid: 'ffffffffffffffff' } })}\n`
    );
    expect(resumeIfDue(repo, { env, processes: quiet, background: false })).toBeNull();
    expect(graphOf(report.movedTo).match(/file:straggler/g)).toHaveLength(1);
    expect(existsSync(spool)).toBe(false);
  });

  test('a fence left by an interrupted migration is not reported as already moved', () => {
    const r = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `
        import { migrate } from ${JSON.stringify(mod('migrate.mjs'))};
        migrate(${JSON.stringify(repo)}, {
          processes: () => ({ complete: true, found: [] }),
          faultAt: (at) => { if (at === 'copy') process.exit(137); },
        });`],
      { encoding: 'utf8', env: { ...process.env, ...env } }
    );
    expect(r.status).toBe(137);
    const result = migrate(repo, { env, processes: quiet });
    expect(result.ok).toBe(false);
    expect(result.blockers[0]).toMatch(/interrupted migration.*recover/);
  });
});

describe('injected failures roll back with the source intact', () => {
  test.each([
    ['fence', 'EACCES'],
    ['copy', 'ENOSPC'],
    ['publish', 'ENOSPC'],
    ['tombstone', 'EACCES'],
  ])('%s fails with %s', (step, code) => {
    const fault = (at) => {
      if (at === step) throw Object.assign(new Error(`${code}: injected at ${at}`), { code });
    };
    const before = graphOf(join(repo, '.token-optimizer'));
    const result = migrate(repo, { env, processes: quiet, faultAt: fault });
    expect(result).toMatchObject({ ok: false, state: 'normal' });
    expect(result.blockers[0]).toContain(code);
    expect(statSync(join(repo, '.token-optimizer')).isDirectory()).toBe(true);
    expect(graphOf(join(repo, '.token-optimizer'))).toBe(before);
    expect(existsSync(join(work, 'home', 'projects', id, 'store'))).toBe(false);
    expect(readdirSync(repo).filter((n) => n.startsWith('.token-optimizer.'))).toEqual([]);
  });
});

describe('a migrator killed at any step is recovered', () => {
  // The child dies at the step with process.exit, which runs no cleanup: the
  // same as kill -9 from the store's point of view.
  // `renamed` is the window inside publish: the copy already renamed into
  // place, CUTOVER not yet recorded. Rolling back must remove that copy, or
  // every later migrate refuses with "a store already exists".
  test.each(['fence', 'copy', 'publish', 'renamed', 'tombstone', 'replay', 'backup'])('killed at %s', (step) => {
    mkdirSync(join(work, 'home', 'spool', id), { recursive: true });
    writeFileSync(
      join(work, 'home', 'spool', id, '1.jsonl'),
      `${JSON.stringify({ file: 'wiki/graph.jsonl', record: { t: 'n', id: 'file:spooled', rid: 'dddddddddddddddd' } })}\n`
    );
    const r = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `
        import { migrate } from ${JSON.stringify(mod('migrate.mjs'))};
        migrate(${JSON.stringify(repo)}, {
          processes: () => ({ complete: true, found: [] }),
          faultAt: (at) => { if (at === ${JSON.stringify(step)}) process.exit(137); },
        });
        process.exit(0);`],
      { encoding: 'utf8', env: { ...process.env, ...env } }
    );
    expect(r.status).toBe(137);

    recover(repo, { env });
    expect(readState(id, env).state).toBe('normal');

    const tomb = readTombstone(repo);
    const live = tomb?.movedTo ?? join(repo, '.token-optimizer');
    const graph = graphOf(live);
    // Nothing acknowledged is lost, and nothing is doubled.
    expect(graph.match(/file:a"/g)).toHaveLength(1);
    expect(readFileSync(join(live, 'wiki', 'metrics.jsonl'), 'utf8')).toContain('"m1"');
    if (tomb) {
      expect(graph.match(/file:spooled/g)).toHaveLength(1);
      expect(readdirSync(join(work, 'home', 'projects', id)).some((n) => n.startsWith('backup-'))).toBe(true);
      expect(readdirSync(repo).filter((n) => n.startsWith('.token-optimizer'))).toEqual(['.token-optimizer']);
    } else {
      expect(statSync(join(repo, '.token-optimizer')).isDirectory()).toBe(true);
      expect(existsSync(join(work, 'home', 'projects', id, 'store'))).toBe(false);
    }
    expect(readdirSync(repo).filter((n) => n.startsWith('.token-optimizer.migrating-'))).toEqual([]);
  });
});

describe('session start finishes what was left', () => {
  const legacy = () => ({ complete: true, found: [{ pid: 4242, version: '7.7.1' }] });

  test('nothing pending costs nothing and says nothing', () => {
    // A repository with no in-repo store and no control directory.
    const empty = join(work, 'empty-repo');
    mkdirSync(empty, { recursive: true });
    expect(resumeIfDue(empty, { env, processes: () => { throw new Error('must not enumerate'); } })).toBeNull();
  });

  test('an existing in-repo store is migrated at session start without being asked (#538)', () => {
    const notice = resumeIfDue(repo, { env, processes: quiet, background: false });
    expect(notice).toMatch(/moved this project's graph out of the repository/);
    expect(readTombstone(repo)?.movedTo).toBeTruthy();
  });

  test('session start only launches the work; it finishes in the background and is reported next time', async () => {
    // A hook has seconds (Codex: 5). Session start must return at once and
    // leave the copy to a detached process -- here with the real process list,
    // so give it a repository nothing on this machine is writing to.
    const started = Date.now();
    expect(resumeIfDue(repo, { env, processes: quiet })).toBeNull();
    expect(Date.now() - started).toBeLessThan(1500);
    // The detached process finishes the move...
    // ...or, when an older token-optimizer process really is running on this
    // machine, refuses and records why. Either outcome proves the detached
    // process ran; neither is reached if it never started.
    const intent = join(work, 'home', 'projects', id, 'intent.json');
    const refused = () => {
      try {
        return JSON.parse(readFileSync(intent, 'utf8')).blockers?.length > 0;
      } catch {
        return false;
      }
    };
    const deadline = Date.now() + 60_000;
    while (!readTombstone(repo)?.movedTo && !refused() && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 200));
    const moved = readTombstone(repo)?.movedTo;
    if (!moved) {
      expect(refused()).toBe(true);
      expect(statSync(join(repo, '.token-optimizer')).isDirectory()).toBe(true);
      return;
    }
    // The next session start says what happened, once.
    expect(resumeIfDue(repo, { env, processes: quiet })).toMatch(/moved this project's graph out of the repository/);
    expect(resumeIfDue(repo, { env, processes: quiet })).toBeNull();
  }, 90_000);

  test('the background process does not hold the project directory open', () => {
    // On Windows a process locks its working directory: launched from the
    // project, the background migration made the project impossible to delete
    // or rename (EBUSY) while it ran. Deleting it at once must succeed.
    const legacy = () => ({ complete: true, found: [{ pid: 4242, version: '7.7.1' }] });
    resumeIfDue(repo, { env, processes: legacy });
    expect(() => rmSync(repo, { recursive: true })).not.toThrow();
  });

  test('a store the user placed by environment is never moved automatically', () => {
    const configured = { ...env, TOKEN_OPTIMIZER_WIKI_DIR: join(repo, '.token-optimizer', 'wiki') };
    expect(resumeIfDue(repo, { env: configured, processes: quiet, background: false })).toBeNull();
    expect(statSync(join(repo, '.token-optimizer')).isDirectory()).toBe(true);
  });

  test('mid-migration, readers are pointed at the staged copy, not the fence', async () => {
    const { projectStore } = await import('../../hooks-core/maintenance.mjs');
    let seen = null;
    let graph = null;
    migrate(repo, {
      env,
      processes: quiet,
      faultAt: (at) => {
        if (at !== 'copy') return;
        // Read while the fence is up, as a session starting now would.
        seen = projectStore(repo, env);
        graph = readFileSync(join(seen, 'wiki', 'graph.jsonl'), 'utf8');
      },
    });
    expect(seen).toMatch(/\.token-optimizer\.migrating-/);
    expect(graph).toContain('file:a');
  });

  test('a blocked automatic migration is retried at most hourly', () => {
    let calls = 0;
    const counting = () => {
      calls += 1;
      return legacy();
    };
    expect(resumeIfDue(repo, { env, processes: counting, background: false })).toBeNull();
    expect(resumeIfDue(repo, { env, processes: counting, background: false })).toBeNull();
    expect(calls).toBe(1);
    expect(statSync(join(repo, '.token-optimizer')).isDirectory()).toBe(true);
  });

  test('a refused migration completes once its blockers clear', () => {
    expect(migrate(repo, { env, processes: legacy }).ok).toBe(false);
    // Still blocked at the next session start: still nothing.
    expect(resumeIfDue(repo, { env, processes: legacy, background: false })).toBeNull();
    expect(statSync(join(repo, '.token-optimizer')).isDirectory()).toBe(true);
    // The legacy session has ended, and an hour has passed since the last try.
    const intentPath = join(work, 'home', 'projects', id, 'intent.json');
    const intent = JSON.parse(readFileSync(intentPath, 'utf8'));
    const hourAgo = new Date(Date.now() - 61 * 60 * 1000).toISOString();
    writeFileSync(intentPath, JSON.stringify({ ...intent, requested: hourAgo, lastTry: hourAgo }));
    const notice = resumeIfDue(repo, { env, processes: quiet, background: false });
    expect(notice).toMatch(/moved this project's graph out of the repository/);
    expect(readTombstone(repo)?.movedTo).toBeTruthy();
    expect(existsSync(join(work, 'home', 'projects', id, 'intent.json'))).toBe(false);
  });

  test('a migration whose owner died is recovered, and the session is told', () => {
    mkdirSync(join(work, 'home', 'projects', id), { recursive: true });
    writeFileSync(
      join(work, 'home', 'projects', id, 'maintenance.json'),
      JSON.stringify({ state: 'draining', owner: { pid: 999999, host: hostname() } })
    );
    expect(resumeIfDue(repo, { env, processes: quiet, background: false })).toMatch(/rolled back an interrupted store migration/);
    expect(readState(id, env).state).toBe('normal');
  });

  test('a live owner is left alone', () => {
    mkdirSync(join(work, 'home', 'projects', id), { recursive: true });
    writeFileSync(
      join(work, 'home', 'projects', id, 'maintenance.json'),
      JSON.stringify({ state: 'draining', owner: { pid: process.pid, host: hostname() } })
    );
    expect(resumeIfDue(repo, { env, processes: quiet, background: false })).toBeNull();
    expect(readState(id, env).state).toBe('draining');
  });
});

describe('restore: the same move in reverse', () => {
  test('brings the store back with writes made after the move', () => {
    const { report } = migrate(repo, { env, processes: quiet });
    appendFileSync(join(report.movedTo, 'wiki', 'graph.jsonl'), '{"t":"n","id":"file:after-move","rid":"eeeeeeeeeeeeeeee"}\n');
    const back = restore(repo, { env, processes: quiet });
    expect(back.ok).toBe(true);
    expect(statSync(join(repo, '.token-optimizer')).isDirectory()).toBe(true);
    expect(graphOf(join(repo, '.token-optimizer'))).toContain('file:after-move');
    expect(readTombstone(repo)).toBeNull();
    expect(existsSync(back.report.movedStoreKept)).toBe(true);
    expect(readState(id, env).state).toBe('normal');
  });

  test('a running legacy writer refuses the restore', () => {
    migrate(repo, { env, processes: quiet });
    const legacy = () => ({ complete: true, found: [{ pid: 4242, version: '7.7.1' }] });
    expect(restore(repo, { env, processes: legacy })).toMatchObject({ ok: false });
    expect(readTombstone(repo)?.movedTo).toBeTruthy();
  });

  test.each(['copy', 'swap'])('a restore killed at %s is recovered at the next session start', (step) => {
    migrate(repo, { env, processes: quiet });
    const r = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `
        import { restore } from ${JSON.stringify(mod('migrate.mjs'))};
        restore(${JSON.stringify(repo)}, {
          processes: () => ({ complete: true, found: [] }),
          faultAt: (at) => { if (at === ${JSON.stringify(step)}) process.exit(137); },
        });`],
      { encoding: 'utf8', env: { ...process.env, ...env } }
    );
    expect(r.status).toBe(137);
    expect(resumeIfDue(repo, { env, processes: quiet, background: false })).toMatch(/interrupted restore/);
    expect(readState(id, env).state).toBe('normal');
    // Either way, exactly one live store, holding the original record once.
    const tomb = readTombstone(repo);
    const live = tomb?.movedTo ?? join(repo, '.token-optimizer');
    expect(graphOf(live).match(/file:a"/g)).toHaveLength(1);
    expect(readdirSync(repo).filter((n) => n.includes('.restoring-'))).toEqual([]);
  });

  test('a swap that fails after removing the tombstone puts it back', () => {
    const { report } = migrate(repo, { env, processes: quiet });
    const fault = (at) => {
      if (at === 'tombstone-removed') throw Object.assign(new Error('EACCES: injected'), { code: 'EACCES' });
    };
    expect(restore(repo, { env, processes: quiet, faultAt: fault })).toMatchObject({ ok: false, state: 'normal' });
    expect(readTombstone(repo)).toMatchObject({ movedTo: report.movedTo, storeId: id });
    expect(graphOf(report.movedTo)).toContain('file:a');
  });
});

describe('gc', () => {
  test('deletes the backup only after the moved store re-validates', () => {
    const { report } = migrate(repo, { env, processes: quiet });
    appendFileSync(join(report.movedTo, 'wiki', 'graph.jsonl'), '{"t":"n","id":"file:later"}\n');
    expect(gc(repo, { env })).toMatchObject({ ok: true, removed: [expect.stringMatching(/^backup-/)] });
    expect(existsSync(report.backup)).toBe(false);
  });

  test('refuses when the moved store lost a file', () => {
    const { report } = migrate(repo, { env, processes: quiet });
    rmSync(join(report.movedTo, 'wiki', 'artifacts', 'x.txt'));
    const result = gc(repo, { env });
    expect(result).toMatchObject({ ok: false, missing: ['wiki/artifacts/x.txt'] });
    expect(existsSync(report.backup)).toBe(true);
  });

  test('a file rewritten in the moved store since the move does not block it', () => {
    const { report } = migrate(repo, { env, processes: quiet });
    writeFileSync(join(report.movedTo, 'ucr', 'index.json'), '{"rebuilt":true}');
    expect(gc(repo, { env })).toMatchObject({ ok: true });
    expect(existsSync(report.backup)).toBe(false);
  });

  test('a backup file that differs from what was copied blocks it', () => {
    const { report } = migrate(repo, { env, processes: quiet });
    // A late write into the backup that the copy never saw.
    writeFileSync(join(report.backup, 'ucr', 'index.json'), '{"late":true}');
    writeFileSync(join(report.movedTo, 'ucr', 'index.json'), '{"rebuilt":true}');
    expect(gc(repo, { env })).toMatchObject({ ok: false, missing: ['ucr/index.json'] });
    expect(existsSync(report.backup)).toBe(true);
  });
});
