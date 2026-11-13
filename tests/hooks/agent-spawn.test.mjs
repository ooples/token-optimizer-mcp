/**
 * PreToolUse on Agent/Task: the report budget, and what a fork or a batch costs
 * before it is spawned (#567).
 */

import { describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUDGET_MARKER,
  DIGEST_MARKER,
  DIGEST_MAX_PATHS,
  parentFindings,
  parentState,
  planSpawn,
  withReportBudget,
  withSharedBriefing,
  modelTier,
  workerModel,
} from '../../src/hooks-core/agent-spawn.mjs';

const repo = join(fileURLToPath(import.meta.url), '..', '..', '..');

/** A parent transcript whose last request carried `context` tokens and spawned `ids`. */
function parent({ context = 150_000, ids = ['t1'], streamed = false, before = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'spawn-'));
  const path = join(dir, 'parent.jsonl');
  const usage = { input_tokens: 10, cache_read_input_tokens: context - 1_010, cache_creation_input_tokens: 1_000 };
  const blocks = ids.map((id) => ({ type: 'tool_use', id, name: 'Agent', input: { prompt: 'x' } }));
  const entries = streamed
    ? blocks.map((b) => ({ type: 'assistant', message: { id: 'msg_1', usage, content: [b] } }))
    : [{ type: 'assistant', message: { id: 'msg_1', usage, content: blocks } }];
  writeFileSync(
    path,
    [{ type: 'user', message: { content: 'go' } }, ...before, ...entries].map((e) => JSON.stringify(e)).join('\n') + '\n'
  );
  return path;
}

describe('parentState', () => {
  test('reads the context and the batch, also when the message is streamed per block', () => {
    expect(parentState(parent({ ids: ['a', 'b', 'c'] }), 'b')).toEqual({ contextTokens: 150_000, batch: 3, first: false, found: [], model: null });
    expect(parentState(parent({ ids: ['a', 'b', 'c'], streamed: true }), 'a')).toEqual({ contextTokens: 150_000, batch: 3, first: true, found: [], model: null });
  });

  test('reads the parent model, skipping harness-made messages', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spawn-model-'));
    const path = join(dir, 'p.jsonl');
    const said = (model) => JSON.stringify({ type: 'assistant', message: { id: model, model, content: [] } });
    writeFileSync(path, [said('claude-sonnet-5-5'), said('<synthetic>')].join('\n') + '\n');
    expect(parentState(path, 'x').model).toBe('claude-sonnet-5-5');
  });

  test('a missing transcript is an empty state, not an error', () => {
    expect(parentState(join(tmpdir(), 'nope.jsonl'), 'x')).toEqual({ contextTokens: 0, batch: 1, first: true, found: [], model: null });
  });
});

describe('workerModel', () => {
  const routed = { prompt: 'x', subagent_type: 'token-optimizer-worker' };
  const at = (parentModel, env = {}, input = { prompt: 'x' }) => workerModel({ input, routed, parentModel, env });

  test('a routed worker under a dearer parent runs on haiku', () => {
    expect(modelTier('claude-opus-5-5')).toBe(2);
    expect(at('claude-opus-5-5')).toBe('haiku');
    expect(at('claude-sonnet-5-5')).toBe('haiku');
    expect(at('claude-opus-5-5', { TOKEN_OPTIMIZER_WORKER_MODEL: 'sonnet' })).toBe('sonnet');
    expect(at('claude-opus-5-5', { TOKEN_OPTIMIZER_WORKER_MODEL: '' })).toBe('haiku');
  });

  test('never upward, never sideways, never from an unknown parent, never over the caller, never when off', () => {
    expect(at('claude-haiku-5-5')).toBeNull();
    expect(at('claude-sonnet-5-5', { TOKEN_OPTIMIZER_WORKER_MODEL: 'sonnet' })).toBeNull();
    expect(at('claude-sonnet-5-5', { TOKEN_OPTIMIZER_WORKER_MODEL: 'opus' })).toBeNull();
    expect(at('claude-fable-5-2')).toBeNull();
    expect(at(null)).toBeNull();
    expect(at('claude-opus-5-5', {}, { prompt: 'x', model: 'opus' })).toBeNull();
    expect(at('claude-opus-5-5', { TOKEN_OPTIMIZER_WORKER_MODEL: 'inherit' })).toBeNull();
    expect(at('claude-opus-5-5', { TOKEN_OPTIMIZER_WORKER_MODEL: 'nonsense' })).toBeNull();
    expect(workerModel({ input: { prompt: 'x' }, routed: null, parentModel: 'claude-opus-5-5', env: {} })).toBeNull();
  });
});

