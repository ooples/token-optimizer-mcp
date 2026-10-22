import { describe, it, expect } from '@jest/globals';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assignedItems,
  fetchItem,
  Prefetcher,
  PREFETCH_HEADING,
  type GhRunner,
} from '../../../src/proxy/prefetch.js';
import type { ProviderRequest } from '../../../src/compress/frontier.js';

const ISSUE = JSON.stringify({
  title: 'Adam ignores weight decay',
  state: 'open',
  body: 'Repro: train with decay 0.1 and weights do not shrink.',
  labels: [{ name: 'bug' }],
});
const COMMENTS = JSON.stringify([
  {
    user: { login: 'dev' },
    created_at: '2026-10-20T00:00:00Z',
    body: 'Seen in AdamOptimizer.cs line 88.',
  },
]);

const fakeGh =
  (calls: string[][] = []): GhRunner =>
  async (args) => {
    calls.push(args);
    return args[1].endsWith('/comments?per_page=100') ? COMMENTS : ISSUE;
  };

describe('which items a task assigns', () => {
  it('reads the campaign worker phrasing', () => {
    expect(
      assignedItems(
        'You are worker AiDotNet#1159-r1. Item: ISSUE ooples/AiDotNet #1159 (bug). Triage scope: ...'
      )
    ).toEqual([{ owner: 'ooples', repo: 'AiDotNet', number: 1159 }]);
    expect(
      assignedItems('Review PR ooples/AiDotNet.Tensors#1502 and report.')
    ).toEqual([{ owner: 'ooples', repo: 'AiDotNet.Tensors', number: 1502 }]);
  });

  it('never fetches references made in passing, such as exclusions', () => {
    expect(
      assignedItems(
        'Excluded entirely (do not list): ooples/AiDotNet#2294, ooples/AiDotNet#2310, ooples/AiDotNet.Tensors#1495.'
      )
    ).toEqual([]);
    expect(
      assignedItems('Skip issue ooples/AiDotNet #7, it is owned.')
    ).toEqual([]);
  });
});

describe('rendering an item', () => {
  it('carries the title, state, labels, body and the latest comments', async () => {
    const text = await fetchItem(
      { owner: 'ooples', repo: 'AiDotNet', number: 1159 },
      fakeGh()
    );
    expect(text).toContain(
      '## ooples/AiDotNet#1159 (issue, open): Adam ignores weight decay'
    );
    expect(text).toContain('Labels: bug');
    expect(text).toContain('weights do not shrink');
    expect(text).toContain(
      'dev (2026-10-20): Seen in AdamOptimizer.cs line 88.'
    );
  });

  it('is nothing when gh cannot fetch it', async () => {
    expect(
      await fetchItem({ owner: 'o', repo: 'r', number: 1 }, async () => null)
    ).toBeNull();
  });
});

const subagent = (task: string, later = false): ProviderRequest =>
  ({
    system: [
      {
        type: 'text',
        text: 'x-anthropic-billing-header: cc_version=2.1.302; cc_is_subagent=true;',
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
      ...(later
        ? [
            { role: 'assistant', content: 'ok' },
            { role: 'user', content: 'go on' },
          ]
        : []),
    ],
  }) as unknown as ProviderRequest;

describe('per conversation', () => {
  it('fetches once for siblings and keeps a conversation on the bytes it started with', async () => {
    const calls: string[][] = [];
    const store = mkdtempSync(join(tmpdir(), 'prefetch-'));
    const p = new Prefetcher({ dir: store, gh: fakeGh(calls) });
    const task = 'Item: ISSUE ooples/AiDotNet #1159 (bug).';
    const first = await p.forRequest(subagent(task), 'k');
    expect(first.reason).toBe('new');
    expect(first.text).toMatch(new RegExp(`^${PREFETCH_HEADING}`));
    // A sibling with the same item reuses the fetch.
    await p.forRequest(subagent(`${task} Also report timing.`), 'k');
    expect(calls).toHaveLength(2);
    // Later turns, and a restarted proxy, replay the pinned bytes.
    for (const q of [p, new Prefetcher({ dir: store, gh: async () => null })]) {
      const again = await q.forRequest(subagent(task, true), 'k');
      expect(again).toEqual({ text: first.text, reason: 'pinned' });
    }
  });

  it('leaves the main session, and a conversation already under way, alone', async () => {
    const p = new Prefetcher({
      dir: mkdtempSync(join(tmpdir(), 'prefetch-')),
      gh: fakeGh(),
    });
    const main = {
      messages: [{ role: 'user', content: 'Item: ISSUE o/r #1' }],
    } as unknown as ProviderRequest;
    expect((await p.forRequest(main, 'm')).reason).toBe('not-subagent');
    expect(
      (await p.forRequest(subagent('Item: ISSUE o/r #1', true), 'z')).reason
    ).toBe('not-new');
  });
});
