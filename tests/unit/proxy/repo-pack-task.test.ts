import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  candidateDirs,
  chooseRepo,
  gitEnv,
  injectPackBeforeTask,
  pathsIn,
  PACK_HEADING,
  RepoPacks,
  runGit,
  taskPackEnabled,
  type GitRunner,
} from '../../../src/proxy/repo-pack.js';
import type { ProviderRequest } from '../../../src/compress/frontier.js';

// SIZED TO THE WORK, NOT JEST'S DEFAULT. These tests spawn git or write
// packs; the slowest took 2.1 s alone, and under a full parallel
// run on a Windows machine with endpoint protection the same I/O went past
// 5 s, with the failing test changing between runs.
jest.setTimeout(20_000);

let root: string;
let alpha: string;
let beta: string;
let betaWorktree: string;

// The temp repositories below are where these packs may be built from.
const roots = process.env.TOKEN_OPTIMIZER_PROXY_REPO_ROOTS;
beforeAll(() => {
  process.env.TOKEN_OPTIMIZER_PROXY_REPO_ROOTS = tmpdir();
});
afterAll(() => {
  if (roots === undefined) delete process.env.TOKEN_OPTIMIZER_PROXY_REPO_ROOTS;
  else process.env.TOKEN_OPTIMIZER_PROXY_REPO_ROOTS = roots;
});

// Scrubbed: a GIT_DIR from a hook-driven run would override `-C`.
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
    encoding: 'utf8',
    env: gitEnv(),
  });

function makeRepo(dir: string, file: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'master');
  writeFileSync(
    join(dir, file),
    `export function ${file.replace(/\W/g, '')}() {}\n`
  );
  git(dir, 'add', '-A');
  git(
    dir,
    '-c',
    'user.email=t@example.com',
    '-c',
    'user.name=t',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    'init'
  );
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'repo-pack-task-'));
  alpha = join(root, 'Alpha').replace(/\\/g, '/');
  beta = join(root, 'Alpha.Beta').replace(/\\/g, '/');
  makeRepo(alpha, 'a.ts');
  makeRepo(beta, 'b.ts');
  betaWorktree = join(root, 'wt-beta-1502').replace(/\\/g, '/');
  git(beta, 'worktree', 'add', '-q', '-b', 'fix-1502', betaWorktree);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The campaign shape: shared rules name both repositories to every agent. */
const rules = (): string =>
  `CAMPAIGN RULES: claims in ${root}/campaign/claims.jsonl. Alpha main clone: ${alpha}. Beta: ${beta}. Never edit another worktree.\n`;

const repo = (commonDir: string) => ({ commonDir });

describe('which repository a task is about', () => {
  const a = repo('/r/Alpha/.git');
  const b = repo('/r/Alpha.Beta/.git');

  it('takes a declared repository over mentions', () => {
    const task =
      'Alpha Alpha Alpha Alpha.Beta. You are a TRIAGE agent. Repo ooples/Alpha.Beta. Exclude ooples/Alpha#1, ooples/Alpha#2.';
    expect(chooseRepo(task, [a, b])).toBe(b);
  });

  it('takes the one repository its issue references name', () => {
    expect(
      chooseRepo('Alpha Alpha Alpha Alpha.Beta. Fix Alpha.Beta#1502.', [a, b])
    ).toBe(b);
    expect(
      chooseRepo('Alpha.Beta Alpha.Beta. Fix ooples/Alpha#7.', [a, b])
    ).toBe(a);
  });

  it('falls back to the most mentioned, and gives a tie no pack', () => {
    expect(chooseRepo('Alpha Alpha Alpha.Beta', [a, b])).toBe(a);
    expect(chooseRepo('Alpha Alpha.Beta', [a, b])).toBeNull();
    // A longer name never counts as a mention of its prefix.
    expect(chooseRepo('Alpha.Beta Alpha.Beta Alpha', [a, b])).toBe(b);
  });

  it('reads absolute paths, Windows and POSIX, without trailing punctuation', () => {
    expect(
      pathsIn('see C:/x/AiDotNet. and /home/u/repo/src: then E:\\w\\i2147')
    ).toEqual(['C:/x/AiDotNet', '/home/u/repo/src', 'E:\\w\\i2147']);
  });
});

const listing = {
  type: 'text',
  text: 'deferred tools and skills',
  cache_control: { type: 'ephemeral', ttl: '1h' },
};

describe('the pack before the task', () => {
  it('goes just before the task in the first turn, everything else untouched', () => {
    const request = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'shared' },
            { type: 'text', text: 'do it' },
          ],
        },
        { role: 'system', content: [listing] },
      ],
    } as unknown as ProviderRequest;
    const out = injectPackBeforeTask(
      request,
      `${PACK_HEADING} x`
    ) as unknown as {
      messages: { role: string; content: { text: string }[] }[];
    };
    expect(out.messages[0].content.map((b) => b.text)).toEqual([
      'shared',
      `${PACK_HEADING} x`,
      'do it',
    ]);
    expect(out.messages[1].content[0]).toBe(listing);
  });

  it('refuses a request whose first turn has no task block', () => {
    const plain = {
      messages: [{ role: 'assistant', content: 'a' }],
    } as unknown as ProviderRequest;
    expect(injectPackBeforeTask(plain, 'p')).toBeNull();
  });
});

