import { afterAll, beforeAll, expect, test } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadState, saveState, stateScope } from '../../src/hooks-core/policy.mjs';

const work = mkdtempSync(join(tmpdir(), 'agy-review-'));
const prior = process.env.TOKEN_OPTIMIZER_STATE_DIR;
const raw = { conversationId: 'scoped', transcriptPath: join(work, 'agent.jsonl'), agent_id: 'agent-a', workspacePaths: [work] };
const scope = stateScope(raw, raw.transcriptPath);
beforeAll(() => { process.env.TOKEN_OPTIMIZER_STATE_DIR = join(work, 'state'); });
afterAll(() => {
  if (prior === undefined) delete process.env.TOKEN_OPTIMIZER_STATE_DIR;
  else process.env.TOKEN_OPTIMIZER_STATE_DIR = prior;
  rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function hook(event, payload = raw, entry = false) {
  const module = pathToFileURL(join(process.cwd(), 'src/hooks-core/adapter.mjs')).href;
  const args = entry ? [join(process.cwd(), 'src/integrations/antigravity/pre-invocation.mjs')] : ['--input-type=module', '-e', `import {run} from ${JSON.stringify(module)}; await run('agy',${JSON.stringify(event)});`];
  const child = spawnSync(process.execPath, args, {
    input: JSON.stringify(payload), encoding: 'utf8', windowsHide: true,
    env: { ...process.env, TOKEN_OPTIMIZER_MODE: 'assist', TOKEN_OPTIMIZER_HOLDOUT: '0', TOKEN_OPTIMIZER_HOME: join(work, 'home'), TOKEN_OPTIMIZER_WIKI_DIR: join(work, 'wiki') },
  });
  expect({ status: child.status, stderr: child.stderr }).toEqual({ status: 0, stderr: '' });
  return child.stdout.trim() ? JSON.parse(child.stdout) : {};
}

test('the packaged PreInvocation entry drains only the matching agent scope, once', () => {
  const state = loadState('scoped', scope);
  state.pendingHarvest = 'deliver scoped context';
  saveState('scoped', state, scope);
  const other = loadState('scoped');
  other.pendingHarvest = 'leave another scope alone';
  saveState('scoped', other);
  expect(hook('pre-invocation', raw, true)).toEqual({ injectSteps: [{ ephemeralMessage: 'deliver scoped context' }] });
  expect(loadState('scoped', scope).pendingHarvest).toBeNull();
  expect(loadState('scoped').pendingHarvest).toBe('leave another scope alone');
  expect(hook('pre-invocation', raw, true)).toEqual({});
});

test('SessionStart drains the same transcript-scoped state as tool hooks', () => {
  const state = loadState('scoped', scope);
  state.pendingHarvest = 'session-start scoped delivery';
  saveState('scoped', state, scope);
  expect(JSON.stringify(hook('session-start'))).toContain('session-start scoped delivery');
  expect(loadState('scoped', scope).pendingHarvest).toBeNull();
});

test('a structural outline request retains its source file', () => {
  const file = join(work, 'large.py');
  writeFileSync(file, Array.from({ length: 300 }, (_, i) => `def rule_${i}(amount, rate):\n    """Pricing rule."""\n    if amount < 0:\n        raise ValueError("negative amount")\n    return round(amount * rate)\n`).join('\n'));
  const response = hook('pre-tool', { ...raw, toolCall: { name: 'view_file_outline', args: { AbsolutePath: file } } });
  expect(response.decision).toBe('allow');
  expect(response.overwrite).toBeUndefined();
});

test('structural views leave full-read bookkeeping untouched', async () => {
  const { normalizePayload, remember } = await import('../../src/hooks-core/decide.mjs');
  const file = join(work, 'bookkeeping.py');
  const state = { seen: {} };
  for (const name of ['view_file_outline', 'view_code_item']) {
    const payload = normalizePayload({ tool_name: name, tool_input: { AbsolutePath: file }, cwd: work });
    remember(payload, state);
    expect(state.seen[payload.tool_input.file_path]).toBeUndefined();
  }
  const payload = normalizePayload({ tool_name: 'view_file', tool_input: { AbsolutePath: file }, cwd: work });
  remember(payload, state);
  expect(state.seen[payload.tool_input.file_path]).toBe(true);
});
