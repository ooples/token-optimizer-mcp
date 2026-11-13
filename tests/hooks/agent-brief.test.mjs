/**
 * The agent brief and the route to the lean worker agent (#567).
 *
 * The rules under test: a draft keeps rules and drops rationale; a subsection
 * under a CRITICAL heading is always sent; a scoped section reaches only agents
 * whose task names it; nothing is routed without an approved brief, the worker
 * agent loaded, and a general-purpose spawn.
 */

import { describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BRIEF_MARKER,
  PROJECT_WORKER,
  USER_WORKER,
  WORKER_AGENT,
  WORKER_BODY,
  briefFor,
  draftBrief,
  generatedWorker,
  instructionFiles,
  parseBrief,
  renderWorkerAgent,
  routeToWorker,
  sessionStartedAt,
  withoutComments,
  workerAgentPath,
} from '../../src/hooks-core/agent-brief.mjs';
import { BUDGET_MARKER, planSpawn } from '../../src/hooks-core/agent-spawn.mjs';

const repo = join(fileURLToPath(import.meta.url), '..', '..', '..');
const pluginRoot = join(repo, 'src', 'plugin');

const INSTRUCTIONS = [
  '# Team Guidelines',
  '',
  '## CRITICAL: Git Safety',
  '',
  '### Before destructive commands',
  '- Always stash before `git clean`, and never run it on untracked work',
  '  that has not been backed up.',
  '',
  '### Why This Matters',
  '- We never want to lose a day of work again.',
  '',
  '## Database Migrations',
  'Every migration must be reversible.',
  '',
  'Prose with no rule in it at all.',
  '',
  '```sql',
  '-- never shown: inside a code fence',
  '```',
].join('\n');

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'brief-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  return { root, project, env: { TOKEN_OPTIMIZER_HOME: home, CLAUDE_CONFIG_DIR: join(root, 'claude') } };
}

describe('withoutComments', () => {
  test('a comment rebuilt by removing an inner one is removed too, and an unterminated one drops the rest', () => {
    expect(withoutComments('keep <!-<!-- x -->- hidden --> this')).toBe('keep  this');
    expect(withoutComments('a <!-- b --> c <!-- d --> e')).toBe('a  c  e');
    expect(withoutComments('rule\n<!-- never closed\nsecret')).toBe('rule\n');
    expect(parseBrief('## Rules\n- Keep it.\n<!-<!-- x -->- hidden -->\n')[0].text).toBe('- Keep it.');
  });
});

describe('draftBrief', () => {
  const draft = draftBrief([{ path: 'CLAUDE.md', text: INSTRUCTIONS }]);
  const sections = parseBrief(draft);

  test('keeps the rules, whole, and drops rationale, prose and code', () => {
    expect(draft).toContain(
      '- Always stash before `git clean`, and never run it on untracked work that has not been backed up.'
    );
    expect(draft).toContain('- Every migration must be reversible.');
    expect(draft).not.toContain('lose a day of work');
    expect(draft).not.toContain('Prose with no rule');
    expect(draft).not.toContain('inside a code fence');
  });

  test('a subsection of a CRITICAL section is always sent; the title scopes nothing', () => {
    const git = sections.find((s) => s.heading.includes('Before destructive commands'));
    expect(git.heading).toBe('CRITICAL: Git Safety > Before destructive commands');
    expect(git.when).toBeNull();
    const db = sections.find((s) => s.heading === 'Database Migrations');
    expect(db.when).toEqual(['database', 'migrations']);
    expect(draft).not.toMatch(/when:.*\bteam\b/);
  });
});

