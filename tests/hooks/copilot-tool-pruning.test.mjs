/**
 * Copilot CLI tool pruning (hooks-core/copilotprune.mjs) and its delivery by the
 * managed launcher (scripts/run-client.mjs).
 *
 * Each test pins a property the design depends on: a tool is left out only on
 * evidence from THIS repository's sessions, the tools every task needs are never
 * left out, asking for a tool in words gives it back for good, a person who
 * chose the tool set on the command line is not overridden, and the launcher
 * actually hands `--excluded-tools` to the real CLI -- last, because the flag is
 * variadic.
 */

import { afterAll, describe, expect, test } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyLeanSwitches,
  choosesOwnTools,
  COPILOT_KEEP,
  copilotExclusions,
  copilotSessionUsage,
  leanSwitchMode,
  leanSwitchState,
  mentions,
  restoreCopilot,
  restoreLeanSwitches,
  runCopilotFold,
} from '../../hooks-core/copilotprune.mjs';
import { probeCopilotSwitches } from '../../hooks-core/doctor.mjs';
import { learnedLocation } from '../../hooks-core/toolprune.mjs';
import { runClient } from '../../scripts/run-client.mjs';

const work = mkdtempSync(join(tmpdir(), 'copilot-tool-pruning-'));
afterAll(() => rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));

