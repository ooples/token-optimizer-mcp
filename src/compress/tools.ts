/**
 * Tool deferral: stop sending tool definitions the model is not using.
 *
 * WHY THIS IS THE BIGGEST LEVER IN THE REQUEST. Measured live, with real Claude
 * Code routed through this proxy against the real API, a single one-word prompt
 * produced a 179,564 byte request: tool schema 85,546 bytes across 31 tools
 * (47.6%), injected context 83,397 (46.4%), system prompt 9,410 (5.2%). The
 * conversation itself was two messages. Every compression engine in this
 * package walks `request.messages`, so all of them together were working on the
 * smaller half of the payload while half of it sat untouched.
 *
 * Anthropic's Tool Search Tool exists for exactly this. Tools marked
 * `defer_loading: true` are not placed in context; the model receives the search
 * tool (~500 tokens) and pulls definitions in when it needs them. Anthropic
 * report an 85% reduction in tool-definition tokens and, on large tool
 * libraries, an accuracy INCREASE -- Opus 4.5 from 79.5% to 88.1%.
 *
 * WHAT THIS COSTS, stated up front. Discovery is a round trip: a model that
 * needs a deferred tool asks for it first. Turns are the most expensive thing
 * in this system -- one extra turn measured around +30% -- so deferral trades a
 * large per-request saving against a possible turn. That trade is measured, not
 * assumed, and this is a separate switch from content compression precisely so
 * the two effects can never be confused for each other.
 */

import type { ProviderRequest } from './frontier.js';
import { activeRanker } from './ranking.js';
import type { EmbeddingCache } from './embedding.js';

/** The regex search tool Anthropic ships for this. */
export const TOOL_SEARCH_TYPE = 'tool_search_tool_regex_20251119';
export const TOOL_SEARCH_NAME = 'tool_search_tool_regex';

/** The beta that enables deferred loading. */
export const ADVANCED_TOOL_USE_BETA = 'advanced-tool-use-2025-11-20';

interface ToolLike {
  readonly type?: string;
  readonly name?: string;
  readonly defer_loading?: boolean;
}

/** Is this entry already one of the server-side tool types rather than a definition? */
function isServerTool(tool: ToolLike): boolean {
  return typeof tool.type === 'string' && tool.type.length > 0;
}

/**
 * Tools that must stay in context no matter what the caller asked for.
 *
 * A forced `tool_choice` names a tool the model is REQUIRED to call. Deferring
 * that definition asks the model to call something it cannot see, which is not
 * a saving but a broken request.
 */
function forcedToolName(request: ProviderRequest): string | null {
  const choice = (request as { tool_choice?: unknown }).tool_choice;
  if (typeof choice !== 'object' || choice === null) return null;
  const named = choice as { type?: string; name?: string };
  return named.type === 'tool' && typeof named.name === 'string'
    ? named.name
    : null;
}

/**
 * Tools that are never deferred, identified structurally rather than by name.
 *
 * An MCP tool is named `mcp__<server>__<tool>`; a client's own built-ins are
 * plain names like `Read` or `Bash`. That distinction is the signal, and using
 * it means this does not rot the next time a client renames or adds a built-in,
 * which a hardcoded list certainly would.
 *
 * The built-ins are the agent's core loop and are reached for constantly, so
 * deferring them guarantees the discovery round trip this is trying to avoid.
 * The long tail of MCP tools is where both the bytes and the safety are: 26 of
 * 31 tools in a measured session, 76,501 characters.
 */
function isCheapToKeep(chars: number, floor: number): boolean {
  return chars <= floor;
}

/**
 * Below this a definition is not worth deferring.
 *
 * MEASURED, NOT ASSUMED, and it replaced a rule that had it backwards. The
 * first version protected "core" tools by origin -- anything not named
 * mcp__server__tool -- on the theory that MCP servers carry the bulk. A live
 * capture said otherwise: all 31 tools in a real Claude Code request were
 * built-ins, 85,514 characters of them, and that rule would have deferred
 * nothing at all.
 *
 * The same capture showed WHERE the weight is, and it is not the core loop:
 * PowerShell 9,244 characters, DesignSync 8,930, Monitor 7,492, Workflow
 * 5,355, SendMessage 4,804 -- the ten largest are about 64% of the schema and
 * are specialised tools most sessions never call. Read, Edit, Write, Bash,
 * Grep and Glob are all comfortably smaller.
 *
 * So size is the signal. A small definition is cheap to keep and keeping it
 * guarantees no discovery round trip for the tools an agent actually lives in;
 * a large one has to earn its place by looking relevant to the task.
 */
export const SMALL_TOOL_CHARS = 1500;

/** How many non-core tools to keep loaded when a task hints at what it needs. */
export const DEFAULT_KEEP_RELEVANT = 5;

export interface DeferOptions {
  /** The task text, used to decide which non-core tools are worth loading. */
  readonly query?: string;
  /** Non-core tools to keep loaded. */
  readonly keepRelevant?: number;
  /** Definitions at or below this size are always kept. */
  readonly smallToolChars?: number;
  /** Vectors for a semantic ranking, when one has been warmed. */
  readonly embeddings?: EmbeddingCache;
}