describe('the report budget', () => {
  test('is appended once, and never to a fork', () => {
    const once = withReportBudget({ prompt: 'Find the bug.', subagent_type: 'general-purpose' });
    expect(once.prompt).toContain(BUDGET_MARKER);
    expect(once.subagent_type).toBe('general-purpose');
    expect(withReportBudget(once)).toBeNull();
    expect(withReportBudget({ prompt: 'continue', subagent_type: 'fork' })).toBeNull();
    // the worker's own prompt carries the budget
    expect(withReportBudget({ prompt: 'x', subagent_type: 'token-optimizer:worker' })).toBeNull();
  });

  test('is off when asked', () => {
    expect(withReportBudget({ prompt: 'x' }, { TOKEN_OPTIMIZER_AGENT_REPORT_BUDGET: 'off' })).toBeNull();
  });
});

/** The parent read a file, ran a files-mode Grep, a content-mode Grep and a Glob. */
const EXPLORED = [
  {
    type: 'assistant',
    message: {
      id: 'm0',
      content: [
        { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'C:\\work\\src\\parser.js' } },
        { type: 'tool_use', id: 'g1', name: 'Grep', input: { pattern: 'tokenize' } },
        { type: 'tool_use', id: 'g2', name: 'Grep', input: { pattern: 'x', output_mode: 'content' } },
        { type: 'tool_use', id: 'l1', name: 'Glob', input: { pattern: '**/*.test.js' } },
        { type: 'tool_use', id: 'l2', name: 'Glob', input: { pattern: 'missing/**' } },
      ],
    },
  },
  {
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 'r1', content: 'const a = 1;' },
        {
          type: 'tool_result',
          tool_use_id: 'g1',
          content: 'Found 2 files\nC:\\work\\src\\lexer.js\nC:\\work\\src\\parser.js\nShowing 2 of 2, narrow with a path/glob\nTruncated: use a narrower path/glob',
        },
        // content mode, with line numbers and without
        { type: 'tool_result', tool_use_id: 'g2', content: 'C:\\work\\src\\noise.js:12:const x = 1;\nimport x from lib/noise.js' },
        { type: 'tool_result', tool_use_id: 'l1', content: [{ type: 'text', text: 'C:\\work\\test\\parser.test.js' }] },
        { type: 'tool_result', tool_use_id: 'l2', is_error: true, content: 'C:\\work\\missing\\gone.js' },
      ],
    },
  },
];

describe('the shared briefing', () => {
  test('collects what the parent read and listed, most recent first, without content-mode matches', () => {
    expect(parentFindings(EXPLORED)).toEqual([
      'C:\\work\\test\\parser.test.js',
      'C:\\work\\src\\parser.js',
      'C:\\work\\src\\lexer.js',
    ]);
    expect(parentState(parent({ before: EXPLORED }), 't1').found).toHaveLength(3);
  });

  test('is relative to the project, skips what the prompt names, and is appended once', () => {
    const found = parentFindings(EXPLORED);
    const input = { prompt: 'Fix src/parser.js.', subagent_type: 'general-purpose' };
    const once = withSharedBriefing(input, found, { cwd: 'C:\\work', env: {} });
    expect(once.prompt).toContain(DIGEST_MARKER);
    expect(once.prompt).toContain('test/parser.test.js, src/lexer.js.');
    expect(once.prompt.split('src/parser.js')).toHaveLength(2);
    expect(withSharedBriefing(once, [...found, 'C:\\work\\new.js'], { cwd: 'C:\\work', env: {} })).toBeNull();
  });

  test('never for a fork, never with nothing new, off when asked, and bounded', () => {
    const found = parentFindings(EXPLORED);
    expect(withSharedBriefing({ prompt: 'continue', subagent_type: 'fork' }, found, { env: {} })).toBeNull();
    expect(withSharedBriefing({ prompt: 'x' }, [], { env: {} })).toBeNull();
    expect(withSharedBriefing({ prompt: 'x' }, found, { env: { TOKEN_OPTIMIZER_AGENT_DIGEST: 'off' } })).toBeNull();
    const many = Array.from({ length: 50 }, (_, i) => `/w/f${i}.js`);
    const bounded = withSharedBriefing({ prompt: 'x' }, many, { cwd: '/w', env: {} });
    expect(bounded.prompt.match(/f\d+\.js/g)).toHaveLength(DIGEST_MAX_PATHS);
  });

  test('planSpawn adds it on top of the report budget', () => {
    const plan = planSpawn({ input: { prompt: 'Audit.' }, found: ['/w/a.js'], cwd: '/w', env: {} });
    expect(plan.updatedInput.prompt).toContain(BUDGET_MARKER);
    expect(plan.updatedInput.prompt).toContain(`${DIGEST_MARKER} Files`);
    expect(plan.updatedInput.prompt).toContain(': a.js.');
  });
});