let counter = 0;
const fresh = (name) => {
  const dir = join(work, `${name}-${(counter += 1)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

function setup() {
  const root = fresh('repo');
  mkdirSync(join(root, '.git', 'info'), { recursive: true });
  const home = fresh('copilot-home');
  mkdirSync(join(home, 'session-state'), { recursive: true });
  return { root, home, dir: fresh('state'), stateDir: join(home, 'session-state') };
}

const at = (minutes) => new Date(Date.now() - 60 * 60 * 1000 + minutes * 1000).toISOString();

/** One Copilot session log in the shape 1.0.107 writes. */
function session(stateDir, id, cwd, { prompts = 3, tools = ['powershell', 'view'], said = 'fix the failing test' } = {}) {
  const lines = [
    { type: 'session.start', data: { sessionId: id, copilotVersion: '1.0.107', context: { cwd } }, timestamp: at(0) },
  ];
  for (let index = 0; index < prompts; index += 1) {
    lines.push({ type: 'user.message', data: { content: index === 0 ? said : 'continue' }, timestamp: at(index + 1) });
    for (const toolName of tools) lines.push({ type: 'tool.execution_start', data: { toolName, arguments: {} }, timestamp: at(index + 1) });
  }
  const sessionDir = join(stateDir, id);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, 'events.jsonl'), lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
}

const env = (extra = {}) => ({ TOKEN_OPTIMIZER_TOOLPRUNE: 'auto', ...extra });

describe('reading a session log', () => {
  test('counts typed prompts and the tools used, and watches only for the tools left out', () => {
    const { stateDir, root } = setup();
    session(stateDir, 's1', root, { prompts: 4, tools: ['powershell', 'sql'], said: 'make an image of a logo, and use sql' });
    const usage = copilotSessionUsage(join(stateDir, 's1', 'events.jsonl'), { mentionCandidates: ['image_generation'] });
    expect(usage.prompts).toBe(4);
    expect(usage.used.sort()).toEqual(['powershell', 'sql']);
    // sql was named too, but it is not left out, so it is not a restore.
    expect(usage.mentioned).toEqual(['image_generation']);
  });

  test('a literal tool name counts as asking for it; a word containing it does not', () => {
    expect(mentions('query it with sql please', 'sql')).toBe(true);
    expect(mentions('move this to nosql', 'sql')).toBe(false);
    expect(mentions('see session_store_sql', 'sql')).toBe(false);
    // Specific phrasing only: GitHub Actions is not a dynamic workflow.
    expect(mentions('fix the GitHub Actions workflow', 'run_dynamic_workflow')).toBe(false);
    expect(mentions('the repo is on github', 'github-mcp-server-search_code')).toBe(false);
  });
});

describe('the decision', () => {
  test('nothing is left out before there is evidence', () => {
    const { stateDir, root, dir } = setup();
    session(stateDir, 'a', root);
    const result = runCopilotFold({ dir, root, env: env(), stateDir });
    expect(result.folded).toBe(1);
    expect(result.exclude).toEqual([]);
  });

  test('tools unused over enough sessions are left out; the tools every task needs never are', () => {
    const { stateDir, root, dir } = setup();
    for (const id of ['a', 'b', 'c', 'd', 'e']) session(stateDir, id, root);
    const { exclude } = runCopilotFold({ dir, root, env: env(), stateDir });
    expect(exclude).toEqual(expect.arrayContaining(['image_generation', 'sql', 'github-mcp-server-search_users', 'run_dynamic_workflow']));
    for (const name of COPILOT_KEEP) expect(exclude).not.toContain(name);
    // Spelled out, because these are the ones whose absence the model would not notice.
    for (const name of ['powershell', 'view', 'edit', 'task', 'read_agent', 'web_fetch', 'skill']) expect(exclude).not.toContain(name);
  });

  test('a tool used in this repository is kept', () => {
    const { stateDir, root, dir } = setup();
    for (const id of ['a', 'b', 'c', 'd']) session(stateDir, id, root);
    session(stateDir, 'e', root, { tools: ['powershell', 'sql'] });
    const { exclude } = runCopilotFold({ dir, root, env: env(), stateDir });
    expect(exclude).not.toContain('sql');
    expect(exclude).toContain('image_generation');
  });

  test("another repository's sessions are not this one's evidence", () => {
    const { stateDir, root, dir } = setup();
    const other = fresh('other-repo');
    mkdirSync(join(other, '.git'), { recursive: true });
    // A repository nested inside this one claims its own sessions.
    const nested = join(root, 'vendor', 'lib');
    mkdirSync(join(nested, '.git'), { recursive: true });
    for (const id of ['a', 'b', 'c']) session(stateDir, id, other);
    for (const id of ['d', 'e']) session(stateDir, id, nested);
    const result = runCopilotFold({ dir, root, env: env(), stateDir });
    expect(result.folded).toBe(0);
    expect(result.exclude).toEqual([]);
  });

  test('asking for a left-out tool in words gives it back for good', () => {
    const { stateDir, root, dir } = setup();
    for (const id of ['a', 'b', 'c', 'd', 'e']) session(stateDir, id, root);
    expect(runCopilotFold({ dir, root, env: env(), stateDir }).exclude).toContain('image_generation');
    session(stateDir, 'f', root, { said: 'generate an image for the README logo' });
    const after = runCopilotFold({ dir, root, env: env(), stateDir });
    expect(after.exclude).not.toContain('image_generation');
    expect(after.restored).toContain('image_generation');
    // More unused sessions do not take it away again.
    for (const id of ['g', 'h', 'i', 'j', 'k', 'l']) session(stateDir, id, root);
    expect(runCopilotFold({ dir, root, env: env(), stateDir }).exclude).not.toContain('image_generation');
  });

  test('propose mode leaves everything in and lists what it would leave out; off does nothing', () => {
    const { stateDir, root, dir } = setup();
    for (const id of ['a', 'b', 'c', 'd', 'e']) session(stateDir, id, root);
    const proposed = runCopilotFold({ dir, root, env: env({ TOKEN_OPTIMIZER_TOOLPRUNE: 'propose' }), stateDir });
    expect(proposed.exclude).toEqual([]);
    expect(proposed.pending).toContain('image_generation');
    expect(runCopilotFold({ dir, root, env: env({ TOKEN_OPTIMIZER_TOOLPRUNE: 'off' }), stateDir }).exclude).toEqual([]);
  });

  test('restore by hand gives back what is left out, and it stays back', () => {
    const { stateDir, root, dir } = setup();
    for (const id of ['a', 'b', 'c', 'd', 'e']) session(stateDir, id, root);
    expect(runCopilotFold({ dir, root, env: env(), stateDir }).exclude).toContain('sql');
    restoreCopilot({ dir, names: ['sql'] });
    const after = runCopilotFold({ dir, root, env: env(), stateDir });
    expect(after.exclude).not.toContain('sql');
    expect(after.exclude).toContain('image_generation');
  });
});

describe('delivery', () => {
  test("the person's own tool choice on the command line wins", () => {
    expect(choosesOwnTools(['--available-tools', 'view'])).toBe(true);
    expect(choosesOwnTools(['--excluded-tools=sql'])).toBe(true);
    expect(choosesOwnTools(['-p', 'hi', '--', '--excluded-tools'])).toBe(false);
    const { stateDir, root, dir } = setup();
    for (const id of ['a', 'b', 'c', 'd', 'e']) session(stateDir, id, root);
    expect(copilotExclusions({ args: ['--available-tools', 'view'], env: env(), dir, root, stateDir }).args).toEqual([]);
    expect(copilotExclusions({ args: [], env: env({ TOKEN_OPTIMIZER_MODE: 'off' }), dir, root, stateDir }).args).toEqual([]);
    const pruned = copilotExclusions({ args: [], env: env(), dir, root, stateDir });
    expect(pruned.args[0]).toBe('--excluded-tools');
    expect(pruned.args).toContain('image_generation');
    expect(pruned.notice).toMatch(/left out \d+ Copilot tool\(s\).*Undo: token-optimizer-learned toolprune restore --copilot/);
  });

  test('the managed launcher hands --excluded-tools to the real CLI, last', async () => {
    const { home, dir: wikiDir } = setup();
    const { root } = learnedLocation(process.cwd());
    const stateDir = join(home, 'session-state');
    for (const id of ['a', 'b', 'c', 'd', 'e']) session(stateDir, `launch-${id}`, root);
    const fakeDir = fresh('fake');
    const file = join(fakeDir, 'launched.json');
    const script = join(fakeDir, 'fake-copilot.mjs');
    writeFileSync(script, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(file)}, JSON.stringify(process.argv.slice(2)));`);
    const saved = process.env.TOKEN_OPTIMIZER_WIKI_DIR;
    process.env.TOKEN_OPTIMIZER_WIKI_DIR = wikiDir;
    try {
      const code = await runClient('copilot', [script, '-p', 'hello'], {
        env: { ...process.env, COPILOT_HOME: home, TOKEN_OPTIMIZER_PROXY: '0', TOKEN_OPTIMIZER_TOOLPRUNE: 'auto', TOKEN_OPTIMIZER_MODE: 'balanced' },
        command: process.execPath,
      });
      expect(code).toBe(0);
    } finally {
      if (saved === undefined) delete process.env.TOKEN_OPTIMIZER_WIKI_DIR;
      else process.env.TOKEN_OPTIMIZER_WIKI_DIR = saved;
    }
    const argv = JSON.parse(readFileSync(file, 'utf8'));
    expect(argv.slice(0, 2)).toEqual(['-p', 'hello']);
    const flag = argv.indexOf('--excluded-tools');
    expect(flag).toBe(2);
    expect(argv.slice(flag + 1)).toContain('image_generation');
    expect(argv.slice(flag + 1)).not.toContain('powershell');
  });
});

