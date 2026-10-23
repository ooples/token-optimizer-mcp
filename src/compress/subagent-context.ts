/**
 * Trimming what Claude Code injects into every SUBAGENT request.
 *
 * THE COST. A workflow worker's first request carried, before its task: the
 * user's auto-memory index (18.4k characters, about a dozen projects' notes),
 * every skill with its full description (18.5k), the names of ~300 deferred
 * tools from every connected server, and eagerly loaded connector tools -- and
 * each later call re-reads all of it. Measured on a 10-worker run, these were
 * about 10k of the 41.4k tokens every one of its 176 calls started from.
 *
 * WHAT IS REMOVED (user decision 2026-10-21, subagents only -- the main
 * session is never touched):
 *   - the MEMORY.md section of the instructions block (CLAUDE.md sections stay);
 *   - skill descriptions (names stay, so a skill is still invocable by name);
 *   - deferred-tool names and eagerly loaded tools from MCP servers the agent's
 *     task never mentions (built-in tools and this package's own stay listed;
 *     the client still holds every tool, so tool search still finds them).
 *
 * DETERMINISTIC PER BLOCK. Each rewrite is a pure function of the block's own
 * text, so every turn of a conversation produces the same bytes and the cached
 * prefix holds.
 */
import type { ProviderRequest, Block, Message } from './frontier.js';

/** Is this a subagent's request? Claude Code says so in its billing header, and in the system prompt. */
export function isSubagentRequest(request: ProviderRequest): boolean {
  const system = request.system;
  const text = Array.isArray(system)
    ? system.map((b) => (b as Block)?.text ?? '').join('\n')
    : String(system ?? '');
  return (
    /cc_is_subagent=true/.test(text) ||
    /You are a subagent spawned by a workflow/.test(text) ||
    /You are an agent for Claude Code, Anthropic's official CLI/.test(text)
  );
}

/** This package's own tool prefix: always kept, the agent may need them. */
const OWN_SERVER = /token-optimizer/i;

/** The server part of an MCP tool name: mcp__<server>__<tool>. */
const serverOf = (name: string): string | null => {
  const m = /^mcp__(.+?)__[^_].*$/.exec(name.trim());
  return m ? m[1] : null;
};

/**
 * Words of a server name a task would use to mean it: `claude_ai_Google_Drive`
 * is mentioned by "google drive", "drive"; `console-automation` by "console".
 */
function serverWords(server: string): string[] {
  return server
    .replace(/^(claude_ai_|plugin_[^_]+_)/, '')
    .split(/[_\-\s]+/)
    .filter((w) => w.length >= 4)
    .map((w) => w.toLowerCase());
}

export interface TrimOptions {
  /** The agent's task text; servers it names are kept. */
  readonly task: string;
}

function keepServer(server: string, task: string): boolean {
  if (OWN_SERVER.test(server)) return true;
  const t = task.toLowerCase();
  return serverWords(server).some((w) => t.includes(w));
}

/** Drop the MEMORY.md section from an instructions block; null when nothing else is left in it. */
export function stripMemoryIndex(text: string): string | null {
  const start = text.search(
    /^Contents of [^\n]*MEMORY\.md \(user's auto-memory[^\n]*\n/m
  );
  if (start < 0) return text;
  const after = text.slice(start);
  const nextSection = after.slice(1).search(/^Contents of /m);
  const close = after.indexOf('</system-reminder>');
  const end =
    nextSection >= 0
      ? start + 1 + nextSection
      : close >= 0
        ? start + close
        : text.length;
  const out = (text.slice(0, start) + text.slice(end)).replace(
    /\n{3,}/g,
    '\n\n'
  );
  // Only the generic preamble left: the block carried nothing but the index.
  const residue = out
    .replace(/<\/?system-reminder>/g, '')
    .replace(/Codebase and user instructions are shown below\.[^\n]*/g, '')
    .trim();
  return residue ? out : null;
}

/** Skill lines `- name: description` become `- name`. */
export function skillNamesOnly(text: string): string {
  const header =
    'The following skills are available for use with the Skill tool:';
  const at = text.indexOf(header);
  if (at < 0) return text;
  const head = text.slice(0, at + header.length);
  const rest = text.slice(at + header.length);
  // The listing runs until the first line that is neither blank nor a `- ` item.
  const lines = rest.split('\n');
  let i = 0;
  const out: string[] = [];
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('- ')) {
      // A name runs to the first ": " -- it may itself contain colons (plugin:skill).
      const m = /^- (\S+?):\s/.exec(line);
      out.push(m ? `- ${m[1]}` : line);
    } else if (line.trim() === '') {
      out.push(line);
    } else break;
  }
  return (
    head +
    out.join('\n') +
    (i < lines.length ? '\n' + lines.slice(i).join('\n') : '')
  );
}

