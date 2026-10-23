/**
 * Sharing the identical leading context of sibling agents through the prompt cache.
 *
 * THE COST. Every subagent Claude Code starts sends the same tools, the same
 * system blocks and the same leading user blocks (memory index, environment,
 * attribution, the workflow harness preamble) -- and then its own task. Its
 * cache markers sit on the system blocks and at the END of the first
 * conversation turn, after the task. A cache entry is a prefix ending at a
 * marker, so the identical blocks after the system are never a prefix of their
 * own: every sibling writes them again at 1.25x instead of reading the first
 * sibling's copy at 0.1x. Measured on the 10-worker campaign run: about 20.4k
 * characters of identical leading blocks per worker, written ten times.
 *
 * THE MARKER. The API allows four cache markers and Claude Code places three.
 * The fourth goes on the last block before the task, so the shared run becomes
 * a prefix the next sibling reads. Nothing in the request changes but one
 * `cache_control` field, and the same request shape always gets it in the same
 * place, so later turns of the same conversation stay byte-stable.
 *
 * WHAT IS NOT SHARED. In a plain subagent the large listing of deferred tools
 * and skills arrives AFTER the task, as messages[1] -- a system-role turn. It
 * cannot be moved ahead of the task: the API requires a system-role turn to
 * precede an assistant turn or end the array (see sharePrefixMode).
 */
import type { ProviderRequest, Block } from './frontier.js';

/** The API's limit on cache_control markers per request. */
export const MAX_CACHE_MARKERS = 4;

/** Below this many characters a shared run is not worth a marker. */
export const MIN_SHARED_CHARS = 2000;

type Ttl = '5m' | '1h';
interface Marker {
  type: 'ephemeral';
  ttl?: Ttl;
}

export interface SiblingPrefixResult {
  readonly request: ProviderRequest;
  /** 'marker' when a marker was added. */
  readonly applied: 'none' | 'marker';
  readonly sharedChars: number;
}

const markerOf = (block: unknown): Marker | null => {
  const cc = (block as Block | null)?.cache_control as
    | Marker
    | null
    | undefined;
  return cc && typeof cc === 'object' ? cc : null;
};

/** Every marker in prefix order: tools, then system, then messages. */
function markersInOrder(
  request: ProviderRequest
): { path: string; marker: Marker }[] {
  const out: { path: string; marker: Marker }[] = [];
  const tools = (request as { tools?: unknown[] }).tools;
  if (Array.isArray(tools))
    tools.forEach((t, i) => {
      const m = markerOf(t);
      if (m) out.push({ path: `t${i}`, marker: m });
    });
  if (Array.isArray(request.system))
    request.system.forEach((b, i) => {
      const m = markerOf(b);
      if (m) out.push({ path: `s${i}`, marker: m });
    });
  (request.messages ?? []).forEach((msg, mi) => {
    if (Array.isArray(msg?.content))
      msg.content.forEach((b, bi) => {
        const m = markerOf(b);
        if (m) out.push({ path: `m${mi}.${bi}`, marker: m });
      });
  });
  return out;
}

/**
 * The TTL for a marker inserted at message 0: the API requires longer-lived
 * markers to come before shorter-lived ones, so take the next marker's TTL (the
 * shortest it may be), or the previous one's when none follows.
 */
function ttlFor(markers: { path: string; marker: Marker }[]): Ttl | undefined {
  const after = markers.find((m) => m.path.startsWith('m'));
  const before = [...markers].reverse().find((m) => !m.path.startsWith('m'));
  return (after ?? before)?.marker.ttl;
}

const isText = (b: unknown): b is Block =>
  (b as Block | null)?.type === 'text' && typeof (b as Block).text === 'string';

export function shareSiblingPrefix(
  request: ProviderRequest
): SiblingPrefixResult {
  const none = { request, applied: 'none' as const, sharedChars: 0 };
  const messages = request.messages;
  if (!Array.isArray(messages) || messages.length === 0) return none;
  const first = messages[0];
  if (
    first?.role !== 'user' ||
    !Array.isArray(first.content) ||
    first.content.length < 2
  )
    return none;
  const blocks = first.content as Block[];
  const taskIndex = blocks.length - 1;
  if (!isText(blocks[taskIndex])) return none;
  // Claude Code marked something inside the first turn's shared run itself: it is managing this.
  if (blocks.slice(0, taskIndex).some((b) => markerOf(b))) return none;

  const markers = markersInOrder(request);
  if (markers.length >= MAX_CACHE_MARKERS) return none;
  const ttl = ttlFor(markers);
  const marker: Marker = ttl
    ? { type: 'ephemeral', ttl }
    : { type: 'ephemeral' };

  const shared = blocks.slice(0, taskIndex);
  const sharedChars = JSON.stringify(shared).length;
  if (sharedChars < MIN_SHARED_CHARS) return none;
  const marked = blocks.map((b, i) =>
    i === taskIndex - 1 ? { ...b, cache_control: marker } : b
  );
  return {
    request: {
      ...request,
      messages: [{ ...first, content: marked }, ...messages.slice(1)],
    },
    applied: 'marker',
    sharedChars,
  };
}

/**
 * TOKEN_OPTIMIZER_PROXY_SHARE_PREFIX: the marker by default; 0/false/off
 * disables it. (`reorder` and `marker` are both accepted and mean the marker.)
 *
 * THE REORDER WAS REMOVED: IT WAS AN INVALID REQUEST. Moving the task into a
 * turn after the system-role listing produced `user, system, user`, which the
 * API rejects ("messages.1: role 'system' must precede an 'assistant' message
 * or end the array"). Every first request it touched failed with a 400 -- 11
 * per 10-agent campaign run -- and Claude Code recovered by rebuilding the
 * request in a different shape. Its measured advantage over the marker
 * (fix task 74.4% vs 86.3% of control) was that fallback shape, bought with a
 * rejected request per conversation, not the reorder.
 */
export function sharePrefixMode(
  env: NodeJS.ProcessEnv = process.env
): 'off' | 'marker' {
  const raw = String(env.TOKEN_OPTIMIZER_PROXY_SHARE_PREFIX ?? '')
    .trim()
    .toLowerCase();
  return /^(0|false|no|off)$/.test(raw) ? 'off' : 'marker';
}
