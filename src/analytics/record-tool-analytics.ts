/**
 * Auto-recording bridge between the MCP tool dispatcher and the AnalyticsManager.
 *
 * Every token-optimizer tool returns its result as a JSON string inside an MCP
 * `content[].text` block. Most optimization tools include a savings triplet
 * (original tokens, optimized tokens, tokens saved) under one of a handful of
 * well-known field names. This module extracts that triplet from a tool result
 * and records it, so the analytics breakdown tools (`get_hook_analytics`,
 * `get_action_analytics`, `get_mcp_server_analytics`, `export_analytics`,
 * `get_optimization_report`) have real data instead of always returning zeros.
 *
 * It is intentionally best-effort: a tool whose result has no recognizable
 * savings triplet is silently skipped, and any parsing/storage error is
 * swallowed so recording can never break a tool call.
 */

import type { AnalyticsManager } from './analytics-manager.js';
import type { HookPhase } from './analytics-types.js';

/** MCP tool result shape (the parts we read). */
interface McpToolResult {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
}

/** A normalized savings measurement extracted from a tool result. */
export interface SavingsTriplet {
  originalTokens: number;
  optimizedTokens: number;
  tokensSaved: number;
}

const VALID_HOOK_PHASES: readonly HookPhase[] = [
  'PreToolUse',
  'PostToolUse',
  'SessionStart',
  'PreCompact',
  'UserPromptSubmit',
  'Unknown',
];

// Field-name aliases seen across the 70+ tools. Order matters: the first present
// numeric field wins.
const ORIGINAL_KEYS = [
  'originalTokens',
  'originalTokenCount',
  'tokensBefore',
  'beforeTokens',
  'inputTokens',
];
const OPTIMIZED_KEYS = [
  'optimizedTokens',
  'compressedTokens',
  'cachedTokens',
  'tokensAfter',
  'afterTokens',
  'outputTokens',
];
const SAVED_KEYS = ['tokensSaved', 'savedTokens', 'tokens_saved', 'tokenSavings'];

// Containers a triplet is commonly nested inside.
const NESTED_CONTAINERS = [
  'metadata',
  'stats',
  'statistics',
  'summary',
  'optimization',
  'tokenAnalysis',
  'tokens',
  'result',
  'data',
];

function firstNumber(
  obj: Record<string, unknown>,
  keys: string[]
): number | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

/** Try to read a savings triplet directly off one object (no recursion). */
function tripletFrom(obj: Record<string, unknown>): SavingsTriplet | null {
  const original = firstNumber(obj, ORIGINAL_KEYS);
  const optimized = firstNumber(obj, OPTIMIZED_KEYS);
  const saved = firstNumber(obj, SAVED_KEYS);

  // Need enough to reconstruct the triplet. Accept any two of the three, or
  // (original + saved) / (original + optimized) / (optimized + saved).
  const known = [original, optimized, saved].filter(
    (n): n is number => typeof n === 'number'
  ).length;
  if (known < 2) {
    // Special case: an explicit savings value alone is still meaningful.
    if (typeof saved === 'number' && typeof original === 'number') {
      // handled below; unreachable here since that's 2 known
    }
    return null;
  }

  let o = original;
  let opt = optimized;
  let s = saved;

  if (o === undefined && opt !== undefined && s !== undefined) o = opt + s;
  if (opt === undefined && o !== undefined && s !== undefined) opt = o - s;
  if (s === undefined && o !== undefined && opt !== undefined) s = o - opt;

  if (o === undefined || opt === undefined || s === undefined) return null;

  // Sanity: no negative token counts; ignore no-op records with nothing saved
  // AND nothing measured (pure noise), but keep genuine 0-savings measurements.
  if (o < 0 || opt < 0) return null;
  if (o === 0 && opt === 0) return null;

  return { originalTokens: o, optimizedTokens: opt, tokensSaved: s };
}

/**
 * Extract a savings triplet from a parsed tool-result payload, checking the
 * top level first, then one level of common nested containers.
 */
export function extractSavings(payload: unknown): SavingsTriplet | null {
  if (!payload || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;

  const top = tripletFrom(obj);
  if (top) return top;

  for (const key of NESTED_CONTAINERS) {
    const child = obj[key];
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      const nested = tripletFrom(child as Record<string, unknown>);
      if (nested) return nested;
    }
  }
  return null;
}

/** Resolve the current hook phase from the environment (set by hook launchers). */
export function currentHookPhase(): HookPhase {
  const raw = process.env.TOKEN_OPTIMIZER_HOOK_PHASE;
  if (raw && (VALID_HOOK_PHASES as readonly string[]).includes(raw)) {
    return raw as HookPhase;
  }
  return 'Unknown';
}

/**
 * Best-effort: record the savings from a single MCP tool result. Never throws.
 *
 * @param manager   the shared AnalyticsManager
 * @param toolName  the tool that produced the result (e.g. "smart_read")
 * @param result    the MCP result object returned by the tool handler
 */
export async function recordToolAnalytics(
  manager: AnalyticsManager,
  toolName: string,
  result: McpToolResult
): Promise<void> {
  try {
    if (!result || result.isError) return;
    const text = result.content?.find((c) => c?.type !== 'image')?.text;
    if (!text) return;

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return; // non-JSON output (e.g. raw text) — nothing to record
    }

    // Don't record failures the tool reported in-band.
    if (
      payload &&
      typeof payload === 'object' &&
      (payload as Record<string, unknown>).success === false
    ) {
      return;
    }

    const savings = extractSavings(payload);
    if (!savings) return;

    const sessionId =
      process.env.TOKEN_OPTIMIZER_SESSION_ID ||
      (payload as Record<string, unknown>).sessionId as string | undefined;

    await manager.track({
      hookPhase: currentHookPhase(),
      toolName,
      mcpServer: 'token-optimizer',
      originalTokens: savings.originalTokens,
      optimizedTokens: savings.optimizedTokens,
      tokensSaved: savings.tokensSaved,
      ...(sessionId ? { sessionId } : {}),
    });
  } catch {
    // Analytics must never break a tool call.
  }
}
