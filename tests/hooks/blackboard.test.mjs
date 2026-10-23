import { afterAll, describe, expect, test } from '@jest/globals';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOARD_BUDGET, BOARD_TTL_MS, boardFor, gitHead, isReadOnlyCommand, recordOnBoard, splitCd } from '../../hooks-core/blackboard.mjs';

const root = mkdtempSync(join(tmpdir(), 'board-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const withState = (fn) => {
  const before = process.env.TOKEN_OPTIMIZER_STATE_DIR;
  process.env.TOKEN_OPTIMIZER_STATE_DIR = mkdtempSync(join(root, 'state-'));
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.TOKEN_OPTIMIZER_STATE_DIR;
    else process.env.TOKEN_OPTIMIZER_STATE_DIR = before;
  }
};
const output = (n = 30) => Array.from({ length: n }, (_, i) => `abc123${i} commit message number ${i}`).join('\n');

describe('what is recorded', () => {
  test('read-only commands only', () => {
    for (const c of ['git log --oneline -20', 'gh issue view 12 -R o/r', 'gh api repos/o/r/issues/12', 'ls -la src', 'grep -rn foo src | head -5', "sed -n '1,40p' a.ts"])
      expect(isReadOnlyCommand(c)).toBe(true);
    for (const c of ['git commit -m x', 'npm install', 'gh api -X POST repos/o/r/issues', 'gh api repos/o/r/issues -f title=x', 'cat a > b', 'sed -i s/a/b/ f', 'rm -rf x', 'find . -name "*.tmp" -delete', 'find . -exec touch {} +', 'git branch -D old', 'git branch --set-upstream-to=origin/main'])
      expect(isReadOnlyCommand(c)).toBe(false);
    for (const c of ['git branch -a', 'grep -c TODO src/a.ts', 'ls -d */'])
      expect(isReadOnlyCommand(c)).toBe(true);
  });

  test('a leading cd becomes the directory', () => {
    expect(splitCd('cd C:/r/AiDotNet && git log -5', '')).toEqual({ command: 'git log -5', cwd: 'C:/r/AiDotNet' });
    expect(splitCd('git status', '/w')).toEqual({ command: 'git status', cwd: '/w' });
  });

  test('the commit comes from disk, worktrees included', () => {
    const repo = join(root, 'repo');
    mkdirSync(repo);
    const git = (...a) => execFileSync('git', ['-c', 'core.fsmonitor=false', '-C', repo, ...a], { encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'a.txt'), 'x');
    git('add', '-A');
    git('-c', 'user.email=t@e.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'one');
    const sha = git('rev-parse', 'HEAD');
    expect(gitHead(join(repo))).toBe(sha);
    const wt = join(root, 'wt');
    git('worktree', 'add', '-q', '-b', 'side', wt);
    expect(gitHead(wt)).toBe(sha);
    expect(gitHead(join(root, 'nowhere-at-all'))).toBeNull();
  });
});

describe('what a sibling is offered', () => {
  test("other agents' results only, latest per command, ranked by the task", () =>
    withState(() => {
      const s = `s-${Date.now()}`;
      recordOnBoard({ sessionId: s, agent: 'a', command: 'gh issue view 1159 -R ooples/AiDotNet', output: output(), now: 1_000 });
      recordOnBoard({ sessionId: s, agent: 'a', command: 'git log --oneline -30', output: output(), now: 2_000 });
      recordOnBoard({ sessionId: s, agent: 'b', command: 'ls -la', output: output(), now: 3_000 });
      const forB = boardFor({ sessionId: s, agent: 'b', task: 'Fix issue 1159 in ooples/AiDotNet', now: 4_000 });
      expect(forB).toMatch(/^# Already run by sibling agents in this session/);
      expect(forB.indexOf('gh issue view 1159')).toBeLessThan(forB.indexOf('git log'));
      expect(forB).not.toContain('`ls -la`');
      expect(boardFor({ sessionId: s, agent: 'c', task: '', now: 4_000 + BOARD_TTL_MS })).toBeNull();
    }));

  test('bounded, and nothing for write commands or small outputs', () =>
    withState(() => {
      const s = `t-${Date.now()}`;
      for (let i = 0; i < 40; i++) recordOnBoard({ sessionId: s, agent: 'a', command: `git show HEAD~${i}`, output: output(), now: 1_000 + i });
      expect(boardFor({ sessionId: s, agent: 'z', task: 'x', now: 2_000 }).length).toBeLessThan(BOARD_BUDGET + 200);
      expect(recordOnBoard({ sessionId: s, agent: 'a', command: 'git push', output: output() })).toBe(false);
      expect(recordOnBoard({ sessionId: s, agent: 'a', command: 'git log', output: 'short' })).toBe(false);
    }));
});

describe('through the hooks', () => {
  test("one sibling's result reaches the next sibling's first-call briefing", () => {
    const workspace = mkdtempSync(join(root, 'ws-'));
    mkdirSync(join(workspace, '.git'));
    const env = {
      ...process.env,
      TOKEN_OPTIMIZER_MODE: 'assist',
      TOKEN_OPTIMIZER_STATE_DIR: join(workspace, '.state'),
      TOKEN_OPTIMIZER_WIKI_DIR: join(workspace, '.wiki'),
      TOKEN_OPTIMIZER_SHARED_DIR: join(workspace, '.wiki'),
      TOKEN_OPTIMIZER_UCR_DIR: join(workspace, '.ucr'),
    };
    const session = `bb-${Date.now()}`;
    const run = (script, input) =>
      spawnSync(process.execPath, [join(process.cwd(), 'plugin', 'hooks', script)], { cwd: workspace, env, encoding: 'utf8', timeout: 30_000, input: JSON.stringify(input) });
    run('post-tool.mjs', {
      hook_event_name: 'PostToolUse', session_id: session, agent_id: 'sib-a', cwd: workspace,
      tool_name: 'Bash', tool_input: { command: 'git log --oneline -30' },
      tool_response: { stdout: output(), stderr: '', interrupted: false, isImage: false },
    });
    const r = run('pretooluse-router.mjs', {
      hook_event_name: 'PreToolUse', session_id: session, agent_id: 'sib-b', cwd: workspace,
      tool_name: 'Bash', tool_input: { command: 'git status' },
    });
    expect(r.stdout).toContain('Already run by sibling agents in this session');
    expect(r.stdout).toContain('git log --oneline -30');
  });
});
