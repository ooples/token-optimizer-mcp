import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chooseRepo,
  injectTaskPack,
  pathsIn,
  PACK_HEADING,
  RepoPacks,
} from '../../../src/proxy/repo-pack.js';
import type { ProviderRequest } from '../../../src/compress/frontier.js';

let root: string;
let alpha: string;
let beta: string;
let betaWorktree: string;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
    encoding: 'utf8',
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

/** A subagent's request after the sibling reorder. */
function reordered(task: string, systemMarkers = 2): ProviderRequest {
  return {
    system: Array.from({ length: systemMarkers }, (_, i) => ({
      type: 'text',
      text: `s${i}`,
      cache_control: { type: 'ephemeral', ttl: '1h' },
    })),
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'shared' }] },
      { role: 'system', content: [listing] },
      { role: 'user', content: [{ type: 'text', text: task }] },
    ],
  } as unknown as ProviderRequest;
}

describe('the pack in the task turn', () => {
  it('goes first in the task turn, with a copy of the preceding marker', () => {
    const out = injectTaskPack(
      reordered('do it'),
      `${PACK_HEADING} x`
    ) as unknown as {
      messages: { content: { text: string; cache_control?: unknown }[] }[];
    };
    expect(out.messages[2].content.map((b) => b.text)).toEqual([
      `${PACK_HEADING} x`,
      'do it',
    ]);
    expect(out.messages[2].content[0].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    });
    expect(out.messages[1].content[0]).toBe(listing);
  });

  it('adds no marker past the limit, and refuses any other shape', () => {
    const full = injectTaskPack(reordered('do it', 3), 'p') as unknown as {
      messages: { content: { cache_control?: unknown }[] }[];
    };
    expect(full.messages[2].content[0].cache_control).toBeUndefined();
    const plain = {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }] }],
    } as unknown as ProviderRequest;
    expect(injectTaskPack(plain, 'p')).toBeNull();
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
    const packs = new RepoPacks({ dir: mkdtempSync(join(root, 'store-')) });
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
    const packs = new RepoPacks({ dir: mkdtempSync(join(root, 'store-')) });
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
