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
export function deferTools(request: ProviderRequest): DeferralResult {
  const tools = (request as { tools?: unknown }).tools;
  if (!Array.isArray(tools) || tools.length === 0)
    return { request, deferredChars: 0, deferredCount: 0 };

  // Already carrying a search tool: the caller is doing this itself.
  if (tools.some((t) => (t as ToolLike)?.type === TOOL_SEARCH_TYPE))
    return { request, deferredChars: 0, deferredCount: 0 };

  const forced = forcedToolName(request);
  let deferredChars = 0;
  let deferredCount = 0;

  const rewritten = tools.map((raw) => {
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
