/**
 * Is a newer release published, and is this copy behind it?
 *
 * A NETWORK CALL THIS PACKAGE DOES NOT MAKE ON ITS OWN. It runs from `doctor`,
 * which a person typed, and from nowhere on the MCP request path: a version
 * check that fires when a client starts the server turns every session into a
 * request to a third party the user did not ask for, and it would sit on the
 * cold handshake path where it can only make startup slower.
 *
 * IT ASKS FOR ONE MANIFEST, NOT THE PACKUMENT. `/<name>/latest` returns the
 * single published manifest; `/<name>` returns every version ever published
 * with its full metadata, which for this package is already hundreds of
 * kilobytes and grows with every release.
 *
 * NOTHING ABOUT THE USER GOES OUT. The request carries a URL and an Accept
 * header. No machine id, no version of ours, no query string -- so unlike the
 * telemetry beacon this is not a report, and `DO_NOT_TRACK` is still honoured
 * because a person who set it has said they do not want unprompted requests.
 */

import { doNotTrack } from '../telemetry/policy.js';
import { PACKAGE_NAME } from './install-method.js';

/** How long the registry gets before the answer is "we do not know". */
export const REGISTRY_TIMEOUT_MS = 4000;

const REGISTRY_DEFAULT = 'https://registry.npmjs.org';

/** The answer, which is either a version or the reason there is not one. */
export type LatestLookup =
  | { readonly version: string; readonly refused?: undefined }
  | { readonly version?: undefined; readonly refused: string };

/** The registry to ask, honouring an npm mirror if one is configured. */
export function registryBase(env: NodeJS.ProcessEnv = process.env): string {
  const asked = (env.npm_config_registry ?? '').trim();
  if (asked.length === 0) return REGISTRY_DEFAULT;
  // Only https, and only a URL that parses. A mirror set to something else is
  // a misconfiguration, and following it would be this module's decision
  // rather than npm's.
  try {
    const parsed = new URL(asked);
    if (parsed.protocol !== 'https:') return REGISTRY_DEFAULT;
    return asked.endsWith('/') ? asked.slice(0, -1) : asked;
  } catch {
    return REGISTRY_DEFAULT;
  }
}

/** Where the single latest manifest for a scoped name lives. */
export function latestUrl(
  name: string = PACKAGE_NAME,
  env: NodeJS.ProcessEnv = process.env
): string {
  // A scoped name's slash is encoded: the registry serves
  // `/@scope%2fname/latest`, and an unencoded slash is a different route.
  return `${registryBase(env)}/${name.replace('/', '%2f')}/latest`;
}

/**
 * The published `latest` version, or why we do not know it.
 *
 * `fetcher` is injected so the tests never reach the network: a test that
 * depends on npm being up is a test that reports a red build when npm has a
 * bad afternoon.
 */
export async function latestVersion(
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly fetcher?: typeof fetch;
    readonly timeoutMs?: number;
  } = {}
): Promise<LatestLookup> {
  const env = options.env ?? process.env;
  if (doNotTrack(env)) return { refused: 'DO_NOT_TRACK is set' };
  const explicitlyOff = (env.TOKEN_OPTIMIZER_UPDATE_CHECK ?? '')
    .trim()
    .toLowerCase();
  if (explicitlyOff === '0' || explicitlyOff === 'off' || explicitlyOff === 'false')
    return { refused: 'the update check is disabled' };

  const get = options.fetcher ?? fetch;
  try {
    const response = await get(latestUrl(PACKAGE_NAME, env), {
      headers: { accept: 'application/json' },

      signal: AbortSignal.timeout(options.timeoutMs ?? REGISTRY_TIMEOUT_MS),
    });
    if (!response.ok) return { refused: `the registry answered ${response.status}` };
    const parsed: unknown = await response.json();
    const version =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { version?: unknown }).version
        : undefined;
    if (typeof version !== 'string' || version.length === 0)
      return { refused: 'the registry answered without a version' };
    return { version };
  } catch (error) {
    // NOT AN ERROR TO RAISE. Being offline is the common case for a diagnostic
    // run on a laptop, and a doctor that fails because the network is down
    // reports the network instead of the installation.
    const why = error instanceof Error ? error.message : String(error);
    return { refused: `the registry could not be reached (${why})` };
  }
}

/** One release's numbers and its prerelease tail, or null if unparseable. */
function parseVersion(
  value: string
): { readonly numbers: number[]; readonly pre: string[] } | null {
  const [core, ...rest] = value.split('+')[0].split('-');
  const numbers = core.split('.').map((part) => Number(part));
  if (numbers.length !== 3 || numbers.some((n) => !Number.isInteger(n) || n < 0))
    return null;
  const pre = rest.join('-');
  return { numbers, pre: pre.length === 0 ? [] : pre.split('.') };
}

/**
 * -1, 0 or 1, as semver orders them, or null when either side is not a version.
 *
 * WRITTEN OUT RATHER THAN DEPENDED ON. `semver` would be a runtime dependency
 * shipped to every user so that a diagnostic can compare two strings, and the
 * ordering rules that matter here are the two below.
 */
export function compareVersions(left: string, right: string): number | null {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a === null || b === null) return null;
  for (let i = 0; i < 3; i += 1)
    if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] < b.numbers[i] ? -1 : 1;
  // A prerelease sorts BEFORE the release it leads to, so 7.4.0-rc.1 < 7.4.0.
  // Getting this backwards would tell someone on a release candidate that they
  // are ahead of the release that supersedes them.
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;
  const depth = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < depth; i += 1) {
    const l = a.pre[i];
    const r = b.pre[i];
    // A shorter set of identifiers sorts first when all the shared ones match.
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const ln = Number(l);
    const rn = Number(r);
    const lNum = l.length > 0 && Number.isInteger(ln);
    const rNum = r.length > 0 && Number.isInteger(rn);
    // Numeric identifiers compare numerically and sort before alphanumeric
    // ones, which is what makes rc.2 follow rc.10's sibling rather than
    // preceding it by string order.
    if (lNum && rNum) {
      if (ln !== rn) return ln < rn ? -1 : 1;
      continue;
    }
    if (lNum) return -1;
    if (rNum) return 1;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}