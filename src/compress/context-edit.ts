/**
 * Old tool results cleared server-side, once they cost more to keep than to drop.
 *
 * A tool result costs its size on every later call: the campaign's 477k
 * characters of shell output were each re-read about 15 times. The provider
 * can drop the oldest results itself (`clear_tool_uses_20250919`, beta
 * `context-management-2025-06-27`), replacing each with a placeholder. That is
 * SERVER-SIDE, so the client keeps its full history, and on the models that
 * bind thinking to the conversation it never invalidates a thinking block --
 * which a rewrite of history by this proxy would.
 *
 * THE CACHE DECIDES THE PARAMETERS. Clearing re-writes the cached prompt from
 * the first cleared result onward, about 1.15x the context behind it (1.25x
 * written instead of 0.1x read), once; it saves 0.1x the cleared tokens on
 * every later call. Clearing at least half of a 60k-token context therefore
 * pays back after about 20 more calls -- short agents never reach the trigger,
 * and long sessions, which run hundreds of calls at that size, gain on every
 * one after. `clear_at_least` makes each activation free enough to be worth
 * the re-write instead of trimming a little every turn.
 *
 * Results of Agent/Task calls are kept: they are the workers' deliverables.
 *
 * TOKEN_OPTIMIZER_PROXY_CLEAR_TOOL_USES=0 turns it off; _TRIGGER, _KEEP and
 * _AT_LEAST set the trigger (input tokens), the tool uses kept, and the
 * minimum cleared per activation (input tokens).
 */
import type { ProviderRequest } from './frontier.js';

export const CONTEXT_MANAGEMENT_BETA = 'context-management-2025-06-27';
export const CLEAR_TOOL_USES = 'clear_tool_uses_20250919';

export interface ClearingPolicy {
  readonly triggerTokens: number;
  readonly keepToolUses: number;
  readonly clearAtLeastTokens: number;
}

export const DEFAULT_CLEARING: ClearingPolicy = {
  triggerTokens: 60_000,
  keepToolUses: 5,
  clearAtLeastTokens: 30_000,
};

const KEPT_TOOLS = ['Agent', 'Task'];

const positive = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

export function clearingFromEnv(
  env: NodeJS.ProcessEnv = process.env
): ClearingPolicy | null {
  const raw = String(env.TOKEN_OPTIMIZER_PROXY_CLEAR_TOOL_USES ?? '').trim();
  if (/^(0|false|no|off)$/i.test(raw)) return null;
  return {
    triggerTokens: positive(
      env.TOKEN_OPTIMIZER_PROXY_CLEAR_TOOL_USES_TRIGGER,
      DEFAULT_CLEARING.triggerTokens
    ),
    keepToolUses: positive(
      env.TOKEN_OPTIMIZER_PROXY_CLEAR_TOOL_USES_KEEP,
      DEFAULT_CLEARING.keepToolUses
    ),
    clearAtLeastTokens: positive(
      env.TOKEN_OPTIMIZER_PROXY_CLEAR_TOOL_USES_AT_LEAST,
      DEFAULT_CLEARING.clearAtLeastTokens
    ),
  };
}

interface Edit {
  readonly type?: string;
  readonly [key: string]: unknown;
}

/**
 * The request with our clearing edit appended to whatever the client already
 * asked for. Claude Code sends `clear_thinking_20251015`, which the API
 * requires to come first, so ours goes after it. A client that already clears
 * tool uses is managing this itself and is left alone, as is a request with no
 * tools (nothing to clear).
 */
export function addToolClearing(
  request: ProviderRequest,
  policy: ClearingPolicy
): { request: ProviderRequest; added: boolean } {
  const tools = (request as { tools?: unknown }).tools;
  if (!Array.isArray(tools) || tools.length === 0)
    return { request, added: false };
  const existing = (request as { context_management?: { edits?: unknown } })
    .context_management;
  const edits = Array.isArray(existing?.edits)
    ? (existing.edits as Edit[])
    : [];
  if (edits.some((e) => e?.type === CLEAR_TOOL_USES))
    return { request, added: false };
  const ours = {
    type: CLEAR_TOOL_USES,
    trigger: { type: 'input_tokens', value: policy.triggerTokens },
    keep: { type: 'tool_uses', value: policy.keepToolUses },
    clear_at_least: { type: 'input_tokens', value: policy.clearAtLeastTokens },
    exclude_tools: KEPT_TOOLS,
  };
  return {
    request: {
      ...request,
      context_management: { ...(existing ?? {}), edits: [...edits, ours] },
    } as ProviderRequest,
    added: true,
  };
}

/** A beta list with `beta` in it, keeping every beta the client asked for. */
export function withBeta(
  existing: string | string[] | undefined,
  beta: string
): string {
  const parts = (
    Array.isArray(existing) ? existing.join(',') : (existing ?? '')
  )
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.includes(beta)) parts.push(beta);
  return parts.join(',');
}

/**
 * Server-side compaction (`compact_20260112`, beta `compact-2026-01-12`): past
 * the trigger the provider replaces the history with a summary it writes,
 * returned as a `compaction` block at the head of the response.
 *
 * OPT-IN until measured (TOKEN_OPTIMIZER_PROXY_COMPACT=1, _TRIGGER in input
 * tokens, minimum 50,000). It only holds if the client sends that block back:
 * the API ignores everything before it. A client that drops the block sends the
 * full history again, and every later request over the trigger would pay for a
 * fresh summary of all of it.
 */
export const COMPACT = 'compact_20260112';
export const COMPACT_BETA = 'compact-2026-01-12';
export const MIN_COMPACT_TRIGGER = 50_000;

export function compactionFromEnv(
  env: NodeJS.ProcessEnv = process.env
): { triggerTokens: number } | null {
  const raw = String(env.TOKEN_OPTIMIZER_PROXY_COMPACT ?? '').trim();
  if (!/^(1|true|yes|on)$/i.test(raw)) return null;
  return {
    triggerTokens: Math.max(
      MIN_COMPACT_TRIGGER,
      positive(env.TOKEN_OPTIMIZER_PROXY_COMPACT_TRIGGER, 80_000)
    ),
  };
}

/** The request with a compaction edit appended, unless the client set one. */
export function addCompaction(
  request: ProviderRequest,
  policy: { triggerTokens: number }
): { request: ProviderRequest; added: boolean } {
  const existing = (request as { context_management?: { edits?: unknown } })
    .context_management;
  const edits = Array.isArray(existing?.edits)
    ? (existing.edits as Edit[])
    : [];
  if (edits.some((e) => e?.type === COMPACT)) return { request, added: false };
  return {
    request: {
      ...request,
      context_management: {
        ...(existing ?? {}),
        edits: [
          ...edits,
          {
            type: COMPACT,
            trigger: { type: 'input_tokens', value: policy.triggerTokens },
          },
        ],
      },
    } as ProviderRequest,
    added: true,
  };
}
