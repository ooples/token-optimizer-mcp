/**
 * The four arms, behind one interface, so the benchmark can compare them.
 *
 *   V1 frontier      compress only what arrives after the last cache
 *                    breakpoint; elisions name a readable path
 *   V2 speculative   V1, plus re-inflate a span the model's last reply shows it
 *                    is about to need -- on a request that was happening anyway
 *   V3 history       V1's markers, applied behind the frontier too
 *   ccr              a faithful imitation of HeadRoom: opaque hash markers, an
 *                    injected retrieval tool, an injected system message, and
 *                    history compressed. The control we have to beat.
 *
 * The ccr arm exists so the comparison is against their DESIGN rather than
 * against their marketing. It is implemented honestly -- if it wins, it wins,
 * and the plan says to stop and report rather than ship the proxy.
 */

import { compressBlock } from './router.js';
import { substituteHistory } from './history.js';
import { dedupBlocks, type DedupBlock } from './dedup.js';
import { queryFrom } from './relevance.js';
import type { Tuning } from './options.js';
import type { EmbeddingCache } from './embedding.js';
import { dedupImages, isImageBlock } from './images.js';
import {
  injectKnowledge,
  knowledgeBlock,
  stableContext,
  type Finding,
} from './knowledge.js';
import {
  anchorDecision,
  type AnchorDecision,
  type AnchorStore,
} from './anchor.js';
import {
  isAfter,
  lastCacheBreakpoint,
  messageIsSigned,
  type Block,
  type Message,
  type Position,
  type ProviderRequest,
} from './frontier.js';
import type { Elision } from './types.js';

export type StrategyName =
  | 'v1-frontier'
  | 'v2-speculative'
  | 'v3-history'
  | 'v4-substitute'
  | 'ccr';

export interface StrategyOptions {
  /** Writes content with no file of its own somewhere readable. */
  readonly spill?: (content: string, hint: string) => string;
  /**
   * V2 only: spans the model's previous reply suggests it is about to need.
   * Supplied by the caller so this stays a pure function of its inputs.
   */
  readonly wanted?: readonly string[];
  /**
   * Memory of which conversations we have already re-anchored.
   *
   * Supplied by the caller rather than held here, so this module keeps no
   * state of its own and two concurrent requests cannot observe each
   * other's -- HeadRoom's #3486 is exactly that bug. Absent means V1 behaves
   * as it always has and never touches the cached prefix.
   */
  readonly anchors?: AnchorStore;
  /**
   * What this project already established, for the cached prefix.
   *
   * Supplied by the caller rather than read here, because reaching for a
   * graph on disk would make a pure function of (request, options) into
   * something that depends on the filesystem. Absent means nothing is
   * injected, which is the default: this is payload, and it has to be
   * asked for.
   */
  readonly findings?: readonly Finding[];
  /** True when `findings` came from a graph shared across projects. */
  readonly sharedGraph?: boolean;
  /** Characters of findings allowed in the prefix. */
  readonly knowledgeBudget?: number;
  /**
   * Vectors a request-level pre-pass already computed.
   *
   * Supplied by the caller, never built here: embedding is async and these
   * strategies are synchronous all the way down. See `embedding.ts`.
   */
  readonly embeddings?: EmbeddingCache;
  /**
   * The resolved dials.
   *
   * Resolved by the CALLER and held fixed for the life of a proxy, because
   * changing a dial mid-session changes how the cached prefix compresses --
   * and a prefix that changes is a cache miss on everything.
   */
  readonly tuning?: Tuning;
}

export interface StrategyResult {
  readonly request: ProviderRequest;
  readonly elisions: readonly Elision[];
  /** Tokens of preamble this strategy ADDED to the request. */
  readonly injectedChars: number;
  /**
   * What to remember about this conversation IF this request is the one sent.
   *
   * Uncommitted on purpose: a caller that decides not to use the rewritten body
   * must not leave a record saying it did. Commit it with
   * `anchors.remember(anchor.key, anchor.record)` once the body is accepted.
   */
  readonly anchor?: AnchorDecision;
}

/** The system message HeadRoom appends, reproduced from ccr/tool_injection.py:143. */
const CCR_SYSTEM = `
## Compressed Context Available

Some tool outputs have been compressed to reduce context size. If you need
the full uncompressed data, you can retrieve it using the \`headroom_retrieve\` tool.

**How to retrieve:**
- Call \`headroom_retrieve(hash="<hash>")\` to get the full original content back

**Available hashes:** {HASHES}

Look for markers like \`[N items compressed to M. Retrieve more: hash=abc123]\`
in tool results to find the hash for each compressed output.
`;

/** The tool definition HeadRoom injects alongside it. */
const CCR_TOOL = {
  name: 'headroom_retrieve',
  description:
    'Retrieve the original, uncompressed content for a compression marker. Call this when you need the full data behind a <<ccr:...>> marker.',
  input_schema: {
    type: 'object',
    properties: {
      hash: {
        type: 'string',
        description:
          "Hash key from the compression marker (e.g., 'abc123' from hash=abc123)",
      },
    },
    required: ['hash'],
  },
};

/** Their opaque marker form, from ccr/marker_resolution.py:36. */
function ccrMarker(content: string, index: number): string {
  const hash = Buffer.from(`${index}:${content.length}`)
    .toString('hex')
    .slice(0, 12)
    .padEnd(12, '0');
  return `<<ccr:${hash},blob,${content.length}>>`;
}

