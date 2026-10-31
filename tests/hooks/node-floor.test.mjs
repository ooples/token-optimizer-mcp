/**
 * Hooks under a Node below the supported floor say so at session start.
 *
 * Under Node 22.2.0, 1,186 of 8,536 hook calls on one machine took over a
 * minute and 64 were killed at the host's 600 s timeout, with nothing telling
 * the user why. The fake version is installed by a preload, so the real
 * session-start entries run unchanged.
 */

import { afterAll, describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checklist } from '../../hooks-core/doctor.mjs';
import {
  NODE_FLOOR,
  nodeBelowFloor,
  nodeFloorNotice,
} from '../../hooks-core/node-floor.mjs';
import { serverCrashNotice } from '../../hooks-core/server-crash.mjs';

const ROOT = process.cwd();
const work = mkdtempSync(join(tmpdir(), 'node-floor-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('the floor', () => {
  test('is the one package.json declares', () => {
    const engines = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
      .engines.node;
    expect(engines).toBe(`>=${NODE_FLOOR}`);
  });

  test.each([
    ['22.2.0', true],
    ['v22.2.0', true],
    ['22.13.9', true],
    ['20.18.0', true],
    ['22.14.0', false],
    ['22.23.4', false],
    ['24.1.0', false],
    ['not-a-version', false],
  ])('%s below the floor: %s', (version, below) => {
    expect(nodeBelowFloor(version)).toBe(below);
  });

  test('the notice names the version and the floor, and is silent at or above it', () => {
    expect(nodeFloorNotice('22.2.0')).toContain(
      'Node 22.2.0, below the supported 22.14.0'
    );
    expect(nodeFloorNotice(NODE_FLOOR)).toBeNull();
    expect(nodeFloorNotice('22.23.4')).toBeNull();
  });

  test('the crash notice prescribes an upgrade for any Node below the floor', () => {
    const runtime = join(work, 'crash');
    rmSync(runtime, { recursive: true, force: true });
    const env = { TOKEN_OPTIMIZER_RUNTIME: runtime };
    for (const node of ['20.18.0', '22.2.0']) {
      mkdirSync(runtime, { recursive: true });
      writeFileSync(
        join(runtime, '.server-crash.json'),
        JSON.stringify({ node, exit: '0xC0000005' })
      );
      expect(serverCrashNotice(env, node)).toContain(
        `Node ${NODE_FLOOR} or newer`
      );
    }
  });
});

/** Runs a session-start entry with process.versions.node replaced by `node`. */
function sessionStart(entry, node) {
  const preload = join(work, `fake-node-${node}.mjs`);
  writeFileSync(
    preload,
    `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(node)} });\n`
  );
  const env = {};
  for (const [k, v] of Object.entries(process.env))
    if (!k.startsWith('TOKEN_OPTIMIZER_')) env[k] = v;
  const r = spawnSync(
    process.execPath,
    ['--import', pathToFileURL(preload).href, join(ROOT, entry)],
    {
      encoding: 'utf8',
      timeout: 60_000,
      cwd: work,
      windowsHide: true,
      input: JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: 'floor',
        cwd: work,
      }),
      env: {
        ...env,
        TOKEN_OPTIMIZER_HOME: join(work, 'home'),
        TOKEN_OPTIMIZER_RUNTIME: join(work, 'runtime'),
        TOKEN_OPTIMIZER_STATE_DIR: join(work, 'state'),
        TOKEN_OPTIMIZER_WIKI_DIR: join(work, 'wiki'),
        TOKEN_OPTIMIZER_SHARED_DIR: join(work, 'shared'),
        TOKEN_OPTIMIZER_REFRESH_INTERVAL_MS: '999999999999',
      },
    }
  );
  expect(r.status).toBe(0);
  return r.stdout;
}

describe.each([
  ['plugin/hooks/session-start.mjs'],
  ['integrations/codex/hooks/session-start.mjs'],
])('%s', (entry) => {
  test('tells the session when Node is below the floor', () => {
    expect(sessionStart(entry, '22.2.0')).toContain(
      'below the supported 22.14.0'
    );
  });

  test('says nothing about Node when it meets the floor', () => {
    expect(sessionStart(entry, '22.23.4')).not.toContain('below the supported');
  });
});

describe('doctor', () => {
  test('reports the Node version against the floor', () => {
    const row = checklist({ root: ROOT }).find(
      (c) => c.name === 'Node meets the supported floor'
    );
    expect(row).toBeTruthy();
    expect(row.pass).toBe(!nodeBelowFloor(process.versions.node));
  });
});
