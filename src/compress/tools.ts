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
 * Client tools that are the only way to reach a whole class of other tools.
 *
 * NEVER DEFERRED, because the search tool added below cannot stand in for them.
 * Claude Code keeps its MCP tools out of the request altogether and lists them
 * by name in the conversation, to be fetched through its own `ToolSearch`. The
 * server-side search only sees definitions that are IN the request, so once
 * `ToolSearch` is deferred behind it, every client-deferred tool is unreachable:
 * observed 2026-10-13 (#496), where three sub-agents searched for
 * `get_optimization_report` and got "No tools match your search" although the
 * name was listed to them, while `ToolSearch` itself loaded it at once.
 */
const CLIENT_DISCOVERY_TOOLS: ReadonlySet<string> = new Set(['ToolSearch']);

/**
 * Keep definitions whose character count is at or below the configured floor.
 * Size, rather than tool name or origin, determines whether deferral pays.
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
 *
 * AND THEN MEASUREMENT OVERTURNED THE FLOOR ITSELF, which is why it is 0.
 * The argument above is per-TOOL and the cost it trades against is per-REQUEST.
 * At 1,500 characters, 88 of 115 definitions in a real capture were exempt --
 * about 55KB held in the cached prefix, in the region that is 66.9% of a
 * request. Every individual exemption looked cheap and the sum was the largest
 * thing this proxy declined to touch.
 *
 * Live A/B, four arms, sixteen runs, each arm holding each position in the run
 * order exactly once so prefix-cache carryover cancels. Weighted input is the
 * provider's own usage at 1.25x for cache writes and 0.1x for reads; the
 * verdict is pytest re-run afterwards, never the agent's own report:
 *
 *   control (recorded, uncompressed)   134,706   4/4 pass
 *   floor 1500 (the old default)       100,818   4/4 pass   -25%
 *   floor 0    (this default)           49,053   4/4 pass   -64%
 *   HeadRoom's shipped proxy            48,626   4/4 pass   -64%
 *
 * The discovery round trips the floor existed to prevent did not appear. The
 * floor-0 arm was the FASTEST of the four (32s mean against 36-38s) and emitted
 * the fewest output tokens (1,024 against control's 1,337) -- the opposite of
 * an agent hunting for tools it cannot see.
 *
 * WHAT THAT DOES NOT SHOW: sixteen runs of one small Python task. It says the
 * exemption costs more than it saves there, not that discovery can never bite.
 * A task needing several specialised tools at once is the shape that would, and
 * is not covered. `TOKEN_OPTIMIZER_PROXY_SMALL_TOOL_CHARS` restores any floor,
 * 1500 included.
 */
export const SMALL_TOOL_CHARS = 0;

/** How many non-core tools to keep loaded when a task hints at what it needs. */
export const DEFAULT_KEEP_RELEVANT = 5;

/**
 * The agent's own loop: never deferred, never ranked.
 *
 * THE FLOOR-0 RULE ABOVE DEFERRED THEM, AND RANKING DID NOT SAVE THEM. Ranking
 * keeps the five definitions whose TEXT best matches the task, and text match is
 * not usage: on the multi-agent harness (bench/live/multi-agent.mjs, 2026-10-21)
 * "four Python packages ... pytest" kept PowerShell, Agent and Skill loaded and
 * deferred Edit, Write, Grep and Glob. Agents then edited through the shell --
 * Edit calls fell from 1.7 to 0.7 per run against the uncompressed control --
 * while the one tool nobody called, PowerShell at 8,947 characters, stayed in
 * every request of every agent.
 *
 * Named, not inferred: these are the tools every coding session lives in, and
 * each is small (Read 1,919, Edit 964, Write 639, Glob 731 characters). The
 * earlier objection to an origin rule ("all 31 built-ins are core") does not
 * apply to an explicit list of eight. TOKEN_OPTIMIZER_PROXY_CORE_TOOLS replaces
 * the list; `none` restores deferring everything.
 */
export const CORE_LOOP_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Edit',
  'MultiEdit',
  'Write',
  'Bash',
  'Grep',
  'Glob',
  'NotebookEdit',
]);

/**
 * A tool that duplicates another one in the same request: deferred, and never
 * ranked into the kept set, while its counterpart is present.
 *
 * Claude Code on Windows offers PowerShell beside Bash; it is the largest
 * definition in a subagent's request (8,947 characters, about 2.2k tokens of
 * every call) and the harness agents never called it. Deferring rather than
 * removing keeps it reachable through tool search for the session that does
 * want it, so nothing is lost.
 */
const REDUNDANT_WITH: Readonly<Record<string, string>> = { PowerShell: 'Bash' };

/**
 * Specialised client tools: deferred, and never ranked into the kept set.
 *
 * Ranking keeps the five definitions whose text best matches the task, and with
 * the core loop kept by name the candidates left are mostly these -- so
 * ranking kept nearly all of them. Across the 10-worker campaign run (176
 * calls) not one of them was called: Artifact alone is 35,306 characters in
 * every request, SendFeedback 5,537, ScheduleWakeup 4,631, Workflow 5,355,
 * ReportFindings 2,206, ListAgents 1,180. A session that wants one finds it
 * through tool search; nothing is removed.
 */
