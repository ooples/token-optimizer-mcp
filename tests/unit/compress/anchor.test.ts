import { describe, it, expect } from '@jest/globals';
import {
  anchorDecision,
  anchorStore,
  conversationKey,
  COLD_MESSAGE_LIMIT,
  type AnchorStore,
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
            text: `${payload('history', 500)}\n${tail}`,
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
      // ENOUGH TURNS TO BE A CONVERSATION ALREADY IN FLIGHT, which is what this
      // fixture means and what the gate now actually tests. It used to mean
      // 'big prefix', because the gate compared prefix SIZE -- a stand-in that
      // was always false against a real client, whose system prompt and tool
      // schema exceed any such limit on the very first request.
      ...Array.from({ length: COLD_MESSAGE_LIMIT + 1 }, (_, i) => ({
        role: 'user' as const,
        content: [{ type: 'text', text: `go on ${i}` }],
      })),
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

  it('sees a divergence past the first four kilobytes', () => {
    // The reason samples are taken at DOUBLING offsets rather than
    // consecutively. Eight consecutive 512-byte chunks cover four kilobytes
    // and nothing after, so two conversations sharing an opening that long
    // looked identical however far they diverged later -- and 'same
    // conversation, different prefix' answers 'anchor, the miss already
    // happened', spending a write on a prefix we may not own.
    const shared = payload('shared opening', 200);
    expect(shared.length).toBeGreaterThan(4096);

    const withTail = (tail: string): ProviderRequest => ({
      system: 'You are a coding agent.',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'start here' }] },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `${shared}
${payload(tail, 400)}`,
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
        // Long enough to be a conversation already in flight, which is what
        // 'joined-mid-conversation' now means: the gate asks how far along the
        // conversation is, not how many bytes its prefix weighs.
        ...Array.from({ length: COLD_MESSAGE_LIMIT + 1 }, (_, i) => ({
          role: 'user' as const,
          content: [{ type: 'text', text: `go on ${i}` }],
        })),
      ],
    });

    const store = anchorStore();
    const one = anchorDecision(withTail('session one'), store);
    store.remember(one.key, one.record);

    // Same key, same first four kilobytes, different history after that.
    const two = anchorDecision(withTail('session two'), store);
    expect(two.reason).toBe('joined-mid-conversation');
    expect(two.reanchor).toBe(false);
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
      samples: ['h1'],
      anchored: true,
    });
    store.remember('b', {
      prefixDigest: '2',
      samples: ['h2'],
      anchored: true,
    });
    // Touching 'a' must move it to the back of the eviction queue.
    store.remember('a', {
      prefixDigest: '1',
      samples: ['h1'],
      anchored: true,
    });
    store.remember('c', {
      prefixDigest: '3',
      samples: ['h3'],
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
        samples: [`h${i}`],
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

describe('a declined rewrite is reconsidered as the conversation grows', () => {
  // WHY THE FIRST REFUSAL MUST NOT BE FINAL. Rewriting the cached prefix has to
  // repay its own 1.25x cache write out of 0.1x reads, so it is refused while
  // the saving is too small. Early in a session there is barely any history to
  // remove, so the saving is ALWAYS small then -- and treating that refusal as
  // permanent left the rest of the session uncompressed.
  //
  // Measured in a six-turn simulation: declined at 10.3% on turn two, worth
  // 22.7% by turn six. Before this, turns two through six all removed nothing.
  const NEWLINE = String.fromCharCode(10);
  const body = (n: number): string =>
    Array.from(
      { length: n },
      (_, i) =>
        `export function helper${i}(input: number): number {` +
        NEWLINE +
        `  const doubled = input * 2;` +
        NEWLINE +
        `  const shifted = doubled + ${i};` +
        NEWLINE +
        `  return shifted;` +
        NEWLINE +
        `}`
    ).join(NEWLINE);

  const conversation = (turns: number): ProviderRequest => {
    const messages: unknown[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'fix the failing test' }],
      },
    ];
    for (let i = 0; i < turns; i += 1) {
      messages.push({
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: `t${i}`,
            name: 'Read',
            input: { file_path: `f${i}.ts` },
          },
        ],
      });
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: `t${i}`,
            content: [{ type: 'text', text: body(60) }],
            ...(i === turns - 1
              ? { cache_control: { type: 'ephemeral' } }
              : {}),
          },
        ],
      });
    }
    return {
      system: 'You are a coding agent. '.repeat(400),
      messages,
    } as unknown as ProviderRequest;
  };

  const removedFrom = (
    request: ProviderRequest,
    anchors: AnchorStore
  ): number => {
    const before = JSON.stringify(request).length;
    const out = v1Frontier(request, { spill: () => '/spill/x.txt', anchors });
    if (out.anchor) anchors.remember(out.anchor.key, out.anchor.record);
    return before - JSON.stringify(out.request).length;
  };

  it('adopts the rewrite on a later turn after refusing an early one', () => {
    const anchors = anchorStore();

    // A first turn with almost no history: the rewrite cannot repay its write.
    const early = removedFrom(conversation(1), anchors);
    expect(early).toBe(0);

    // The same conversation once it has accumulated enough to be worth it --
    // both in saving AND in length, since the write only repays out of the
    // turns that follow it, and a session that ends first has just paid it.
    const later = removedFrom(conversation(24), anchors);
    expect(later).toBeGreaterThan(0);
  });

  it('keeps refusing while the saving stays below the floor', () => {
    // The other half, without which the test above would pass against a rule
    // that simply always rewrote.
    const anchors = anchorStore();
    expect(removedFrom(conversation(1), anchors)).toBe(0);
    expect(removedFrom(conversation(1), anchors)).toBe(0);
  });
});
