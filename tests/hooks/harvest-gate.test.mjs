/**
 * The Stop hook's in-band harvest prompt fires only on a turn that earned it.
 *
 * Each firing continues the turn, so it re-reads the whole context: measured on
 * one session at 1.1-1.4M input tokens a firing, with 4 of 10 recording nothing.
 * It now asks only after a failure was worked past or a user correction, and
 * never after wiki_write was already called. Unknown evidence keeps the prompt.
 */
import { describe, test, expect, afterAll } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { turnEvidence } from '../../hooks-core/transcript.mjs';
import { semanticHarvestPrompt } from '../../hooks-core/recording.mjs';

const root = mkdtempSync(join(tmpdir(), 'harvest-gate-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
const transcript = (entries) => {
  const path = join(root, `t${++n}.jsonl`);
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return path;
};
const prompt = (text) => ({
  type: 'user',
  message: { role: 'user', content: text },
});
const call = (id, name, input = {}) => ({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', id, name, input }],
  },
});
const result = (id, content, isError = false) => ({
  type: 'user',
  message: {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: id, content, is_error: isError },
    ],
  },
});

describe('turnEvidence', () => {
  test('reads only the current turn', () => {
    const path = transcript([
      prompt('first task'),
      call('a', 'Bash'),
      result('a', 'Exit code 1', true),
      prompt('second task'),
      call('b', 'Bash'),
      result('b', 'ok'),
    ]);
    expect(turnEvidence(path)).toEqual({
      opening: 'second task',
      failures: 0,
      recorded: false,
    });
  });

  test('counts a failure once, though an api-request-blob repeats it', () => {
    const failure = result('a', 'Exit code 2', true);
    const path = transcript([
      prompt('fix the build'),
      call('a', 'Bash'),
      failure,
      { ...failure, type: 'api-request-blob' },
    ]);
    expect(turnEvidence(path).failures).toBe(1);
  });

  test("the Stop hook's own feedback is not a turn, nor a correction", () => {
    const feedback =
      'Stop hook feedback:\nBefore finishing, perform the semantic harvest yourself.';
    const path = transcript([
      prompt('add the option'),
      call('a', 'Edit'),
      result('a', 'ok'),
      {
        type: 'api-request-blob',
        message: { role: 'user', content: feedback },
      },
      { ...prompt(feedback), isMeta: true },
    ]);
    expect(turnEvidence(path).opening).toBe('add the option');
  });

  test('a declined call is not a failure', () => {
    const path = transcript([
      prompt('go'),
      call('a', 'Bash'),
      result('a', "The user doesn't want to proceed with this tool use.", true),
    ]);
    expect(turnEvidence(path).failures).toBe(0);
  });

  test("the optimizer's own refusal is not a failure", () => {
    // Claude Code records a hook denial as an error result; a redirect to
    // smart_grep is not something the turn worked past (review on #520).
    const path = transcript([
      prompt('go'),
      call('a', 'Bash'),
      result(
        'a',
        'PreToolUse:Bash hook error: Call smart_grep instead. (Not what you wanted? ' +
          'TOKEN_OPTIMIZER_MODE=assist stops refusals and keeps everything else on.)',
        true
      ),
    ]);
    expect(turnEvidence(path).failures).toBe(0);
  });

  test('sees a wiki_write under any server prefix', () => {
    const path = transcript([
      prompt('go'),
      call('a', 'mcp__plugin_token-optimizer_token-optimizer__wiki_write'),
    ]);
    expect(turnEvidence(path).recorded).toBe(true);
  });

  test('null without a transcript, so the caller keeps its old behaviour', () => {
    expect(turnEvidence(null)).toBeNull();
    expect(turnEvidence(join(root, 'missing.jsonl'))).toBeNull();
  });
});

describe('semanticHarvestPrompt, gated on the turn', () => {
  const ask = (turn) =>
    semanticHarvestPrompt({ edits: 2, files: ['src/a.ts'], turn });

  test('asks after a failure that was worked past', () => {
    expect(ask({ failures: 1, recorded: false, corrected: false })).toMatch(
      /wiki_write/
    );
  });

  test('asks after a user correction', () => {
    expect(ask({ failures: 0, recorded: false, corrected: true })).toMatch(
      /wiki_write/
    );
  });

  test('stays quiet on a clean turn', () => {
    expect(ask({ failures: 0, recorded: false, corrected: false })).toBeNull();
  });

  test('stays quiet once wiki_write was already called', () => {
    expect(ask({ failures: 3, recorded: true, corrected: true })).toBeNull();
  });

  test('asks as before when the turn is unknown', () => {
    expect(ask(null)).toMatch(/wiki_write/);
  });
});

