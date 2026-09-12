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
  type Position,
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
/**
 * How many messages a conversation may already have and still count as one we
 * are seeing from its start.
 *
 * THIS REPLACED A PREFIX-SIZE TEST, and the replacement is the whole point.
 * The old rule anchored only when the cached prefix was under 20,000
 * characters, as a stand-in for "did we see this conversation from the
 * beginning". Against Claude Code that stand-in is always false: its system
 * prompt and tool schema alone exceed 20,000 characters on the very first
 * request, so every conversation was classified as joined-mid-conversation,
 * the proxy never anchored, v1 kept respecting a frontier that sits at the
 * newest turn, and NOTHING was ever compressed -- measured at 0 bytes removed
 * across 44 real requests in two campaigns.
 *
 * Message count asks the question directly. A proxy running before its client
 * sees the conversation at one or two messages however heavy they are; a proxy
 * attached to a session already in flight sees many, and still declines --
 * which is the protection the old limit was there to provide.
 */
export const COLD_MESSAGE_LIMIT = 4;

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
    // A STRING AND A ONE-TEXT-BLOCK ARRAY ARE THE SAME MESSAGE, and this
    // used to skip the string form entirely -- so the text vanished from the
    // digest and the prefix read as changed.
    //
    // That is not hypothetical. Claude Code sends the SessionStart block as
    // an array of text blocks on one turn and as a plain string on the next:
    // captured back to back, message 0 was byte-identical while message 1
    // carried the same 22,755 characters in a different container. Every
    // turn therefore reported client-invalidated, the conversation was never
    // recognised, and anything keyed on recognising it never ran.
    if (typeof content === 'string') {
      if (!isAfter({ message: mi, block: 0 }, breakpoint)) parts.push(content);
      return;
    }
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
  // `metadata.user_id` when the client sends one (Anthropic documents the
  // field and Claude Code populates it). It does not separate two
  // conversations from the same person, but it costs nothing and removes
  // every collision between different people -- which is the larger set.
  const metadata = request.metadata as { user_id?: unknown } | undefined;
  const user = typeof metadata?.user_id === 'string' ? metadata.user_id : '';
  return digest(`${user} ${system} ${first ?? ''}`);
}

/**
 * The prefix, digested in fixed-size chunks.
 *
 * WHY CHUNKS AND NOT ONE DIGEST OF THE OPENING. A conversation grows by
 * APPENDING, so what identifies it is that the earlier bytes are still there
 * -- but the cached prefix does not merely gain a tail, it gains whole
 * messages as the breakpoint advances. Turn one might cache nothing but the
 * system prompt; turn two caches the system prompt and two messages. A
 * single digest of "the first few KB" therefore changes between two turns of
 * the SAME conversation, which is precisely the case that must be
 * recognised: measured, it stopped anchoring engaging at all and took the
 * sre-debugging arm from 844 steady tokens back to 1,740.
 *
 * Chunks are aligned to fixed offsets, so growth leaves the earlier ones
 * untouched and "is this the conversation we were serving?" becomes "are the
 * chunks we recorded still the chunks at the front?". Digests rather than
 * the text itself, because this is retained across requests and there is no
 * reason for a proxy to hold onto a kilobyte of anybody's conversation.
 */
const CHUNK_BYTES = 512;

/**
 * Samples are taken at DOUBLING offsets, not consecutively.
 *
 * Eight consecutive chunks cover the first four kilobytes and nothing after,
 * so two conversations that share an opening of that length look identical
 * however far they diverge later -- and the answer to "same conversation,
 * different prefix" is "anchor, the miss already happened", which spends a
 * 1.25x write on a prefix we may not own. Doubling offsets keep the sample
 * count logarithmic in the prefix size while covering all of it: a 32 KB
 * prefix takes seven samples, a megabyte twelve.
 *
 * Offsets are absolute, so growth leaves every earlier sample exactly where
 * it was -- which is what makes comparing the overlap meaningful.
 *
 * WHAT THIS DOES NOT PROMISE. Sampling is sampling: two prefixes that agree
 * at every sampled window and differ only between them read as the same
 * conversation. That is a bounded residual, it grows less likely as the
 * prefix does, and its worst outcome is one avoidable cache write -- not
 * wrong content. It is recorded rather than dressed up as a proof.
 */
