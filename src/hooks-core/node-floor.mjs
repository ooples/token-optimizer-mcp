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

/**
 * The supported releases, one floor per line of Node. Every floor but the last
 * covers only its own major (`^22.18.0`); the last covers everything after it
 * (`>=24.11.0`). Node 23 and 24.0-24.10 fall between and are unsupported.
 *
 * 22.14.0 became 22.18.0 / 24.11.0 with the 2026-11-14 dependency batch:
 * @babel/parser 8, a runtime dependency (src/compress/code.ts), declares
 * `^22.18.0 || >=24.11.0`, and a package cannot honestly support less than
 * what it loads at runtime. Tests hold `engines.node` equal to NODE_ENGINES.
 */
export const NODE_FLOORS = ['22.18.0', '24.11.0'];

/** The `engines.node` range these floors describe. */
export const NODE_ENGINES = NODE_FLOORS.map((f, i) =>
  i < NODE_FLOORS.length - 1 ? `^${f}` : `>=${f}`
).join(' || ');

/**
 * How the floors read in a message: "22.x from 22.18.0, or 24.11.0 or newer".
 * Each floor but the last names its major, so "22.18.0+" cannot be read as
 * admitting Node 23 or 24.0-24.10.
 */
export const NODE_SUPPORTED = NODE_FLOORS.map((f, i) =>
  i < NODE_FLOORS.length - 1
    ? `${f.split('.')[0]}.x from ${f}`
    : `${f} or newer`
).join(', or ');

const parse = (v) =>
  /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v))?.slice(1).map(Number);

const atLeast = (x, y) => {
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return true;
};

/**
 * True when `version` is a release outside the supported floors. Unparseable
 * input is never below.
 */
export function nodeBelowFloor(version, floors = NODE_FLOORS) {
  const x = parse(version);
  if (!x) return false;
  const ys = floors.map(parse);
  if (ys.some((y) => !y)) return false;
  const supported = ys.some((y, i) =>
    i < ys.length - 1 ? x[0] === y[0] && atLeast(x, y) : atLeast(x, y)
  );
  return !supported;
}

/** Below this release, hook calls were measured taking minutes (Node 22.2.0). */
const SLOW_HOOKS_BELOW = '22.14.0';

/**
 * True when `node` is old enough that slow hooks were measured on it. The
 * floor notice then names the cause of slow hooks itself; above it, the notice
 * is about dependency support only and the slow-hook notice must still be told.
 */
export function nodeHooksMeasuredSlow(node = process.versions.node) {
  return nodeBelowFloor(node, [SLOW_HOOKS_BELOW]);
}

/**
 * Why `node` is unsupported, in one sentence; null when it is supported.
 *
 * The slow-hook evidence is from Node 22.2.0, below the old 22.14.0 floor. A
 * release from 22.14.0 up that is still unsupported (22.14-22.17, 23,
 * 24.0-24.10) is so because its runtime dependencies declare it, not because
 * it was measured slow -- so it is not told that it was.
 */
export function nodeUnsupportedReason(node = process.versions.node) {
  if (!nodeBelowFloor(node)) return null;
  return nodeHooksMeasuredSlow(node)
    ? 'Under such a Node, hook calls have taken minutes each, stalling the tool call they guard ' +
        "up to the host's 600 s timeout."
    : "Its runtime dependencies do not support this Node, so the MCP server's tools may fail.";
}

/** The notice for this session, or null when Node meets the floor. */
export function nodeFloorNotice(node = process.versions.node) {
  const why = nodeUnsupportedReason(node);
  if (!why) return null;
  return (
    `token-optimizer's hooks run under Node ${node}, outside the supported range (${NODE_SUPPORTED}). ` +
    `${why} Tell the user once: upgrade Node to a supported release and restart the client.`
  );
}
