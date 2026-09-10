/**
 * Amortised re-anchoring: rewriting history when the rewrite is already paid for.
 *
 * THE ECONOMICS, because every decision here follows from them. Anthropic bills
 * a cache read at 0.1x the base input rate and a cache write at 1.25x. So
 * rewriting a cached prefix is not a small cost -- it converts 50,000 tokens
 * billed as 5,000 into 50,000 billed at the write rate. Compression that busts
 * the cache can cost several times what it saves, which is why V1 refuses to
 * touch anything at or before the last breakpoint.
 *
 * WHAT THAT REFUSAL GETS WRONG. It assumes the provider's cache holds the
 * CLIENT'S prefix. That is only true when something other than us put it there.
 * Once we are in the path and rewriting deterministically, the cache holds OUR
 * prefix -- so re-deriving the same bytes next turn HITS, on a prefix that is a
 * fraction of the size. The write is paid once and read back cheaply for the
 * rest of the conversation. That is the amortisation.
 *
 * THREE SITUATIONS, AND THEY GET DIFFERENT ANSWERS:
 *
 *   we anchored this conversation before   rewrite again, identically. The
 *                                          cache holds our bytes; reproducing
 *                                          them is a hit. Stopping now would
 *                                          be the miss.
 *
 *   we have never seen it, and it is small  rewrite. The prefix is written
 *                                          either way on a first turn, and a
 *                                          compressed one is cheaper to write.
 *
 *   we have never seen it, and it is large  leave it alone. We joined
 *                                          mid-conversation, so the provider
 *                                          probably holds the client's
 *                                          original; rewriting spends a write
 *                                          on a large prefix to buy back an
 *                                          unknown number of remaining turns.
 *
 * ONCE ANCHORED, ALWAYS ANCHORED -- for a given prefix. This is the part that
 * is easy to get backwards: the decision cannot be "rewrite only when it is
 * free", because the turn after a free rewrite is precisely when NOT rewriting
 * would miss. What is remembered is therefore not just the prefix but whether
 * we anchored it.
 *
 * THE PRECONDITION IS DETERMINISM. Re-anchoring only works if next turn
 * re-derives byte-identical bytes for the same history. Two things had to
 * change for that to hold: cached content is compressed WITHOUT the question
 * (`strategy.ts` -- the question changes every turn), and the spill sink is
 * content-addressed (`proxy/server.ts` -- a random path per call changes the
 * output). Neither is optional; without them this makes billing worse.
 *
 * NO PER-REQUEST STATE ON A SHARED OBJECT. HeadRoom's #3486 is one shared
 * `ContentRouter` keeping request state on `self`, so concurrent requests
 * cross-contaminate. What is kept here is per CONVERSATION, is only ever a hash
 * plus a boolean, is passed in explicitly, and is consulted for nothing but
 * this one question.
 */

import { createHash } from 'node:crypto';
import {
  isAfter,
  lastCacheBreakpoint,
  type Block,
  type ProviderRequest,
} from './frontier.js';

/**
 * How many conversations are remembered.
 *
 * Bounded because this lives in a long-running proxy and an unbounded map keyed
 * by conversation is a slow leak. Least-recently-used eviction: a conversation
 * untouched across a thousand others is over.
 */
export const MAX_TRACKED = 1000;

/**
 * Above this many characters of cached prefix, a conversation we have never
 * seen is left alone.
 *
 * The trade is a one-time write against an unknown number of remaining turns.
 * Small prefixes are cheap to be wrong about; a large one on a conversation
 * that ends next turn is the single most expensive mistake available here, and
 * it is worse than compressing nothing. Roughly five thousand tokens.
 */
export const COLD_PREFIX_LIMIT = 20_000;

/** Everything at or before the breakpoint, which is what the provider caches. */
function prefixOf(request: ProviderRequest): string {
  const breakpoint = lastCacheBreakpoint(request);
  const parts: string[] = [
    typeof request.system === 'string'
      ? request.system
      : JSON.stringify(request.system ?? ''),
  ];
  (request.messages ?? []).forEach((message, mi) => {
    const content = message?.content;
    if (!Array.isArray(content)) return;
    content.forEach((raw, bi) => {
      const block = raw as Block;
      if (typeof block?.text !== 'string') return;
      if (isAfter({ message: mi, block: bi }, breakpoint)) return;
      parts.push(block.text);
    });
  });
  return parts.join(' ');
}

