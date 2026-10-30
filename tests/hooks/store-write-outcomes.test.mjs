/**
 * #542: a store write says what became of it, and a failed one is reported.
 *
 * The reporter's reproduction: with a FILE where the graph directory should be,
 * 7.7.1's putNode returned an id and exited successfully while writing nothing;
 * an unrestricted control wrote its record. Every case below runs in a child
 * process with its own environment, so stderr and the failure log are observed
 * exactly as an operator would see them.
 */

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const mod = (name) => pathToFileURL(join(ROOT, 'hooks-core', name)).href;

let work;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'store-write-'));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

/** Run `body` as an ES module with the store helpers in scope; returns {out, err}. */
function run(body, env = {}) {
  const script = `
    import * as wiki from ${JSON.stringify(mod('wiki.mjs'))};
    import * as metrics from ${JSON.stringify(mod('metrics.mjs'))};
    import * as expand from ${JSON.stringify(mod('expand.mjs'))};
    const out = await (async () => { ${body} })();
    process.stdout.write(JSON.stringify(out ?? null));
  `;
  const base = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('TOKEN_OPTIMIZER_')) base[k] = v;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...base, TOKEN_OPTIMIZER_HOME: join(work, 'home'), ...env },
  });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return { out: JSON.parse(r.stdout), err: r.stderr };
}

/** A path whose parent is a FILE, so every mkdir/append under it fails ENOTDIR. */
function blockedStore() {
  const blocker = join(work, 'blocker');
  writeFileSync(blocker, 'fixture');
  return join(blocker, 'wiki');
}

const failureLog = () => join(work, 'home', 'write-failures.jsonl');

describe('graph writes report their outcome', () => {
  test('control: a writable store persists and putNode returns the id', () => {
    const dir = join(work, 'ok', 'wiki');
    const { out } = run(`return {
      written: wiki.writeNode(${JSON.stringify(dir)}, { kind: 'file', key: '/a.ts' }),
      id: wiki.putNode(${JSON.stringify(dir)}, { kind: 'file', key: '/b.ts' }),
    };`);
    expect(out.written.outcome).toBe('persisted');
    expect(out.id).toEqual(expect.any(String));
    const lines = readFileSync(join(dir, 'graph.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(lines.map((l) => l.key)).toEqual(expect.arrayContaining(['/a.ts', '/b.ts']));
  });

  test('the reported case: a blocked store returns no id and says why', () => {
    const dir = blockedStore();
    const { out, err } = run(`return {
      written: wiki.writeNode(${JSON.stringify(dir)}, { kind: 'file', key: '/a.ts' }),
      id: wiki.putNode(${JSON.stringify(dir)}, { kind: 'file', key: '/b.ts' }),
    };`);
    expect(out.written).toMatchObject({ outcome: 'rejected', code: 'ENOTDIR' });
    expect(out.id).toBeNull();
    expect(readFileSync(join(work, 'blocker'), 'utf8')).toBe('fixture');
    // Reported once per store, operation and code -- two failed writes, one line.
    expect(err.match(/graph-append rejected/g)).toHaveLength(1);
    const logged = readFileSync(failureLog(), 'utf8').trim().split('\n').map(JSON.parse);
    expect(logged).toEqual([expect.objectContaining({ op: 'graph-append', code: 'ENOTDIR', store: dir })]);
  });

  test('an edge to a node that was never written is not written', () => {
    const dir = join(work, 'edges', 'wiki');
    const { out } = run(`return wiki.putEdge(${JSON.stringify(dir)}, null, 'contains', 'symbol:x');`);
    expect(out).toBe(false);
    expect(existsSync(join(dir, 'graph.jsonl'))).toBe(false);
  });

  test('a switched-off graph is rejected quietly: no id, no error report', () => {
    const dir = join(work, 'off', 'wiki');
    const { out, err } = run(
      `return { written: wiki.writeNode(${JSON.stringify(dir)}, { kind: 'file', key: '/a.ts' }),
                id: wiki.putNode(${JSON.stringify(dir)}, { kind: 'file', key: '/a.ts' }) };`,
      { TOKEN_OPTIMIZER_WIKI_DISABLED: '1' }
    );
    expect(out.written).toMatchObject({ outcome: 'rejected', reason: 'graph disabled' });
    expect(out.id).toBeNull();
    expect(err).toBe('');
    expect(existsSync(failureLog())).toBe(false);
  });

  test('every record carries a unique rid, so a replay can dedupe', () => {
    const dir = join(work, 'rid', 'wiki');
    run(`wiki.putNode(${JSON.stringify(dir)}, { kind: 'file', key: '/a.ts' });
         wiki.putNode(${JSON.stringify(dir)}, { kind: 'file', key: '/a.ts' });`);
    const rids = readFileSync(join(dir, 'graph.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).rid);
    expect(rids).toHaveLength(2);
    expect(new Set(rids).size).toBe(2);
    rids.forEach((rid) => expect(rid).toMatch(/^[0-9a-f]{16}$/));
  });

  test('inside a batch a write is queued, and a failed flush is reported', () => {
    const dir = blockedStore();
    const { out, err } = run(`
      let inside;
      wiki.withBatchedWrites(${JSON.stringify(dir)}, () => {
        inside = wiki.writeNode(${JSON.stringify(dir)}, { kind: 'file', key: '/a.ts' });
      });
      return inside;`);
    expect(out).toMatchObject({ outcome: 'queued', reason: 'batched' });
    expect(err).toMatch(/graph-append rejected/);
  });
});

describe('other store writers report a lost write', () => {
  test('metrics', () => {
    const dir = blockedStore();
    const { out, err } = run(`return metrics.record(${JSON.stringify(dir)}, { kind: 'read' });`);
    expect(out).toBeNull();
    expect(err).toMatch(/metrics-append rejected/);
  });

  test('an artifact that cannot be written yields no ref, so nothing is folded away', () => {
    const dir = blockedStore();
    const { out, err } = run(`return expand.capture(${JSON.stringify(dir)}, 'x'.repeat(5000), { tool: 'Bash' });`);
    expect(out).toBeNull();
    expect(err).toMatch(/rejected/);
  });
});

describe('the report channel', () => {
  test('an unwritable failure log still leaves the stderr report and the outcome', () => {
    // TOKEN_OPTIMIZER_HOME is itself under a file, so the log cannot be created.
    const home = join(work, 'blocker-home');
    writeFileSync(home, 'fixture');
    const dir = blockedStore();
    const { out, err } = run(
      `return wiki.writeNode(${JSON.stringify(dir)}, { kind: 'file', key: '/a.ts' });`,
      { TOKEN_OPTIMIZER_HOME: join(home, 'inner') }
    );
    expect(out.outcome).toBe('rejected');
    expect(err).toMatch(/graph-append rejected/);
  });

  test('the failure log rotates instead of growing without bound', () => {
    mkdirSync(join(work, 'home'), { recursive: true });
    writeFileSync(failureLog(), 'x'.repeat(1024 * 1024 + 10));
    const dir = blockedStore();
    run(`return wiki.writeNode(${JSON.stringify(dir)}, { kind: 'file', key: '/a.ts' });`);
    expect(readFileSync(`${failureLog()}.1`, 'utf8').length).toBeGreaterThan(1024 * 1024);
    expect(readFileSync(failureLog(), 'utf8').trim().split('\n')).toHaveLength(1);
  });
});
