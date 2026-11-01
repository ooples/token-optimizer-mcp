// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/node-floor.mjs. Regenerate with `npm run sync:hooks`.
/**
 * Telling a session its hooks run under a Node older than the package supports.
 *
 * package.json declares `engines.node`, but nothing enforces it for the hooks:
 * the host runs them with whatever `node` is on PATH. On one machine that was
 * Node 22.2.0 for weeks (2026-10). Its MCP server crashed in native code on
 * every start (server-crash.mjs), and its hook calls were slow: over 8,536
 * calls the p90 was 84 s, 1,186 took over a minute, and 64 were killed at the
 * host's 600 s timeout -- each one stalling the tool call it guarded. Under
 * Node 22.23.4 the same hooks measured p90 1.2 s, with none over a minute.
 * Nothing said why, so the cause went unnoticed for weeks.
 */

/** The supported floor; tests hold it equal to package.json `engines.node`. */
export const NODE_FLOOR = '22.14.0';

/** True when `version` is a release below `floor`. Unparseable input is never below. */
export function nodeBelowFloor(version, floor = NODE_FLOOR) {
  const parse = (v) =>
    /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v))?.slice(1).map(Number);
  const x = parse(version);
  const y = parse(floor);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}

/** The notice for this session, or null when Node meets the floor. */
export function nodeFloorNotice(node = process.versions.node) {
  if (!nodeBelowFloor(node)) return null;
  return (
    `token-optimizer's hooks run under Node ${node}, below the supported ${NODE_FLOOR}. ` +
    'Under such a Node, hook calls have taken minutes each, stalling the tool call they guard ' +
    "up to the host's 600 s timeout. Tell the user once: upgrade Node to " +
    `${NODE_FLOOR} or newer and restart the client.`
  );
}