/**
 * The four lean user switches are the person's settings, so they are written
 * only on opt-in, never over a value the person set, and undone exactly: the
 * original bytes when the file is untouched since, only our keys when not.
 */
describe('copilot lean user switches', () => {
  const lean = (extra = {}) => {
    const home = fresh('lean-home');
    const tokenHome = fresh('lean-token-home');
    return {
      home,
      settings: join(home, 'settings.json'),
      env: { COPILOT_HOME: home, TOKEN_OPTIMIZER_HOME: tokenHome, TOKEN_OPTIMIZER_COPILOT_LEAN_SWITCHES: 'write', ...extra },
    };
  };

  test('writes nothing unless opted in, and an unknown value is off', () => {
    for (const value of [undefined, '', 'yes', 'on']) {
      const { env, settings } = lean({ TOKEN_OPTIMIZER_COPILOT_LEAN_SWITCHES: value });
      if (value === undefined) delete env.TOKEN_OPTIMIZER_COPILOT_LEAN_SWITCHES;
      expect(leanSwitchMode(env)).toBe('off');
      expect(applyLeanSwitches({ env }).changed).toBe(false);
      expect(existsSync(settings)).toBe(false);
    }
  });

  test('writes only the unset switches and keeps every other setting', () => {
    const { env, settings } = lean();
    const original = '{\n  "askUser": true,\n  "theme": "dark"\n}\n';
    writeFileSync(settings, original);
    const result = applyLeanSwitches({ env });
    expect(result.changed).toBe(true);
    expect(result.written).toEqual(['connectors', 'contextManagementTools', 'imageGeneration']);
    expect(result.notice).toMatch(/Undo: token-optimizer-learned toolprune restore --copilot/);
    const now = JSON.parse(readFileSync(settings, 'utf8'));
    expect(now).toEqual({ askUser: true, theme: 'dark', connectors: false, contextManagementTools: false, imageGeneration: false });
    // A second launch has nothing left to write.
    expect(applyLeanSwitches({ env }).changed).toBe(false);
  });

  test('restore returns the original bytes when the file is untouched since', () => {
    const { env, settings } = lean();
    const original = '{"theme":"dark"}';
    writeFileSync(settings, original);
    applyLeanSwitches({ env });
    const undone = restoreLeanSwitches({ env });
    expect(undone.restored).toEqual(['askUser', 'connectors', 'contextManagementTools', 'imageGeneration']);
    expect(readFileSync(settings, 'utf8')).toBe(original);
    // ...and does not write them again while the opt-in stays on.
    expect(applyLeanSwitches({ env }).changed).toBe(false);
    expect(readFileSync(settings, 'utf8')).toBe(original);
    expect(leanSwitchState(env).declined).toBe(true);
  });

  test('restore removes the file it created', () => {
    const { env, settings } = lean();
    applyLeanSwitches({ env });
    expect(existsSync(settings)).toBe(true);
    restoreLeanSwitches({ env });
    expect(existsSync(settings)).toBe(false);
  });

  test('restore after the person edited the file removes only our still-false keys', () => {
    const { env, settings } = lean();
    writeFileSync(settings, '{"theme":"dark"}');
    applyLeanSwitches({ env });
    const edited = JSON.parse(readFileSync(settings, 'utf8'));
    edited.imageGeneration = true;
    edited.model = 'x';
    writeFileSync(settings, JSON.stringify(edited));
    restoreLeanSwitches({ env });
    expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual({ theme: 'dark', imageGeneration: true, model: 'x' });
  });

  test('a settings.json that is not strict JSON is never written', () => {
    const { env, settings } = lean();
    const text = '// mine\n{ "theme": "dark" }\n';
    writeFileSync(settings, text);
    expect(applyLeanSwitches({ env }).changed).toBe(false);
    expect(readFileSync(settings, 'utf8')).toBe(text);
    expect(leanSwitchState(env).readable).toBe(false);
  });

  test('doctor names the switches that are on and how to turn them off', () => {
    const { env, settings, home } = lean({ TOKEN_OPTIMIZER_COPILOT_LEAN_SWITCHES: 'off' });
    writeFileSync(settings, '{"askUser":false}');
    const [check] = probeCopilotSwitches(env);
    expect(check.warn).toBe(true);
    expect(check.detail).toMatch(/^connectors, contextManagementTools, imageGeneration are on/);
    expect(check.remedy).toMatch(/`copilot config connectors false`/);
    expect(check.remedy).not.toMatch(/askUser/);
    expect(check.remedy).toMatch(/TOKEN_OPTIMIZER_COPILOT_LEAN_SWITCHES=write/);
    writeFileSync(settings, JSON.stringify({ askUser: false, connectors: false, contextManagementTools: false, imageGeneration: false }));
    expect(probeCopilotSwitches(env)[0].warn).toBeUndefined();
    rmSync(home, { recursive: true, force: true });
    expect(probeCopilotSwitches(env)).toEqual([]);
  });

  test('the managed launcher writes them on opt-in, before Copilot starts', async () => {
    const { env, settings } = lean({ TOKEN_OPTIMIZER_PROXY: '0', TOKEN_OPTIMIZER_TOOLPRUNE: 'off' });
    const fakeDir = fresh('lean-fake');
    const file = join(fakeDir, 'seen.json');
    const script = join(fakeDir, 'fake-copilot.mjs');
    writeFileSync(
      script,
      `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(file)}, fs.readFileSync(${JSON.stringify(settings)}, 'utf8'));`
    );
    const code = await runClient('copilot', [script, '-p', 'hello'], { env: { ...process.env, ...env }, command: process.execPath });
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ askUser: false, connectors: false, contextManagementTools: false, imageGeneration: false });
  });
});
