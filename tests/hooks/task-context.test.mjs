import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promptSubmitted, toolCallObserved } from '../../src/hooks-core/task-session.mjs';
import { loadState, saveState } from '../../src/hooks-core/policy.mjs';
import { resolveTaskPrompt, readTaskContext, TASK_CONTEXT_BYTES } from '../../src/hooks-core/task-context.mjs';

let dir;
const previousStateDir = process.env.TOKEN_OPTIMIZER_STATE_DIR;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'task-context-'));
  process.env.TOKEN_OPTIMIZER_STATE_DIR = join(dir, 'state');
});
afterAll(() => {
  if (previousStateDir === undefined) delete process.env.TOKEN_OPTIMIZER_STATE_DIR;
  else process.env.TOKEN_OPTIMIZER_STATE_DIR = previousStateDir;
  rmSync(dir, { recursive: true, force: true });
});

const user = (text) => ({ type: 'user', message: { role: 'user', content: text } });
const assistant = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const transcript = (rows) => {
  const path = join(dir, `chat-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return path;
};
const resolve = (prompt, category = 'fix', messages = []) =>
  resolveTaskPrompt(prompt, { previous: { category, gen: 1000 }, messages, now: 2000 });

describe('conversation-aware task resolution', () => {
  test.each(['yes', 'yes, do that', 'go ahead', 'continue', 'keep going', 'do #1'])('%s inherits the task when context is unclear', (prompt) => {
    expect(resolve(prompt, 'rewrite')).toMatchObject({ category: 'rewrite', source: 'inherited' });
  });

  test.each([
    ['now write a report about the fix', 'survey'],
    ['Explain how the cache works', 'explain'],
    ['Fix the failing tests', 'fix'],
    ['Implement the new endpoint', 'build'],
    ['no, fix the failing tests', 'fix'],
    ['yes, rewrite the whole file in TypeScript', 'rewrite'],
    ['Could you rephrase this sentence?', 'rewrite'],
    ['Can you translate this paragraph?', 'rewrite'],
    ['Fix the grammar issues in this paragraph', 'rewrite'],
    ['Please fix these issues in the cache', 'fix'],
  ])('a new request wins over old context: %s', (prompt, category) => {
    expect(resolve(prompt, 'rewrite', [{ role: 'assistant', text: 'I can rewrite the whole file.' }]).category).toBe(category);
  });

  test('an accepted proposal can change the task', () => {
    expect(resolve('yes, do that', 'fix', [
      { role: 'user', text: 'Fix the failing tests' },
      { role: 'assistant', text: 'The bug is fixed. Would you like me to write a report about the fix?' },
    ])).toMatchObject({ category: 'survey', source: 'context' });
  });

  test('only the selected option is classified, even when other options repeat keywords', () => {
    const messages = [{ role: 'assistant', text: '1. Rewrite the whole file.\n2. Fix the failing tests and repair the broken CI job.\n3. Write a comprehensive audit report.' }];
    expect(resolve('yes do #1', 'fix', messages).category).toBe('rewrite');
    expect(resolve('option 2 please', 'survey', messages).category).toBe('fix');
    expect(resolve('2 please', 'survey', messages).category).toBe('fix');
    expect(resolve('do option 3', 'fix', messages).category).toBe('survey');
    expect(resolve('option #1', 'fix', messages).category).toBe('rewrite');
    expect(resolve("yes do #1, but this isn't working code that I have reviewed", 'build', messages).category).toBe('rewrite');
    expect(resolve('yes option 1, but now write a report about the fix', 'build', messages).category).toBe('survey');
    expect(resolve('go with option 3', 'fix', messages).category).toBe('survey');
    expect(resolve('yes', 'build', messages)).toMatchObject({ category: 'build', source: 'inherited' });
    expect(resolve('option 9', 'build', messages).category).toBe('build');
    expect(resolve('yes do #1 and #2', 'build', messages).category).toBe('build');
  });

  test('a completed action is not a new proposal', () => {
    expect(resolve('continue', 'fix', [{ role: 'assistant', text: 'I rewrote the whole file and wrote an audit report. The bug still needs fixing.' }]).category).toBe('fix');
  });

  test('quoted suggestions and unselected alternatives are not accepted proposals', () => {
    for (const text of [
      'A pasted comment says:\n> I can rewrite the whole file.\nThe bug remains.',
      'Example:\n```text\nI can rewrite the whole file.\n```\nThe bug remains.',
      'I can rewrite the whole file or write a report. Which do you want?',
    ]) expect(resolve('yes', 'fix', [{ role: 'assistant', text }])).toMatchObject({ category: 'fix', source: 'inherited' });
  });

  test('an old path mentioned by a proposal is not filesystem evidence', () => {
    const large = join(dir, 'old.log');
    writeFileSync(large, 'x'.repeat(300_000));
    expect(resolve('yes', 'rewrite', [{ role: 'assistant', text: `I can inspect \`${large}\`.` }])).toMatchObject({ category: 'rewrite', source: 'inherited' });
  });

  test.each(['thanks', 'hello', 'cancel that', 'stop', 'never mind', 'no, do not do that', 'do not rewrite the whole file', 'continue but do not rewrite the file', 'unrelated task: check this out'])('%s does not inherit a setting-changing category', (prompt) => {
    expect(resolve(prompt, 'rewrite').category).toBe('unknown');
  });

  test('a missing or stale category is not inherited', () => {
    expect(resolve('yes', 'typo').category).toBe('unknown');
    expect(resolveTaskPrompt('yes', { previous: { category: 'rewrite', gen: 1 }, now: 7 * 86400000 }).category).toBe('unknown');
  });

  test('a cancelled task cannot be revived by older conversation', () => {
    expect(resolveTaskPrompt('continue', { previous: { category: 'unknown', gen: 1000 }, now: 2000,
      messages: [{ role: 'user', text: 'Rewrite the whole file' }],
    }).category).toBe('unknown');
    expect(resolveTaskPrompt('continue', { messages: [{ role: 'user', text: 'Do not rewrite the whole file' }] }).category).toBe('unknown');
  });

  test('a previous user request provides context on a resumed session', () => {
    expect(resolveTaskPrompt('continue', { messages: [
      { role: 'user', text: 'Rewrite the whole file in TypeScript' },
      { role: 'assistant', text: 'The first half is done.' },
    ] }).category).toBe('rewrite');
  });
});