/**
 * What the agent is asking, read off the request itself.
 *
 * Only SHORT blocks count. The last message in an agentic conversation is
 * usually a tool result -- tens of kilobytes of the very content being
 * compressed -- and tokenising that as the question would make every block
 * maximally relevant to itself. That failure would look like it was working,
 * which is the worst kind.
 */
export function questionIn(request: ProviderRequest): string {
  const blocks: { text: string }[] = [];
  for (const message of request.messages ?? []) {
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    for (const raw of content) {
      const block = raw as Block;
      if (typeof block?.text === 'string') blocks.push({ text: block.text });
    }
  }
  const system = typeof request.system === 'string' ? request.system : '';
  return `${system}\n${queryFrom(blocks)}`.trim();
}

/**
 * The steering text for TOOL deferral, which must not move during a session.
 *
 * WHY THIS IS NOT `questionIn`. Both pick what is relevant, but they rewrite
 * different halves of the request and only one of them is cached. Content
 * compression works AFTER the cache frontier, so it may follow the live
 * question and change every turn at no cost. Tool deferral rewrites the tools
 * array, which sits at the FRONT of the prefix -- so if its steering text
 * changes, the chosen tools change, the prefix changes, and every cached token
 * behind it is invalidated.
 *
 * MEASURED, and it is not a small effect. Steering deferral with `questionIn`
 * kept a stable COUNT of 14 deferred tools while producing 11 distinct
 * `deferredToolChars` values across 41 requests -- the same number of tools,
 * but a different set each turn. Cache creation went from 2,188 tokens per
 * request to 7,048 while cache reads fell from 30,307 to 14,181: weighting
 * writes at 1.25x and reads at 0.1x, that is 5,766 -> 10,228, so the feature
 * that removes 38,322 characters per request made the bill 1.77x WORSE.
 *
 * The first user turn is the task, and the task does not change while it is
 * being worked on. Relevance to it is what tool selection actually wants.
 */
export function taskIn(request: ProviderRequest): string {
  const system = typeof request.system === 'string' ? request.system : '';
  for (const message of request.messages ?? []) {
    if (message?.role !== 'user') continue;
    const content = message.content;
    if (typeof content === 'string') {
      if (content.trim()) return `${system}\n${content}`.trim();
      continue;
    }
    if (!Array.isArray(content)) continue;
    const text = content
      .map((raw) => (raw as Block)?.text)
      .filter((t): t is string => typeof t === 'string')
      .join('\n');
    // A first turn carrying only an image or a tool result has no task text to
    // steer with; keep looking rather than steering on nothing.
    if (text.trim()) return `${system}\n${text}`.trim();
  }
  return system.trim();
}

/** Walks every text-bearing block, letting the visitor replace its text. */
/** The elision marker `pathAddressed` leaves behind. */
const ELIDED = /\[\.\.\. body, [^\]]+\]/;

/** The untouched text at a position in the request the strategy was given. */
function blockTextAt(request: ProviderRequest, at: Position): string | null {
  const content = request.messages?.[at.message]?.content;
  if (!Array.isArray(content)) return null;
  const block = content[at.block] as Block | undefined;
  return typeof block?.text === 'string' ? block.text : null;
}

/** A tool result, whose payload is nested rather than on `text`. */
interface ToolResultBlock {
  readonly type: string;
  readonly content?: unknown;
  /** Links this result back to the call that produced it. */
  readonly tool_use_id?: string;
}

/** An assistant's call, which is where a tool result's provenance lives. */
interface ToolUseBlock {
  readonly type: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: Record<string, unknown>;
}

/**
 * Which file each tool result came from, keyed by the call that produced it.
 *
 * WITHOUT THIS THE CODE ENGINE IS INERT, and measurably so. compressCode
 * resolves a language from `ctx.sourcePath`; a tool result arrives with no
 * path attached, so the language came out empty, the Babel fallback returned
 * nothing, and the engine reported 0.0% on content it compresses 55.6% when
 * told the path -- 17,130 characters to 7,604 with seven elisions, measured on
 * a captured request reading src/compress/log.ts.
 *
 * The path was never missing, only unlinked: the result carries a
 * `tool_use_id` and the matching `tool_use` block sits in the SAME request,
 * carrying `{ file_path }`. This walks the assistant turns once and builds
 * the index the walker then reads.
 *
 * Names are not assumed. Any input key that looks like a path is accepted, so
 * a client calling its reader something other than `Read` still benefits and
 * this does not rot the next time a tool is renamed.
 */
function toolResultPaths(request: ProviderRequest): Map<string, string> {
  const paths = new Map<string, string>();
  for (const message of request.messages ?? []) {
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    for (const raw of content) {
      const block = raw as ToolUseBlock;
      if (block?.type !== 'tool_use') continue;
      if (typeof block.id !== 'string' || !block.input) continue;
      for (const key of ['file_path', 'path', 'filePath', 'notebook_path']) {
        const value = block.input[key];
        if (typeof value === 'string' && value.length > 0) {
          paths.set(block.id, value);
          break;
        }
      }
    }
  }
  return paths;
}

/**
 * Whether a block is a tool result.
 *
 * Checked by `type` rather than by the presence of `content`, because a
 * `tool_use` block also has structured fields and must NOT be rewritten -- its
 * input is an argument the model chose, not output to be summarised.
 */
function isToolResult(block: unknown): boolean {
  return (
    typeof block === 'object' &&
    block !== null &&
    (block as ToolResultBlock).type === 'tool_result'
  );
}

