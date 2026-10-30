/**
 * #542 part 2: a store in maintenance is not written; its writes are spooled.
 *
 * Each case runs the writer in a child process with its own TOKEN_OPTIMIZER_HOME,
 * so the state file, the leases and the spool are all real files.
 */

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { liveLeases, storeId, SPOOL_MAX_BYTES } from '../../hooks-core/maintenance.mjs';

const ROOT = process.cwd();
const mod = (name) => pathToFileURL(join(ROOT, 'hooks-core', name)).href;

let work;
let home;
let store;
let wiki;
let id;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'store-maint-'));
  home = join(work, 'home');
  store = join(work, 'repo', '.token-optimizer');
  wiki = join(store, 'wiki');
  id = storeId(wiki);
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

function run(body) {
  const script = `
    import * as wiki from ${JSON.stringify(mod('wiki.mjs'))};
    const out = await (async () => { ${body} })();
    process.stdout.write(JSON.stringify(out ?? null));
  `;
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('TOKEN_OPTIMIZER_')) env[k] = v;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...env, TOKEN_OPTIMIZER_HOME: home },
  });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return { out: JSON.parse(r.stdout), err: r.stderr };
}

function setState(state) {
  mkdirSync(join(home, 'projects', id), { recursive: true });
  writeFileSync(join(home, 'projects', id, 'maintenance.json'), typeof state === 'string' ? state : JSON.stringify(state));
}

const writeNode = (key = '/a.ts') => `return wiki.writeNode(${JSON.stringify(wiki)}, { kind: 'file', key: ${JSON.stringify(key)} });`;
const spooled = () => {
  const dir = join(home, 'spool', id);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => readFileSync(join(dir, f), 'utf8').trim().split('\n').map(JSON.parse));
};

describe('a store in normal operation', () => {
  test('is written, and leaves no lease behind', () => {
    const { out } = run(writeNode());
    expect(out.outcome).toBe('persisted');
    expect(readFileSync(join(wiki, 'graph.jsonl'), 'utf8')).toContain('/a.ts');
    expect(readdirSync(join(home, 'projects', id, 'leases'))).toEqual([]);
    expect(spooled()).toEqual([]);
  });
});

describe('a store in maintenance', () => {
  test.each(['draining', 'ready', 'cutover', 'failed'])('%s: the write is spooled, not written', (state) => {
    setState({ state, since: new Date().toISOString() });
    const { out } = run(writeNode());
    expect(out).toMatchObject({ outcome: 'queued', reason: `store ${state}` });
    expect(existsSync(join(wiki, 'graph.jsonl'))).toBe(false);
    const [entry] = spooled();
    expect(entry.file).toBe('wiki/graph.jsonl');
    expect(entry.record).toMatchObject({ kind: 'file', key: expect.stringContaining('a.ts') });
    expect(entry.record.rid).toMatch(/^[0-9a-f]{16}$/);
  });

  test('an unreadable or foreign state file fails closed', () => {
    setState('{ not json');
    expect(run(writeNode()).out.outcome).toBe('queued');
    setState({ state: 'whatever' });
    expect(run(writeNode('/b.ts')).out.outcome).toBe('queued');
    expect(existsSync(join(wiki, 'graph.jsonl'))).toBe(false);
  });

  test('a full spool rejects, and says so', () => {
    setState({ state: 'draining' });
    mkdirSync(join(home, 'spool', id), { recursive: true });
    writeFileSync(join(home, 'spool', id, '1.jsonl'), 'x'.repeat(SPOOL_MAX_BYTES));
    const { out, err } = run(writeNode());
    expect(out.outcome).toBe('rejected');
    expect(out.reason).toMatch(/spool is over/);
    expect(err).toMatch(/spool rejected/);
  });

  test('returning to normal writes the store again', () => {
    setState({ state: 'draining' });
    run(writeNode());
    setState({ state: 'normal' });
    expect(run(writeNode('/b.ts')).out.outcome).toBe('persisted');
  });
});