describe('briefFor', () => {
  test('sends a scoped section only to a task that names it; the user brief comes before the project one', () => {
    const { project, env } = sandbox();
    writeFileSync(join(env.TOKEN_OPTIMIZER_HOME, 'agent-brief.md'), draftBrief([{ path: 'x', text: INSTRUCTIONS }]));
    mkdirSync(join(project, '.token-optimizer'));
    writeFileSync(join(project, '.token-optimizer', 'agent-brief.md'), '## Project\n- Use pnpm, never npm.\n');
    const plain = briefFor('Fix the login bug', { cwd: project, env });
    expect(plain).toContain('Always stash');
    expect(plain).not.toContain('reversible');
    expect(plain.indexOf('Always stash')).toBeLessThan(plain.indexOf('Use pnpm'));
    expect(briefFor('Add a database index', { cwd: project, env })).toContain('reversible');
    // a word inside another word is not a mention
    expect(briefFor('Add a hyperdatabase', { cwd: project, env })).not.toContain('reversible');
  });

  test('no brief is null', () => {
    const { project, env } = sandbox();
    expect(briefFor('anything', { cwd: project, env })).toBeNull();
  });
});

describe('instructionFiles', () => {
  test('global first, then the project nearest last, stopping at the ceiling', () => {
    const { root, project, env } = sandbox();
    mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
    writeFileSync(join(env.CLAUDE_CONFIG_DIR, 'CLAUDE.md'), '- always global');
    writeFileSync(join(root, 'CLAUDE.md'), '- always parent');
    writeFileSync(join(project, 'CLAUDE.md'), '- always project');
    mkdirSync(join(project, '.claude'));
    writeFileSync(join(project, '.claude', 'CLAUDE.md'), '- always dot');
    const found = instructionFiles({ cwd: project, env, ceiling: root });
    expect(found.global).toEqual([join(env.CLAUDE_CONFIG_DIR, 'CLAUDE.md')]);
    expect(found.project).toEqual([join(root, 'CLAUDE.md'), join(project, 'CLAUDE.md'), join(project, '.claude', 'CLAUDE.md')]);
  });
});

describe('routeToWorker', () => {
  function withBrief() {
    const s = sandbox();
    writeFileSync(join(s.env.TOKEN_OPTIMIZER_HOME, 'agent-brief.md'), '## Rules\n- Never push to main.\n');
    return { ...s, env: { ...s.env, CLAUDE_PLUGIN_ROOT: pluginRoot } };
  }

  test('routes a general-purpose spawn, or one with no type, with the brief before the task', () => {
    const { project, env } = withBrief();
    for (const type of ['general-purpose', undefined]) {
      const routed = routeToWorker({ description: 'd', prompt: 'Fix it.', subagent_type: type }, { cwd: project, env });
      expect(routed.subagent_type).toBe(WORKER_AGENT);
      expect(routed.description).toBe('d');
      expect(routed.prompt.startsWith(BRIEF_MARKER)).toBe(true);
      expect(routed.prompt).toContain('- Never push to main.');
      expect(routed.prompt.endsWith('Fix it.')).toBe(true);
    }
  });

  test('never routes other agent types, a marked prompt, without the worker, without a brief, or when off', () => {
    const { project, env } = withBrief();
    const at = (input, e = env) => routeToWorker(input, { cwd: project, env: e });
    expect(at({ prompt: 'x', subagent_type: 'Explore' })).toBeNull();
    expect(at({ prompt: 'x', subagent_type: 'fork' })).toBeNull();
    expect(at({ prompt: 'x', subagent_type: 'my-reviewer' })).toBeNull();
    expect(at({ prompt: `${BRIEF_MARKER} x` })).toBeNull();
    expect(at({ prompt: 'x' }, { ...env, CLAUDE_PLUGIN_ROOT: '' })).toBeNull();
    expect(at({ prompt: 'x' }, { ...env, CLAUDE_PLUGIN_ROOT: tmpdir() })).toBeNull();
    expect(at({ prompt: 'x' }, { ...env, TOKEN_OPTIMIZER_AGENT_ROUTE: 'off' })).toBeNull();
    const bare = sandbox();
    expect(routeToWorker({ prompt: 'x' }, { cwd: bare.project, env: { ...bare.env, CLAUDE_PLUGIN_ROOT: pluginRoot } })).toBeNull();
  });

  test('planSpawn routes instead of appending the report budget, and budgets what it does not route', () => {
    const { project, env } = withBrief();
    const routed = planSpawn({ input: { prompt: 'Fix it.' }, cwd: project, env }).updatedInput;
    expect(routed.subagent_type).toBe(WORKER_AGENT);
    expect(routed.prompt).not.toContain(BUDGET_MARKER);
    const told = planSpawn({ input: { prompt: 'Fix it.' }, cwd: project, env });
    expect(told.context).toContain('runs as token-optimizer:worker');
    expect(planSpawn({ input: { prompt: 'Fix it.' }, cwd: project, env, batch: 2, first: false }).context).toBeNull();
    const kept = planSpawn({ input: { prompt: 'Fix it.', subagent_type: 'my-reviewer' }, cwd: project, env }).updatedInput;
    expect(kept.subagent_type).toBe('my-reviewer');
    expect(kept.prompt).toContain(BUDGET_MARKER);
  });

  test('planSpawn puts a routed worker on a cheaper model than the parent, and says so', () => {
    const { project, env } = withBrief();
    const plan = planSpawn({ input: { prompt: 'Fix it.' }, cwd: project, env, parentModel: 'claude-opus-5-5' });
    expect(plan.updatedInput.subagent_type).toBe(WORKER_AGENT);
    expect(plan.updatedInput.model).toBe('haiku');
    expect(plan.context).toContain('on haiku');
    expect(plan.context).toContain('Pass model explicitly');
    // an unrouted agent keeps the parent's model
    const kept = planSpawn({ input: { prompt: 'x', subagent_type: 'my-reviewer' }, cwd: project, env, parentModel: 'claude-opus-5-5' });
    expect(kept.updatedInput.model).toBeUndefined();
    // and a routed one without a known parent model says nothing about a model
    const unknown = planSpawn({ input: { prompt: 'Fix it.' }, cwd: project, env });
    expect(unknown.updatedInput.model).toBeUndefined();
    expect(unknown.context).not.toContain('Pass model');
  });
});

