/**
 * Where the provider's cache ends and new content begins.
 *
 * THE ARITHMETIC THAT MAKES THIS THE CENTRAL IDEA. Anthropic bills a cache read
 * at 0.1x base input and a cache write at 1.25x. So 50,000 cached tokens cost
 * the same as 5,000 fresh ones. Compress them to 20,000 and the prefix no
 * longer matches, the cache misses, and those 20,000 are billed at 1.0x -- plus
 * 1.25x to write the new prefix.
 *
 *     50,000 cached   ->  5,000 effective
 *     20,000 fresh    -> 20,000 effective, and 25,000 if it re-caches
 *
 * A 60% token reduction that makes the request FOUR TIMES more expensive. This
 * is the trap that a reduction-percentage metric cannot see, and it is why
 * `effective` tokens are measured here alongside gross and net.
 *
 * So the rule: never rewrite anything at or before the last cache breakpoint.
 * Compress only what is arriving now, once, before it enters the cache -- where
 * it is billed at 1.0x today and 0.1x for every remaining turn of the session.
 * Cache-safe by construction rather than by keeping a rewritten prefix
 * byte-stable, which is what their CacheAligner has to attempt.
 */

/** A content block in a provider request. Deliberately loose: providers differ. */
export interface Block {
  type?: string;
  text?: string;
  content?: unknown;
  signature?: string;
  cache_control?: { type?: string } | null;
  [key: string]: unknown;
}

/** One message in the conversation. */
export interface Message {
  role?: string;
  content?: string | Block[];
  [key: string]: unknown;
}

/** The subset of a provider request this cares about. */
export interface ProviderRequest {
  system?: string | Block[];
  messages?: Message[];
  tools?: unknown[];
  [key: string]: unknown;
}

/** A position in the conversation: which message, and which block within it. */
export interface Position {
  readonly message: number;
  readonly block: number;
}

/**
 * A signed thinking block must never be touched.
 *
 * Their issue #3456 is exactly this: rewriting a message that carries signed
 * thinking blocks produces a PERMANENT upstream 400 -- the signature no longer
 * matches the content, the provider rejects it, and because the poisoned block
 * is now in history every subsequent request fails too. Not a degraded
 * response: a dead conversation.
 *
 * Checked on the block AND on its message, since the signature covers the
 * message as the provider received it.
 */
export function isSigned(block: Block): boolean {
  return (
    typeof block.signature === 'string' ||
    block.type === 'thinking' ||
    block.type === 'redacted_thinking'
  );
}

/** True when any block in the message is signed, so the whole message is off limits. */
export function messageIsSigned(message: Message): boolean {
  const content = message.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => isSigned(block as Block));
}

/**
 * The last position carrying an explicit cache breakpoint.
 *
 * Returns null when nothing is cached, in which case every block is new and the
 * whole request is fair game.
 */
export function lastCacheBreakpoint(request: ProviderRequest): Position | null {
  let found: Position | null = null;

  const system = request.system;
  if (Array.isArray(system)) {
    system.forEach((block, index) => {
      if (block?.cache_control) found = { message: -1, block: index };
    });
  }

  const messages = request.messages ?? [];
  messages.forEach((message, mi) => {
    const content = message?.content;
    if (!Array.isArray(content)) return;
    content.forEach((block, bi) => {
      if ((block as Block)?.cache_control) found = { message: mi, block: bi };
    });
  });

  return found;
}

/** Is this position strictly after the frontier, and therefore compressible? */
export function isAfter(
  position: Position,
  frontier: Position | null
): boolean {
  if (!frontier) return true;
  if (position.message !== frontier.message)
    return position.message > frontier.message;
  return position.block > frontier.block;
}
