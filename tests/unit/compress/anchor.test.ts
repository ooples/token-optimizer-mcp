import { describe, it, expect } from '@jest/globals';
import {
  anchorDecision,
  anchorStore,
  conversationKey,
  COLD_PREFIX_LIMIT,
} from '../../../src/compress/anchor.js';
import { v1Frontier } from '../../../src/compress/strategy.js';
import type { ProviderRequest } from '../../../src/compress/frontier.js';

/**
 * Amortised re-anchoring.
 *
 * The decision this makes is the most expensive one in the package. A cache
 * read bills at 0.1x and a write at 1.25x, so answering "yes" on a large prefix
 * the provider already holds converts a cheap read into an expensive write --
 * worse than compressing nothing at all. These tests pin each branch, and the
 * benchmark's gate 4 pins the consequence: re-anchoring must never cost more
 * than leaving the prefix alone, on any workload.
 */

const payload = (seed: string, copies: number): string =>
  Array.from(
    { length: copies },
    (_, i) => `${seed} line ${i}: the quick brown fox jumps over the lazy dog`
  ).join('\n');

/** A conversation whose prefix is small enough to be an opening turn. */
function small(fresh = 'go on'): ProviderRequest {
  return {
    system: 'You are a coding agent.',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'start here',
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: fresh }] },
    ],
  };
}

/**
 * The same conversation, joined when its history is already large.
 *
 * The OPENING block is held fixed across variants, because a conversation's
 * identity is derived from it. Editing that block would produce a different
 * conversation rather than an edited one, which is not what any of these tests
 * mean to exercise -- the invalidation case edits a later part of the prefix,
 * the way a compaction or a history edit actually does.
 */
function large(tail = 'earlier turns'): ProviderRequest {
  return {
    system: 'You are a coding agent.',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'start here' }] },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `${tail}\n${payload('history', Math.ceil(COLD_PREFIX_LIMIT / 40))}`,
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'go on' }] },
    ],
  };
}

describe('conversationKey', () => {
  it('is stable across the turns of one conversation', () => {
    // Keyed on the system prompt and the opening block, both fixed for the life
    // of a conversation. Keying on the whole prefix -- which grows every turn --
    // would make each turn look like a new conversation and re-anchor forever.
    expect(conversationKey(small('turn one'))).toBe(
      conversationKey(small('turn two'))
    );
  });

  it('differs between conversations', () => {
    const other: ProviderRequest = {
      system: 'You are an SRE agent.',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'start here' }] },
      ],
    };
    expect(conversationKey(small())).not.toBe(conversationKey(other));
  });
});

describe('anchorDecision', () => {
  it('rewrites an opening turn, where the write happens either way', () => {
    const decision = anchorDecision(small(), anchorStore());
    expect(decision.reanchor).toBe(true);
    expect(decision.reason).toBe('first-turn');
  });

  it('leaves a large prefix alone when it has never seen the conversation', () => {
    // We joined mid-conversation, so the provider probably holds the client's
    // original. Spending a write on a large prefix to buy back an unknown
    // number of remaining turns is the one bet not worth taking.
    const decision = anchorDecision(large(), anchorStore());
    expect(decision.reanchor).toBe(false);
    expect(decision.reason).toBe('joined-mid-conversation');
  });

  it('keeps rewriting a conversation it already anchored', () => {
    // THE BRANCH THAT IS EASY TO GET BACKWARDS. After a free rewrite the cache
    // holds OUR prefix, so the next turn must reproduce it. Stopping would be
    // the miss, not the saving.
    const store = anchorStore();
    const first = anchorDecision(small('turn one'), store);
    store.remember(first.key, first.record);

    const second = anchorDecision(small('turn two'), store);
    expect(second.reanchor).toBe(true);
    expect(second.reason).toBe('already-anchored');
  });

  it('keeps leaving alone a conversation it already left alone', () => {
    // The mirror image, and just as important: having declined once, the
    // provider holds the client's prefix, so sending anything else now misses.
    const store = anchorStore();
    const first = anchorDecision(large(), store);
    store.remember(first.key, first.record);

    const second = anchorDecision(large(), store);
    expect(second.reanchor).toBe(false);
    expect(second.reason).toBe('left-alone');
  });

  it('rewrites when the client itself invalidated the prefix', () => {
    // An edit, a new system prompt, a compaction. That miss has already
    // happened, so what replaces it may as well be smaller.
    const store = anchorStore();
    const first = anchorDecision(large(), store);
    store.remember(first.key, first.record);

    const second = anchorDecision(large('somebody edited history'), store);
    expect(second.reanchor).toBe(true);
    expect(second.reason).toBe('client-invalidated');
  });
});

