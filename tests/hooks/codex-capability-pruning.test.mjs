/**
 * Codex capability pruning (src/hooks-core/codexprune.mjs).
 *
 * Each test pins a property the design depends on: that a capability is
 * switched off only on evidence, that the person asking for it gives it back,
 * that the user's own config text survives a write and a restore byte for
 * byte, that a config Codex would refuse to parse is never produced, and that
 * the global ~/.codex/config.toml is never written as if it were a project's.
 */

import { afterAll, describe, expect, test } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  belongsTo,
  capabilityOfCall,
  codexSessionUsage,
  configPath,
  isTrusted,
  parseConfig,
  restoreCodex,
  runCodexFold,
  writeCodexConfig,
} from '../../src/hooks-core/codexprune.mjs';

const work = mkdtempSync(join(tmpdir(), 'codex-capability-pruning-'));
afterAll(() => rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));

let counter = 0;
const fresh = (name) => {
  const dir = join(work, `${name}-${(counter += 1)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** A repository, a Codex home that trusts it (unless told not to), and a state dir. */
function setup({ trusted = true } = {}) {
  const root = fresh('repo');
  mkdirSync(join(root, '.git', 'info'), { recursive: true });
  const home = fresh('codex-home');
  const key = root.replace(/'/g, '');
  writeFileSync(
    join(home, 'config.toml'),
    `model = "x"\n\n[projects.'${process.platform === 'win32' ? key.toLowerCase() : key}']\ntrust_level = "${trusted ? 'trusted' : 'untrusted'}"\n`
  );
  mkdirSync(join(home, 'sessions', '2026', '11', '07'), { recursive: true });
  return { root, home, dir: fresh('state'), sessions: join(home, 'sessions') };
}

const IMAGE = { type: 'ImageView', path: 'file:///shot.png' };

const at = (minutes) => new Date(Date.UTC(2026, 10, 7, 12, minutes)).toISOString();

function rollout(sessions, id, cwd, { prompts = 6, calls = [], items = [], said = 'fix the failing test' } = {}) {
  const lines = [{ timestamp: at(0), type: 'session_meta', payload: { id, cwd, cli_version: '0.167.0' } }];
  for (let index = 0; index < prompts; index += 1) {
    lines.push({
      timestamp: at(index + 1),
      type: 'event_msg',
      payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: said }] } },
    });
  }
  for (const call of calls) lines.push({ timestamp: at(30), type: 'response_item', payload: { type: 'function_call', ...call } });
  for (const item of items) lines.push({ timestamp: at(31), type: 'event_msg', payload: { type: 'item_completed', item } });
  const path = join(sessions, '2026', '11', '07', `rollout-${id}.jsonl`);
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  return path;
}

const fold = (ctx, extra = {}) =>
  runCodexFold({ dir: ctx.dir, root: ctx.root, sessionsDir: ctx.sessions, home: ctx.home, env: {}, checkTracked: () => false, ...extra });

describe('reading a rollout', () => {
  test('sub-agent calls count, and an MCP server tool of the same name does not', () => {
    expect(capabilityOfCall('spawn_agent', 'collaboration')).toBe('multi_agent');
    expect(capabilityOfCall('collaboration.wait_agent')).toBe('multi_agent');
    expect(capabilityOfCall('send_message', 'mcp__slack__')).toBeNull();
    expect(capabilityOfCall('exec', 'functions')).toBeNull();
  });

  test('only agent-specific words count as asking for sub-agents (a restore is permanent)', () => {
    const ctx = setup();
    const said = (text) =>
      codexSessionUsage(rollout(ctx.sessions, `m${(counter += 1)}`, ctx.root, { prompts: 1, said: text }), {
        mentionCandidates: ['multi_agent'],
      }).mentioned;
    expect(said('spawn 3 sub-agents for this')).toEqual(['multi_agent']);
    expect(said('run the agents in parallel')).toEqual(['multi_agent']);
    expect(said('run the tests in parallel')).toEqual([]);
    expect(said('spawn a process and wait for it')).toEqual([]);
  });

  test('the plugin-install, apps and sleep calls are recognised by their real shapes', () => {
    // As recorded in real 0.167.0 rollouts on this machine.
    expect(capabilityOfCall('sleep', 'clock')).toBe('sleep_tool');
    expect(capabilityOfCall('_search_issues', 'mcp__codex_apps__github')).toBe('apps');
    expect(capabilityOfCall('mcp__codex_apps__github._search_issues')).toBe('apps');
    expect(capabilityOfCall('request_plugin_install')).toBe('tool_suggest');
    // Another MCP server's `sleep` is not Codex's clock.
    expect(capabilityOfCall('sleep', 'mcp__timer__')).toBeNull();
    expect(capabilityOfCall('sleep', 'timers')).toBeNull();
  });

  test('a repository that sleeps or uses apps keeps them; the plugin advert goes', () => {
    const ctx = setup();
    rollout(ctx.sessions, 's1', ctx.root, { calls: [{ name: 'sleep', namespace: 'clock' }] });
    rollout(ctx.sessions, 's2', ctx.root, { calls: [{ name: '_search_issues', namespace: 'mcp__codex_apps__github' }] });
    const applied = fold(ctx).applied;
    expect(applied).toContain('tool_suggest');
    expect(applied).not.toContain('sleep_tool');
    expect(applied).not.toContain('apps');
  });

  test('only specific words ask for the new capabilities back', () => {
    const ctx = setup();
    const said = (text) =>
      codexSessionUsage(rollout(ctx.sessions, `w${(counter += 1)}`, ctx.root, { prompts: 1, said: text }), {
        mentionCandidates: ['tool_suggest', 'apps', 'sleep_tool'],
      }).mentioned.sort();
    expect(said('install the figma plugin')).toEqual(['tool_suggest']);
    expect(said('use the GitHub connector for this')).toEqual(['apps']);
    expect(said('wait 30 seconds, then check')).toEqual(['sleep_tool']);
    expect(said('fix the app crash and wait for CI')).toEqual([]);
    expect(said('the process should sleep less')).toEqual([]);
  });

  test('typed prompts, code-mode extension calls and image views are all seen', () => {
    const ctx = setup();
    const path = rollout(ctx.sessions, 'a', ctx.root, {
      prompts: 3,
      items: [
        { type: 'Extension', kind: 'collaboration.spawn_agent' },
        { type: 'ImageView', path: 'file:///x.png' },
      ],
    });
    const usage = codexSessionUsage(path);
    expect(usage.prompts).toBe(3);
    expect(usage.used.sort()).toEqual(['multi_agent', 'view_image']);
  });

  test('a session in a nested repository belongs to that repository, not its parent', () => {
    const ctx = setup();
    const nested = join(ctx.root, 'vendor', 'lib');
    mkdirSync(join(nested, '.git'), { recursive: true });
    expect(belongsTo(join(ctx.root, 'src'), ctx.root)).toBe(true);
    expect(belongsTo(nested, ctx.root)).toBe(false);
    expect(belongsTo(join(nested, 'src'), ctx.root)).toBe(false);
  });
});

describe('the decision', () => {
  test('unused over the evidence threshold is switched off; used in this repo is not', () => {
    const ctx = setup();
    rollout(ctx.sessions, 's1', ctx.root, { items: [{ type: 'ImageView', path: 'file:///a.png' }] });
    rollout(ctx.sessions, 's2', ctx.root);
    const summary = fold(ctx);
    expect(summary.applied).toEqual(['multi_agent', 'tool_suggest', 'apps', 'sleep_tool']);
    const text = readFileSync(configPath(ctx.root), 'utf8');
    expect(text).toMatch(/^# >>> token-optimizer/);
    expect(text).toContain('features.multi_agent = false\nagents.enabled = false\n');
    expect(text).toContain('features.tool_suggest = false\n');
    expect(text).toContain('features.apps = false\n');
    expect(text).toContain('features.sleep_tool = false\n');
    expect(text).not.toContain('view_image');
    expect(readFileSync(join(ctx.root, '.git', 'info', 'exclude'), 'utf8')).toContain('.codex/config.toml');
  });

  test('one session alone never decides', () => {
    const ctx = setup();
    rollout(ctx.sessions, 'only', ctx.root, { prompts: 400 });
    expect(fold(ctx).applied).toEqual([]);
  });

  test('another repository’s sessions are not this one’s evidence', () => {
    const ctx = setup();
    const other = fresh('other');
    rollout(ctx.sessions, 'o1', other);
    rollout(ctx.sessions, 'o2', other);
    expect(fold(ctx).folded).toBe(0);
  });

  test('asking for sub-agents in words gives the capability back, for good', () => {
    const ctx = setup();
    rollout(ctx.sessions, 's1', ctx.root, { items: [IMAGE] });
    rollout(ctx.sessions, 's2', ctx.root);
    expect(fold(ctx).applied).toEqual(['multi_agent', 'tool_suggest', 'apps', 'sleep_tool']);
    rollout(ctx.sessions, 's3', ctx.root, { prompts: 1, said: 'spawn sub-agents to do these in parallel' });
    const after = fold(ctx);
    expect(after.applied).not.toContain('multi_agent');
    expect(after.restored).toContain('multi_agent');
    expect(readFileSync(configPath(ctx.root), 'utf8')).not.toContain('multi_agent');
    for (let index = 4; index < 12; index += 1) rollout(ctx.sessions, `s${index}`, ctx.root);
    expect(fold(ctx).applied).not.toContain('multi_agent');
  });

  test('an untrusted project stays a proposal, and says why', () => {
    const ctx = setup({ trusted: false });
    rollout(ctx.sessions, 's1', ctx.root);
    rollout(ctx.sessions, 's2', ctx.root);
    const summary = fold(ctx);
    expect(summary.applied).toEqual([]);
    expect(summary.pending).toContain('multi_agent');
    expect(summary.blocked).toMatch(/does not trust/);
  });

  test('propose mode never writes', () => {
    const ctx = setup();
    rollout(ctx.sessions, 's1', ctx.root);
    rollout(ctx.sessions, 's2', ctx.root);
    const summary = fold(ctx, { env: { TOKEN_OPTIMIZER_TOOLPRUNE: 'propose' } });
    expect(summary.pending).toContain('multi_agent');
    expect(() => readFileSync(configPath(ctx.root), 'utf8')).toThrow();
  });
});

describe('the config file', () => {
  test('the user’s text survives a write and a restore byte for byte, CRLF included', () => {
    const ctx = setup();
    const original = '# mine\r\n[shell_environment_policy]\r\ninherit = "core"\r\n';
    mkdirSync(join(ctx.root, '.codex'), { recursive: true });
    writeFileSync(configPath(ctx.root), original);
    const written = writeCodexConfig(ctx.root, ['multi_agent'], { home: ctx.home, checkTracked: () => false });
    expect(written.ok).toBe(true);
    const text = readFileSync(configPath(ctx.root), 'utf8');
    expect(text.endsWith(original)).toBe(true);
    expect(parseConfig(text).owned).toEqual(['multi_agent']);
    expect(writeCodexConfig(ctx.root, [], { home: ctx.home }).removed).toEqual(['multi_agent']);
    expect(readFileSync(configPath(ctx.root), 'utf8')).toBe(original);
  });

  test('a [features] table of the user’s is never defined twice, even after the block exists', () => {
    const ctx = setup();
    mkdirSync(join(ctx.root, '.codex'), { recursive: true });
    writeFileSync(configPath(ctx.root), '[features]\nweb_search = true\n');
    const refused = writeCodexConfig(ctx.root, ['multi_agent'], { home: ctx.home, checkTracked: () => false });
    expect(refused.ok).toBe(true);
    expect(refused.added).toEqual([]);
    expect(refused.reason).toMatch(/\[features\]/);
    expect(readFileSync(configPath(ctx.root), 'utf8')).toBe('[features]\nweb_search = true\n');

    // The block was written first; the person added [features] afterwards.
    writeFileSync(configPath(ctx.root), '');
    expect(writeCodexConfig(ctx.root, ['multi_agent'], { home: ctx.home, checkTracked: () => false }).added).toEqual(['multi_agent']);
    writeFileSync(configPath(ctx.root), `${readFileSync(configPath(ctx.root), 'utf8')}\n[features]\nweb_search = true\n`);
    const repaired = writeCodexConfig(ctx.root, ['multi_agent'], { home: ctx.home, checkTracked: () => false });
    expect(repaired.removed).toEqual(['multi_agent']);
    expect(readFileSync(configPath(ctx.root), 'utf8')).not.toContain('features.multi_agent');
  });

  test('a config tracked by git is the team’s and is left alone', () => {
    const ctx = setup();
    mkdirSync(join(ctx.root, '.codex'), { recursive: true });
    writeFileSync(configPath(ctx.root), 'model = "x"\n');
    const result = writeCodexConfig(ctx.root, ['multi_agent'], { home: ctx.home, checkTracked: () => true });
    expect(result).toEqual({ ok: false, reason: '.codex/config.toml is tracked by git' });
  });

  test('the global config is never written as a project’s', () => {
    const home = fresh('home');
    const codexHome = join(home, '.codex');
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, 'config.toml'), `[projects.'${home.toLowerCase()}']\ntrust_level = "trusted"\n`);
    const result = writeCodexConfig(home, ['multi_agent'], { home: codexHome, checkTracked: () => false });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/global/);
    expect(readFileSync(join(codexHome, 'config.toml'), 'utf8')).not.toContain('multi_agent');
  });

  test('trust is read for exactly this root, quoted either way', () => {
    const ctx = setup();
    expect(isTrusted(ctx.root, { home: ctx.home })).toBe(true);
    expect(isTrusted(join(ctx.root, 'sub'), { home: ctx.home })).toBe(false);
    const escaped = ctx.root.replace(/\\/g, '\\\\');
    writeFileSync(join(ctx.home, 'config.toml'), `[projects."${process.platform === 'win32' ? escaped.toLowerCase() : escaped}"]\ntrust_level = "trusted"\n`);
    expect(isTrusted(ctx.root, { home: ctx.home })).toBe(true);
  });

  test('a manual restore gives everything back and it is never switched off again', () => {
    const ctx = setup();
    rollout(ctx.sessions, 's1', ctx.root, { items: [IMAGE] });
    rollout(ctx.sessions, 's2', ctx.root);
    expect(fold(ctx).applied).toEqual(['multi_agent', 'tool_suggest', 'apps', 'sleep_tool']);
    expect(restoreCodex({ dir: ctx.dir, root: ctx.root, home: ctx.home }).restored).toEqual(['multi_agent', 'tool_suggest', 'apps', 'sleep_tool']);
    rollout(ctx.sessions, 's3', ctx.root);
    const again = fold(ctx).applied;
    for (const id of ['multi_agent', 'tool_suggest', 'apps', 'sleep_tool']) expect(again).not.toContain(id);
  });
});