const digest = (text: string): string =>
  createHash('sha256').update(text).digest('hex').slice(0, 32);

/**
 * Identity of a conversation, stable across its turns.
 *
 * The system prompt plus the first text block: both are fixed for the life of a
 * conversation and differ between conversations. NOT the whole prefix, which
 * grows every turn -- keying on that would make each turn look like a new
 * conversation, report "never seen" forever, and re-anchor on every request,
 * which is the behaviour this exists to avoid.
 */
export function conversationKey(request: ProviderRequest): string {
  const system =
    typeof request.system === 'string'
      ? request.system
      : JSON.stringify(request.system ?? '');
  const first = (request.messages ?? [])
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .map((raw) => (raw as Block)?.text)
    .find((text): text is string => typeof text === 'string');
  return digest(`${system} ${first ?? ''}`);
}

/** What we last did for one conversation. */
export interface AnchorRecord {
  /** Digest of the CLIENT's prefix as it arrived, so a change is detectable. */
  readonly prefixDigest: string;
  /** Did we rewrite that prefix? */
  readonly anchored: boolean;
}

export interface AnchorStore {
  seen(key: string): AnchorRecord | undefined;
  remember(key: string, record: AnchorRecord): void;
}

/** An in-memory store, bounded and explicit. */
export function anchorStore(max = MAX_TRACKED): AnchorStore {
  const records = new Map<string, AnchorRecord>();
  return {
    seen: (key) => records.get(key),
    remember(key, record) {
      // Re-inserting moves it to the end, so eviction is genuinely least
      // recently USED rather than least recently created.
      records.delete(key);
      records.set(key, record);
      while (records.size > max) {
        const oldest = records.keys().next().value;
        if (oldest === undefined) break;
        records.delete(oldest);
      }
    },
  };
}

export type AnchorReason =
  | 'already-anchored'
  | 'first-turn'
  | 'client-invalidated'
  | 'joined-mid-conversation'
  | 'left-alone';

export interface AnchorDecision {
  /** Rewrite history on this turn? */
  readonly reanchor: boolean;
  readonly reason: AnchorReason;
  /** The conversation this decision was made for. */
  readonly key: string;
  /** Record this once the request is built, so the next turn can compare. */
  readonly record: AnchorRecord;
}

/**
 * Decides whether history may be rewritten on this turn.
 *
 * CONSERVATIVE WHERE IT IS UNCERTAIN, consistent where it is not. The one case
 * that spends money for nothing -- rewriting a large prefix the provider has
 * cached in its original form -- is the one case that answers no.
 */
export function anchorDecision(
  request: ProviderRequest,
  store: AnchorStore
): AnchorDecision {
  const key = conversationKey(request);
  const prefix = prefixOf(request);
  const prefixDigest = digest(prefix);
  const previous = store.seen(key);

  if (previous && previous.prefixDigest === prefixDigest) {
    // Unchanged prefix: do exactly what we did last time, whatever that was.
    // Consistency IS the cache hit here -- switching either way is the miss.
    return {
      reanchor: previous.anchored,
      reason: previous.anchored ? 'already-anchored' : 'left-alone',
      key,
      record: previous,
    };
  }

  if (previous) {
    // The client changed history under us: an edit, a new system prompt, a
    // compaction. That miss has already happened, so what replaces it may as
    // well be smaller.
    return {
      reanchor: true,
      reason: 'client-invalidated',
      key,
      record: { prefixDigest, anchored: true },
    };
  }

  if (prefix.length <= COLD_PREFIX_LIMIT) {
    // A conversation at its start. The prefix is written either way.
    return {
      reanchor: true,
      reason: 'first-turn',
      key,
      record: { prefixDigest, anchored: true },
    };
  }

  return {
    reanchor: false,
    reason: 'joined-mid-conversation',
    key,
    record: { prefixDigest, anchored: false },
  };
}
