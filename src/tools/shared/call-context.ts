/**
 * What the server knows about the tool call being handled right now.
 *
 * Carried by AsyncLocalStorage rather than threaded through every tool's
 * options: the cache scope needs it deep inside tools that never see the MCP
 * request, and an argument would have to be added to each of them.
 */
import { AsyncLocalStorage } from 'async_hooks';

export interface CallContext {
  /** Claude Code's `_meta["claudecode/toolUseId"]` for this call, if sent. */
  toolUseId?: string;
}

export const callContext = new AsyncLocalStorage<CallContext>();

/** The `claudecode/toolUseId` a `tools/call` request carried, if any. */
export function toolUseIdFrom(meta: unknown): string | undefined {
  if (!meta || typeof meta !== 'object') return undefined;
  const value = (meta as Record<string, unknown>)['claudecode/toolUseId'];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