describe('the worker agent and the CLI', () => {
  test('the shipped worker starts lean', () => {
    const agent = readFileSync(join(pluginRoot, 'agents', 'worker.md'), 'utf8');
    expect(agent).toMatch(/^name: worker$/m);
    expect(agent).toMatch(/^omitClaudeMd: true$/m);
    expect(agent).toMatch(/^disallowedTools: Skill$/m);
    // No fixed cache tier: a 1h write costs 2x against 1.25x, which a short
    // agent never earns back (measured, bench/agents/ab.mjs); the evidence-gated
    // subagentPromptCacheTtl setting decides the tier instead.
    expect(agent).not.toMatch(/cacheTtl/);
  });

  test('draft, approve, show and remove', () => {
    const { project, env } = sandbox();
    writeFileSync(join(project, 'CLAUDE.md'), INSTRUCTIONS);
    const cli = (...args) =>
      spawnSync(process.execPath, [join(repo, 'src', 'scripts', 'agent-brief.mjs'), ...args, '--cwd', project], {
        encoding: 'utf8',
        env: { ...process.env, ...env },
      });
    const brief = join(project, '.token-optimizer', 'agent-brief.md');
    const draft = cli('draft', '--project');
    expect(draft.status).toBe(0);
    expect(draft.stdout).toContain(join(project, 'CLAUDE.md'));
    expect(existsSync(brief)).toBe(false);
    expect(cli('show', '--project', '--task', 'database work').stdout).toContain('No approved brief');
    expect(cli('approve', '--project').status).toBe(0);
    expect(readFileSync(brief, 'utf8')).toContain('Every migration must be reversible.');
    expect(cli('show', '--project', '--task', 'database work').stdout).toContain('reversible');
    expect(cli('remove', '--project').stdout).toContain('Removed');
    expect(existsSync(brief)).toBe(false);
    expect(cli('approve', '--project').status).toBe(1);
  });

  test('the hook routes end to end from the plugin', () => {
    const { project, env } = sandbox();
    writeFileSync(join(env.TOKEN_OPTIMIZER_HOME, 'agent-brief.md'), '## Rules\n- Never push to main.\n');
    const result = spawnSync(process.execPath, [join(pluginRoot, 'hooks', 'agent-spawn.mjs')], {
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Agent',
        cwd: project,
        tool_input: { description: 'd', prompt: 'Fix it.', subagent_type: 'general-purpose' },
      }),
      encoding: 'utf8',
      env: { ...process.env, ...env, CLAUDE_PLUGIN_ROOT: pluginRoot, TOKEN_OPTIMIZER_STATE_DIR: join(project, 's'), TOKEN_OPTIMIZER_MODE: '' },
      timeout: 30_000,
    });
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout).hookSpecificOutput;
    expect(out.permissionDecision).toBe('allow');
    expect(out.updatedInput.subagent_type).toBe(WORKER_AGENT);
    expect(out.updatedInput.prompt).toContain('Never push to main.');
    expect(out.additionalContext).toContain('token-optimizer:worker');
  });
});