function mapBlocks(
  request: ProviderRequest,
  visit: (
    text: string,
    at: Position,
    message: Message,
    toolUseId?: string
  ) => string | null
): ProviderRequest {
  const messages = (request.messages ?? []).map((message, mi) => {
    const content = message?.content;
    if (!Array.isArray(content)) return message;

    const mapped = content.map((raw, bi) => {
      const block = raw as Block;
      const at = { message: mi, block: bi };

      if (typeof block?.text === 'string') {
        const replaced = visit(block.text, at, message);
        return replaced === null ? block : { ...block, text: replaced };
      }

      // A TOOL RESULT CARRIES ITS PAYLOAD ONE LEVEL DOWN, and skipping it made
      // this compressor blind to almost everything a coding agent sends.
      //
      // This walker keyed on `block.text`. A tool_result has no `text`: the
      // file that was read, the command output, the search hits all live under
      // `content`, either as a plain string or as nested text blocks. So every
      // one of them was returned untouched -- the same defect already recorded
      // here for images, in the engine that exists to compress exactly this.
      //
      // MEASURED, on 23 real requests through the rig: 2.79 MB of traffic,
      // largest request 128 KB, and 23 of 23 reported "compression did not
      // pay" having removed 0 bytes. The identical file content compresses
      // 36.4% as a text block and 0.0% as a tool_result.
      //
      // The nested text inherits its CONTAINER's position, which is what the
      // frontier comparison needs: a tool_result sits on one side of the cache
      // breakpoint as a unit, and its parts cannot straddle it.
      if (isToolResult(block)) {
        const inner = (block as ToolResultBlock).content;

        const producedBy = (block as ToolResultBlock).tool_use_id;

        if (typeof inner === 'string') {
          const replaced = visit(inner, at, message, producedBy);
          return replaced === null ? block : { ...block, content: replaced };
        }

        if (Array.isArray(inner)) {
          let touched = false;
          const mappedInner = inner.map((rawInner) => {
            const innerBlock = rawInner as Block;
            if (typeof innerBlock?.text !== 'string') return innerBlock;
            const replaced = visit(innerBlock.text, at, message, producedBy);
            if (replaced === null) return innerBlock;
            touched = true;
            return { ...innerBlock, text: replaced };
          });
          return touched ? { ...block, content: mappedInner } : block;
        }
      }

      return block;
    });

    return { ...message, content: mapped };
  });

  return { ...request, messages };
}

/** Walks every image block, in the same order `replaceImages` will. */
function visitImages(
  request: ProviderRequest,
  visit: (block: unknown, at: Position, message: Message) => null
): void {
  (request.messages ?? []).forEach((message, mi) => {
    const content = message?.content;
    if (!Array.isArray(content)) return;
    content.forEach((raw, bi) => {
      if (!isImageBlock(raw)) return;
      visit(raw, { message: mi, block: bi }, message);
    });
  });
}

/**
 * Collapses repeated images, and records what that removed.
 *
 * SHARED WITH THE CONTROL ARM, deliberately. HeadRoom's published engines are
 * text engines and all four of their published workloads are text, but their
 * marker layer is content-hash addressed and hash dedup of an identical image
 * block is its natural extension -- so assuming they cannot do this would be
 * inventing an advantage rather than measuring one. The control gets it too,
 * and on the browser workload the arms tie. What the workload is really for is
 * a regression guard on a hole that was OURS: every walker here keyed on
 * `block.text`, so an image was invisible to all of it.
 */
function imagePass(
  request: ProviderRequest,
  frontier: Position | null,
  elisions: Elision[]
): ReturnType<typeof dedupImages> {
  const found: { block: unknown; touchable: boolean }[] = [];
  visitImages(request, (block, at, message) => {
    found.push({
      block,
      touchable: !messageIsSigned(message) && isAfter(at, frontier),
    });
    return null;
  });

  const images = dedupImages(found);
  if (images.collapsed) {
    elisions.push({
      removed: `${images.collapsed} repeated image${images.collapsed === 1 ? '' : 's'}, about ${images.tokensSaved.toLocaleString('en-US')} tokens`,
      // The image is still above, and the reference names which one.
      recoverAt: null,
      lossless: true,
    });
  }
  return images;
}

/**
 * Swaps an image block for a text block naming the copy above.
 *
 * A content array is heterogeneous, so replacing an `image` with a `text`
 * is well-formed -- and it is the only replacement that removes the whole
 * cost. Shrinking the image would need a codec; saying "this one again"
 * needs nothing.
 */
function replaceImages(
  request: ProviderRequest,
  next: () => string | null
): ProviderRequest {
  const messages = (request.messages ?? []).map((message) => {
    const content = message?.content;
    if (!Array.isArray(content)) return message;
    const mapped = content.map((raw) => {
      if (!isImageBlock(raw)) return raw;
      const replacement = next();
      return replacement === null
        ? raw
        : ({ type: 'text', text: replacement } as Block);
    });
    return { ...message, content: mapped };
  });
  return { ...request, messages };
}

/**
 * Shared body for V1 and V3; they differ only in where they are allowed to act.
 *
 * TWO PASSES, because the second one sees what the first cannot. Every engine
 * is a pure function of one block, so no engine can notice that the file it is
 * compressing is the same file the agent read nine turns ago. The blocks are
 * staged first, then `dedupBlocks` reads the whole sequence and replaces a
 * repeat with a reference to the copy already in the request.
 */
