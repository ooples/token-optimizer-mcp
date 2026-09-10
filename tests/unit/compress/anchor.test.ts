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
 * A conversation joined when its history is already large.
 *
 * TWO VARIATION POINTS, AND THEY MEAN DIFFERENT THINGS. `tail` changes the END
 * of the prefix, which is what a history edit or a compaction does to a
 * conversation that is still the same conversation. `opening` changes its
 * START, which is what a DIFFERENT conversation looks like -- including one
 * that hashes to the same key because its system prompt and first message
 * happen to match.
 *
 * The distinction is the whole subject of the head digest, so the fixture has
 * to be able to express both, and the tail variant must sit beyond the first
 * few KB or it would move the head too and prove nothing.
 */
function large(
  tail = 'earlier turns',
  opening = 'start here'
): ProviderRequest {
  return {
    system: 'You are a coding agent.',
    messages: [
      { role: 'user', content: [{ type: 'text', text: opening }] },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `${payload('history', Math.ceil(COLD_PREFIX_LIMIT / 40))}\n${tail}`,
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

  it('does not treat a colliding conversation as an edited one', () => {
    // Two sessions whose system prompt and opening message are identical share
    // a key -- a user who starts two conversations with the same first message.
    // Without the head digest the second looks like the first with its history
    // rewritten, and the answer to that is "anchor, the miss already happened",
    // which would spend a 1.25x write on a large prefix the provider holds in
    // its original form.
    const store = anchorStore();
    const anchored = anchorDecision(large(), store);
    store.remember(anchored.key, anchored.record);

    // A store that hands back the OTHER conversation's record under this key,
    // which is exactly what a hash collision produces. Stubbed rather than
    // constructed, because `conversationKey` deliberately cannot see enough of
    // the request to be forced into a collision from the outside.
    const collided = anchorDecision(large('x', 'a different opening'), {
      seen: () => anchored.record,
      remember: () => {},
    });

    expect(collided.reason).toBe('joined-mid-conversation');
    expect(collided.reanchor).toBe(false);
  });

  it('still calls a genuine edit an edit', () => {
    // The other half: same opening, changed tail. Without this, the test above
    // would pass just as well against a rule that never re-anchored anything.
    const store = anchorStore();
    const first = anchorDecision(large(), store);
    store.remember(first.key, first.record);

    const edited = anchorDecision(large('a compaction rewrote this'), store);
    expect(edited.reason).toBe('client-invalidated');
    expect(edited.reanchor).toBe(true);
  });
});

describe('anchorStore', () => {
  it('evicts least recently used, not least recently created', () => {
    const store = anchorStore(2);
    store.remember('a', {
      prefixDigest: '1',
      headChunks: ['h1'],
      anchored: true,
    });
    store.remember('b', {
      prefixDigest: '2',
      headChunks: ['h2'],
      anchored: true,
    });
    // Touching 'a' must move it to the back of the eviction queue.
    store.remember('a', {
      prefixDigest: '1',
      headChunks: ['h1'],
      anchored: true,
    });
    store.remember('c', {
      prefixDigest: '3',
      headChunks: ['h3'],
      anchored: true,
    });

    expect(store.seen('a')).toBeDefined();
    expect(store.seen('c')).toBeDefined();
    expect(store.seen('b')).toBeUndefined();
  });

  it('stays bounded', () => {
    const store = anchorStore(3);
    for (let i = 0; i < 50; i += 1)
      store.remember(`k${i}`, {
        prefixDigest: `${i}`,
        headChunks: [`h${i}`],
        anchored: false,
      });
    expect(store.seen('k0')).toBeUndefined();
    expect(store.seen('k49')).toBeDefined();
  });
});

describe('v1 with an anchor store', () => {
  /**
   * DISTINCT BODIES, so a test can tell WHICH one survived.
   *
   * With identical bodies the assertions below pass whenever any single body
   * remains -- including the wrong one -- which proves that something was kept
   * and nothing at all about relevance. Every signature survives compression
   * too, so asserting on the NAME would be just as vacuous. The unique marker
   * line inside each body is the only thing that discriminates.
   */
  const file = Array.from(
    { length: 14 },
    (_, i) => `export function handler${i}(input: string): string {
  const trimmed = input.trim();
  const marker = 'body-of-handler${i}';
  const parts = trimmed.toUpperCase().split(',');
  return marker + parts.join('|');
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

  /**
   * V1 plus the commit step the proxy performs.
   *
   * The strategy returns what to remember rather than writing it, because the
   * proxy still discards a rewrite that did not come out smaller. A test that
   * skipped this step would report `first-turn` on every call and prove
   * nothing about the turn-to-turn behaviour it claims to test.
   */
  const anchored = (
    request: ProviderRequest,
    anchors: ReturnType<typeof anchorStore>,
    options: { spill?: () => string } = {}
  ) => {
    const result = v1Frontier(request, { ...options, anchors });
    if (result.anchor)
      anchors.remember(result.anchor.key, result.anchor.record);
    return result;
  };

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
    const out = anchored(session('what does handler3 do'), anchors, {
      // The code engine needs somewhere to put the bodies it removes, or it
      // declines outright -- the same contract every engine holds to.
      spill: () => '/spill/block.txt',
    });
    const content = out.request.messages?.[1].content;
    const fresh = Array.isArray(content) ? (content[0].text ?? '') : '';

    expect(fresh.length).toBeLessThan(file.length);
    // The body the question named survives, and a neighbour's does not.
    expect(fresh).toContain("body-of-handler3'");
    expect(fresh).not.toContain("body-of-handler11'");
  });
});
