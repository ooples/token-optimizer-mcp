/**
 * A subagent's first tool call carries what the graph knows about its task.
 *
 * SessionStart delivers the standing rules and the task-relevant index to the
 * main session only -- Claude Code fires it for nothing else -- so a subagent
 * started from nothing however much its siblings had recorded. Observed on
 * 2026-10-20: nine workflow agents on one backlog, none able to see another's
 * conclusions.
 */

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { agentTranscriptFor, subagentKnowledge, subagentTask } from '../../hooks-core/briefing.mjs';
import { load, nodeId, putEdge, putNode } from '../../hooks-core/wiki.mjs';
import { indexFile } from '../../hooks-core/staleness.mjs';
import { subagentBriefing } from '../../hooks-core/policy.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const TASK = 'Fix the failing Layers D shard: the npx jest command fails, find the repository test runner.';

let workspace;
let wiki;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'brief-'));
  wiki = join(workspace, 'wiki');
  process.env.TOKEN_OPTIMIZER_HOLDOUT = '0';
});
afterEach(() => rmSync(workspace, { recursive: true, force: true }));

function seed(claim) {
  const path = join(workspace, 'runner.ts');
  writeFileSync(path, 'export const runner = "npm test";');
  indexFile(wiki, path);
  const id = putNode(wiki, { kind: 'finding', key: claim.slice(0, 12), claim, confidence: 0.9, type: 'command' });
  putEdge(wiki, id, 'derived_from', nodeId('file', path));
}

/** A session transcript with one workflow subagent whose first user entry is `task`. */
function subagentSession(task, agentId = 'a1b2') {
  const session = join(workspace, 'sess.jsonl');
  writeFileSync(session, '{}\n');
  const dir = join(workspace, 'sess', 'subagents', 'workflows', 'wf_x');
  mkdirSync(dir, { recursive: true });
  const transcript = join(dir, `agent-${agentId}.jsonl`);
  writeFileSync(
    transcript,
    [
      JSON.stringify({ type: 'user', isSidechain: true, message: { role: 'user', content: task } }),
      JSON.stringify({ type: 'attachment' }),
    ].join('\n')
  );
  return { session, transcript, agentId };
}

describe("finding a subagent's task", () => {
  test('from its own transcript path', () => {
    const { transcript } = subagentSession(TASK);
    expect(subagentTask({ transcript_path: transcript })).toBe(TASK);
  });

  test("from the parent's transcript and the agent id", () => {
    const { session, transcript, agentId } = subagentSession(TASK);
    expect(agentTranscriptFor({ transcript_path: session, agent_id: agentId })).toBe(transcript);
    expect(subagentTask({ transcript_path: session, agent_id: agentId })).toBe(TASK);
  });

  test('nothing to find is an empty task, not a throw', () => {
    expect(subagentTask({})).toBe('');
    expect(subagentTask({ transcript_path: join(workspace, 'nope.jsonl'), agent_id: 'zz' })).toBe('');
  });
});

describe('the knowledge block', () => {
  test('carries a finding relevant to the task', () => {
    seed('Run npm test instead of npx jest for this repository');
    const text = subagentKnowledge([{ dir: wiki, graph: load(wiki) }], TASK);
    expect(text).toContain('npm test');
  });

  test('says nothing when nothing is relevant', () => {
    seed('The deployment region is selected by the release job');
    expect(subagentKnowledge([{ dir: wiki, graph: load(wiki) }], 'Rename a CSS class in the header.')).toBeNull();
  });
});

describe('the briefing asks for a record only when one can be made', () => {
  test('wiki_write available', () => {
    const text = subagentBriefing({ agent_id: 'x' }, {}, { canRecord: true });
    expect(text).toContain('wiki_write');
    expect(text).toContain('batch independent commands');
  });

  test('wiki_write absent', () => {
    expect(subagentBriefing({ agent_id: 'x' }, {})).not.toContain('wiki_write');
  });
});

describe('end to end through the packaged router', () => {
  test("a subagent's first call carries the briefing and the relevant finding", () => {
    seed('Run npm test instead of npx jest for this repository');
    const { transcript } = subagentSession(TASK);
    const result = spawnSync(process.execPath, [join(ROOT, 'plugin/hooks/pretooluse-router.mjs')], {
      input: JSON.stringify({
        session_id: `brief-${randomUUID()}`,
        transcript_path: transcript,
        cwd: workspace,
        tool_name: 'Bash',
        tool_input: { command: 'echo hi' },
      }),
      encoding: 'utf8',
      env: {
        ...process.env,
        TOKEN_OPTIMIZER_MODE: 'assist',
        TOKEN_OPTIMIZER_WIKI_DIR: wiki,
        TOKEN_OPTIMIZER_SHARED_DIR: wiki,
        TOKEN_OPTIMIZER_STATE_DIR: join(workspace, 'state'),
        TOKEN_OPTIMIZER_MCP_CAPABILITIES: 'smart_read,smart_grep,smart_glob,wiki_write',
      },
    });
    const out = JSON.parse(result.stdout.trim() || '{}').hookSpecificOutput || {};
    expect(out.additionalContext).toContain('Token Optimizer (shown once to this agent)');
    expect(out.additionalContext).toContain('wiki_write');
    expect(out.additionalContext).toContain('npm test');
  });
});