function pathAddressed(
  request: ProviderRequest,
  options: StrategyOptions,
  respectFrontier: boolean,
  floor?: Position | null
): StrategyResult {
  // Located whether or not it is respected: even an arm that rewrites
  // history needs to know which side of the breakpoint a block is on,
  // because that decides whether the block has to be BYTE-STABLE.
  const breakpoint = lastCacheBreakpoint(request);
  // THE FLOOR IS WHERE THE CACHE ACTUALLY ENDS, which is not where this
  // request's marker sits. A client marks the LAST message every turn, so
  // respecting THIS breakpoint leaves nothing compressible; respecting the
  // one we saw LAST turn leaves exactly the span the conversation has grown
  // since, which the provider is about to cache for the first time.
  const frontier = respectFrontier ? (floor ?? breakpoint) : null;
  const query = questionIn(request);
  const elisions: Elision[] = [];
  const staged: DedupBlock[] = [];

  // A SOURCE THAT APPEARS TWICE IS COMPRESSED THE SAME WAY BOTH TIMES.
  //
  // Relevance and liveness make the output depend on the question, and cached
  // content must not (see below), so the two copies of one file would compress
  // differently and cross-block dedup would collapse neither -- the fresh copy
  // is then sent in full, which costs far more than relevance-tuning it saves.
  // Matching them on SOURCE instead was the wrong repair: it replaces the fresh
  // text with earlier, different text and cannot honestly be called lossless.
  //
  // Compressing every copy query-independently makes the outputs genuinely
  // equal, so the reference is exact. What the agent gives up is relevance
  // tuning on content that is repeated verbatim elsewhere in the same request,
  // and every body that elision removes still names its path.
  const sourceCounts = new Map<string, number>();
  mapBlocks(request, (text) => {
    sourceCounts.set(text, (sourceCounts.get(text) ?? 0) + 1);
    return null;
  });

  // Pass one: compress each block, and record whether it could be touched at
  // all. An untouchable block is still staged, because it is the strongest
  // referent a later repeat can point at -- it is guaranteed to arrive
  // byte-identical.
  const sourcePaths = toolResultPaths(request);
  mapBlocks(request, (text, at, message, toolUseId) => {
    // #3456: a signed message is untouchable. Rewriting it poisons the
    // conversation permanently, not just this turn.
    const touchable =
      !messageIsSigned(message) && (!respectFrontier || isAfter(at, frontier));
    if (!touchable) {
      staged.push({ text, original: text, touchable: false });
      return null;
    }
    // CACHED CONTENT IS COMPRESSED WITHOUT THE QUESTION, and this is not a
    // detail -- it is what makes rewriting history viable at all.
    //
    // Relevance and liveness make the output a function of what the agent
    // asked, and the question changes every turn. Applied to the cached
    // prefix that is fatal: turn N compresses the prefix one way, turn N+1
    // asks a different question and compresses the same bytes differently,
    // so the prefix we send differs every turn and the provider cache misses
    // every turn. Compression that busts the cache costs more than it saves
    // -- a read bills at 0.1x and a write at 1.25x.
    //
    // Behind the breakpoint the transform is therefore a pure function of
    // the CONTENT, so re-deriving it next turn reproduces the same bytes and
    // the cache hits. After the breakpoint nothing is cached yet, so the
    // question is free to steer retention.
    const cached = !isAfter(at, breakpoint);
    const repeated = (sourceCounts.get(text) ?? 0) > 1;
    const result = compressBlock(text, {
      spill: options.spill,
      query: cached || repeated ? undefined : query,
      tuning: options.tuning,
      embeddings: options.embeddings,
      // The path the payload came from, recovered from the call that
      // produced it. This is what lets the code engine pick a language;
      // without it the same content compresses by exactly 0.0%.
      sourcePath: toolUseId ? sourcePaths.get(toolUseId) : undefined,
    });
    elisions.push(...result.elisions);
    staged.push({ text: result.text, original: text, touchable: true });
    return null;
  });

  const deduped = dedupBlocks(staged);
  elisions.push(...deduped.elisions);

  // IMAGES, WHICH NOTHING ABOVE CAN SEE. Every walker here keys on
  // `block.text`, so an image block was never classified, compressed,
  // deduplicated or counted -- and one screenshot is roughly
  // `width * height / 750` tokens, re-sent as history on every later turn.
  // A browser-driving agent sends the same screenshot repeatedly, which is
  // the case worth catching, and the argument is the one text dedup already
  // makes: the referent is in this request, so the reference cannot miss.
  const images = imagePass(
    request,
    respectFrontier ? frontier : null,
    elisions
  );

  // Pass two writes the answers back. `mapBlocks` walks in the same order it
  // walked before, so the index lines up with what was staged.
  let at = 0;
  const withText = mapBlocks(request, () => deduped.texts[at++] ?? null);
  let imageAt = 0;
  const out = replaceImages(
    withText,
    () => images.replacements[imageAt++] ?? null
  );

  // Nothing is added to the request: no system message, no tool, no hash.
  return { request: out, elisions, injectedChars: 0 };
}

/**
 * V1: the recommended design.
 *
 * WITH AN ANCHOR STORE IT ALSO RE-ANCHORS, which is the one case where
 * touching the cached prefix is not a mistake. `anchorDecision` answers yes
 * only when the write is already happening -- a first turn, a prefix the
 * client itself invalidated -- or when the prefix in the cache is ALREADY
 * ours, in which case reproducing it is the hit and stopping would be the
 * miss. See `anchor.ts` for the economics; without a store this is exactly
 * the frontier-only behaviour it has always had.
 */
