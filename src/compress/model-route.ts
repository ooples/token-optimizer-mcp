/**
 * Read-only subagents on a cheaper model (user decision 2026-10-21: on by
 * default for read-only subagents; writers keep their model).
 *
 * Triage, audit and exploration agents read and report. They are the bulk of a
 * fan-out's calls and need the least judgment, so routing them one tier down
 * -- Opus to Sonnet, Sonnet to Haiku -- cuts what they cost (Haiku 5.5 is a
 * fortieth of Opus 5.5 per token) without touching an agent that changes code.
 *
 * ONE DECISION PER CONVERSATION. The model is chosen from the subagent's own
 * task text, which is the same on every turn, so a conversation never changes
 * model midway: a switch would miss the prompt cache, and on the models that
 * bind thinking to the conversation it would drop every earlier thinking block.
 *
 * READ-ONLY MEANS DECLARED READ-ONLY. Only an explicit statement in the task --
 * "read-only", "do not edit/modify/write" -- or Claude Code's own read-only
 * agent types qualify. Nothing is inferred from what a task happens to do.
 *
 * TOKEN_OPTIMIZER_PROXY_READONLY_ROUTE=0 turns it off; =<model id> routes every
 * read-only subagent to that model instead of one tier down.
 */
import type { ProviderRequest, Block } from './frontier.js';
import { isSubagentRequest } from './subagent-context.js';

/** One tier down, by family. A model outside these families is left alone. */
const DOWN: readonly [RegExp, string][] = [
  [/fable|mythos/i, 'claude-opus-5-5'],
  [/opus/i, 'claude-sonnet-5-5'],
  [/sonnet/i, 'claude-haiku-5-5'],
];

/** The task text, or the stretch of it before a benchmark's own appended mode note. */
function declaredTask(request: ProviderRequest): string {
  const first = (request.messages ?? []).find((m) => m?.role === 'user');
  const content = first?.content;
  const texts =
    typeof content === 'string'
      ? [content]
      : Array.isArray(content)
        ? content.filter((b) => (b as Block)?.type === 'text').map((b) => String((b as Block).text ?? ''))
        : [];
  return texts[texts.length - 1] ?? '';
}

/**
 * A DECLARED role, not a passing phrase. Shared rule text says things like
 * "never edit another worktree" to agents that do edit, so prohibitions alone
 * routed every worker of a real campaign, fixers included. What counts is the
 * task naming itself read-only: "(read-only: ...)", "read-only agent/task/
 * mode/review/audit/triage", "this is a read-only ...".
 */
const READ_ONLY_TASK =
  /\(read-only\b|\bread-only:|\bread-only (?:agent|task|mode|review|audit|triage|research|investigation|exploration)\b|\b(?:this|you) (?:is|are) (?:a |an )?read-only\b/i;
const READ_ONLY_AGENT = /\bread-only (?:search|exploration|research) agent\b|\bYou are a (?:file search|read-only)\b/i;

/** Is this subagent declared read-only by its task or by its agent type's system prompt? */
export function isReadOnlySubagent(request: ProviderRequest): boolean {
  if (!isSubagentRequest(request)) return false;
  const system = Array.isArray(request.system)
    ? request.system.map((b) => (b as Block)?.text ?? '').join('\n')
    : String(request.system ?? '');
  if (READ_ONLY_AGENT.test(system)) return true;
  return READ_ONLY_TASK.test(declaredTask(request));
}

export function readOnlyRouteFromEnv(env: NodeJS.ProcessEnv = process.env): 'off' | 'down' | string {
  const raw = String(env.TOKEN_OPTIMIZER_PROXY_READONLY_ROUTE ?? '').trim();
  if (/^(0|false|no|off)$/i.test(raw)) return 'off';
  if (!raw || /^(1|true|yes|on|down)$/i.test(raw)) return 'down';
  return raw;
}

export interface RouteResult {
  readonly request: ProviderRequest;
  readonly from: string | null;
  readonly to: string | null;
}

export function routeReadOnlySubagent(
  request: ProviderRequest,
  mode: 'off' | 'down' | string = readOnlyRouteFromEnv()
): RouteResult {
  const model = String((request as { model?: unknown }).model ?? '');
  const none = { request, from: null, to: null };
  if (mode === 'off' || !model || !isReadOnlySubagent(request)) return none;
  const to = mode === 'down' ? (DOWN.find(([re]) => re.test(model))?.[1] ?? null) : mode;
  if (!to || to === model) return none;
  return { request: { ...request, model: to } as ProviderRequest, from: model, to };
}