export interface DeferralResult {
  readonly request: ProviderRequest;
  /** Characters of tool definition removed from context. */
  readonly deferredChars: number;
  readonly deferredCount: number;
}

/**
 * Marks tool definitions for on-demand loading and adds the search tool.
 *
 * Returns the request UNCHANGED whenever deferral would be wrong rather than
 * merely unhelpful -- no tools, one tool (the search tool costs more than it
 * saves), the caller already deferring, or a forced tool_choice. Failing open
 * is the rule everywhere in this proxy and it matters more here than usual,
 * because a malformed tools array is a broken session rather than a slow one.
 */
export function deferTools(
  request: ProviderRequest,
  options: DeferOptions = {}
): DeferralResult {
  const tools = (request as { tools?: unknown }).tools;
  if (!Array.isArray(tools) || tools.length === 0)
    return { request, deferredChars: 0, deferredCount: 0 };

  // Already carrying a search tool: the caller is doing this itself.
  if (tools.some((t) => (t as ToolLike)?.type === TOOL_SEARCH_TYPE))
    return { request, deferredChars: 0, deferredCount: 0 };

  const forced = forcedToolName(request);

  // CHOSEN HERE RATHER THAN DISCOVERED LATER, which is the whole point.
  //
  // Letting the model search for a tool costs a round trip AND a second cold
  // prefix write -- measured at about 11,000 tokens on top of the first. We can
  // see the task and every tool description in the same request, so we can make
  // that choice ourselves and never pay for discovery at all.
  //
  // This reuses the ranker already built for content, so it is BM25 by default
  // and semantic when an encoder has been warmed. With no query it keeps the
  // first few, which is no worse than an arbitrary choice and never worse than
  // deferring everything.
  const keep = options.keepRelevant ?? DEFAULT_KEEP_RELEVANT;
  const smallFloor = options.smallToolChars ?? SMALL_TOOL_CHARS;
  const candidates: { index: number; text: string }[] = [];
  tools.forEach((raw, index) => {
    if (typeof raw !== 'object' || raw === null) return;
    const t = raw as ToolLike & { description?: string };
    if (typeof t.name !== 'string') return;
    if (isCheapToKeep(JSON.stringify(raw).length, smallFloor)) return;
    candidates.push({ index, text: `${t.name} ${t.description ?? ''}` });
  });
  const ranked = activeRanker(options.query, options.embeddings);
  const chosen = ranked.top(
    candidates.map((c) => c.text),
    Math.min(keep, candidates.length)
  );
  const keepLoaded = new Set<number>();
  candidates.forEach((c, i) => {
    if (chosen.has(i)) keepLoaded.add(c.index);
  });
  // With no ranking signal at all, keep the first few rather than none.
  if (keepLoaded.size === 0)
    candidates.slice(0, keep).forEach((c) => keepLoaded.add(c.index));
  let deferredChars = 0;
  let deferredCount = 0;

  const rewritten = tools.map((raw, index) => {
    // A tools array is client input and can contain anything. Nothing below
    // may assume an object, or one null entry takes the whole session down
    // for the sake of a saving.
    if (typeof raw !== 'object' || raw === null) return raw;
    const tool = raw as ToolLike;
    // A server tool (code execution, computer use) is not a definition we can
    // defer, and a tool the caller already decided about is not ours to change.
    if (isServerTool(tool)) return raw;
    if (typeof tool.defer_loading === 'boolean') return raw;
    if (typeof tool.name !== 'string' || tool.name.length === 0) return raw;
    if (forced !== null && tool.name === forced) return raw;
    // The agent's own loop, and the non-core tools this task looks like it
    // needs, both stay in context so nothing has to be searched for.
    // Small enough that deferring it would save less than the discovery it
    // risks. This is what keeps the agent's core loop in context without
    // naming it -- those definitions are small.
    if (isCheapToKeep(JSON.stringify(raw).length, smallFloor)) return raw;
    if (keepLoaded.has(index)) return raw;

    deferredChars += JSON.stringify(raw).length;
    deferredCount += 1;
    return { ...(raw as object), defer_loading: true };
  });

  // Nothing was deferrable, so adding a search tool would only make the request
  // bigger -- the one outcome this must never produce.
  if (deferredCount === 0)
    return { request, deferredChars: 0, deferredCount: 0 };

  return {
    request: {
      ...request,
      tools: [{ type: TOOL_SEARCH_TYPE, name: TOOL_SEARCH_NAME }, ...rewritten],
    } as ProviderRequest,
    deferredChars,
    deferredCount,
  };
}

/**
 * Adds the beta to an existing `anthropic-beta` header without losing what is
 * already there.
 *
 * APPENDED, NEVER REPLACED. The client may already be enabling betas it needs;
 * overwriting the header would silently switch those off, and the failure would
 * appear far from here as a feature quietly not working.
 */
export function withAdvancedToolUse(
  existing: string | string[] | undefined
): string {
  const present = Array.isArray(existing)
    ? existing.join(',')
    : (existing ?? '');
  const parts = present
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.includes(ADVANCED_TOOL_USE_BETA))
    parts.push(ADVANCED_TOOL_USE_BETA);
  return parts.join(',');
}
