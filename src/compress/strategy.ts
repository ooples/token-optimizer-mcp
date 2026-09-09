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
}

export interface StrategyResult {
  readonly request: ProviderRequest;
  readonly elisions: readonly Elision[];
  /** Tokens of preamble this strategy ADDED to the request. */
  readonly injectedChars: number;
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

/** Shared body for V1 and V3; they differ only in where they are allowed to act. */
function pathAddressed(
  request: ProviderRequest,
  options: StrategyOptions,
  respectFrontier: boolean
): StrategyResult {
  const frontier = respectFrontier ? lastCacheBreakpoint(request) : null;
  const elisions: Elision[] = [];

  const out = mapBlocks(request, (text, at, message) => {
    // #3456: a signed message is untouchable. Rewriting it poisons the
    // conversation permanently, not just this turn.
    if (messageIsSigned(message)) return null;
    if (respectFrontier && !isAfter(at, frontier)) return null;

    const result = compressBlock(text, { spill: options.spill });
    if (result.text === text) return null;
    elisions.push(...result.elisions);
    return result.text;
  });

  // Nothing is added to the request: no system message, no tool, no hash.
  return { request: out, elisions, injectedChars: 0 };
}

/** V1: the recommended design. */
export function v1Frontier(
  request: ProviderRequest,
  options: StrategyOptions = {}
): StrategyResult {
  return pathAddressed(request, options, true);
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

  const out = mapBlocks(request, (text, _at, message) => {
    if (messageIsSigned(message)) return null;
    const result = compressBlock(text, { spill: options.spill });
    if (result.text === text) return null;
    const marker = ccrMarker(text, index);
    index += 1;
    hashes.push(marker.slice(7, 19));
    elisions.push(...result.elisions);
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
