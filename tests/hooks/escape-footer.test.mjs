/**
 * The off switch belongs on refusals, not on everything the router says.
 *
 * It rode on every advisory -- the subagent briefing, recalled findings, the
 * bounding notice -- so an agent in assist mode was told, on each injection,
 * that "TOKEN_OPTIMIZER_MODE=assist stops refusals". Nothing had been refused.
 */
import { describe, it, expect, afterAll } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROUTER = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'plugin',
  'hooks',
  'pretooluse-router.mjs'
);
const root = mkdtempSync(join(tmpdir(), 'escape-footer-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function route(payload, mode, cwd = root) {
  const graph = join(root, `graph-${mode}`);
  mkdirSync(graph, { recursive: true });
  const result = spawnSync(process.execPath, [ROUTER], {
    input: JSON.stringify({
      session_id: `${basename(root)}-${mode}`,
      cwd,
      hook_event_name: 'PreToolUse',
      ...payload,
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      TOKEN_OPTIMIZER_MODE: mode,
      // The positive inventory evidence production requires before redirecting.
      TOKEN_OPTIMIZER_MCP_CAPABILITIES:
        'smart_read,smart_glob,smart_grep,wiki_write',
      TOKEN_OPTIMIZER_STATE_DIR: join(root, `state-${mode}`),
      TOKEN_OPTIMIZER_WIKI_DIR: graph,
      TOKEN_OPTIMIZER_SHARED_DIR: graph,
      TOKEN_OPTIMIZER_UCR_DIR: join(root, `ucr-${mode}`),
    },
    timeout: 30_000,
  });
  return JSON.parse(result.stdout || '{}').hookSpecificOutput ?? {};
}

describe('the escape footer', () => {
  it('is not appended to a subagent briefing, where nothing was refused', () => {
    const transcript = join(root, 'session', 'subagents', 'agent-footer.jsonl');
    mkdirSync(dirname(transcript), { recursive: true });
    writeFileSync(
      transcript,
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'check the build' } })}\n`
    );

    const out = route(
      {
        transcript_path: transcript,
        tool_name: 'Bash',
        tool_input: { command: 'git status' },
      },
      'assist'
    );

    expect(out.permissionDecision).toBeUndefined();
    expect(out.additionalContext).toMatch(
      /Token Optimizer \(shown once to this agent\)/
    );
    expect(out.additionalContext).not.toMatch(/Not what you wanted/);
  });

  it('still rides on a refusal', () => {
    // A project, and the command's first run in this session: refused.
    const project = join(root, 'project');
    mkdirSync(join(project, '.git'), { recursive: true });
    const out = route(
      { tool_name: 'Bash', tool_input: { command: 'grep -rn needle .' } },
      'enforce',
      project
    );

    expect(out.permissionDecision).toBe('deny');
    expect(out.permissionDecisionReason).toMatch(
      /TOKEN_OPTIMIZER_MODE=assist stops refusals/
    );
  });

  it('is not appended when a repeated search is bounded and let through', () => {
    // The second run of a command is bounded rather than refused: the call
    // proceeds, so the off switch has nothing to switch off.
    const out = route(
      { tool_name: 'Bash', tool_input: { command: 'grep -rn needle .' } },
      'enforce',
      join(root, 'project')
    );

    expect(out.permissionDecision).toBe('allow');
    expect(out.updatedInput.command).toMatch(/grep -rn needle/);
    expect(out.additionalContext).not.toMatch(/Not what you wanted/);
  });
});