/** In a tool-name listing (one name per line after its header), drop MCP names of unmentioned servers. */
function pruneNameListing(text: string, header: RegExp, task: string): string {
  const m = header.exec(text);
  if (!m) return text;
  const start = m.index + m[0].length;
  const lines = text.slice(start).split('\n');
  const kept: string[] = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const name = lines[i].trim();
    if (!name) break;
    if (!/^[\w.-]+$/.test(name)) break;
    const server = serverOf(name);
    if (!server || keepServer(server, task)) kept.push(lines[i]);
  }
  return text.slice(0, start) + [...kept, ...lines.slice(i)].join('\n');
}

const DEFERRED_HEADER =
  /The following deferred tools are now available via ToolSearch\.[^\n]*\n/;
const LOADED_HEADER =
  /The following tools just became available and are ready to use:\n/;

function trimText(text: string, task: string): string {
  let out = skillNamesOnly(text);
  out = pruneNameListing(out, DEFERRED_HEADER, task);
  out = pruneNameListing(out, LOADED_HEADER, task);
  // A "just became available" header with no names left under it says nothing.
  out = out.replace(
    /The following tools just became available and are ready to use:\n(?=\n|$)/,
    ''
  );
  return out;
}

const isToolAddition = (
  b: unknown
): b is { type: string; tool?: { definition?: { name?: string } } } =>
  (b as { type?: string } | null)?.type === 'tool_addition';

export interface TrimResult {
  readonly request: ProviderRequest;
  readonly removedChars: number;
}

/** The task text: the last text block of the first user turn (what a workflow or Agent call passed). */
function taskOf(messages: Message[]): string {
  const first = messages.find((m) => m?.role === 'user');
  const content = first?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const texts = content
    .filter((b) => (b as Block)?.type === 'text')
    .map((b) => String((b as Block).text ?? ''));
  return texts[texts.length - 1] ?? '';
}

export function trimSubagentContext(request: ProviderRequest): TrimResult {
  const none = { request, removedChars: 0 };
  if (!isSubagentRequest(request)) return none;
  const messages = request.messages;
  if (!Array.isArray(messages) || messages.length === 0) return none;
  const task = taskOf(messages);
  const before = JSON.stringify(messages).length;

  const next = messages.map((message) => {
    const content = message?.content;
    if (!Array.isArray(content)) return message;
    let changed = false;
    let droppedMarker: unknown;
    const blocks: unknown[] = [];
    for (const block of content as unknown[]) {
      if (isToolAddition(block)) {
        const server = serverOf(String(block.tool?.definition?.name ?? ''));
        if (server && !keepServer(server, task)) {
          changed = true;
          droppedMarker ??= (block as Block).cache_control;
          continue;
        }
        blocks.push(block);
        continue;
      }
      const b = block as Block;
      if (b?.type !== 'text' || typeof b.text !== 'string') {
        blocks.push(block);
        continue;
      }
      // Never rewrite the task itself.
      if (b.text === task) {
        blocks.push(block);
        continue;
      }
      const stripped = stripMemoryIndex(b.text);
      if (stripped === null) {
        // An instructions block that held only the memory index; keep any cache marker it carried.
        if (b.cache_control)
          blocks.push({ ...b, text: '<system-reminder>\n</system-reminder>' });
        changed = true;
        continue;
      }
      const trimmed = trimText(stripped, task);
      if (trimmed !== b.text) {
        changed = true;
        blocks.push({ ...b, text: trimmed });
      } else blocks.push(block);
    }
    // THE MARKER OUTLIVES THE BLOCK. Claude Code puts a subagent's last cache
    // marker on the final tool_addition of its system-role listing; dropping
    // that block without it left the first request cached only to the sibling
    // prefix, and call 2 re-wrote the rest (explore: +10k writes per run).
    const last = blocks[blocks.length - 1] as Block | undefined;
    if (droppedMarker && last && !last.cache_control)
      blocks[blocks.length - 1] = { ...last, cache_control: droppedMarker };
    return changed && blocks.length ? { ...message, content: blocks } : message;
  });

  const removedChars = before - JSON.stringify(next).length;
  if (removedChars <= 0) return none;
  return { request: { ...request, messages: next as Message[] }, removedChars };
}

/** TOKEN_OPTIMIZER_PROXY_TRIM_SUBAGENTS=0 turns it off. */
export function trimSubagentsEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return !/^(0|false|no|off)$/i.test(
    String(env.TOKEN_OPTIMIZER_PROXY_TRIM_SUBAGENTS ?? '').trim()
  );
}