describe('planSpawn', () => {
  test('a large fork is priced against a fresh agent, and refused only in enforce', () => {
    const input = { prompt: 'continue', subagent_type: 'fork' };
    const assist = planSpawn({ input, contextTokens: 150_000, batch: 3 });
    expect(assist.context).toContain('3 forks copy');
    expect(assist.context).toContain('~450k');
    expect(assist.deny).toBeNull();
    expect(planSpawn({ input, contextTokens: 150_000, batch: 3, first: false }).context).toBeNull();
    const enforce = planSpawn({ input, contextTokens: 150_000, mode: 'enforce' });
    expect(enforce.deny).toContain('non-fork subagent_type');
  });

  test('a small fork says nothing', () => {
    expect(planSpawn({ input: { prompt: 'x', subagent_type: 'fork' }, contextTokens: 20_000 }).context).toBeNull();
  });

  test('a batch is priced once, by its first call', () => {
    const input = { prompt: 'x' };
    expect(planSpawn({ input, batch: 4, first: true, agentBase: 50_000 }).context).toContain('~200k together');
    expect(planSpawn({ input, batch: 4, first: false }).context).toBeNull();
    expect(planSpawn({ input, batch: 2 }).context).toBeNull();
  });
});

describe('the hook, end to end', () => {
  function run(payload, env = {}) {
    const home = mkdtempSync(join(tmpdir(), 'spawn-home-'));
    const result = spawnSync(process.execPath, [join(repo, 'src', 'plugin', 'hooks', 'agent-spawn.mjs')], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      env: { ...process.env, TOKEN_OPTIMIZER_HOME: home, TOKEN_OPTIMIZER_STATE_DIR: join(home, 's'), TOKEN_OPTIMIZER_MODE: '', ...env },
      timeout: 30_000,
    });
    return { status: result.status, out: result.stdout ? JSON.parse(result.stdout) : null };
  }

  test('rewrites the prompt with the budget and says what the batch costs', () => {
    const transcript = parent({ ids: ['a', 'b', 'c'] });
    const { status, out } = run({
      hook_event_name: 'PreToolUse',
      tool_name: 'Agent',
      tool_use_id: 'a',
      transcript_path: transcript,
      tool_input: { description: 'd', prompt: 'Audit the parser.', subagent_type: 'general-purpose' },
    });
    expect(status).toBe(0);
    expect(out.hookSpecificOutput.updatedInput.prompt).toContain('Audit the parser.');
    expect(out.hookSpecificOutput.updatedInput.prompt).toContain(BUDGET_MARKER);
    expect(out.hookSpecificOutput.updatedInput.description).toBe('d');
    expect(out.hookSpecificOutput.additionalContext).toContain('3 agents');
  });

  test('prints nothing in off mode, for other tools, and for garbage', () => {
    const payload = { tool_name: 'Agent', tool_input: { prompt: 'x' } };
    expect(run(payload, { TOKEN_OPTIMIZER_MODE: 'off' }).out).toBeNull();
    expect(run({ tool_name: 'Read', tool_input: { file_path: 'x' } }).out).toBeNull();
    const garbage = spawnSync(process.execPath, [join(repo, 'src', 'plugin', 'hooks', 'agent-spawn.mjs')], {
      input: 'nope',
      encoding: 'utf8',
    });
    expect(garbage.status).toBe(0);
    expect(garbage.stdout).toBe('');
  });

  test('with the budget off, a plain spawn is left completely alone', () => {
    const { out } = run({ tool_name: 'Agent', tool_input: { prompt: 'x' } }, { TOKEN_OPTIMIZER_AGENT_REPORT_BUDGET: 'off' });
    expect(out).toBeNull();
  });

  test('passes on where the parent already looked; both switches off leave it alone', () => {
    const transcript = parent({ before: EXPLORED });
    const payload = { tool_name: 'Agent', tool_use_id: 't1', transcript_path: transcript, cwd: 'C:\\work', tool_input: { prompt: 'Fix it.' } };
    expect(run(payload).out.hookSpecificOutput.updatedInput.prompt).toContain('src/lexer.js');
    expect(
      run(payload, { TOKEN_OPTIMIZER_AGENT_REPORT_BUDGET: 'off', TOKEN_OPTIMIZER_AGENT_DIGEST: 'off' }).out
    ).toBeNull();
  });
});