describe('anchorStore', () => {
  it('evicts least recently used, not least recently created', () => {
    const store = anchorStore(2);
    store.remember('a', { prefixDigest: '1', anchored: true });
    store.remember('b', { prefixDigest: '2', anchored: true });
    // Touching 'a' must move it to the back of the eviction queue.
    store.remember('a', { prefixDigest: '1', anchored: true });
    store.remember('c', { prefixDigest: '3', anchored: true });

    expect(store.seen('a')).toBeDefined();
    expect(store.seen('c')).toBeDefined();
    expect(store.seen('b')).toBeUndefined();
  });

  it('stays bounded', () => {
    const store = anchorStore(3);
    for (let i = 0; i < 50; i += 1)
      store.remember(`k${i}`, { prefixDigest: `${i}`, anchored: false });
    expect(store.seen('k0')).toBeUndefined();
    expect(store.seen('k49')).toBeDefined();
  });
});

describe('v1 with an anchor store', () => {
  const file = Array.from(
    { length: 14 },
    (_, i) => `export function handler${i}(input: string): string {
  const trimmed = input.trim();
  const upper = trimmed.toUpperCase();
  const parts = upper.split(',');
  return parts.join('|');
}`
  ).join('\n\n');

  const session = (fresh: string): ProviderRequest => ({
    system: 'You are a coding agent.',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'ok', cache_control: { type: 'ephemeral' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: file },
          { type: 'text', text: fresh },
        ],
      },
    ],
  });

  const prefixOf = (r: ProviderRequest): string => {
    const content = r.messages?.[0].content;
    return Array.isArray(content) ? (content[0].text ?? '') : '';
  };

  it('behaves exactly as before when given no store', () => {
    // The feature is opt-in. Without a store this is the frontier-only design
    // it has always been.
    const out = v1Frontier(session('what does handler3 do'), {});
    expect(prefixOf(out.request)).toBe('ok');
  });

  it('reproduces a byte-identical prefix across turns', () => {
    // THE PRECONDITION FOR ALL OF IT. If two turns of the same conversation
    // produce different prefixes, every turn is a cache miss and re-anchoring
    // costs 1.25x instead of saving. This is why cached content is compressed
    // without the question, which changes every turn.
    const anchors = anchorStore();
    const one = v1Frontier(session('what does handler3 do'), { anchors });
    const two = v1Frontier(session('now look at handler11 instead'), {
      anchors,
    });

    expect(prefixOf(two.request)).toBe(prefixOf(one.request));
  });

  it('lets the question steer the fresh block while the prefix stays fixed', () => {
    // The two rules working together: stability behind the breakpoint, and
    // relevance in front of it.
    const anchors = anchorStore();
    const out = v1Frontier(session('what does handler3 do'), {
      anchors,
      // The code engine needs somewhere to put the bodies it removes, or it
      // declines outright -- the same contract every engine holds to.
      spill: () => '/spill/block.txt',
    });
    const content = out.request.messages?.[1].content;
    const fresh = Array.isArray(content) ? (content[0].text ?? '') : '';

    expect(fresh.length).toBeLessThan(file.length);
    expect(fresh).toContain('handler3');
  });
});
