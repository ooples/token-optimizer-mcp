/**
 * One nudge per agent when it runs one shell command per turn.
 *
 * Each turn re-reads the agent's whole context; on 2026-10-20 nine agents spent
 * 5.36M of 7.39M tokens re-reading a ~56k baseline across 105 turns, many of
 * them a single short command that one batched call would have answered.
 */

import { describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  BATCH_NUDGE_AFTER,
  batchingNudge,
  isSingleCommand,
  loadState,
  saveState,
} from '../../hooks-core/policy.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });

describe('isSingleCommand', () => {
  test.each([
    ['git status', true],
    ['grep -n foo file.txt', true],
    ['echo "a && b"', true],
    ["node -e 'x; y'", true],
    ['git status && git log -1', false],
    ['a; b', false],
    ['a | head', false],
    ['a || b', false],
    ['a &', false],
    ['line1\nline2', false],
    ['', false],
  ])('%j -> %s', (command, expected) => {
    expect(isSingleCommand(command)).toBe(expected);
  });
});

describe('batchingNudge', () => {
  test(`speaks once, on the ${BATCH_NUDGE_AFTER}th single command in a row`, () => {
    const state = {};
    const said = [];
    for (let i = 0; i < BATCH_NUDGE_AFTER + 4; i++) said.push(batchingNudge(bash(`cmd${i}`), state));
    expect(said.filter(Boolean)).toHaveLength(1);
    expect(said[BATCH_NUDGE_AFTER - 1]).toContain('batch independent commands');
  });

  test('a batched command resets the run', () => {
    const state = {};
    for (let i = 0; i < BATCH_NUDGE_AFTER - 1; i++) batchingNudge(bash(`cmd${i}`), state);
    batchingNudge(bash('a && b'), state);
    expect(state.singleRun).toBe(0);
    for (let i = 0; i < BATCH_NUDGE_AFTER - 1; i++) expect(batchingNudge(bash(`c${i}`), state)).toBeNull();
  });

  test('other tools neither count nor reset', () => {
    const state = {};
    batchingNudge(bash('one'), state);
    expect(batchingNudge({ tool_name: 'Read', tool_input: { file_path: 'x' } }, state)).toBeNull();
    expect(state.singleRun).toBe(1);
  });

  test('the run and the once-flag survive a save and reload', () => {
    const session = `batch-${randomUUID()}`;
    const state = loadState(session);
    for (let i = 0; i < 3; i++) batchingNudge(bash(`x${i}`), state);
    state.batchNudged = true;
    saveState(session, state);
    const back = loadState(session);
    expect(back.singleRun).toBe(3);
    expect(back.batchNudged).toBe(true);
  });
});

describe('through the packaged router', () => {
  test('the nudge arrives on the call that earns it, and only once', () => {
    const session = `batch-e2e-${randomUUID()}`;
    const env = {
      ...process.env,
      TOKEN_OPTIMIZER_MODE: 'assist',
      TOKEN_OPTIMIZER_STATE_DIR: mkdtempSync(join(tmpdir(), 'batch-state-')),
      TOKEN_OPTIMIZER_MCP_CAPABILITIES: '',
    };
    const outputs = [];
    for (let i = 0; i < BATCH_NUDGE_AFTER + 2; i++) {
      const result = spawnSync(process.execPath, [join(ROOT, 'plugin/hooks/pretooluse-router.mjs')], {
        input: JSON.stringify({ session_id: session, cwd: ROOT, ...bash(`echo ${i}`) }),
        encoding: 'utf8',
        env,
      });
      expect(result.status).toBe(0);
      outputs.push(result.stdout);
    }
    const nudged = outputs.map((o) => o.includes('single shell commands in a row'));
    expect(nudged.indexOf(true)).toBe(BATCH_NUDGE_AFTER - 1);
    expect(nudged.filter(Boolean)).toHaveLength(1);
  });
});