describe('bounded transcript context', () => {
  test('reads conversation text, excluding tools, thinking, meta and the current prompt', () => {
    const path = transcript([
      user('Fix the failing tests'),
      assistant('Would you like me to write a report?'),
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Rewrite the whole file' }, { type: 'tool_use', name: 'Write', input: { content: 'rewrite everything' } }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'Rewrite the entire file' }] } },
      { ...user('Rewrite the entire file'), isMeta: true },
      { ...user('Rewrite the entire file'), isCompactSummary: true },
      user('yes, do that'),
    ]);
    expect(readTaskContext(path, 'yes, do that')).toEqual([
      { role: 'user', text: 'Fix the failing tests' },
      { role: 'assistant', text: 'Would you like me to write a report?' },
    ]);
  });

  test('understands Codex rollout messages but excludes environment instructions and reasoning', () => {
    const message = (role, text, channel) => ({ type: 'response_item', payload: { type: 'message', role, channel, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
    const path = transcript([
      message('user', '# AGENTS.md instructions\nRewrite the whole file'),
      message('user', 'Fix the failing tests'),
      message('assistant', 'I should rewrite everything', 'analysis'),
      message('assistant', 'I can write a report about the fix.', 'final'),
      message('user', 'yes'),
    ]);
    expect(readTaskContext(path, 'yes')).toEqual([
      { role: 'user', text: 'Fix the failing tests' },
      { role: 'assistant', text: 'I can write a report about the fix.' },
    ]);
  });

  test('a bounded tail skips a partial record and tolerates an interrupted append', () => {
    const path = transcript([assistant('rewrite '.repeat(TASK_CONTEXT_BYTES)), user('Fix failing tests'), assistant('I can write a report.')]);
    writeFileSync(path, '{"type":', { flag: 'a' });
    expect(readTaskContext(path, 'yes')).toEqual([
      { role: 'user', text: 'Fix failing tests' },
      { role: 'assistant', text: 'I can write a report.' },
    ]);
    expect(readTaskContext(join(dir, 'missing'), 'yes')).toEqual([]);
    expect(readTaskContext(dir, 'yes')).toEqual([]);
  });

  test('a stale transcript without timestamps cannot restore an old proposal', () => {
    const path = transcript([assistant('I can rewrite the whole file.')]);
    const old = new Date(Date.now() - 2 * 86400000);
    utimesSync(path, old, old);
    expect(readTaskContext(path, 'yes')).toEqual([]);
  });

  test('a long assistant response retains its proposed next step at the end', () => {
    const path = transcript([
      user('Fix the failing tests'),
      assistant(`${'The checks passed. '.repeat(400)}\nI’ll write a report about the fix.`),
      user('yes'),
    ]);
    expect(resolveTaskPrompt('yes', { transcriptPath: path }).category).toBe('survey');
  });

  test('the shipped prompt hook uses its transcript and never stores raw conversation', () => {
    const path = transcript([user('Fix the failing tests'), assistant('Would you like me to write a report containing PRIVATE-MARKER?'), user('yes')]);
    const stateDir = join(dir, 'shipped-state');
    const hook = fileURLToPath(new URL('../../src/plugin/hooks/user-prompt-submit.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ session_id: 'context-shipped', transcript_path: path, cwd: dir, prompt: 'yes' }),
      encoding: 'utf8', timeout: 30000,
      env: { ...process.env, TOKEN_OPTIMIZER_STATE_DIR: stateDir, TOKEN_OPTIMIZER_HOME: join(dir, 'home'), TOKEN_OPTIMIZER_MODE: 'assist', TOKEN_OPTIMIZER_OUTPUT_DISCIPLINE: '', TOKEN_OPTIMIZER_RUNTIME_SWITCH: '0' },
    });
    expect(result.status).toBe(0);
    const state = readdirSync(stateDir).filter((name) => name.endsWith('.json')).map((name) => readFileSync(join(stateDir, name), 'utf8')).find((text) => JSON.parse(text).taskClass);
    expect(JSON.parse(state).taskClass).toMatchObject({ category: 'survey', source: 'context' });
    expect(state).not.toContain('PRIVATE-MARKER');
    const ledger = readFileSync(join(dir, 'home', 'task-classes.jsonl'), 'utf8');
    expect(ledger).not.toContain('PRIVATE-MARKER');
    expect(ledger).toContain('context:accepted-proposal');
    expect(result.stdout).not.toContain('Keep output lean');
  });

  test('a follow-up starts a new correction window and old tool evidence cannot replace it', () => {
    const sessionId = 'context-state';
    const first = promptSubmitted({ sessionId, prompt: 'Rewrite the whole file in TypeScript', cwd: dir, env: {}, now: 1000 });
    expect(first.category).toBe('rewrite');
    const stale = loadState(sessionId);
    promptSubmitted({ sessionId, prompt: 'continue', cwd: dir, env: {}, now: 2000 });
    toolCallObserved(stale, { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: 'FAIL' }, { cwd: dir });
    saveState(sessionId, stale);
    expect(loadState(sessionId).taskClass).toMatchObject({ category: 'rewrite', source: 'inherited', calls: 0, gen: 2000 });
  });

  test('a subagent cannot accept a proposal from its parent transcript', () => {
    const path = transcript([user('Fix the failing tests'), assistant('I can rewrite the whole file.')]);
    const stateDir = join(dir, 'subagent-state');
    const hook = fileURLToPath(new URL('../../src/plugin/hooks/user-prompt-submit.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ session_id: 'context-child', agent_id: 'worker', transcript_path: path, cwd: dir, prompt: 'yes' }),
      encoding: 'utf8', timeout: 30000,
      env: { ...process.env, TOKEN_OPTIMIZER_STATE_DIR: stateDir, TOKEN_OPTIMIZER_HOME: join(dir, 'child-home'), TOKEN_OPTIMIZER_MODE: 'assist' },
    });
    expect(result.status).toBe(0);
    const states = readdirSync(stateDir).filter((name) => name.endsWith('.json')).map((name) => JSON.parse(readFileSync(join(stateDir, name), 'utf8')));
    expect(states.find((state) => state.taskClass).taskClass.category).toBe('unknown');
  });

  test('several follow-ups in the same millisecond preserve the task', () => {
    const sessionId = 'context-same-time';
    for (const prompt of ['Rewrite the whole file', 'continue', 'continue', 'yes'])
      expect(promptSubmitted({ sessionId, prompt, env: {}, now: 3000 }).category).toBe('rewrite');
    expect(loadState(sessionId).taskClass.gen).toBe(3003);
  });

  test('fix to survey to fix releases and reactivates instructions already delivered', () => {
    const sessionId = 'context-instructions';
    const submit = (prompt, now) => promptSubmitted({ sessionId, prompt, cwd: dir, env: {}, now });
    expect(submit('Fix the failing tests', 1000).context).toContain('Keep output lean');
    expect(submit('now write a report about the fix', 2000).context).toContain('inactive');
    expect(submit('continue', 3000).context).toBe('');
    expect(submit('Fix the failing tests', 4000).context).toContain('Keep output lean');
    expect(submit('continue', 5000).context).toBe('');
    expect(loadState(sessionId).disciplineReleasedAt).toBe(2000);
  });
});