/**
 * How much of the cached prefix a rewrite must remove before it pays for itself.
 *
 * THE ARITHMETIC THAT DECIDES THIS, because it is not a matter of taste. A
 * cached token is read at 0.1x every turn. Rewriting the prefix means the
 * provider caches OUR version instead, which costs 1.25x once on the whole
 * prefix and then reads a smaller one at 0.1x thereafter. Removing a fraction f
 * therefore breaks even after
 *
 *     1.25 * P  ==  0.1 * f * P * N        =>        N = 12.5 / f
 *
 * turns. At the reduction actually achieved on real Claude Code traffic --
 * 2.47%, measured over 22 requests -- that is 507 turns. THOL tasks run 6 to 12
 * and a long human session is around 100, so at that rate the rewrite cannot
 * pay under any realistic session, and the measured result agreed: the proxy
 * cost about 24% more than control with identical turn counts, and the cache
 * writes it caused were 42% of weighted input cost while being 5.5% of tokens.
 *
 * 12.5% is break-even at 100 turns, which is a generous estimate of a long
 * session. Below it we leave the prefix alone and compress only what the
 * provider has not cached; above it the rewrite genuinely wins and is sent.
 *
 * This is not a guess that can quietly go stale: it is `CACHE_WRITE / CACHE_READ`
 * divided by the session length we are willing to bet on, and both are named.
 */
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;
/**
 * The DEFAULT prior on session length. Overridable via `assumedSessionTurns`.
 *
 * Kept as a named constant so the derivation below stays readable, but it is no
 * longer the only value available: a workload that knows it runs short can say
 * so, and one that runs for hundreds of turns can say that instead. See
 * `options.ts#assumedSessionTurns` for why this is a fixed prior rather than
 * something measured from the conversation as it goes.
 */
const ASSUMED_SESSION_TURNS = 100;
/**
 * How long a conversation must already be before we bet on it continuing.
 *
 * A rewrite needs 12.5/f turns of cheap reads after it to repay its write, so
 * the bet is on turns REMAINING -- which nothing here can know. Turns so far is
 * the only available estimate, and a session that has already run this long is
 * the kind that plausibly runs long enough again.
 *
 * Each turn contributes two messages, so this is roughly twenty turns: past the
 * length of every task in the benchmark, which is deliberate. Those tasks end
 * at 6 to 12 turns and measurably cannot amortise a write, so the honest
 * behaviour there is not to make one.
 */
const MIN_MESSAGES_TO_AMORTISE = 40;

const MIN_PREFIX_REWRITE_SHARE =
  CACHE_WRITE_MULTIPLIER / CACHE_READ_MULTIPLIER / ASSUMED_SESSION_TURNS;

/**
 * The share a rewrite must remove to repay itself, for this proxy's prior.
 *
 * FIXED FOR THE LIFE OF A PROXY, like every other dial, and that is the whole
 * point: a threshold that moved with the conversation would decline a rewrite
 * on one turn and accept it on the next, re-sending the entire prefix at 1.25x
 * instead of re-reading it at 0.1x.
 */
export function minRewriteShare(tuning?: Tuning): number {
  const turns = tuning?.assumedSessionTurns;
  if (!turns || !Number.isFinite(turns) || turns <= 0) {
    return MIN_PREFIX_REWRITE_SHARE;
  }
  return CACHE_WRITE_MULTIPLIER / CACHE_READ_MULTIPLIER / turns;
}

