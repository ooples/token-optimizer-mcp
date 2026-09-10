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
import { dedupBlocks, type DedupBlock } from './dedup.js';
import { queryFrom } from './relevance.js';
import type { Tuning } from './options.js';
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
  /** Characters of findings allowed in the prefix. */
  readonly knowledgeBudget?: number;
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
function questionIn(request: ProviderRequest): string {
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

/** Walks every text-bearing block, letting the visitor replace its text. */
function mapBlocks(
  request: ProviderRequest,
  visit: (text: string, at: Position, message: Message) => string | null
): ProviderRequest {
  const messages = (request.messages ?? []).map((message, mi) => {
    const content = message?.content;
    if (!Array.isArray(content)) return message;

    const mapped = content.map((raw, bi) => {
      const block = raw as Block;
      if (typeof block?.text !== 'string') return block;
      const replaced = visit(block.text, { message: mi, block: bi }, message);
      return replaced === null ? block : { ...block, text: replaced };
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
  respectFrontier: boolean
): StrategyResult {
  // Located whether or not it is respected: even an arm that rewrites
  // history needs to know which side of the breakpoint a block is on,
  // because that decides whether the block has to be BYTE-STABLE.
  const breakpoint = lastCacheBreakpoint(request);
  const frontier = respectFrontier ? breakpoint : null;
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
  mapBlocks(request, (text, at, message) => {
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
    });
    elisions.push(...result.elisions);
    staged.push({ text: result.text, original: text, touchable: true });
    return null;
  });

  const deduped = dedupBlocks(staged);
  elisions.push(...deduped.elisions);

  // Pass two writes the answers back. `mapBlocks` walks in the same order it
  // walked before, so the index lines up with what was staged.
  let at = 0;
  const out = mapBlocks(request, () => deduped.texts[at++] ?? null);

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
  const decision = anchorDecision(request, options.anchors);

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
        options.knowledgeBudget ?? options.tuning?.knowledgeBudgetChars
      )
    : (decision.record.knowledge ?? null);

  const out = pathAddressed(request, options, !decision.reanchor);
  const withKnowledge = injectKnowledge(out.request, knowledge);

  return {
    ...out,
    request: withKnowledge,
    injectedChars: out.injectedChars + (knowledge?.length ?? 0),
    anchor: { ...decision, record: { ...decision.record, knowledge } },
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

  // A span the model is reaching for is left whole this turn, on a request
  // that was already being sent -- so recovery costs no round trip at all,
  // where CCR's retrieve tool always costs one.
  const out = mapBlocks(base.request, (text) => {
    const hit = wanted.some((want) => text.includes(want));
    if (!hit) return null;
    const original = wanted.find((want) => text.includes(want));
    return original ? text.replace(/\[\.\.\. body, [^\]]+\]/g, '') : null;
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

  if (!index) return { request: out, elisions, injectedChars: 0 };

  const systemText = CCR_SYSTEM.replace(
    '{HASHES}',
    hashes.slice(0, 5).join(', ')
  );
  const withInjection: ProviderRequest = {
    ...out,
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

/** Every arm, by name. */
export const STRATEGIES: Record<
  StrategyName,
  (request: ProviderRequest, options?: StrategyOptions) => StrategyResult
> = {
  'v1-frontier': v1Frontier,
  'v2-speculative': v2Speculative,
  'v3-history': v3History,
  ccr: ccrStyle,
};
