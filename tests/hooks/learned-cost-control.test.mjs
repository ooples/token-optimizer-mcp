/**
 * Learned cost control: tool pruning, the loop guard, the injection holdout and
 * billing-mode detection.
 *
 * Each test pins a PROPERTY the design depends on, not a snapshot: that a deny
 * list never removes a rule the user wrote, that a wrong prune is given back
 * without a command, that a turn failing in different ways is left alone, that
 * one session's hook processes all agree on its holdout arm, and that billing
 * detection never opens a credential file.
 */

import { afterAll, describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { billingMode } from '../../hooks-core/billing.mjs';
import {
  analyze,
  applyHoldout,
  armFor,
  decide,
  holdoutSettings,
  MIN_SERVED,
  MIN_WITHHELD,
  OUTCOMES_FILE,
  POLICY_FILE,
  shouldServe,
  WITHHOLDABLE,
} from '../../hooks-core/injection-holdout.mjs';
import {
  classifyTurn,
  currentTurn,
  envelopeSummary,
  failureSignature,
  loopguardSettings,
  onToolFailure,
  recordTurnEnd,
  turnStats,
} from '../../hooks-core/loopguard.mjs';
import {
  candidates,
  costUnitsOf,
  foldSession,
  learnedLocation,
  loadStore,
  promptAsksFor,
  restoreForPrompt,
  restoreTools,
  runFold,
  sessionUsage,
  takeNotice,
  toolpruneSettings,
  writeDenyList,
} from '../../hooks-core/toolprune.mjs';

const ROOT = process.cwd();
const work = mkdtempSync(join(tmpdir(), 'learned-cost-control-'));
afterAll(() => rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));

