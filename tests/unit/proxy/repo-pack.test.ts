import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildPack,
  gitEnv,
  injectPack,
  isNewConversation,
  isUnderRoot,
  PACK_HEADING,
  RepoPacks,
  repoPackEnabled,
  resolveRepo,
  trustedRoots,
  workingRepoOf,
  type GitRunner,
} from '../../../src/proxy/repo-pack.js';
import type { ProviderRequest } from '../../../src/compress/frontier.js';

let root: string;
let repo: string;
let worktree: string;

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

function commit(message: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, 'add', '-A');
  git(
    repo,
    '-c',
    'user.email=t@example.com',
    '-c',
    'user.name=t',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    message
  );
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'repo-pack-'));
  repo = join(root, 'demo-repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'master');
  commit('first', {
    'package.json': JSON.stringify({
      scripts: { test: 'jest', build: 'tsc', 'bench:x': 'node b.mjs' },
    }),
    'src/core.ts':
      'export function alpha(a: number): number {\n  return a;\n}\nexport class Beta {}\n',
    'copies/one/core.ts':
      'export function alpha(a: number): number {\n  return a;\n}\nexport class Beta {}\n',
  });
  worktree = join(root, 'wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'feature', worktree);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const envSection = (dir: string, isRepo = true): string =>
  `# Environment\n - Primary working directory: ${dir}\n - Is a git repository: ${isRepo}\n - Platform: linux\n`;

function request(
  dir: string,
  extra: Partial<ProviderRequest> = {}
): ProviderRequest {
  return {
    model: 'claude-sonnet-5-5',
    tools: [{ name: 'Read', input_schema: { type: 'object' } }],
    system: [
      { type: 'text', text: 'You are an agent.' },
      {
        type: 'text',
        text: envSection(dir),
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Fix the bug.' }] },
    ],
    ...extra,
  } as unknown as ProviderRequest;
}

describe('repository pack', () => {
  it('reads the working repository from the environment section', () => {
    expect(workingRepoOf(request('/x/y'))).toBe('/x/y');
    const notRepo = request('/x/y', {
      system: [{ type: 'text', text: envSection('/x/y', false) }],
    } as never);
    expect(workingRepoOf(notRepo)).toBeNull();
    expect(isNewConversation(request('/x'))).toBe(true);
    expect(repoPackEnabled({ TOKEN_OPTIMIZER_PROXY_REPO_PACK: '0' })).toBe(
      false
    );
    expect(repoPackEnabled({})).toBe(true);
  });

  it('moves the system cache marker onto the pack instead of adding one', () => {
    const out = injectPack(
      request('/x'),
      `${PACK_HEADING} demo`
    ) as unknown as { system: { text: string; cache_control?: unknown }[] };
    expect(out.system).toHaveLength(3);
    expect(out.system[1].cache_control).toBeUndefined();
    expect(out.system[2].text).toBe(`${PACK_HEADING} demo`);
    expect(out.system[2].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('is the same bytes from every worktree, named for the repository', async () => {
    const a = await resolveRepo(repo);
    const b = await resolveRepo(worktree);
    expect(a?.baseSha).toBe(b?.baseSha);
    const packA = await buildPack(a!, { budget: 24_000 });
    const packB = await buildPack(b!, { budget: 24_000 });
    expect(packA).toBe(packB);
    expect(packA).toContain(`${PACK_HEADING} demo-repo @`);
    expect(packA).toContain('npm run build: tsc');
    // Everyday commands ahead of the tooling tail.
    expect(packA!.indexOf('npm run test')).toBeLessThan(
      packA!.indexOf('npm run bench:x')
    );
    // A byte-identical copy is outlined once.
    expect(packA).toContain('### src/core.ts');
    expect(packA).not.toContain('### copies/one/core.ts');
    expect(packA).toMatch(/\d+ export function alpha/);
  });

  it('keeps a conversation on the pack it started with after the base moves', async () => {
    const dir = mkdtempSync(join(root, 'store-'));
    let now = 1_000_000;
    const packs = new RepoPacks({ dir, now: () => now });
    const first = await packs.forRequest(request(worktree), 'conv-1');
    expect(first.reason).toBe('new');
    expect(first.text).toContain(PACK_HEADING);

    commit('second', { 'src/more.ts': 'export const more = 1;\n' });
    now += 2 * 60 * 60_000;
    const laterTurn = request(worktree, {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Fix the bug.' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        { role: 'user', content: [{ type: 'text', text: 'go on' }] },
      ],
    } as never);
    // A fresh store over the same directory stands in for a restarted proxy.
    const restarted = new RepoPacks({ dir, now: () => now });
    for (const store of [packs, restarted]) {
      const again = await store.forRequest(laterTurn, 'conv-1');
      expect(again.reason).toBe('pinned');
      expect(again.text).toBe(first.text);
    }
    const fresh = await restarted.forRequest(request(worktree), 'conv-2');
    expect(fresh.reason).toBe('new');
    expect(fresh.text).not.toBe(first.text);
    expect(fresh.text).toContain('second');
  });

  it('never adds a pack mid-conversation, to utility calls, or twice', async () => {
    const packs = new RepoPacks({ dir: mkdtempSync(join(root, 'store-')) });
    const midway = request(repo, {
      messages: [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
      ],
    } as never);
    expect((await packs.forRequest(midway, 'k1')).reason).toBe('not-new');
    expect(
      (await packs.forRequest(request(repo, { tools: [] } as never), 'k2'))
        .reason
    ).toBe('not-agentic');
    const packed = injectPack(request(repo), `${PACK_HEADING} x`);
    expect((await packs.forRequest(packed, 'k3')).reason).toBe('already');
  });

  it('waits a bounded time for a slow build, then leaves that conversation without one', async () => {
    const hang: GitRunner = () => new Promise(() => {});
    const packs = new RepoPacks({
      dir: mkdtempSync(join(root, 'store-')),
      git: hang,
      maxWaitMs: 50,
    });
    const out = await packs.forRequest(request(repo), 'slow');
    expect(out).toEqual({ text: null, reason: 'timeout', placement: null });
    expect((await packs.forRequest(request(repo), 'slow')).reason).toBe(
      'pinned'
    );
    expect((await packs.forRequest(request(repo), 'slow')).text).toBeNull();
  });
});

describe('where a pack may be built from', () => {
  it('never runs git on a directory outside every trusted root', async () => {
    const calls: string[] = [];
    const spy: GitRunner = async (cwd) => {
      calls.push(cwd);
      return null;
    };
    const packs = new RepoPacks({
      dir: mkdtempSync(join(root, 'store-')),
      git: spy,
      roots: async () => [join(root, 'elsewhere')],
    });
    const out = await packs.forRequest(request(repo), 'untrusted');
    expect(out.reason).toBe('untrusted');
    expect(out.text).toBeNull();
    expect(calls).toEqual([]);
  });

  it('trusts a root the SessionStart hook registered, and the configured roots', async () => {
    const registry = join(mkdtempSync(join(root, 'reg-')), 'projects.jsonl');
    writeFileSync(
      registry,
      `${JSON.stringify({ v: 1, root: '/work/registered' })}\n{torn`
    );
    const got = await trustedRoots(
      {
        TOKEN_OPTIMIZER_PROJECT_REGISTRY: registry,
        TOKEN_OPTIMIZER_PROXY_REPO_ROOTS: ['/work/a', '/work/b'].join(
          process.platform === 'win32' ? ';' : ':'
        ),
      },
      ['/work/project']
    );
    expect(got).toEqual(
      expect.arrayContaining([
        '/work/registered',
        '/work/a',
        '/work/b',
        '/work/project',
      ])
    );
  });

  it('matches a root or what is inside it, never a sibling sharing its prefix', () => {
    expect(isUnderRoot('/work/repo', ['/work/repo'])).toBe(true);
    expect(isUnderRoot('/work/repo/sub', ['/work/repo/'])).toBe(true);
    expect(isUnderRoot('/work/repo-2', ['/work/repo'])).toBe(false);
    expect(isUnderRoot('/work', ['/work/repo'])).toBe(false);
  });

  it('runs git without the caller’s repository-location variables', () => {
    const env = gitEnv({ GIT_DIR: '/x/.git', GIT_WORK_TREE: '/x', PATH: 'p' });
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_WORK_TREE).toBeUndefined();
    expect(env.PATH).toBe('p');
  });
});