export function v1Frontier(
  request: ProviderRequest,
  options: StrategyOptions = {}
): StrategyResult {
  if (!options.anchors) return pathAddressed(request, options, true);

  // DECIDED HERE, COMMITTED BY THE CALLER, and the order matters. The proxy
  // still discards a rewrite that did not come out smaller and forwards the
  // original instead. Recording `anchored: true` before that verdict told the
  // next turn to rewrite a prefix the provider had cached in its ORIGINAL form
  // -- an avoidable cache write, caused by remembering something that never
  // went on the wire. The record travels back with the result and is committed
  // only once the body it describes is actually sent.
  const decision = anchorDecision(
    request,
    options.anchors,
    options.tuning?.coldMessageLimit
  );

  // KNOWLEDGE RIDES ON THE ANCHOR DECISION, and that is the whole trick.
  // Putting findings in the cached prefix is what makes them cost 0.1x a
  // turn instead of 1.0x, and what puts them in front of the model BEFORE
  // it decides rather than in an advisory after it already has. But the
  // prefix has to arrive byte-identical or the cache misses and the
  // injection costs more than everything it could ever save.
  //
  // So the block is recomputed only on a turn where rewriting the prefix is
  // already free -- the first turn, or one the client invalidated itself --
  // and replayed verbatim on every other. A conversation we declined to
  // anchor gets nothing: starting to inject there would be the cache miss
  // this is supposed to avoid.
  const fresh =
    decision.reason === 'first-turn' ||
    decision.reason === 'client-invalidated';
  const knowledge = fresh
    ? knowledgeBlock(
        options.findings ?? [],
        stableContext(request),
        options.knowledgeBudget ?? options.tuning?.knowledgeBudgetChars,
        {
          embeddings: options.embeddings,
          // Passed through rather than defaulted here: only the loader knows
          // which graph these findings came from, and a project claim served
          // out of a shared graph is a fact about some other tree.
          sharedGraph: options.sharedGraph === true,
        }
      )
    : (decision.record.knowledge ?? null);

  // RECONSIDERED EVERY TURN, because the answer changes as the conversation
  // grows. The break-even test below compares what a rewrite would remove
  // against what it costs, and early in a session there is little history to
  // remove -- so a conversation can be declined at 10% on turn two and be
  // worth 23% by turn six. Treating the first refusal as final left that on
  // the table for the rest of the session.
  //
  // `left-alone` is exactly the state of having declined before, so it is
  // retried rather than honoured. Nothing is lost by asking again: the
  // provider still holds the client's prefix, which is what it held when we
  // declined, so adopting the rewrite later costs the same write it would
  // have cost then.
  // AND ONLY IN A SESSION LONG ENOUGH TO AMORTISE THE WRITE. Reconsidering is
  // the right behaviour, but it is not free: it lets a rewrite happen the moment
  // the saving clears the floor, and the 1.25x write that buys still needs
  // 12.5/f turns of 0.1x reads AFTER it to repay. A session that ends before
  // then has simply paid the write.
  //
  // Measured: on 6-to-12 turn tasks, reconsidering cost $0.81 against $0.76 for
  // the same build that never rewrote -- worse, and by about what the arithmetic
  // predicts. Turns so far is the only estimate of turns remaining available
  // here, so a conversation has to have shown it is long before we bet on it
  // continuing.
  const longEnough =
    (request.messages ?? []).length >= MIN_MESSAGES_TO_AMORTISE;
  const attempt =
    decision.reanchor || (decision.reason === 'left-alone' && longEnough);
  // ONLY WHEN WE RECOGNISE THE CONVERSATION AND ITS PREFIX IS UNCHANGED.
  // 'already-anchored' and 'left-alone' are exactly the two states that say
  // the client sent us the same prefix we saw last time, so the breakpoint we
  // stored still points at the same message and everything past it is new.
  // A first sighting, a joined conversation or a client-invalidated prefix
  // all mean we cannot say what the provider holds, and the honest answer
  // there is the conservative one: fall back to this request's own marker.
  const recognised =
    decision.reason === 'already-anchored' ||
    decision.reason === 'left-alone' ||
    decision.reason === 'extended';
  // ONCE COMPRESSION HAS STARTED THE BOUNDARY NEVER MOVES. `breakpoint`
  // advances every turn as the client moves its cache marker, so using it as
  // the floor would push a span compressed on turn N below the floor on turn
  // N+1 and send the client's original for bytes the provider is holding as
  // ours. `compressFrom` is set once, on the turn compression first bites,
  // and reused verbatim thereafter -- so the same content yields the same
  // output every turn and the cache hits. See anchor.ts for the measurement.
  const frozen = recognised ? (decision.record.compressFrom ?? null) : null;
  const floor =
    frozen ?? (recognised ? (decision.record.breakpoint ?? null) : null);
  // A FROZEN BOUNDARY OUTRANKS THE REWRITE PATH. `attempt` normally means
  // "rewrite the whole history", which is right when we are deciding to
  // anchor for the first time and wrong once a boundary exists: re-deriving
  // the prefix from scratch touches content the provider already holds in a
  // form we chose, and changes it. Measured: exactly one message-turn in 418
  // moved, at the turn the already-anchored path first fired, and it was
  // this.
  const respect = !attempt || frozen !== null;
  let out = pathAddressed(request, options, respect, floor);
  let reanchored = attempt;
  // WHETHER THE OUTPUT WE SHIP RESPECTED A BOUNDARY, tracked rather than
  // re-derived, because the revert below can replace `out` with one that does.
  let respected = respect;

  // COMPRESSING NEW CONTENT COMMITS US TO IT. The moment we shrink a block,
  // the provider caches OUR bytes for it -- so next turn, when the client
  // sends the original again, passing it through unchanged is a guaranteed
  // miss on everything from that point on. Recording the turn as anchored is
  // what makes the next one reproduce the same transform over the whole
  // history, which is a hit precisely because the transform is a pure
  // function of the content behind the breakpoint.
  if (
    !attempt &&
    JSON.stringify(out.request).length < JSON.stringify(request).length
  )
    reanchored = true;

  // A REWRITE OF THE CACHED PREFIX HAS TO CLEAR ITS OWN COST. See
  // MIN_PREFIX_REWRITE_SHARE: below that share the 1.25x write we are about to
  // cause outweighs every 0.1x read it will ever save, so the honest move is to
  // leave the prefix exactly as the provider already has it and compress only
  // what is not cached yet.
  //
  // Measured before this existed: 2.47% removed, and the resulting cache writes
  // were 42% of weighted input cost.
  // THE THRESHOLD IS FOR DECIDING TO START, NOT FOR CARRYING ON. When the
  // provider already holds OUR version of this prefix, reproducing it is the
  // cache hit and declining is the miss -- there is no 1.25x write to clear,
  // because the write already happened on the turn we started. Applying the
  // floor here anyway de-anchored an anchored conversation the moment its
  // saving dipped under the share, flipping the prefix back to the client's
  // bytes and guaranteeing the very miss the floor exists to prevent.
  const alreadyOurs =
    (decision.reason === 'already-anchored' ||
      decision.reason === 'extended') &&
    decision.record.anchored;
  if (attempt && !alreadyOurs) {
    const before = JSON.stringify(request).length;
    const removed = before - JSON.stringify(out.request).length;
    if (removed < before * minRewriteShare(options.tuning)) {
      out = pathAddressed(request, options, true, floor);
      reanchored = false;
      respected = true;
    }
  }

  // The boundary to reuse next turn: whatever we already froze, or -- on the
  // turn compression first bites -- the floor it bit at. Recorded only when
  // something was actually removed, because a turn that changed nothing has
  // committed us to nothing.
  //
  // THE BOUNDARY THE OUTPUT ACTUALLY USED, NOT THE ONE WE WERE HANDED, which is
  // why it is measured here rather than before the revert above, and why it
  // reads the tracked `respected` rather than the `respect` we asked for.
  // `floor` is null on the turn compression first bites, and null does not mean
  // "no boundary": `pathAddressed` substitutes `lastCacheBreakpoint(request)`
  // for it and compresses strictly after that. Recording the null froze
  // nothing, so the turn after it saw `anchored: true` with no boundary,
  // re-derived the prefix from scratch and rewrote bytes the provider was
  // already holding -- a guaranteed miss on the whole prefix, which is the one
  // thing anchoring exists to prevent. Measured on browser-session: v1-anchored
  // 14,666 steady tokens against v1-frontier's 11,410, equal once it is real.
  //
  // And only when the output respected a boundary at all. A full rewrite has
  // none to freeze, and claiming one would tell the next turn to leave a prefix
  // alone that we had in fact replaced.
  const removedAnything =
    JSON.stringify(out.request).length < JSON.stringify(request).length;
  const boundary = respected ? (floor ?? lastCacheBreakpoint(request)) : null;
  const compressFrom = frozen ?? (removedAnything ? boundary : null);

  const withKnowledge = injectKnowledge(out.request, knowledge);

  return {
    ...out,
    request: withKnowledge,
    injectedChars: out.injectedChars + (knowledge?.length ?? 0),
    // RECORDED AS WHAT WE ACTUALLY DID. Remembering `anchored: true` for a
    // rewrite we declined would tell the next turn the provider holds our
    // version when it holds the client's -- the exact cache write this check
    // exists to avoid, bought with a lie about what went on the wire.
    anchor: {
      ...decision,
      reanchor: reanchored,
      record: {
        ...decision.record,
        anchored: reanchored,
        knowledge,
        // Where the cache ends as of this turn, so the next one knows which
        // span is new. Recorded from the request as it ARRIVED, not as we
        // send it: it describes what the provider is about to hold.
        breakpoint: lastCacheBreakpoint(request),
        compressFrom,
      },
    },
  };
}

