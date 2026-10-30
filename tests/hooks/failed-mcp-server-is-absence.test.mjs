/**
 * A session whose host reports the optimizer MCP server as FAILED TO CONNECT
 * has none of its tools, and the hooks must stop advertising them.
 *
 * Claude Code writes the failure into the transcript before the first turn, in
 * the same `deferred_tools_delta` attachment that lists the deferred tools:
 *
 *   failedMcpServers: [{ name: 'plugin:token-optimizer:token-optimizer',
 *                        errorCode: 'CONNECTION_CLOSED', error: 'Connection closed' }]
 *
 * The model reads the matching system notice and never tries the tools, so no
 * failed call or tool search ever reaches the #470/#484 readers. Before this,
 * three live sessions on 2026-10-30 were told to "call smart_grep instead" and
 * to "call wiki_write" for their whole length while neither existed.
 */

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { HOOK_MCP_TOOLS } from '../../hooks-core/capabilities.mjs';
import { serverFailuresFromTranscript } from '../../hooks-core/transcript.mjs';

const ROOT = process.cwd();
const PLUGIN_SERVER = 'plugin:token-optimizer:token-optimizer';
const QUALIFIED = 'mcp__plugin_token-optimizer_token-optimizer__wiki_write';

let workspace;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'failed-mcp-'));
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

function transcript(lines, name = 'transcript.jsonl') {
  const path = join(workspace, name);
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join('\n'));
  return path;
}

/** A deferred-tools delta, shaped as Claude Code records it. */
const delta = (timestamp, { added = [], readded = [], failed = [], pending = [] } = {}) => ({
  type: 'attachment',
  timestamp,
  attachment: {
    type: 'deferred_tools_delta',
    addedNames: added,
    addedLines: added,
    removedNames: [],
    wireHiddenNames: [],
    readdedNames: readded,
    pendingMcpServers: pending,
    failedMcpServers: failed.map((name) => ({
      name,
      errorCode: 'CONNECTION_CLOSED',
      error: 'Connection closed',
    })),
  },
});

const T0 = '2026-10-30T14:00:00.000Z';
const T1 = '2026-10-30T15:00:00.000Z';

describe('serverFailuresFromTranscript', () => {
  test('a failed optimizer server marks every hook-visible tool absent', () => {
    const path = transcript([delta(T0, { added: ['CronCreate'], failed: [PLUGIN_SERVER] })]);
    expect(serverFailuresFromTranscript(path)).toEqual({
      failed: HOOK_MCP_TOOLS.map((name) => ({ name, at: Date.parse(T0) })),
      restored: [],
    });
  });

  test('another server failing says nothing about this one', () => {
    const path = transcript([delta(T0, { failed: ['claude.ai Gmail'] })]);
    expect(serverFailuresFromTranscript(path)).toEqual({ failed: [], restored: [] });
  });

  test('a server still pending is not a failure', () => {
    const path = transcript([delta(T0, { pending: [PLUGIN_SERVER] })]);
    expect(serverFailuresFromTranscript(path)).toEqual({ failed: [], restored: [] });
  });

  test('a later delta announcing the tools again is a reconnect', () => {
    const path = transcript([
      delta(T0, { failed: [PLUGIN_SERVER] }),
      delta(T1, { added: [QUALIFIED] }),
    ]);
    expect(serverFailuresFromTranscript(path).restored).toEqual([
      { name: 'wiki_write', at: Date.parse(T1) },
    ]);
  });

  test('an announcement BEFORE the failure does not restore anything', () => {
    const path = transcript([
      delta(T0, { added: [QUALIFIED] }),
      delta(T1, { failed: [PLUGIN_SERVER] }),
    ]);
    const outcome = serverFailuresFromTranscript(path);
    expect(outcome.restored).toEqual([]);
    expect(outcome.failed).toHaveLength(HOOK_MCP_TOOLS.length);
  });
});

describe('the hooks stop advertising a server that never connected', () => {
  const POST = join(ROOT, 'plugin', 'hooks', 'post-tool.mjs');

  function env() {
    const base = { ...process.env };
    delete base.TOKEN_OPTIMIZER_MCP_CAPABILITIES;
    return {
      ...base,
      // The plugin install declares its tools; that declaration is what the
      // hooks advertised from while the server was down.
      TOKEN_OPTIMIZER_MCP_CAPABILITIES_BUNDLED: HOOK_MCP_TOOLS.join(','),
      TOKEN_OPTIMIZER_STATE_DIR: join(workspace, '.state'),
      TOKEN_OPTIMIZER_WIKI_DIR: join(workspace, '.wiki'),
      TOKEN_OPTIMIZER_SHARED_DIR: join(workspace, '.shared'),
    };
  }

  function edit(sessionId, transcriptPath, hookEnv) {
    const file = join(workspace, 'edited.ts');
    writeFileSync(file, 'export const edited = 1;\n');
    const result = spawnSync(process.execPath, [POST], {
      cwd: workspace,
      env: hookEnv,
      input: JSON.stringify({
        hook_event_name: 'PostToolUse',
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd: workspace,
        tool_name: 'Write',
        tool_input: { file_path: file },
        tool_response: { success: true },
      }),
      encoding: 'utf8',
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    return result.stdout;
  }

  function stateOf(hookEnv, sessionId) {
    const files = readdirSync(hookEnv.TOKEN_OPTIMIZER_STATE_DIR).filter((name) =>
      name.startsWith(sessionId)
    );
    expect(files).toHaveLength(1);
    return JSON.parse(readFileSync(join(hookEnv.TOKEN_OPTIMIZER_STATE_DIR, files[0]), 'utf8'));
  }

  test('a connected server gets the wiki_write guidance (positive control)', () => {
    const path = transcript([delta(T0, { added: [QUALIFIED] })]);
    expect(edit('connected', path, env())).toContain('Call wiki_write');
  });

  test('a failed server gets no wiki_write guidance', () => {
    const path = transcript([delta(T0, { failed: [PLUGIN_SERVER] })]);
    const hookEnv = env();
    const output = edit('failed', path, hookEnv);

    // Pinned by the state the hook wrote, so a hook that never ran cannot pass.
    const state = stateOf(hookEnv, 'failed');
    expect(Object.keys(state.optimizerToolAbsentAt ?? {}).sort()).toEqual(
      [...HOOK_MCP_TOOLS].sort()
    );
    expect(state.edits).toBe(1);
    expect(output).not.toContain('wiki_write');
  });

  test('a reconnect after the failure brings the guidance back', () => {
    const path = transcript([
      delta(T0, { failed: [PLUGIN_SERVER] }),
      delta(T1, { added: [QUALIFIED] }),
    ]);
    const hookEnv = env();
    expect(edit('reconnected', path, hookEnv)).toContain('Call wiki_write');
    expect(stateOf(hookEnv, 'reconnected').optimizerToolOkAt?.wiki_write).toBe(
      Date.parse(T1)
    );
  });
});
