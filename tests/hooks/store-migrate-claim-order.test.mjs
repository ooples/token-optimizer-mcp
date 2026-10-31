/**
 * #545 review, the two pieces beyond spooling under the lease:
 *  - one migrator per store (a second one is refused, a dead one's claim is taken);
 *  - replay never brings back a graph record older than the store's own copy.
 */

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '../../hooks-core/migrate.mjs';
import { storeId } from '../../hooks-core/maintenance.mjs';

const quiet = () => ({ complete: true, found: [] });

let work;
let repo;
let env;
let id;
let control;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'store-claim-'));
  repo = join(work, 'repo');
  env = { TOKEN_OPTIMIZER_HOME: join(work, 'home') };
  mkdirSync(join(repo, '.git', 'info'), { recursive: true });
  mkdirSync(join(repo, '.token-optimizer', 'wiki'), { recursive: true });
  writeFileSync(join(repo, '.token-optimizer', 'wiki', 'graph.jsonl'), '{"t":"n","id":"file:a","at":10,"rid":"aaaaaaaaaaaaaaaa"}\n');
  id = storeId(join(repo, '.token-optimizer'));
  control = join(work, 'home', 'projects', id);
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

describe('one migrator per store', () => {
  test('a second migrator is refused while a live one holds the claim', () => {
    mkdirSync(control, { recursive: true });
    writeFileSync(join(control, 'migrate.claim'), JSON.stringify({ pid: process.pid, host: hostname() }));
    expect(migrate(repo, { env, processes: quiet })).toMatchObject({
      ok: false,
      blockers: ['another migration of this store is in progress'],
    });
    expect(statSync(join(repo, '.token-optimizer')).isDirectory()).toBe(true);
  });

  test('a claim left by a dead process is taken over, and released afterwards', () => {
    mkdirSync(control, { recursive: true });
    writeFileSync(join(control, 'migrate.claim'), JSON.stringify({ pid: 999999, host: hostname() }));
    expect(migrate(repo, { env, processes: quiet }).ok).toBe(true);
    expect(() => statSync(join(control, 'migrate.claim'))).toThrow();
  });
});

describe('replay is order-safe', () => {
  test('a spooled record older than the store copy is not appended after it', () => {
    mkdirSync(join(work, 'home', 'spool', id), { recursive: true });
    writeFileSync(
      join(work, 'home', 'spool', id, '1.jsonl'),
      `${JSON.stringify({ file: 'wiki/graph.jsonl', record: { t: 'n', id: 'file:a', at: 1, rid: 'bbbbbbbbbbbbbbbb' } })}\n`
    );
    const { report } = migrate(repo, { env, processes: quiet });
    const lines = readFileSync(join(report.movedTo, 'wiki', 'graph.jsonl'), 'utf8').trim().split('\n');
    expect(JSON.parse(lines.at(-1)).at).toBe(10);
  });

  test('a spooled record newer than the store copy is appended', () => {
    mkdirSync(join(work, 'home', 'spool', id), { recursive: true });
    writeFileSync(
      join(work, 'home', 'spool', id, '1.jsonl'),
      `${JSON.stringify({ file: 'wiki/graph.jsonl', record: { t: 'n', id: 'file:a', at: 20, rid: 'cccccccccccccccc' } })}\n`
    );
    const { report } = migrate(repo, { env, processes: quiet });
    const lines = readFileSync(join(report.movedTo, 'wiki', 'graph.jsonl'), 'utf8').trim().split('\n');
    expect(JSON.parse(lines.at(-1)).at).toBe(20);
  });
});