describe('the generated worker agents', () => {
  const BRIEF = [
    '## CRITICAL: Safety',
    '- Never push to main.',
    '',
    '## Database Migrations',
    '<!-- when: database, migration -->',
    '- Every migration must be reversible.',
    '',
  ].join('\n');

  function approved() {
    const s = sandbox();
    writeFileSync(join(s.env.TOKEN_OPTIMIZER_HOME, 'agent-brief.md'), BRIEF);
    return s;
  }

  function generate(s, scope, mtimeMs) {
    const path = workerAgentPath(scope, { cwd: s.project, env: s.env });
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, renderWorkerAgent(scope, { cwd: s.project, env: s.env }));
    utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
    return path;
  }

  test('carries the worker prompt and only the always-sent rules', () => {
    const s = approved();
    const agent = renderWorkerAgent('user', { cwd: s.project, env: s.env });
    expect(agent.startsWith(`---\nname: ${USER_WORKER}\n`)).toBe(true);
    expect(agent).toMatch(/^omitClaudeMd: true$/m);
    expect(agent).toMatch(/^disallowedTools: Skill$/m);
    expect(agent).toContain(WORKER_BODY);
    expect(agent).toContain('- Never push to main.');
    expect(agent).not.toContain('reversible');
  });

  test('the plugin worker and the generated ones share one prompt', () => {
    const plugin = readFileSync(join(pluginRoot, 'agents', 'worker.md'), 'utf8').replace(/\r\n/g, '\n');
    expect(plugin.split('\n---\n')[1].trim()).toBe(WORKER_BODY);
  });

  test('only an agent that existed when the session started is used; the project one first', () => {
    const s = approved();
    const start = Date.now();
    expect(generatedWorker({ cwd: s.project, env: s.env, sessionStart: start })).toBeNull();
    generate(s, 'user', start - 60_000);
    expect(generatedWorker({ cwd: s.project, env: s.env, sessionStart: start })).toEqual({ name: USER_WORKER, scope: 'user' });
    expect(generatedWorker({ cwd: s.project, env: s.env, sessionStart: null })).toBeNull();
    generate(s, 'project', start + 60_000);
    expect(generatedWorker({ cwd: s.project, env: s.env, sessionStart: start }).name).toBe(USER_WORKER);
    generate(s, 'project', start - 60_000);
    expect(generatedWorker({ cwd: s.project, env: s.env, sessionStart: start })).toEqual({ name: PROJECT_WORKER, scope: 'project' });
  });

  test('routes to it with only the scoped rules a task names, without needing the plugin', () => {
    const s = approved();
    const start = Date.now();
    generate(s, 'user', start - 60_000);
    const opts = { cwd: s.project, env: s.env, sessionStart: start };
    const plain = routeToWorker({ prompt: 'Fix the login bug.' }, opts);
    expect(plain).toEqual({ prompt: 'Fix the login bug.', subagent_type: USER_WORKER });
    const db = routeToWorker({ prompt: 'Add a database index.', subagent_type: 'general-purpose' }, opts);
    expect(db.subagent_type).toBe(USER_WORKER);
    expect(db.prompt).toContain('Every migration must be reversible.');
    expect(db.prompt).not.toContain('Never push to main.');
    // the brief withdrawn: no route, even with the generated agent still on disk
    const withdrawn = sandbox();
    expect(routeToWorker({ prompt: 'x' }, { ...opts, env: { ...withdrawn.env, CLAUDE_CONFIG_DIR: s.env.CLAUDE_CONFIG_DIR } })).toBeNull();
  });

  test('planSpawn names the agent it routed to', () => {
    const s = approved();
    const start = Date.now();
    generate(s, 'user', start - 60_000);
    const plan = planSpawn({ input: { prompt: 'Fix it.' }, cwd: s.project, env: s.env, sessionStart: start });
    expect(plan.updatedInput.subagent_type).toBe(USER_WORKER);
    expect(plan.updatedInput.prompt).not.toContain(BUDGET_MARKER);
    expect(plan.context).toContain(`runs as ${USER_WORKER}`);
  });

  test('a session starts at its first timestamped entry', () => {
    const { root } = sandbox();
    const path = join(root, 't.jsonl');
    writeFileSync(
      path,
      '{"type":"summary"}\n{"type":"user","timestamp":"2026-11-13T01:02:03.000Z"}\n{"timestamp":"2026-11-13T09:00:00.000Z"}\n'
    );
    expect(sessionStartedAt(path)).toBe(Date.parse('2026-11-13T01:02:03.000Z'));
    expect(sessionStartedAt(join(root, 'none.jsonl'))).toBeNull();
    expect(sessionStartedAt('')).toBeNull();
  });

  test('approve generates the agent and remove takes it away', () => {
    const s = sandbox();
    writeFileSync(join(s.project, 'CLAUDE.md'), INSTRUCTIONS);
    const cli = (...a) =>
      spawnSync(process.execPath, [join(repo, 'src', 'scripts', 'agent-brief.mjs'), ...a, '--cwd', s.project], {
        encoding: 'utf8',
        env: { ...process.env, ...s.env },
      });
    expect(cli('draft', '--project').status).toBe(0);
    expect(cli('approve', '--project').status).toBe(0);
    const agent = workerAgentPath('project', { cwd: s.project, env: s.env });
    expect(readFileSync(agent, 'utf8')).toContain(`name: ${PROJECT_WORKER}`);
    expect(readFileSync(agent, 'utf8')).toContain('Always stash before');
    expect(cli('remove', '--project').status).toBe(0);
    expect(existsSync(agent)).toBe(false);
  });

  test('a rule repeated in another section is drafted once', () => {
    const draft = draftBrief([
      {
        path: 'a',
        text: '## CRITICAL: One\n- Never push to main.\n\n## CRITICAL: Two\n- never push to main.\n- Always run the tests.\n',
      },
    ]);
    expect(draft.match(/push to main/gi)).toHaveLength(1);
    expect(draft).toContain('- Always run the tests.');
  });

  test('the hook routes to the generated worker end to end, with no plugin root', () => {
    const s = approved();
    const transcript = join(s.root, 'parent.jsonl');
    generate(s, 'user', Date.now() - 120_000);
    writeFileSync(
      transcript,
      `${JSON.stringify({ type: 'user', timestamp: new Date(Date.now() - 60_000).toISOString(), message: { content: 'go' } })}\n`
    );
    const result = spawnSync(process.execPath, [join(pluginRoot, 'hooks', 'agent-spawn.mjs')], {
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Agent',
        cwd: s.project,
        transcript_path: transcript,
        tool_input: { prompt: 'Fix it.', subagent_type: 'general-purpose' },
      }),
      encoding: 'utf8',
      env: {
        ...process.env,
        ...s.env,
        CLAUDE_PLUGIN_ROOT: '',
        TOKEN_OPTIMIZER_STATE_DIR: join(s.root, 'st'),
        TOKEN_OPTIMIZER_MODE: '',
      },
      timeout: 30_000,
    });
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout).hookSpecificOutput;
    expect(out.updatedInput).toEqual({ prompt: 'Fix it.', subagent_type: USER_WORKER });
  });
});
