/**
 * Which project a request belongs to, read from the request itself.
 *
 * WHY THIS HAS TO EXIST. `startProxy` resolves the graph root once, from `projectRoot` or
 * `process.cwd()`, and holds it for the life of the listener. That is correct for a per-session
 * proxy the launcher starts inside the user's project, and impossible for the supervisor: one
 * detached daemon, serving every project on the machine, whose cwd is whatever directory happened
 * to spawn it. Without this, on-by-default routing would put one project's findings into every
 * other project's sessions.
 *
 * That is not a small inaccuracy. bench/thol/manifests/token-optimizer-proxy-knowledge measured it
 * on a real seed graph: a per-project ceiling of 99,842 characters against a transferable 30,870,
 * so 69% of what would be injected is wrong-project advice -- paid for in the cached prefix and
 * re-read every turn, to make the agent worse. Compression removes tokens and the knowledge block
 * adds them, so mis-scoped injection loses on both of the things this product competes on.
 *
 * VERIFIED AGAINST A REAL REQUEST, not assumed. A live `claude -p` was pointed at a recorder and
 * its 177KB body inspected: the path appears as `Primary working directory: <path>`, and NOT in the
 * `system` blocks -- it rides in the message content, which is why this scans the whole body.
 *
 * THE MATCH IS CONFIRMED ON DISK, which is what separates the path from prose about paths. That
 * same capture contained "Working directory persists between calls" in a tool description; it is
 * rejected here because what follows it is not a directory that exists.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

/**
 * Every "working directory: <path>" in the body whose path is really there.
 *
 * Bounded deliberately: the pattern stops at a quote or newline and takes at most 400 characters,
 * so a body crafted to look like an enormous path cannot turn this into a long scan.
 */
const WORKING_DIRECTORY =
  /[Ww]orking directory:\s*((?:[A-Za-z]:(?:\\\\|\\|\/)|\/)[^"\n]{1,400}?)(?=\\n|"|\n|$)/g;

export function workingDirectoryFrom(body: Buffer): string | null {
  let text: string;
  try {
    text = body.toString('utf8');
  } catch {
    return null;
  }
  for (const match of text.matchAll(WORKING_DIRECTORY)) {
    // The body is JSON, so a Windows path arrives with its separators escaped.
    const candidate = match[1].replace(/\\\\/g, '\\').replace(/\s+$/, '');
    try {
      // eslint-disable-next-line n/no-sync -- one stat on a bounded candidate, on the request path;
      // an awaited version here would not make the request faster and would make it interleave.
      if (existsSync(candidate)) return candidate;
    } catch {
      // An unusable path is simply not the answer.
    }
  }
  return null;
}

/**
 * The repository root for the project this request came from, or null.
 *
 * Resolved through the same `projectRootFor` the hooks and MCP tools use, so a request from a
 * subdirectory lands on the same graph the rest of the product would use for it. Loaded the way
 * findings.ts loads its helpers, because `hooks-core` is plain ESM beside the compiled output.
 */
export async function projectRootFromRequest(
  body: Buffer
): Promise<string | null> {
  const directory = workingDirectoryFrom(body);
  if (!directory) return null;
  try {
    const here = new URL('.', import.meta.url);
    const wiki = await import(
      pathToFileURL(fileURLToPath(new URL('../../hooks-core/wiki.mjs', here)))
        .href
    );
    // A FILE PATH, NOT A DIRECTORY. projectRootFor walks up from a file, so handing it the
    // directory itself starts the walk one level too high: this repository resolved to the
    // machine-level `unrooted` graph and was served three findings belonging to a different
    // project. `__session__` is the same stand-in run-client.mjs uses for exactly this.
    const root = wiki.projectRootFor(
      join(directory, '__session__'),
      directory
    ) as string | null;
    return root || null;
  } catch {
    // No project resolved means no project-scoped findings, which is the safe answer.
    return null;
  }
}
