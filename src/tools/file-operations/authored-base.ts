/**
 * The bytes this session wrote to a file, for use as a diff base.
 *
 * THE BRIDGE THIS CROSSES. The hook knows the client's real `session_id` and
 * the file's content; the MCP server knows neither. They share a filesystem and
 * a project, so the hook records what it wrote and the server reads it back --
 * the same shape the legacy PowerShell path used, rather than a new invention.
 *
 * WHY A SESSION SCOPE IS NOT OPTIONAL. A diff base is only sound if the caller
 * already holds the bytes being diffed against. The knowledge-graph snapshot
 * cannot supply that: `indexFile` runs on every file either hook observes,
 * READS INCLUDED and across sessions, so it answers "what did some hook last
 * see". Using it would hand a fresh session `// No changes` for a file it has
 * never seen -- withholding content while reporting success, which is worse
 * than the full resend this replaces.
 *
 * EVERY UNCERTAINTY RESOLVES TO NULL, and null means "resend the file", which
 * is today's behaviour. So this can add a saving and can never subtract one.
 * Nothing here throws: a diff-base lookup must not be able to fail a read.
 */

import { createRequire } from 'module';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

interface AuthoredModule {
  authoredContentFor(
    projectRoot: string,
    sessionId: string,
    filePath: string
  ): string | null;
}

interface WikiModule {
  projectRootFor(filePath: string, fallback: string): string;
}

let modules: { authored: AuthoredModule; wiki: WikiModule } | null = null;
let loadFailed = false;

/**
 * Loads the hook-core modules, once.
 *
 * Loaded lazily and defensively for the same reason the wiki routes are: these
 * are plain ESM the clients execute with no build step, and a missing runtime
 * must degrade to "no base" rather than break every read. `createRequire` keeps
 * this synchronous, because the read path cannot await a dynamic import without
 * changing its own signature.
 */
function load(): { authored: AuthoredModule; wiki: WikiModule } | null {
  if (modules) return modules;
  if (loadFailed) return null;
  try {
    const root = join(here, '..', '..', '..', 'hooks-core');
    modules = {
      authored: require(join(root, 'authored.mjs')) as AuthoredModule,
      wiki: require(join(root, 'wiki.mjs')) as WikiModule,
    };
    return modules;
  } catch {
    loadFailed = true;
    return null;
  }
}

/**
 * The session this server belongs to, or null.
 *
 * TOKEN_OPTIMIZER_SESSION_ID is set by the client for both the hooks and the
 * MCP server when the plugin can supply it. When it is absent there is no way
 * to prove the caller authored anything, so there is no base -- deliberately,
 * because guessing here is exactly the cross-session leak this design exists to
 * avoid. Absent identity degrades to the current full-resend behaviour.
 */
function sessionId(): string | null {
  const raw = (process.env.TOKEN_OPTIMIZER_SESSION_ID || '').trim();
  return raw || null;
}

/** The content this session wrote to `filePath`, or null. */
export function authoredBase(filePath: string): string | null {
  try {
    const session = sessionId();
    if (!session) return null;

    const loaded = load();
    if (!loaded) return null;

    const root = loaded.wiki.projectRootFor(filePath, process.cwd());
    if (!root) return null;

    return loaded.authored.authoredContentFor(root, session, filePath);
  } catch {
    return null;
  }
}