describe('every writer honours maintenance', () => {
  function runWith(body) {
    const script = `
      import * as metrics from ${JSON.stringify(mod('metrics.mjs'))};
      import * as pending from ${JSON.stringify(mod('pending.mjs'))};
      import * as expand from ${JSON.stringify(mod('expand.mjs'))};
      const out = await (async () => { ${body} })();
      process.stdout.write(JSON.stringify(out ?? null));
    `;
    const env = {};
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('TOKEN_OPTIMIZER_')) env[k] = v;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...env, TOKEN_OPTIMIZER_HOME: home },
    });
    if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
    return { out: JSON.parse(r.stdout), err: r.stderr };
  }

  test('metrics are spooled with their id as the dedupe key', () => {
    setState({ state: 'draining' });
    const { out } = runWith(`return metrics.record(${JSON.stringify(wiki)}, { kind: 'read' });`);
    expect(out).toMatchObject({ kind: 'read', id: expect.any(String) });
    expect(existsSync(join(wiki, 'metrics.jsonl'))).toBe(false);
    const entries = spooled();
    expect(entries.map((e) => e.file)).toContain('wiki/metrics.jsonl');
    expect(entries[0].record.rid).toBe(out.id);
  });

  test('a pending invalidation is spooled', () => {
    setState({ state: 'draining' });
    const file = join(work, 'repo', 'a.ts');
    mkdirSync(join(work, 'repo'), { recursive: true });
    writeFileSync(file, 'x');
    const { out } = runWith(`return pending.queueInvalidation(${JSON.stringify(wiki)}, { path: ${JSON.stringify(file)} });`);
    expect(out).toBe(true);
    expect(existsSync(join(wiki, 'pending-invalidation.jsonl'))).toBe(false);
    expect(spooled().map((e) => e.file)).toEqual(['wiki/pending-invalidation.jsonl']);
  });

  test('an artifact is refused, so the output stays whole', () => {
    setState({ state: 'cutover' });
    const { out, err } = runWith(`return expand.capture(${JSON.stringify(wiki)}, 'y'.repeat(5000), { tool: 'Bash' });`);
    expect(out).toBeNull();
    expect(err).toMatch(/artifact-write rejected.*store is cutover/);
    expect(existsSync(join(wiki, 'artifacts'))).toBe(false);
  });

  test('the wiki and authored stores of one repository are one store', () => {
    expect(storeId(join(store, 'authored'))).toBe(id);
  });
});

describe('when no lease can be taken', () => {
  test('a sandbox that cannot write the control directory still writes the store', () => {
    // TOKEN_OPTIMIZER_HOME under a FILE: no control directory can exist, so no
    // maintenance record can either, and the write is admitted.
    writeFileSync(join(work, 'blocked-home'), 'fixture');
    home = join(work, 'blocked-home', 'inner');
    expect(run(writeNode()).out.outcome).toBe('persisted');
    expect(readFileSync(join(wiki, 'graph.jsonl'), 'utf8')).toContain('/a.ts');
  });

  test('a store whose record exists stays closed even if the lease fails', () => {
    setState({ state: 'draining' });
    // A FILE where the lease directory should be: the lease cannot be created.
    writeFileSync(join(home, 'projects', id, 'leases'), 'fixture');
    const { out } = run(writeNode());
    expect(out.outcome).not.toBe('persisted');
    expect(existsSync(join(wiki, 'graph.jsonl'))).toBe(false);
  });
});

describe('leases', () => {
  test('a lease from a dead process is not counted', () => {
    mkdirSync(join(home, 'projects', id, 'leases'), { recursive: true });
    writeFileSync(join(home, 'projects', id, 'leases', '999999-1.lease'), '');
    expect(liveLeases(id, { TOKEN_OPTIMIZER_HOME: home })).toEqual([]);
  });

  test('a lease held by a live process is counted', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)']);
    try {
      mkdirSync(join(home, 'projects', id, 'leases'), { recursive: true });
      writeFileSync(join(home, 'projects', id, 'leases', `${child.pid}-1.lease`), '');
      expect(liveLeases(id, { TOKEN_OPTIMIZER_HOME: home })).toEqual([`${child.pid}-1.lease`]);
    } finally {
      child.kill();
    }
  });

  test('the store id folds case where the filesystem does', () => {
    expect(storeId('C:/Repo/.token-optimizer/wiki', 'win32')).toBe(storeId('c:/repo/.token-optimizer', 'win32'));
    expect(storeId('/Repo/.token-optimizer', 'linux')).not.toBe(storeId('/repo/.token-optimizer', 'linux'));
  });
});