/**
 * V2: V1, plus re-inflation of spans the model is about to need.
 *
 * MEASURED, NOT ASSUMED. This guesses, and a wrong guess spends tokens
 * re-inflating something unwanted. It is compared against V1 on the same
 * fixtures; if it loses, V1 ships.
 */
export function v2Speculative(
  request: ProviderRequest,
  options: StrategyOptions = {}
): StrategyResult {
  const wanted = options.wanted ?? [];
  const base = pathAddressed(request, options, true);
  if (!wanted.length) return base;

  // A span the model is reaching for is left whole this turn, on a request that was
  // already being sent -- so recovery costs no round trip at all, where CCR's retrieve
  // tool always costs one.
  //
  // MATCHED AGAINST THE ORIGINAL, AND RESTORED FROM IT. Matching the COMPRESSED text
  // was wrong twice over: the wanted symbol usually lives in the body that was just
  // elided, so the test rarely fired -- and when it did, stripping the
  // `[... body, N lines -> path]` marker removed the only route back to the content
  // without putting the content back. The request then looked complete while having
  // quietly lost its recovery path, which is the one failure this whole design exists
  // to avoid.
  const out = mapBlocks(base.request, (text, at) => {
    if (!ELIDED.test(text)) return null;
    const original = blockTextAt(request, at);
    if (original === null) return null;
    if (!wanted.some((want) => original.includes(want))) return null;
    return original;
  });

  return { ...base, request: out };
}

/** V3: V1's markers with no frontier restriction. */
export function v3History(
  request: ProviderRequest,
  options: StrategyOptions = {}
): StrategyResult {
  return pathAddressed(request, options, false);
}

/**
 * The CCR-style control: what HeadRoom does, as faithfully as we can state it.
 *
 * Opaque markers, history compressed, and the two injections that make the
 * markers redeemable. `injectedChars` is what those cost -- the number their
 * published reduction figures do not appear to include.
 */
