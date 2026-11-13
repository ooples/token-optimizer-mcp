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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BRIEF_MARKER,
  WORKER_AGENT,
  briefFor,
  draftBrief,
  instructionFiles,
  parseBrief,
  routeToWorker,
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
