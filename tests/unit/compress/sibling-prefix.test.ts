import { describe, it, expect } from '@jest/globals';
import {
  shareSiblingPrefix,
  sharePrefixMode,
  MAX_CACHE_MARKERS,
} from '../../../src/compress/sibling-prefix.js';
import type { ProviderRequest } from '../../../src/compress/frontier.js';

/**
 * Layouts as Claude Code 2.1.302 sends a subagent's first request (live
 * captures, 2026-10-21): markers on two system blocks and at the end of
 * messages[1]; the agent's own task is the LAST block of messages[0].
 */
const cc = (ttl?: string) =>
  ttl ? { type: 'ephemeral', ttl } : { type: 'ephemeral' };
const text = (n: number, tag: string, marker?: object) => ({
  type: 'text',
  text: `${tag} ${'x'.repeat(n)}`,
  ...(marker ? { cache_control: marker } : {}),
});

/** The campaign workflow worker: ~20k identical leading characters, then the task. */
const worker = (task: string): ProviderRequest =>
  ({
    model: 'claude',
    tools: [
      { name: 'Read', description: 'r', input_schema: { type: 'object' } },
    ],
    system: [
      text(70, 'billing'),
      text(60, 'identity', cc('1h')),
      text(6000, 'sys', cc('1h')),
    ],
    messages: [
      {
        role: 'user',
        content: [
          text(18_000, 'memory'),
          text(500, 'email'),
          text(800, 'attribution'),
          text(300, 'harness'),
          text(5000, task),
        ],
      },
      {
        role: 'system',
        content: [
          text(23_000, 'listing'),
          { type: 'tool_addition', tool: {}, cache_control: cc('1h') },
        ],
      },
    ],
  }) as unknown as ProviderRequest;

/** The plain `claude -p` subagent: short shared run, task, then the big identical system turn. */
const subagent = (task: string): ProviderRequest =>
  ({
    model: 'claude',
    tools: [
      { name: 'Read', description: 'r', input_schema: { type: 'object' } },
    ],
    system: [
      text(90, 'billing'),
      text(60, 'identity', cc('5m')),
      text(2600, 'sys', cc('5m')),
    ],
    messages: [
      {
        role: 'user',
        content: [text(1060, 'context'), text(600, 'email'), text(350, task)],
      },
      {
        role: 'system',
        content: [
          text(20_000, 'listing'),
          { type: 'tool_addition', tool: {}, cache_control: cc('5m') },
        ],
      },
    ],
  }) as unknown as ProviderRequest;

const m0 = (r: ProviderRequest) =>
  r.messages?.[0]?.content as Record<string, unknown>[];

describe('the shared-prefix marker', () => {
  it('marks the block before the task, with the following marker’s ttl', () => {
    const out = shareSiblingPrefix(worker('task A'));
    expect(out.applied).toBe('marker');
    const blocks = m0(out.request);
    expect(blocks[3].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(blocks[4].cache_control).toBeUndefined();
    expect(out.sharedChars).toBeGreaterThan(19_000);
  });

  it('gives two siblings byte-identical requests up to the new marker', () => {
    const a = JSON.stringify(shareSiblingPrefix(worker('task A')).request);
    const b = JSON.stringify(shareSiblingPrefix(worker('task B')).request);
    const cut = a.indexOf('"harness ');
    const end = a.indexOf('}', a.indexOf('cache_control', cut)) + 1;
    expect(b.slice(0, end)).toBe(a.slice(0, end));
  });

  it('changes nothing but the one cache_control field', () => {
    const before = worker('task A');
    const after = shareSiblingPrefix(before).request;
    const strip = (r: ProviderRequest) =>
      JSON.parse(JSON.stringify(r), (k, v) =>
        k === 'cache_control' ? undefined : v
      );
    expect(strip(after)).toEqual(strip(before));
  });

  it('is deterministic, so a later turn of the same conversation keeps its prefix', () => {
    const turn2 = worker('task A');
    turn2.messages?.push({
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
    } as never);
    const one = JSON.stringify(
      m0(shareSiblingPrefix(worker('task A')).request)
    );
    const two = JSON.stringify(m0(shareSiblingPrefix(turn2).request));
    expect(two).toBe(one);
  });

  it('never exceeds the API’s four markers', () => {
    const full = worker('task A');
    (full.tools as Record<string, unknown>[])[0].cache_control = cc('1h');
    const out = shareSiblingPrefix(full);
    expect(MAX_CACHE_MARKERS).toBe(4);
    expect(out.applied).toBe('none');
    expect(out.request).toBe(full);
  });

  it('declines a shared run too short to be worth a marker', () => {
    const out = shareSiblingPrefix({
      model: 'c',
      messages: [
        { role: 'user', content: [text(100, 'a'), text(100, 'task')] },
      ],
    } as unknown as ProviderRequest);
    expect(out.applied).toBe('none');
  });

  it('declines when the client already marked inside the shared run', () => {
    const r = worker('task A');
    m0(r)[1].cache_control = cc('1h');
    expect(shareSiblingPrefix(r).applied).toBe('none');
  });
});

describe('the reorder (opt-in, pending the A/B)', () => {
  it('moves the task into its own user turn after the shared system turn', () => {
    const out = shareSiblingPrefix(subagent('fix pricing'), { reorder: true });
    expect(out.applied).toBe('reordered');
    const msgs = out.request.messages as {
      role: string;
      content: Record<string, unknown>[];
    }[];
    expect(msgs.map((m) => m.role)).toEqual(['user', 'system', 'user']);
    expect(String(msgs[2].content[0].text)).toMatch(/^fix pricing /);
    expect(msgs[0].content).toHaveLength(2);
  });

  it('makes siblings identical through the end of the shared system turn', () => {
    const a = shareSiblingPrefix(subagent('fix pricing'), {
      reorder: true,
    }).request.messages?.slice(0, 2);
    const b = shareSiblingPrefix(subagent('fix ledger'), {
      reorder: true,
    }).request.messages?.slice(0, 2);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('is on by default, after the A/B held correctness on both harness tasks', () => {
    expect(sharePrefixMode({})).toBe('reorder');
    expect(
      sharePrefixMode({ TOKEN_OPTIMIZER_PROXY_SHARE_PREFIX: 'marker' })
    ).toBe('marker');
    expect(sharePrefixMode({ TOKEN_OPTIMIZER_PROXY_SHARE_PREFIX: '0' })).toBe(
      'off'
    );
  });
});