const MAX_SAMPLES = 12;

function prefixSamples(prefix: string): string[] {
  const samples: string[] = [];
  for (
    let at = 0;
    at + CHUNK_BYTES <= prefix.length && samples.length < MAX_SAMPLES;
    at = at === 0 ? CHUNK_BYTES : at * 2
  ) {
    samples.push(digest(prefix.slice(at, at + CHUNK_BYTES)));
  }
  return samples;
}

/**
 * Is `now` the same conversation as the one `before` was recorded for?
 *
 * True when every complete chunk they have in common matches. An empty
 * overlap -- the recorded prefix was shorter than one chunk -- answers TRUE,
 * and deliberately: a prefix that small means we joined at the very start of
 * the conversation, so we served its earlier turns and nothing of the
 * client's original is in the provider's cache to be protected.
 */
function isContinuation(
  before: readonly string[],
  now: readonly string[]
): boolean {
  const shared = Math.min(before.length, now.length);
  for (let i = 0; i < shared; i += 1) {
    if (before[i] !== now[i]) return false;
  }
  return true;
}

/** What we last did for one conversation. */
export interface AnchorRecord {
  /** Digest of the CLIENT's prefix as it arrived, so a change is detectable. */
  readonly prefixDigest: string;
  /**
   * Length of the prefix that digest covers.
   *
   * WITH IT, EXTENSION IS PROVABLE. Re-digesting exactly this many
   * characters of the new prefix and comparing answers "is what I saw last
   * time still an exact prefix of what I see now" -- which separates a
   * conversation that grew from one whose history was edited. A sample
   * comparison cannot: samples are spot checks at doubling offsets, so an
   * edit that lands between two of them passes, and a test pinning that
   * exact case is what caught the guess.
   */
  readonly prefixLength?: number;
  /**
   * Digests sampled across that prefix, at doubling offsets.
   *
   * THIS IS WHAT SEPARATES AN EDIT FROM A COLLISION. Two different sessions
   * whose system prompt and opening message are identical -- a user who
   * starts two conversations with "fix the tests" -- share a key. Without
   * this, the second one looks like the first with its history rewritten,
   * and the answer to that is "anchor, the miss already happened", which
   * would spend a 1.25x write on a large prefix the provider is holding in
   * its original form. With it, an unrelated conversation is recognised as
   * unrelated and falls back to the size rule for a first sighting.
   */
  readonly samples: readonly string[];
  /** Did we rewrite that prefix? */
  readonly anchored: boolean;
  /**
   * Where this conversation's cache breakpoint sat when we last saw it.
   *
   * THE ONE FACT THAT SAYS WHAT IS NOT YET CACHED. A client puts its
   * cache_control marker on the LAST message of every request -- verified
   * across three consecutive captured turns, which reported breakpoints at
   * message 1 of 2, 3 of 4 and 5 of 6 -- so "after the breakpoint in THIS
   * request" is always empty and a frontier policy reading it compresses
   * nothing at all.
   *
   * Between the breakpoint we saw last turn and the one in this request
   * lies everything the conversation has grown since, which the provider
   * has not cached yet and is about to cache now. Rewriting THAT costs no
   * invalidation, shrinks the 1.25x write happening this turn, and shrinks
   * every 0.1x read after it.
   */
  readonly breakpoint?: Position | null;
  /**
   * The knowledge block we last put in this prefix, if any.
   *
   * Kept here because it IS part of the prefix, and the prefix has to
   * arrive byte-identical every turn. Re-selecting findings each turn
   * would rewrite it each turn and convert a 0.1x read into a 1.25x write
   * on everything -- so the block is chosen once and replayed verbatim
   * until a turn on which rewriting is already free. Null means nothing
   * was injected and nothing may start being injected without a rewrite.
   */
  readonly knowledge?: string | null;
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
  /** The same conversation, one or more turns longer. The common case. */
  | 'extended'
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
  store: AnchorStore,
  coldMessageLimit: number = COLD_MESSAGE_LIMIT
): AnchorDecision {
  const key = conversationKey(request);
  const prefix = prefixOf(request);
  const prefixDigest = digest(prefix);
  const samples = prefixSamples(prefix);
  const previous = store.seen(key);
  const sameConversation = previous
    ? isContinuation(previous.samples, samples)
    : false;

  if (previous && sameConversation && previous.prefixDigest === prefixDigest) {
    // Unchanged prefix: do exactly what we did last time, whatever that was.
    // Consistency IS the cache hit here -- switching either way is the miss.
    return {
      reanchor: previous.anchored,
      reason: previous.anchored ? 'already-anchored' : 'left-alone',
      key,
      record: previous,
    };
  }

  if (previous && sameConversation) {
    // GROWTH IS NOT AN EDIT, and conflating them cost this design its whole
    // purpose. isContinuation has already established that every sample the
    // two prefixes share is identical, so a differing digest with no fewer
    // samples than before means the conversation got LONGER, not that
    // anything cached was rewritten -- which is what happens on every single
    // turn, because the client moves its cache_control marker forward and the
    // prefix legitimately extends.
    //
    // Captured back to back: between two turns message 3 differed only by the
    // removal of its cache_control marker, its 20,026 characters of text
    // byte-identical, and the prefix simply reached further. Calling that
    // 'client-invalidated' forced a rewrite every turn and meant the
    // conversation was never once recognised as continuing.
    //
    // Safe by construction: this keeps whatever posture we already had
    // (`previous.anchored`) rather than switching, and carries the stored
    // breakpoint forward, so nothing before it is touched either way.
    const grew =
      previous.prefixLength !== undefined &&
      prefix.length >= previous.prefixLength &&
      digest(prefix.slice(0, previous.prefixLength)) === previous.prefixDigest;
    if (grew) {
      return {
        reanchor: previous.anchored,
        reason: 'extended',
        key,
        record: {
          ...previous,
          prefixDigest,
          prefixLength: prefix.length,
          samples,
        },
      };
    }

    // Genuinely shorter: history was compacted or edited away under us.
    // That miss has already happened, so what replaces it may as well be
    // smaller.
    return {
      reanchor: true,
      reason: 'client-invalidated',
      key,
      record: {
        prefixDigest,
        prefixLength: prefix.length,
        samples,
        anchored: true,
      },
    };
  }

  // Either nothing is known, or the key belongs to a DIFFERENT conversation
  // that opened the same way. Both are first sightings, and both answer the
  // same question: is this prefix small enough that being wrong is cheap?

  // THE DIAL, NOT THE CONSTANT. `coldPrefixLimit` was declared in options.ts with this
  // exact meaning and a matching default, while this line read the module constant --
  // so setting it changed nothing, on the most expensive decision in this file.
  // EARLY IN ITS LIFE, NOT SMALL. A first request can be enormous -- a large
  // system prompt and a full tool schema arrive before the user has said
  // anything -- and it is still a conversation we are seeing from the start,
  // where the prefix is written either way and anchoring is free.
  if ((request.messages ?? []).length <= coldMessageLimit) {
    return {
      reanchor: true,
      reason: 'first-turn',
      key,
      record: {
        prefixDigest,
        prefixLength: prefix.length,
        samples,
        anchored: true,
      },
    };
  }

  return {
    reanchor: false,
    reason: 'joined-mid-conversation',
    key,
    record: {
      prefixDigest,
      prefixLength: prefix.length,
      samples,
      anchored: false,
    },
  };
}