const SPECIALISED_TOOLS: ReadonlySet<string> = new Set([
  'Artifact',
  'ArtifactComments',
  'ArtifactData',
  'SendFeedback',
  'ReportFindings',
  'ListAgents',
  'ScheduleWakeup',
  'Workflow',
  'DesignSync',
  'CronCreate',
  'CronDelete',
  'CronList',
  'RemoteTrigger',
  'PushNotification',
  'SendUserFile',
  'EnterWorktree',
  'ExitWorktree',
  'EnterPlanMode',
  'ExitPlanMode',
]);

/**
 * A definition without the JSON-schema meta keys the provider does not need.
 *
 * `$schema` names the draft the schema was written against; it constrains
 * nothing the model or the API reads, and Claude Code sends it on every
 * built-in (57-72 characters each, in every request). Deterministic, so the
 * cached prefix stays byte-stable across turns.
 */
function slimDefinition(raw: unknown): { tool: unknown; saved: number } {
  if (typeof raw !== 'object' || raw === null) return { tool: raw, saved: 0 };
  const schema = (raw as { input_schema?: unknown }).input_schema;
  if (typeof schema !== 'object' || schema === null || !('$schema' in schema))
    return { tool: raw, saved: 0 };
  const { $schema: _schema, ...rest } = schema as Record<string, unknown>;
  const tool = { ...(raw as object), input_schema: rest };
  return {
    tool,
    saved: JSON.stringify(raw).length - JSON.stringify(tool).length,
  };
}

export interface DeferOptions {
  /** The task text, used to decide which non-core tools are worth loading. */
  readonly query?: string;
  /** Non-core tools to keep loaded. */
  readonly keepRelevant?: number;
  /** Definitions at or below this size are always kept. */
  readonly smallToolChars?: number;
  /** Vectors for a semantic ranking, when one has been warmed. */
  readonly embeddings?: EmbeddingCache;
  /** Tools never deferred or ranked; defaults to CORE_LOOP_TOOLS. */
  readonly coreTools?: ReadonlySet<string>;
}

export interface DeferralResult {
  readonly request: ProviderRequest;
  /** Characters of tool definition removed from context. */
  readonly deferredChars: number;
  readonly deferredCount: number;
  /** Characters removed from definitions that stayed (schema meta keys). */
  readonly slimmedChars?: number;
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
  const core = options.coreTools ?? CORE_LOOP_TOOLS;
  const present = new Set(
    tools
      .map((t) => (t as ToolLike | null)?.name)
      .filter((n): n is string => typeof n === 'string')
  );
  // Never kept by ranking or by the size floor: a duplicate of a tool that is
  // present, or a specialised tool no measured session called.
  const redundant = (name: string): boolean =>
    SPECIALISED_TOOLS.has(name) ||
    (REDUNDANT_WITH[name] !== undefined && present.has(REDUNDANT_WITH[name]));
  const candidates: { index: number; text: string }[] = [];
  tools.forEach((raw, index) => {
    if (typeof raw !== 'object' || raw === null) return;
    const t = raw as ToolLike & { description?: string };
    if (typeof t.name !== 'string') return;
    if (CLIENT_DISCOVERY_TOOLS.has(t.name)) return;
    if (core.has(t.name) || redundant(t.name)) return;
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
  let slimmedChars = 0;
  const slim = (raw: unknown): unknown => {
    const out = slimDefinition(raw);
    slimmedChars += out.saved;
    return out.tool;
  };

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
    if (forced !== null && tool.name === forced) return slim(raw);
    if (CLIENT_DISCOVERY_TOOLS.has(tool.name)) return slim(raw);
    // The agent's own loop stays loaded by name; see CORE_LOOP_TOOLS.
    if (core.has(tool.name)) return slim(raw);
    if (!redundant(tool.name)) {
      // The non-core tools this task looks like it needs stay in context so
      // nothing has to be searched for, and so does anything below the floor.
      if (isCheapToKeep(JSON.stringify(raw).length, smallFloor))
        return slim(raw);
      if (keepLoaded.has(index)) return slim(raw);
    }

    const slimmed = slim(raw);
    deferredChars += JSON.stringify(slimmed).length;
    deferredCount += 1;
    return { ...(slimmed as object), defer_loading: true };
  });

  // Nothing was deferrable, so adding a search tool would only make the request
  // bigger -- the one outcome this must never produce. Slimmed definitions are
  // still worth forwarding: they are smaller and byte-stable.
  if (deferredCount === 0)
    return slimmedChars > 0
      ? {
          request: { ...request, tools: rewritten } as ProviderRequest,
          deferredChars: 0,
          deferredCount: 0,
          slimmedChars,
        }
      : { request, deferredChars: 0, deferredCount: 0 };

  return {
    request: {
      ...request,
      tools: [{ type: TOOL_SEARCH_TYPE, name: TOOL_SEARCH_NAME }, ...rewritten],
    } as ProviderRequest,
    deferredChars,
    deferredCount,
    slimmedChars,
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
