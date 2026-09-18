/**
 * A synchronous "is there a credential at all" probe for startup-time selection.
 *
 * WHY SYNCHRONOUS, AND WHY SO SMALL. `createSummarizerFromEnv()` runs on the MCP server's startup
 * path, where the surrounding code cannot await usefully and the cost of getting this wrong is a
 * server that does not boot. The asynchronous credential store is the source of truth everywhere
 * else; this only decides whether the OrcaRouter summarizer is a candidate, and it answers from the
 * environment and a single small file.
 *
 * It never returns the key. A boolean is all a selector needs, and a function that returned the
 * secret would eventually be called from somewhere that logs.
 */

/* eslint-disable n/no-sync -- SEE THE HEADER. This runs on the MCP server's startup path, where the
 * surrounding code cannot await usefully and the cost of getting it wrong is a server that does not
 * boot. `src/proxy/default-routing.ts` and `src/proxy/accounting.ts` are synchronous throughout for
 * the same reason, and both record it. The read is one small file. */
import { existsSync, readFileSync } from 'node:fs';
import { credentialStorePath } from './credential-store.js';

/**
 * Is an OrcaRouter credential available?
 *
 * Reads the environment first, then the store's presence and shape. A store that exists but holds
 * only credentials awaiting reauthentication answers false, because selecting a summarizer that is
 * guaranteed to 401 turns a working truncating fallback into a failing network call.
 */
export function hasOrcaRouterCredential(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (String(env.ORCAROUTER_API_KEY ?? '').trim()) return true;
  try {
    const path = credentialStorePath(env);
    if (!existsSync(path)) return false;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      schema?: unknown;
      credentials?: unknown;
    };
    if (parsed?.schema !== 1 || !Array.isArray(parsed.credentials))
      return false;
    return parsed.credentials.some(
      (entry) =>
        !!entry &&
        typeof (entry as { key?: unknown }).key === 'string' &&
        ((entry as { key: string }).key.length ?? 0) > 0 &&
        (entry as { needsReauth?: unknown }).needsReauth !== true
    );
  } catch {
    return false;
  }
}