// THE WIRING, through the real Claude Code hooks: edits recorded by
// post-tool.mjs, then stop.mjs reading the turn from transcript_path.
describe('the Claude Code Stop hook', () => {
  let PLUGIN = join(process.cwd(), 'plugin', 'hooks');
  const hook = (name, payload, workspace) =>
    spawnSync(process.execPath, [join(PLUGIN, `${name}.mjs`)], {
      cwd: workspace,
      input: JSON.stringify(payload),
      encoding: 'utf8',
      env: {
        ...process.env,
        TOKEN_OPTIMIZER_MODE: 'assist',
        TOKEN_OPTIMIZER_MCP_CAPABILITIES: 'wiki_write',
        TOKEN_OPTIMIZER_STATE_DIR: join(workspace, '.state'),
        TOKEN_OPTIMIZER_WIKI_DIR: join(workspace, '.wiki'),
        TOKEN_OPTIMIZER_SHARED_DIR: join(workspace, '.wiki'),
        TOKEN_OPTIMIZER_UCR_DIR: join(workspace, '.ucr'),
      },
      timeout: 30_000,
    });
  const stopAfterEdits = (entries) => {
    const workspace = mkdtempSync(join(root, 'stop-'));
    const transcript_path = transcript(entries);
    const session_id = `gate-${n}`;
    for (const file of ['a.ts', 'b.ts']) {
      writeFileSync(join(workspace, file), 'x\n');
      hook(
        'post-tool',
        {
          hook_event_name: 'PostToolUse',
          session_id,
          transcript_path,
          cwd: workspace,
          tool_name: 'Edit',
          tool_input: {
            file_path: join(workspace, file),
            old_string: 'x',
            new_string: 'y',
          },
          tool_response: { success: true },
          // Copilot's own success shape, so its post-tool counts the edit.
          toolResult: { resultType: 'success', textResultForLlm: 'ok' },
        },
        workspace
      );
    }
    const out = hook(
      'stop',
      {
        hook_event_name: 'Stop',
        session_id,
        transcript_path,
        cwd: workspace,
        stop_hook_active: false,
      },
      workspace
    );
    const parsed = out.stdout ? JSON.parse(out.stdout) : {};
    // The NEXT turn's first tool call, in the same session.
    parsed.nextToolCall = () => {
      writeFileSync(join(workspace, 'c.ts'), 'x\n');
      const next = hook(
        'post-tool',
        {
          hook_event_name: 'PostToolUse',
          session_id,
          transcript_path,
          cwd: workspace,
          tool_name: 'Edit',
          tool_input: { file_path: join(workspace, 'c.ts'), old_string: 'x', new_string: 'y' },
          tool_response: { success: true },
        },
        workspace
      );
      return next.stdout ? JSON.parse(next.stdout) : {};
    };
    return parsed;
  };

  test('a clean turn ends without the extra harvest turn', () => {
    const out = stopAfterEdits([
      prompt('rename it'),
      call('a', 'Edit'),
      result('a', 'ok'),
    ]);
    expect(out.decision).toBeUndefined();
  });

  test('a turn that worked past a failure is asked to record it -- on the next turn, not with one of its own', () => {
    // User decision 2026-10-21: a blocking Stop continues the turn and re-reads
    // the whole context, so the nudge rides on the next turn's first tool result.
    const out = stopAfterEdits([
      prompt('make the test pass'),
      call('a', 'Bash'),
      result('a', 'Exit code 1\nFAIL', true),
      call('b', 'Edit'),
      result('b', 'ok'),
    ]);
    expect(out.decision).toBeUndefined();
    const next = out.nextToolCall();
    expect(next.hookSpecificOutput.additionalContext).toMatch(/Semantic harvest for the previous turn/);
    expect(next.hookSpecificOutput.additionalContext).not.toMatch(/restating the answer/);
    // Once: the call after that carries no nudge.
    expect(JSON.stringify(out.nextToolCall())).not.toMatch(/Semantic harvest/);
  });

  test('another client keeps the prompt: only Claude Code transcripts are read', () => {
    // Copilot shares this Stop adapter, and its transcript need not record
    // failures the way Claude Code's does (review on #520).
    PLUGIN = join(process.cwd(), 'integrations', 'copilot', '.github', 'hooks');
    try {
      const out = stopAfterEdits([
        prompt('rename it'),
        call('a', 'Edit'),
        result('a', 'ok'),
      ]);
      expect(out.decision).toBe('block');
      expect(out.reason).toMatch(/semantic harvest/);
    } finally {
      PLUGIN = join(process.cwd(), 'plugin', 'hooks');
    }
  });
});