/** A subagent's first request as Claude Code sends it, from a session outside any repository. */
function subagent(task: string, sub = true): ProviderRequest {
  return {
    tools: [{ name: 'Read', input_schema: { type: 'object' } }],
    system: [
      {
        type: 'text',
        text: `x-anthropic-billing-header: cc_version=2.1.302;${sub ? ' cc_is_subagent=true;' : ''}`,
      },
      {
        type: 'text',
        text: ` - Primary working directory: ${root}\n - Is a git repository: false\n`,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'shared' },
          { type: 'text', text: task },
        ],
      },
      { role: 'system', content: [listing] },
    ],
  } as unknown as ProviderRequest;
}

describe('task-path packs for a session outside any repository', () => {
  it('packs the repository each sibling works on, separately pinned', async () => {
    const packs = new RepoPacks({
      dir: mkdtempSync(join(root, 'store-')),
      taskPlacement: true,
    });
    // Same conversation key for both, as Claude Code's siblings have.
    const onBeta = await packs.forRequest(
      subagent(`${rules()}Fix Alpha.Beta#1502 in ${betaWorktree}.`),
      'shared-key'
    );
    const onAlpha = await packs.forRequest(
      subagent(`${rules()}Fix Alpha#9.`),
      'shared-key'
    );
    expect(onBeta.placement).toBe('task');
    expect(onBeta.text).toContain(`${PACK_HEADING} Alpha.Beta @`);
    expect(onAlpha.text).toContain(`${PACK_HEADING} Alpha @`);
    const again = await packs.forRequest(
      subagent(`${rules()}Fix Alpha.Beta#1502 in ${betaWorktree}.`),
      'shared-key'
    );
    expect(again).toEqual({
      text: onBeta.text,
      reason: 'pinned',
      placement: 'task',
    });
  });

  it('leaves a main session and an ambiguous task alone', async () => {
    const packs = new RepoPacks({
      dir: mkdtempSync(join(root, 'store-')),
      taskPlacement: true,
    });
    expect(
      (await packs.forRequest(subagent(`${rules()}Fix Alpha#9.`, false), 'k'))
        .reason
    ).toBe('no-repo');
    const tie = await packs.forRequest(
      subagent(`Compare ${alpha} with ${beta}.`),
      'k2'
    );
    expect(tie).toEqual({ text: null, reason: 'unbuilt', placement: null });
  });
});

describe('resolving the paths a task names', () => {
  it('asks git about the path and its parent, never a root', () => {
    expect(candidateDirs('C:/r/AiDotNet/src/a.cs')).toEqual([
      'C:/r/AiDotNet/src/a.cs',
      'C:/r/AiDotNet/src',
    ]);
    expect(candidateDirs('/claude.ai/code')).toEqual(['/claude.ai/code']);
    expect(candidateDirs('/claude.ai')).toEqual([]);
  });

  it('bounds every resolution call, so an unreachable path cannot hold the first request', async () => {
    const seen: (number | undefined)[] = [];
    const hanging = `${root}/unreachable-drive/wt`;
    const git: GitRunner = (cwd, args, timeoutMs) => {
      if (args[0] === 'rev-parse' && args.includes('--git-common-dir'))
        seen.push(timeoutMs);
      // An unreachable path answers only when its call times out.
      if (cwd.startsWith(`${root}/unreachable-drive`))
        return new Promise((r) =>
          setTimeout(() => r(null), timeoutMs ?? 60_000)
        );
      return runGit(cwd, args, timeoutMs);
    };
    const packs = new RepoPacks({
      dir: mkdtempSync(join(root, 'store-')),
      git,
      taskPlacement: true,
      maxWaitMs: 10_000,
    });
    const started = Date.now();
    const out = await packs.forRequest(
      subagent(`Work in ${hanging}. Repo ${alpha}. Fix Alpha#3.`),
      'bounded'
    );
    expect(out.text).toContain(`${PACK_HEADING} Alpha @`);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((t) => t !== undefined && t <= 2_500)).toBe(true);
    expect(Date.now() - started).toBeLessThan(8_000);
  }, 15_000); // waits out the 2.5 s resolution timeout on purpose
});

describe('the task-path pack is opt-in', () => {
  it('stays off unless asked for, and the switch turns it on', async () => {
    expect(taskPackEnabled({})).toBe(false);
    expect(taskPackEnabled({ TOKEN_OPTIMIZER_PROXY_REPO_PACK_TASK: '1' })).toBe(
      true
    );
    const packs = new RepoPacks({ dir: mkdtempSync(join(root, 'store-')) });
    const out = await packs.forRequest(
      subagent(`${rules()}Fix Alpha#9.`),
      'default-off'
    );
    expect(out).toEqual({ text: null, reason: 'no-repo', placement: null });
  });
});
