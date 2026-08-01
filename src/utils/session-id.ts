/**
 * The one allowlist that decides whether a session id may shape a path.
 *
 * This regex existed twice -- in src/server/web-server.ts and again in
 * src/server/index.ts -- each carrying a comment saying it was "kept in sync"
 * with the other. A security allowlist maintained by comment is one careless
 * edit away from divergence, and the divergence would be silent: both copies
 * would still look plausible, and only one of the two entry points would be
 * safe.
 *
 * Session ids are generated as alphanumeric/dash tokens (UUIDs, or
 * `YYYYMMDD-HHMMSS-XXXX`), so this rejects every dot, separator, null byte and
 * absolute path before the value is ever concatenated into a filesystem path.
 *
 * SECURITY (CWE-22 / js/path-injection): the dashboard's /api/session-summary
 * and /api/session-events endpoints, and the MCP get_session_stats and
 * optimize_session tools, all build a path from a caller-supplied session id.
 * Without this guard a value like `abc/../../../../secret` resolves outside the
 * hooks data directory, giving an unauthenticated arbitrary file read.
 */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Whether `sessionId` is safe to use in a filesystem path. */
export function isValidSessionId(sessionId: unknown): sessionId is string {
  return typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId);
}
