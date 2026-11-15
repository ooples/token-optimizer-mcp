/**
 * The deferred recording guidance (#357, M5) reaches only the sessions that can
 * receive it and are meant to.
 *
 * Delivery is once per session, so the flag that says "delivered" must not be
 * spent where nothing is delivered: an experiment arm with harvest off gets no
 * recording instructions at all, and a client that cannot carry context
 * (Windsurf's silent style) must leave the flag unset.
 */
import { afterAll, describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLAUDE_POST = join(ROOT, 'src', 'plugin', 'hooks', 'post-tool.mjs');
const CLAUDE_PRE = join(ROOT, 'src', 'plugin', 'hooks', 'pretooluse-router.mjs');
const WINDSURF_POST = join(ROOT, 'src', 'integrations', 'windsurf', 'hooks', 'post-tool.mjs');

const scratch = mkdtempSync(join(tmpdir(), 'recording-delivery-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function hook(script, payload, env = {}) {
  // A caller continuing one session across calls passes its own state dir.
  const state = env.TOKEN_OPTIMIZER_STATE_DIR ?? mkdtempSync(join(scratch, 'state-'));
  const result = spawnSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      TOKEN_OPTIMIZER_MODE: 'assist',
      TOKEN_OPTIMIZER_MCP_CAPABILITIES: 'smart_edit,wiki_write',
      TOKEN_OPTIMIZER_WIKI_DIR: join(scratch, 'graph'),
      TOKEN_OPTIMIZER_SHARED_DIR: join(scratch, 'graph'),
      TOKEN_OPTIMIZER_STATE_DIR: state,
      ...env,
    },
  });
  const saved = readdirSync(state)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(state, name), 'utf8')));
  return { stdout: result.stdout, saved };
}

const file = join(scratch, 'edited.ts');
writeFileSync(file, 'export const a = 1;\n');

const claudeEdit = (session) => ({
  hook_event_name: 'PostToolUse',
  session_id: session,
  cwd: scratch,
  tool_name: 'Edit',
  tool_input: { file_path: file, old_string: '1', new_string: '2' },
  tool_response: { success: true },
});

describe('the deferred recording guidance', () => {
  test('arrives on the first edit in the full arm (the control for the tests below)', () => {
    const { stdout, saved } = hook(CLAUDE_POST, claudeEdit('full-arm'));
    expect(stdout).toContain('Record what you work out');
    expect(saved.some((s) => s.recordingGuided === true)).toBe(true);
  });

  test("never reaches token-optimizer's own worker, whose prompt says not to record; other agents still get it", () => {
    for (const agentType of ['token-optimizer-worker', 'token-optimizer-project-worker', 'token-optimizer:worker']) {
      const { stdout, saved } = hook(CLAUDE_POST, { ...claudeEdit(`worker-${agentType}`), agent_id: 'a1', agent_type: agentType });
      expect(stdout).not.toContain('Record what you work out');
      expect(saved.some((s) => s.recordingGuided === true)).toBe(false);
    }
    const other = hook(CLAUDE_POST, { ...claudeEdit('explore-agent'), agent_id: 'a2', agent_type: 'general-purpose' });
    expect(other.stdout).toContain('Record what you work out');
  });

  test('never arrives in an arm with harvest off, and the flag stays unspent', () => {
    for (const arm of ['optimizer', 'retrieval', 'baseline']) {
      const { stdout, saved } = hook(CLAUDE_POST, claudeEdit(`arm-${arm}`), {
        TOKEN_OPTIMIZER_EXPERIMENT_ARM: arm,
      });
      expect(stdout).not.toContain('Record what you work out');
      expect(saved.some((s) => s.recordingGuided === true)).toBe(false);
    }
  });

  test('a Claude Code session is asked to record once, by whichever ask comes first', () => {
    const graph = mkdtempSync(join(scratch, 'graph-once-'));
    const shared = (extra) => ({
      TOKEN_OPTIMIZER_WIKI_DIR: graph,
      TOKEN_OPTIMIZER_SHARED_DIR: graph,
      TOKEN_OPTIMIZER_STATE_DIR: mkdtempSync(join(scratch, 'state-once-')),
      ...extra,
    });
    // The nudge first: at a threshold of one edit it fires on the first edit,
    // which is also the positive control that it can fire at all here. The
    // generic guidance due on that same edit is then withheld.
    const first = hook(CLAUDE_POST, claudeEdit('nudge-first'), shared({ TOKEN_OPTIMIZER_NUDGE_AFTER: '1' }));
    expect(first.stdout).toContain('edits this session');
    expect(first.stdout).not.toContain('Record what you work out');

    // The guidance first: the nudge due on the second edit is withheld.
    const env = shared({ TOKEN_OPTIMIZER_NUDGE_AFTER: '2' });
    const opening = hook(CLAUDE_POST, claudeEdit('guidance-first'), env);
    expect(opening.stdout).toContain('Record what you work out');
    const second = hook(CLAUDE_POST, claudeEdit('guidance-first'), env);
    expect(second.stdout).not.toContain('edits this session');
    expect(second.saved.some((s) => s.edits === 2)).toBe(true);

    // Claude Code's PreToolUse router carries its own copy of the nudge, and in
    // the THOL replay that copy was the one that fired. Control: it fires on a
    // fresh session; then it stays quiet once the guidance has been given.
    const preEdit = (session) => ({ ...claudeEdit(session), hook_event_name: 'PreToolUse', tool_response: undefined });
    const fresh = hook(CLAUDE_PRE, preEdit('router-fresh'), shared({ TOKEN_OPTIMIZER_NUDGE_AFTER: '1' }));
    expect(fresh.stdout).toContain('edits this session');
    const routed = hook(CLAUDE_PRE, preEdit('guidance-first'), env);
    expect(routed.stdout).not.toContain('edits this session');
    expect(routed.saved.some((s) => s.edits >= 2)).toBe(true);
  });

  test('is not marked delivered for a client that cannot carry context', () => {
    const { stdout, saved } = hook(WINDSURF_POST, {
      agent_action_name: 'post_write_code',
      trajectory_id: 'windsurf-silent',
      tool_info: { file_path: file, working_directory: scratch, edits: [] },
    });
    expect(stdout.trim()).toBe('');
    expect(saved.length).toBeGreaterThan(0);
    expect(saved.some((s) => s.recordingGuided === true)).toBe(false);
  });
});