export function ccrStyle(
  request: ProviderRequest,
  options: StrategyOptions = {}
): StrategyResult {
  const elisions: Elision[] = [];
  const hashes: string[] = [];
  let index = 0;
  // THE CONTROL GETS DEDUP TOO, and it must. A content-addressed cache
  // collapses repeats for free: the second copy of the same bytes hashes to
  // the entry already stored, so their design would send the marker alone.
  // Handicapping the control to flatter ours would make the comparison
  // worthless. What remains ours is that their marker points OUT of the
  // payload at an entry that can be missing -- their #2509 -- where a
  // back-reference points at bytes in the request being sent.
  const byContent = new Map<string, string>();
  const query = questionIn(request);

  const out = mapBlocks(request, (text, _at, message) => {
    if (messageIsSigned(message)) return null;
    const already = byContent.get(text);
    if (already !== undefined) return already;
    // The control gets the same query-independence rule behind the breakpoint
    // that we hold ourselves to. It is the harder choice -- their real design
    // is cache-unaware, so this makes the control MORE cache-stable than it
    // would be in the wild -- but it isolates what is actually being compared:
    // opaque markers and injected retrieval versus paths and nothing injected.
    const cached = !isAfter(_at, lastCacheBreakpoint(request));
    const result = compressBlock(text, {
      spill: options.spill,
      query: cached ? undefined : query,
      tuning: options.tuning,
      embeddings: options.embeddings,
    });
    if (result.text === text) return null;
    const marker = ccrMarker(text, index);
    index += 1;
    hashes.push(marker.slice(7, 19));
    elisions.push(...result.elisions);
    byContent.set(text, marker);
    // Their form: the compressed body with an opaque marker standing in for
    // everything removed.
    return `${result.text}\n${marker}`;
  });

  // The control gets the image pass too; see `imagePass`.
  const ccrImages = imagePass(out, null, elisions);
  let ccrImageAt = 0;
  const withImages = replaceImages(
    out,
    () => ccrImages.replacements[ccrImageAt++] ?? null
  );

  if (!index) return { request: withImages, elisions, injectedChars: 0 };

  const systemText = CCR_SYSTEM.replace(
    '{HASHES}',
    hashes.slice(0, 5).join(', ')
  );
  const withInjection: ProviderRequest = {
    ...withImages,
    system: Array.isArray(out.system)
      ? [...out.system, { type: 'text', text: systemText }]
      : `${out.system ?? ''}${systemText}`,
    tools: [...((out.tools as unknown[]) ?? []), CCR_TOOL],
  };

  return {
    request: withInjection,
    elisions,
    injectedChars: systemText.length + JSON.stringify(CCR_TOOL).length,
  };
}

/**
 * V1, plus the history substitution -- the one region nothing else touches.
 *
 * COMPOSED RATHER THAN FORKED. V1 attacks the fresh tail and the tool
 * definitions; this attacks the reasoning in history, which is 52% of it and
 * which every other arm steps over because `messageIsSigned` forbids rewriting
 * it. They are disjoint, so the substitution runs first and V1 then does
 * exactly what it always did to what is left. Anything V1 learns about
 * anchoring, knowledge injection and the saving floor is inherited rather than
 * reimplemented, which is the difference between a fifth arm and a second
 * codebase.
 *
 * ORDER IS NOT ARBITRARY. Substitution must happen BEFORE the anchor decision,
 * because the anchor records what the cached prefix looks like and it has to
 * record the prefix we actually send. Running it afterwards would anchor one
 * body and transmit another -- the same class of defect as recording
 * `anchored: true` for a rewrite the proxy then discarded.
 *
 * OFF BY DEFAULT AT THE CALLER. Registered here so it is measurable; the proxy
 * gates it on `TOKEN_OPTIMIZER_PROXY_SUBSTITUTE`. Deferral shipped default-off
 * and was therefore never measured for months, so the switch is deliberate and
 * so is the instrumentation behind it.
 */
export function v4Substitute(
  request: ProviderRequest,
  options: StrategyOptions = {}
): StrategyResult {
  const substitution = substituteHistory(request.messages, {
    // NO QUERY AND NO EMBEDDINGS -- those depend on the live question, so the
    // same block would compress differently as the conversation moves and the
    // prefix would churn. `tuning` is fixed for the life of the proxy.
    //
    // THE SPILL SINK IS PASSED, and withholding it was a real defect rather
    // than caution. I excluded it alongside the query on the assumption that
    // it was another source of variance; it is not. The sink is
    // CONTENT-ADDRESSED -- the same bytes always spill to the same path, which
    // both the proxy and the benchmark harness guarantee -- so a block's
    // compressed form stays a pure function of its own content, and the
    // append-only rule holds exactly as before.
    //
    // What it costs to withhold is most of the compression. Without a sink the
    // engines can only shrink content in place; with one they can move a large
    // tool result out and leave a path the agent can read back, which is the
    // whole mechanism. Measured on the agent-loop fixture: 24.5% reduction
    // without it against v3-history's 85.1% on identical bytes.
    compressToolResult: (text) =>
      compressBlock(text, { tuning: options.tuning, spill: options.spill })
        .text,
  });
  // BOTH REGIONS COUNT, and gating on `substituted` alone silently threw one
  // away. That counter tracks assistant REASONING substitutions only; tool
  // results report through `toolResultChars`. So a conversation whose assistant
  // turns carry no `thinking` -- an ordinary non-reasoning session -- had its
  // compressed tool results computed and then discarded, because the reasoning
  // count was zero.
  //
  // Nothing to substitute is still not a reason to skip compression: the
  // request has a fresh tail and tool definitions either way, and V1 handles
  // those.
  const changed =
    substitution.substituted > 0 || substitution.toolResultChars > 0;
  const next: ProviderRequest = changed
    ? { ...request, messages: substitution.messages }
    : request;
  const result = v1Frontier(next, options);
  return {
    ...result,
    // The digest is content we ADDED, and it is counted as such. A strategy
    // that reports only what it removed can show a saving while having made
    // the request larger, which is the specific way a compression figure
    // becomes a lie.
    injectedChars: result.injectedChars + substitution.substituteChars,
  };
}

/** Every arm, by name. */
export const STRATEGIES: Record<
  StrategyName,
  (request: ProviderRequest, options?: StrategyOptions) => StrategyResult
> = {
  'v1-frontier': v1Frontier,
  'v2-speculative': v2Speculative,
  'v3-history': v3History,
  'v4-substitute': v4Substitute,
  ccr: ccrStyle,
};