let counter = 0;
const fresh = (name) => {
  const dir = join(work, `${name}-${(counter += 1)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

// ---------------------------------------------------------------------------
// Transcript fixtures, in Claude Code's JSONL shape.

let uuid = 0;
const at = (minute) => new Date(Date.UTC(2026, 10, 1, 10, minute)).toISOString();
const prompt = (text, minute = 0) => ({
  type: 'user',
  uuid: `u${(uuid += 1)}`,
  timestamp: at(minute),
  message: { role: 'user', content: text },
});
const call = (id, name, input = {}, minute = 0, usage = null, messageId = null) => ({
  type: 'assistant',
  uuid: `a${(uuid += 1)}`,
  timestamp: at(minute),
  message: {
    role: 'assistant',
    id: messageId || `m-${id}`,
    content: [{ type: 'tool_use', id, name, input }],
    ...(usage ? { usage } : {}),
  },
});
const result = (id, text, isError = false, minute = 0) => ({
  type: 'user',
  uuid: `r${(uuid += 1)}`,
  timestamp: at(minute),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] },
});
const writeTranscript = (path, rows) => writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');

/** A session of `prompts` prompts that calls each of `tools` once. */
function session(sessionDir, sessionId, prompts, tools, { minute = 0 } = {}) {
  const rows = [];
  for (let index = 0; index < prompts; index += 1) rows.push(prompt(`task ${index}`, minute));
  tools.forEach((name, index) => {
    rows.push(call(`${sessionId}-${index}`, name, {}, minute));
    rows.push(result(`${sessionId}-${index}`, 'ok', false, minute));
  });
  const path = join(sessionDir, `${sessionId}.jsonl`);
  writeTranscript(path, rows);
  return path;
}

const idle = (path) => {
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  utimesSync(path, old, old);
};

// ---------------------------------------------------------------------------

describe('billing mode', () => {
  test('a Claude subscription login is detected from the non-secret billingType field', () => {
    const home = fresh('home');
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { billingType: 'stripe_subscription' } }));
    expect(billingMode({ client: 'claude-code', env: {}, home }).mode).toBe('subscription');
  });

  test('an API key with no login is an API user; cloud providers are API users', () => {
    const home = fresh('home');
    expect(billingMode({ client: 'claude-code', env: { ANTHROPIC_API_KEY: 'x' }, home }).mode).toBe('api');
    expect(billingMode({ client: 'claude-code', env: { CLAUDE_CODE_USE_BEDROCK: '1' }, home }).mode).toBe('api');
    expect(billingMode({ client: 'claude-code', env: {}, home }).mode).toBe('unknown');
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { billingType: 'enterprise_invoice' } }));
    expect(billingMode({ client: 'claude-code', env: {}, home }).mode).toBe('unknown');
  });

  test('the explicit override always wins', () => {
    const home = fresh('home');
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { billingType: 'stripe_subscription' } }));
    expect(billingMode({ client: 'claude-code', env: { TOKEN_OPTIMIZER_BILLING: 'api' }, home }).mode).toBe('api');
    expect(billingMode({ client: 'codex', env: { TOKEN_OPTIMIZER_BILLING: 'subscription', OPENAI_API_KEY: 'x' }, home }).mode).toBe('subscription');
  });

  test('credential files are never opened', () => {
    const source = readFileSync(join(ROOT, 'hooks-core', 'billing.mjs'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    // The one file it does read is the non-secret account metadata.
    expect(code.match(/'[^']*\.json'/g)).toEqual(["'.claude.json'"]);
    expect(code).not.toMatch(/credentials\.json|auth\.json/);
  });
});

// ---------------------------------------------------------------------------

describe('tool pruning', () => {
  test('a tool unused over the evidence threshold becomes a candidate; a used one does not', () => {
    let store = loadStore(fresh('store'));
    store.catalog.tools = ['Read', 'CronList', 'NotebookEdit'];
    for (let index = 0; index < 2; index += 1) {
      store = foldSession(store, { sessionId: `s${index}`, prompts: 6, used: ['Read', 'NotebookEdit'], lastAt: index + 1 });
    }
    const names = candidates(store, toolpruneSettings({})).map((item) => item.name);
    expect(names).toEqual(['CronList']);
  });

  test('one long session alone never decides', () => {
    let store = loadStore(fresh('store'));
    store.catalog.tools = ['CronList'];
    store = foldSession(store, { sessionId: 's0', prompts: 500, used: [], lastAt: 1 });
    expect(candidates(store, toolpruneSettings({}))).toEqual([]);
  });

  test('the keep list, this package’s own tools and user-allowed tools are never pruned', () => {
    let store = loadStore(fresh('store'));
    // WebFetch and WebSearch are kept: a pruned web tool is never requested, so
    // the automatic restore (which fires on a failed call) could never fire.
    store.catalog.tools = ['AskUserQuestion', 'mcp__plugin_token-optimizer_token-optimizer__smart_read', 'WebFetch', 'WebSearch', 'NotebookEdit', 'Cron'];
    for (let index = 0; index < 6; index += 1) store = foldSession(store, { sessionId: `s${index}`, prompts: 5, used: [], lastAt: index + 1 });
    const names = candidates(store, toolpruneSettings({}), new Set(['NotebookEdit'])).map((item) => item.name);
    expect(names).toEqual(['Cron']);
  });

  test('the deny-list writer never removes or adopts a rule the user wrote', () => {
    const root = fresh('root');
    mkdirSync(join(root, '.claude'));
    writeFileSync(
      join(root, '.claude', 'settings.local.json'),
      JSON.stringify({ permissions: { deny: ['CronList', 'Bash(rm:*)'], allow: ['Read'] }, other: 1 })
    );
    const first = writeDenyList(root, [], ['CronList', 'Cron']);
    expect(first.ok).toBe(true);
    expect(first.owned).toEqual(['Cron']);
    const removed = writeDenyList(root, first.owned, []);
    expect(removed.ok).toBe(true);
    const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.local.json'), 'utf8'));
    expect(settings.permissions.deny).toEqual(['CronList', 'Bash(rm:*)']);
    expect(settings.permissions.allow).toEqual(['Read']);
    expect(settings.other).toBe(1);
  });

  test('an invalid or symlinked settings file is never touched', () => {
    const root = fresh('root');
    mkdirSync(join(root, '.claude'));
    writeFileSync(join(root, '.claude', 'settings.local.json'), '{ not json');
    expect(writeDenyList(root, [], ['Cron']).ok).toBe(false);
    expect(readFileSync(join(root, '.claude', 'settings.local.json'), 'utf8')).toBe('{ not json');

    const linked = fresh('root');
    mkdirSync(join(linked, '.claude'));
    const target = join(fresh('elsewhere'), 'settings.json');
    writeFileSync(target, '{}');
    let made = true;
    try {
      symlinkSync(target, join(linked, '.claude', 'settings.local.json'));
    } catch {
      made = false; // No symlink privilege on this Windows runner.
    }
    if (made) {
      expect(writeDenyList(linked, [], ['Cron']).ok).toBe(false);
      expect(readFileSync(target, 'utf8')).toBe('{}');
    }
  });

  test('a new deny list waits until the repository is idle, then is written once', () => {
    const transcripts = fresh('transcripts');
    const root = fresh('root');
    const dir = fresh('state');
    const env = { TOKEN_OPTIMIZER_TOOLPRUNE_QUIET_MINUTES: '60' };
    const paths = [];
    for (let index = 0; index < 5; index += 1) paths.push(session(transcripts, `s${index}`, 3, ['Read', 'Bash']));
    const store = loadStore(dir);
    store.catalog = { tools: ['Read', 'Bash', 'CronList'], probedAt: Date.now(), clientVersion: 'x' };
    writeFileSync(join(dir, 'toolprune.json'), JSON.stringify(store));

    // Sessions written just now: not idle, so the list is held.
    const busy = runFold({ dir, root, transcriptDir: transcripts, currentSession: null, env });
    expect(busy.pending).toEqual(['CronList']);
    expect(busy.applied).toEqual([]);

    for (const path of paths) idle(path);
    const quiet = runFold({ dir, root, transcriptDir: transcripts, currentSession: null, env });
    expect(quiet.applied).toEqual(['CronList']);
    const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.local.json'), 'utf8'));
    expect(settings.permissions.deny).toEqual(['CronList']);
    const notice = takeNotice(dir);
    expect(notice).toMatch(/CronList/);
    expect(takeNotice(dir)).toBeNull();
  });

  test('a fold never writes a new prune while any session, its own included, is live; the waiter does once all are quiet', async () => {
    const { waitAndApply } = await import('../../hooks-core/toolprune.mjs');
    const transcripts = fresh('transcripts');
    const root = fresh('root');
    const dir = fresh('state');
    const paths = [];
    for (let index = 0; index < 5; index += 1) paths.push(session(transcripts, `s${index}`, 3, ['Read']));
    for (const path of paths) idle(path);
    const live = session(transcripts, 'live', 1, ['Read']);
    const store = loadStore(dir);
    store.catalog = { tools: ['Read', 'CronList'], probedAt: Date.now(), clientVersion: 'x' };
    writeFileSync(join(dir, 'toolprune.json'), JSON.stringify(store));
    // Launched from the live session: it is excluded from the evidence but not from the idle check.
    const held = runFold({ dir, root, transcriptDir: transcripts, currentSession: 'live', env: {} });
    expect(held.pending).toEqual(['CronList']);
    expect(held.applied).toEqual([]);
    let slept = 0;
    const summary = await waitAndApply({
      dir, root, transcriptDir: transcripts, env: {},
      sleep: async () => { slept += 1; idle(live); },
    });
    expect(slept).toBe(1);
    expect(summary.applied).toEqual(['CronList']);
  });

  test('a session that reaches for a pruned tool gives it back, and it is never pruned again', () => {
    const transcripts = fresh('transcripts');
    const root = fresh('root');
    const dir = fresh('state');
    const paths = [];
    for (let index = 0; index < 5; index += 1) paths.push(session(transcripts, `s${index}`, 3, ['Read']));
    const store = loadStore(dir);
    store.catalog = { tools: ['Read', 'CronList'], probedAt: Date.now(), clientVersion: 'x' };
    writeFileSync(join(dir, 'toolprune.json'), JSON.stringify(store));
    for (const path of paths) idle(path);
    expect(runFold({ dir, root, transcriptDir: transcripts, env: {} }).applied).toEqual(['CronList']);

    // The next session's model calls it and is told it does not exist.
    const needy = join(transcripts, 'needy.jsonl');
    writeTranscript(needy, [
      prompt('fetch the docs page'),
      call('n1', 'CronList', { url: 'https://example.com' }),
      result('n1', 'Error: No such tool available: CronList', true),
    ]);
    idle(needy);
    const after = runFold({ dir, root, transcriptDir: transcripts, env: {} });
    expect(after.applied).toEqual([]);
    expect(after.restored).toContain('CronList');
    const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.local.json'), 'utf8'));
    expect(settings.permissions.deny).toEqual([]);
    expect(takeNotice(dir)).toMatch(/restored CronList/);
  });

  test('a person naming a pruned tool in a prompt gives it back', () => {
    const transcripts = fresh('transcripts');
    const usage = (() => {
      const path = join(transcripts, 'x.jsonl');
      writeTranscript(path, [prompt('please use CronList for this')]);
      return sessionUsage(path, { mentionCandidates: ['CronList'] });
    })();
    expect(usage.mentioned).toEqual(['CronList']);
  });

  test('client-written messages are not prompts', () => {
    const transcripts = fresh('transcripts');
    const path = join(transcripts, 'x.jsonl');
    writeTranscript(path, [
      prompt('real question'),
      prompt('<task-notification> <task-id>abc</task-id> done'),
      prompt('<command-name>/status</command-name>'),
      { ...prompt('This session is being continued from a previous conversation...'), isCompactSummary: true },
    ]);
    expect(sessionUsage(path).prompts).toBe(1);
  });

  test('manual restore removes only our entries and is permanent', () => {
    const root = fresh('root');
    const dir = fresh('state');
    const store = loadStore(dir);
    const written = writeDenyList(root, [], ['Cron', 'CronList']);
    store.applied = written.owned;
    writeFileSync(join(dir, 'toolprune.json'), JSON.stringify(store));
    expect(restoreTools({ dir, root, names: ['Cron'] }).restored).toEqual(['Cron']);
    const after = loadStore(dir);
    expect(after.applied).toEqual(['CronList']);
    expect(after.restored).toEqual(['Cron']);
  });

  test('Agent is prunable: five sessions without it make it a candidate', () => {
    let store = loadStore(fresh('state'));
    for (let index = 0; index < 5; index += 1) {
      store = foldSession(store, { sessionId: `s${index}`, prompts: 1, used: ['Bash'], lastAt: index + 1 });
    }
    store.catalog.tools = ['Agent', 'Task', 'Bash', 'Skill'];
    expect(candidates(store, toolpruneSettings({})).map((item) => item.name)).toEqual(['Agent', 'Task']);
  });

  test('a request for agents matches; prose that merely mentions one does not', () => {
    for (const asks of [
      'use agents to review these three files',
      'spawn a sub-agent for the tests',
      'Use 3 agents',
      'launch an agent',
      'have an agent to check the docs',
      'run these as agents in parallel',
      'do this with subagents',
      'call the Agent tool',
    ]) {
      expect([asks, promptAsksFor(asks, ['Agent', 'Bash'])]).toEqual([asks, ['Agent']]);
    }
    for (const prose of [
      'run the tests in parallel',
      'the user agent header is wrong',
      'fix agent.py so it parses',
      'rename the agent module',
      'parallelize the loop',
    ]) {
      expect([prose, promptAsksFor(prose, ['Agent'])]).toEqual([prose, []]);
    }
    // Only APPLIED prunes are ever restored.
    expect(promptAsksFor('use agents', ['CronList'])).toEqual([]);
  });

  test('restoreForPrompt gives Agent back at once, keeps the rest, and never prunes it again', () => {
    const root = fresh('root');
    const dir = fresh('state');
    let store = loadStore(dir);
    for (let index = 0; index < 5; index += 1) {
      store = foldSession(store, { sessionId: `s${index}`, prompts: 1, used: ['Bash'], lastAt: index + 1 });
    }
    store.catalog.tools = ['Agent', 'CronList'];
    store.applied = writeDenyList(root, [], ['Agent', 'CronList']).owned;
    writeFileSync(join(dir, 'toolprune.json'), JSON.stringify(store));
    // Positive control: the evidence alone still wants Agent pruned.
    expect(candidates(store, toolpruneSettings({})).map((item) => item.name)).toEqual(['Agent', 'CronList']);
    expect(restoreForPrompt({ dir, root, prompt: 'rename the agent module' })).toEqual([]);
    expect(restoreForPrompt({ dir, root, prompt: 'use two agents for this' })).toEqual(['Agent']);
    const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.local.json'), 'utf8'));
    expect(settings.permissions.deny).toEqual(['CronList']);
    const after = loadStore(dir);
    expect(after.restored).toContain('Agent');
    expect(after.autoRestored).toContain('Agent');
    expect(candidates(after, toolpruneSettings({})).map((item) => item.name)).toEqual(['CronList']);
  });

  test('usage is counted from the last row per message id', () => {
    const transcripts = fresh('transcripts');
    const path = join(transcripts, 'x.jsonl');
    const partial = { input_tokens: 10, cache_read_input_tokens: 1000, output_tokens: 1 };
    const final = { input_tokens: 10, cache_read_input_tokens: 1000, output_tokens: 100 };
    writeTranscript(path, [prompt('go'), call('c1', 'Read', {}, 0, partial, 'msg-1'), call('c2', 'Read', {}, 0, final, 'msg-1')]);
    expect(sessionUsage(path).costUnits).toBeCloseTo(costUnitsOf(final));
    expect(costUnitsOf(final)).toBeCloseTo(10 + 100 + 500);
  });
});

// ---------------------------------------------------------------------------

describe('loop guard', () => {
  test('signatures mask what varies between attempts at the same mistake', () => {
    const a = failureSignature('Bash', 'Exit code 1\nError: Cannot find module /tmp/a/b.js at line 12');
    const b = failureSignature('Bash', 'Exit code 2\nError: Cannot find module /home/x/c.js at line 99');
    const c = failureSignature('Bash', 'Exit code 1\nTypeError: x is not a function');
    expect(a.key).toBe(b.key);
    expect(a.key).not.toBe(c.key);
  });

  const failingTurn = (count, distinct = false) => {
    const rows = [prompt('fix the build')];
    for (let index = 0; index < count; index += 1) {
      rows.push(call(`f${index}`, 'Edit', { file_path: '/repo/src/a.ts' }));
      rows.push(result(`f${index}`, 'ok'));
      rows.push(call(`b${index}`, 'Bash', { command: 'npm test' }));
      rows.push(result(`b${index}`, distinct ? `Error: failure number ${'abcdefgh'[index]}x${index} kind ${'qrstuvwx'[index]}` : 'Error: expected 3 to equal 4', true));
    }
    return rows;
  };

  test('the same failure four times is certain; three is suspect; different failures are left alone', () => {
    const settings = loopguardSettings({});
    const empty = envelopeSummary({ turns: [] }, settings);
    const dir = fresh('turns');
    const classify = (rows) => {
      const path = join(dir, `t${(counter += 1)}.jsonl`);
      writeTranscript(path, rows);
      return classifyTurn(turnStats(currentTurn(path).calls), empty, settings).level;
    };
    expect(classify(failingTurn(4))).toBe('certain');
    expect(classify(failingTurn(3))).toBe('suspect');
    expect(classify(failingTurn(2))).toBe('none');
    expect(classify(failingTurn(6, true))).toBe('none');
  });

  test('refusals, interrupts and rejections are steering, not failures', async () => {
    const dir = fresh('graph');
    const path = join(dir, 't.jsonl');
    const rows = [prompt('read the files')];
    for (let index = 0; index < 5; index += 1) {
      rows.push(call(`r${index}`, 'Read', { file_path: `/repo/f${index}.ts` }));
      rows.push(result(`r${index}`, `Read of /repo/f${index}.ts refused: use smart_read. (Not what you wanted? TOKEN_OPTIMIZER_MODE=assist stops refusals and keeps everything else on.)`, true));
    }
    writeTranscript(path, rows);
    const stats = turnStats(currentTurn(path).calls);
    expect(stats.failures).toBe(0);
    expect(classifyTurn(stats, envelopeSummary({ turns: [] }, loopguardSettings({})), loopguardSettings({})).level).toBe('none');
    const payload = { tool_name: 'Read', error: 'refused (TOKEN_OPTIMIZER_MODE=assist ...)' };
    expect(await onToolFailure({ dir, sessionId: 'steer', transcriptPath: path, payload, env: {} })).toBeNull();
    expect(await onToolFailure({ dir, sessionId: 'steer', transcriptPath: path, payload: { tool_name: 'Bash', error: 'x', is_interrupt: true }, env: {} })).toBeNull();
  });

  test('a turn starts at the person’s last prompt', () => {
    const dir = fresh('turns');
    const path = join(dir, 't.jsonl');
    writeTranscript(path, [...failingTurn(4), prompt('new task'), call('z', 'Read', {}), result('z', 'ok')]);
    const turn = currentTurn(path);
    expect(turn.calls.map((item) => item.name)).toEqual(['Read']);
  });

  test('redirects once with what the turn keeps hitting, then tells the person, then stays quiet', async () => {
    const stateDir = fresh('loop-state');
    const previous = process.env.TOKEN_OPTIMIZER_STATE_DIR;
    process.env.TOKEN_OPTIMIZER_STATE_DIR = stateDir;
    try {
      const dir = fresh('graph');
      const path = join(dir, 't.jsonl');
      writeTranscript(path, failingTurn(3));
      const payload = { tool_name: 'Bash', tool_use_id: 'new', error: 'Exit code 1\nError: expected 3 to equal 4', tool_input: { command: 'npm test' } };
      const first = await onToolFailure({ dir, sessionId: 'loop-1', transcriptPath: path, payload, env: {} });
      expect(first.additionalContext).toMatch(/Loop guard/);
      expect(first.additionalContext).toMatch(/expected # to equal #/);
      const second = await onToolFailure({ dir, sessionId: 'loop-1', transcriptPath: path, payload, env: {} });
      expect(second.systemMessage).toMatch(/Press Esc/);
      expect(await onToolFailure({ dir, sessionId: 'loop-1', transcriptPath: path, payload, env: {} })).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.TOKEN_OPTIMIZER_STATE_DIR;
      else process.env.TOKEN_OPTIMIZER_STATE_DIR = previous;
    }
  });

  test('subagents and a disabled guard do nothing', async () => {
    const dir = fresh('graph');
    const path = join(dir, 't.jsonl');
    writeTranscript(path, failingTurn(3));
    const payload = { tool_name: 'Bash', error: 'Error: expected 3 to equal 4' };
    expect(await onToolFailure({ dir, sessionId: 's', transcriptPath: path, payload: { ...payload, agent_id: 'a1' }, env: {} })).toBeNull();
    expect(await onToolFailure({ dir, sessionId: 's', transcriptPath: path, payload, env: { TOKEN_OPTIMIZER_LOOPGUARD: 'off' } })).toBeNull();
  });

  test('only a turn that ended well teaches the envelope', () => {
    const dir = fresh('graph');
    const good = join(dir, 'good.jsonl');
    writeTranscript(good, [prompt('task'), call('g1', 'Edit', { file_path: '/a' }), result('g1', 'ok'), call('g2', 'Bash', { command: 'npm test' }), result('g2', 'passed')]);
    expect(recordTurnEnd(dir, good).recorded).toBe(true);
    const bad = join(dir, 'bad.jsonl');
    writeTranscript(bad, [prompt('task'), call('h1', 'Edit', { file_path: '/a' }), result('h1', 'ok'), call('h2', 'Bash', { command: 'npm test' }), result('h2', 'Error: fail', true)]);
    expect(recordTurnEnd(dir, bad).recorded).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('injection holdout', () => {
  const settings = { enabled: true, fraction: 0.1 };

  test('every hook process of one session agrees on its arm; about a tenth are enrolled', () => {
    const arms = [];
    for (let index = 0; index < 4000; index += 1) arms.push(armFor(`session-${index}`, settings));
    expect(armFor('session-7', settings)).toBe(arms[7]);
    const enrolled = arms.filter(Boolean).length / arms.length;
    expect(enrolled).toBeGreaterThan(0.08);
    expect(enrolled).toBeLessThan(0.12);
    for (const cls of WITHHOLDABLE) expect(arms).toContain(cls);
  });

  test('an enrolled session withholds exactly its class; policy context is never withheld', () => {
    let enrolled = null;
    for (let index = 0; !enrolled; index += 1) if (armFor(`s${index}`, settings) === 'graph') enrolled = `s${index}`;
    const dir = fresh('holdout');
    const served = applyHoldout(
      [{ cls: 'policy', text: 'P' }, { cls: 'graph', text: 'G' }, { cls: 'index', text: 'I' }],
      { dir, sessionId: enrolled, settings }
    );
    expect(served.map((part) => part.cls)).toEqual(['policy', 'index']);
  });

  test('off means off: everything is served even for a gated class', () => {
    const dir = fresh('holdout');
    writeFileSync(join(dir, POLICY_FILE), JSON.stringify({ gated: ['graph'] }));
    const off = holdoutSettings({ TOKEN_OPTIMIZER_INJECTION_HOLDOUT: 'off' });
    expect(applyHoldout([{ cls: 'graph', text: 'G' }], { dir, sessionId: 'x', settings: off })).toHaveLength(1);
    expect(holdoutSettings({ TOKEN_OPTIMIZER_EXPERIMENT_ARM: 'baseline' }).enabled).toBe(false);
  });

  test('a class sessions are measurably cheaper without is gated, and the gate reverses on evidence', () => {
    const dir = fresh('holdout');
    const sessions = {};
    let index = 0;
    const add = (arm, cost) => {
      sessions[`x${(index += 1)}`] = { arm, costPerPrompt: cost, prompts: 5, endedAt: index, g: 1 };
    };
    for (let k = 0; k < MIN_SERVED + 10; k += 1) add('none', 100 + (k % 7));
    for (let k = 0; k < MIN_WITHHELD + 4; k += 1) add('graph', 70 + (k % 5));
    writeFileSync(join(dir, OUTCOMES_FILE), JSON.stringify({ sessions }));
    const row = analyze(dir).find((item) => item.cls === 'graph');
    expect(row.verdict).toBe('costs-more-than-it-saves');
    expect(decide(dir).gated).toEqual(['graph']);
    expect(shouldServe('graph', { sessionId: 'not-enrolled-anything', dir, settings: { enabled: true, fraction: 0 } })).toBe(false);

    // Reverse arm: sessions that SERVED the gated class turn out cheaper.
    const reversed = {};
    index = 0;
    const put = (arm, cost) => {
      reversed[`y${(index += 1)}`] = { arm, costPerPrompt: cost, prompts: 5, endedAt: index, g: 1 };
    };
    for (let k = 0; k < MIN_SERVED + 10; k += 1) put('none', 100 + (k % 7));
    for (let k = 0; k < MIN_WITHHELD + 4; k += 1) put('graph', 60 + (k % 5));
    writeFileSync(join(dir, OUTCOMES_FILE), JSON.stringify({ sessions: reversed }));
    expect(analyze(dir).find((item) => item.cls === 'graph').verdict).toBe('pays-for-itself');
    // Same milestone as the gating look: no second look, so no flip-flop.
    expect(decide(dir).gated).toEqual(['graph']);
    // At the next milestone the reversed evidence is acted on.
    for (let k = 0; k < 4; k += 1) put('graph', 60 + (k % 5));
    writeFileSync(join(dir, OUTCOMES_FILE), JSON.stringify({ sessions: reversed }));
    expect(decide(dir).gated).toEqual([]);
  });

  test('Holm keeps the family-wise error at alpha across classes', async () => {
    const { holm } = await import('../../hooks-core/injection-holdout.mjs');
    expect(holm([0.01, 0.04, null, 0.03])).toEqual([0.03, 0.06, null, 0.06]);
  });

  test('too few sessions is collecting, never a verdict', () => {
    const dir = fresh('holdout');
    writeFileSync(join(dir, OUTCOMES_FILE), JSON.stringify({ sessions: { a: { arm: 'graph', costPerPrompt: 1, prompts: 1, endedAt: 1, g: 1 } } }));
    expect(analyze(dir).every((row) => row.verdict === 'collecting')).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('wiring', () => {
  test('a failed call reaches the guard through the packaged Claude Code entry', () => {
    const dir = fresh('e2e');
    const stateDir = fresh('e2e-state');
    const path = join(dir, 't.jsonl');
    const rows = [prompt('fix it')];
    for (let index = 0; index < 4; index += 1) {
      rows.push(call(`b${index}`, 'Bash', { command: 'npm test' }));
      rows.push(result(`b${index}`, 'Error: expected 3 to equal 4', true));
    }
    writeTranscript(path, rows);
    const run = spawnSync(process.execPath, [join(ROOT, 'plugin', 'hooks', 'post-tool-failure.mjs')], {
      input: JSON.stringify({
        hook_event_name: 'PostToolUseFailure',
        session_id: 'e2e-session',
        transcript_path: path,
        cwd: dir,
        tool_name: 'Bash',
        tool_use_id: 'b3',
        tool_input: { command: 'npm test' },
        error: 'Error: expected 3 to equal 4',
      }),
      env: { ...process.env, TOKEN_OPTIMIZER_STATE_DIR: stateDir, TOKEN_OPTIMIZER_WIKI_DIR: join(dir, 'wiki') },
      encoding: 'utf8',
    });
    const output = JSON.parse(run.stdout);
    expect(output.hookSpecificOutput.hookEventName).toBe('PostToolUseFailure');
    expect(output.hookSpecificOutput.additionalContext).toMatch(/Loop guard/);
  });

  test('a turn that asks for a pruned Agent gets it back and continues, once', () => {
    const cwd = fresh('live-restore');
    const wiki = join(cwd, 'wiki');
    const env = { ...process.env, TOKEN_OPTIMIZER_STATE_DIR: fresh('live-state'), TOKEN_OPTIMIZER_WIKI_DIR: wiki };
    const saved = process.env.TOKEN_OPTIMIZER_WIKI_DIR;
    process.env.TOKEN_OPTIMIZER_WIKI_DIR = wiki;
    const learned = learnedLocation(cwd);
    if (saved === undefined) delete process.env.TOKEN_OPTIMIZER_WIKI_DIR;
    else process.env.TOKEN_OPTIMIZER_WIKI_DIR = saved;
    mkdirSync(learned.dir, { recursive: true });
    const store = loadStore(learned.dir);
    store.applied = writeDenyList(learned.root, [], ['Agent']).owned;
    writeFileSync(join(learned.dir, 'toolprune.json'), JSON.stringify(store));
    const path = join(cwd, 't.jsonl');
    writeTranscript(path, [prompt('use two agents to review src and tests')]);
    const stop = (extra = {}) =>
      JSON.parse(
        spawnSync(process.execPath, [join(ROOT, 'plugin', 'hooks', 'stop.mjs')], {
          input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'live', transcript_path: path, cwd, ...extra }),
          env,
          encoding: 'utf8',
        }).stdout
      );
    // A continuation never restores or blocks: it cannot loop.
    expect(stop({ stop_hook_active: true }).decision).toBeUndefined();
    expect(loadStore(learned.dir).applied).toEqual(['Agent']);
    const output = stop();
    expect(output.decision).toBe('block');
    expect(output.reason).toMatch(/Agent tool .* restored/);
    const settings = JSON.parse(readFileSync(join(learned.root, '.claude', 'settings.local.json'), 'utf8'));
    expect(settings.permissions.deny).toEqual([]);
    // Restored for good: the same prompt at the next Stop changes nothing.
    expect(stop().reason ?? '').not.toMatch(/restored/);
  });

  test('a process this package started itself is never optimized', () => {
    const run = spawnSync(process.execPath, [join(ROOT, 'plugin', 'hooks', 'stop.mjs')], {
      input: JSON.stringify({ session_id: 'side', cwd: work }),
      env: { ...process.env, TOKEN_OPTIMIZER_SIDECALL: '1' },
      encoding: 'utf8',
    });
    expect(run.stdout).toBe('{}');
  });
});

// ---------------------------------------------------------------------------

describe('weekly-aware subscription pacing', () => {
  const HOUR = 3600 * 1000;
  const DAY = 24 * HOUR;
  const subscriptionHome = () => {
    const home = fresh('home');
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { billingType: 'stripe_subscription' } }));
    return home;
  };
  const limitsAt = (now, fivePct, weekPct, daysLeft) => ({
    rate_limits: {
      five_hour: { used_percentage: fivePct, resets_at: Math.floor((now + 2 * HOUR) / 1000) },
      seven_day: { used_percentage: weekPct, resets_at: Math.floor((now + daysLeft * DAY) / 1000) },
    },
  });

  test('room in the window and the week on pace allows pacing; ahead of pace does not', async () => {
    const { quotaHeadroom, normalizeRateLimits } = await import('../../hooks-core/quota-policy.mjs');
    const now = Date.UTC(2026, 10, 7, 12);
    // 4 days left of 7: 42.9% of the week elapsed.
    expect(quotaHeadroom(normalizeRateLimits(limitsAt(now, 30, 40, 4).rate_limits), { now }).ok).toBe(true);
    expect(quotaHeadroom(normalizeRateLimits(limitsAt(now, 30, 50, 4).rate_limits), { now }).ok).toBe(false);
    expect(quotaHeadroom(normalizeRateLimits(limitsAt(now, 95, 10, 4).rate_limits), { now }).ok).toBe(false);
    expect(quotaHeadroom(null, { now }).ok).toBe(false);
  });

  test('the pacer continues an unverified session only with fresh data, on a subscription, under policy pace', async () => {
    const { recordRateLimits } = await import('../../hooks-core/quota-policy.mjs');
    const { nextPacedContinuation } = await import('../../hooks-core/quota-pacer.mjs');
    const now = Date.now();
    const stateDir = fresh('pace-state');
    const home = subscriptionHome();
    {
      const env = { TOKEN_OPTIMIZER_STATE_DIR: stateDir };
      const unverified = () => ({ edits: 2, verifiedEdits: 0, editedFiles: ['a.ts'] });

      // No data yet: hold.
      expect(nextPacedContinuation({ cwd: work, home, state: unverified(), now, env })).toBeNull();

      recordRateLimits(limitsAt(now, 20, 10, 4), { now, env });
      const continued = nextPacedContinuation({ cwd: work, home, state: unverified(), now, env });
      expect(continued).toMatch(/quota: 5h 20%/);

      // Ahead of weekly pace: hold even with the 5-hour window nearly empty.
      recordRateLimits(limitsAt(now, 5, 80, 4), { now, env });
      expect(nextPacedContinuation({ cwd: work, home, state: unverified(), now, env })).toBeNull();

      // Stale data: hold.
      recordRateLimits(limitsAt(now, 20, 10, 4), { now: now - 60 * 60 * 1000, env });
      expect(nextPacedContinuation({ cwd: work, home, state: unverified(), now, env })).toBeNull();

      // Policy suggest, or an API user: never.
      recordRateLimits(limitsAt(now, 20, 10, 4), { now, env });
      expect(nextPacedContinuation({ cwd: work, home, state: unverified(), now, env: { ...env, TOKEN_OPTIMIZER_SUBSCRIPTION_POLICY: 'suggest' } })).toBeNull();
      expect(nextPacedContinuation({ cwd: work, home, state: unverified(), now, env: { ...env, TOKEN_OPTIMIZER_BILLING: 'api' } })).toBeNull();
    }
  });

  test('the status-line tap wraps an existing status line and uninstall puts it back exactly', async () => {
    const { installStatusline, uninstallStatusline } = await import('../../scripts/learned.mjs');
    const home = fresh('home');
    mkdirSync(join(home, '.claude'));
    const original = { statusLine: { type: 'command', command: 'bash -c "echo \'my line\' && date"', padding: 1 }, theme: 'dark' };
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(original));
    expect(installStatusline({ home, tap: '/x/statusline-tap.mjs' }).wrapped).toBe(original.statusLine.command);
    const installed = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
    expect(installed.statusLine.command).toMatch(/statusline-tap\.mjs" --wrap-b64 /);
    expect(installed.theme).toBe('dark');
    expect(installStatusline({ home, tap: '/x/statusline-tap.mjs' }).already).toBe(true);
    expect(uninstallStatusline({ home }).restored).toBe(true);
    expect(JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'))).toEqual(original);
  });

  test('the tap records usage and passes the wrapped command’s output through unchanged', () => {
    const stateDir = fresh('tap-state');
    const wrapped = Buffer.from(`"${process.execPath}" -e "process.stdout.write('WRAPPED')"`).toString('base64');
    const run = spawnSync(process.execPath, [join(ROOT, 'scripts', 'statusline-tap.mjs'), '--wrap-b64', wrapped], {
      input: JSON.stringify(limitsAt(Date.now(), 12, 30, 5)),
      env: { ...process.env, TOKEN_OPTIMIZER_STATE_DIR: stateDir },
      encoding: 'utf8',
    });
    expect(run.stdout).toBe('WRAPPED');
    const recorded = JSON.parse(readFileSync(join(stateDir, 'rate-limits.json'), 'utf8'));
    expect(recorded.fiveHour.used).toBe(12);
    expect(recorded.sevenDay.used).toBe(30);
  });
});
