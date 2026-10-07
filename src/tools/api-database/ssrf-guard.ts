/**
 * SSRF GUARD FOR AN OUTBOUND URL (CWE-918).
 *
 * `smart_api_fetch` took a caller-supplied URL straight to `fetch` with
 * `redirect: 'follow'`, so anything able to invoke the tool -- including a
 * prompt-injected instruction -- could read loopback, RFC1918 and cloud
 * metadata services, and get status, headers and body back in the result.
 * Redirects were followed to any host with the caller's own headers re-sent,
 * so an allow-listed first hop could hand an API key to a second host.
 *
 * WHAT THIS REFUSES, and why each one is not paranoia:
 *
 *   non-http(s) schemes   `file:`, `gopher:`, `data:` turn a fetch into a file
 *                         read or a protocol-smuggling primitive.
 *   loopback              127.0.0.0/8, ::1, and the names that resolve there.
 *                         The proxy, the dashboard and every local service
 *                         live here, and they trust loopback callers.
 *   link-local            169.254.0.0/16 and fe80::/10 -- 169.254.169.254 is
 *                         the cloud metadata endpoint that hands out
 *                         credentials to anything that asks.
 *   private ranges        10/8, 172.16/12, 192.168/16, fc00::/7, plus the
 *                         carrier range 100.64/10.
 *   unspecified           0.0.0.0 and :: reach loopback on many stacks.
 *
 * A HOSTNAME IS NOT ENOUGH TO DECIDE, and this is the honest limit of a
 * synchronous check: `evil.example` can resolve to 127.0.0.1 (DNS rebinding),
 * and nothing short of resolving the name and pinning the socket to that
 * address closes it. So this blocks what is decidable from the URL, and the
 * caller must treat the remaining gap as real rather than as covered.
 */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  // The metadata name every major cloud answers on.
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
]);

/** Is this literal address one we refuse to reach outbound? */
function isBlockedAddress(host: string): boolean {
  const bare =
    host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const lower = bare.toLowerCase();
  if (lower === '::' || lower === '::1' || lower === '0:0:0:0:0:0:0:1')
    return true;
  // IPv6 unique-local fc00::/7 and link-local fe80::/10.
  if (/^f[cd][0-9a-f]{0,2}:/.test(lower)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;
  // AN IPV4-MAPPED IPV6 ADDRESS CARRIES THE V4 RULES, AND ARRIVES IN HEX.
  // `new URL('http://[::ffff:127.0.0.1]/').hostname` normalises to
  // `[::ffff:7f00:1]`, so a dotted-quad pattern never matches it -- measured,
  // and it let the metadata address straight through. Both forms are handled:
  // the literal one a human writes and the hex one the URL parser produces.
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  const v4 = dotted
    ? dotted[1]
    : hex
      ? [
          (parseInt(hex[1], 16) >> 8) & 0xff,
          parseInt(hex[1], 16) & 0xff,
          (parseInt(hex[2], 16) >> 8) & 0xff,
          parseInt(hex[2], 16) & 0xff,
        ].join('.')
      : lower;
  const parts = v4.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => Number(part));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
    return false;
  const [a, b] = octets;
  if (a === 0 || a === 127) return true;
  if (a === 10) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/**
 * The refusal reason for a URL we will not fetch, or null when it is allowed.
 *
 * Returns the reason rather than throwing so the caller can name the target
 * back to the caller who asked -- and only to them. A refusal is never logged
 * or transmitted.
 */
export function ssrfRefusal(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'not a URL this tool can parse';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return `refusing scheme '${url.protocol}' -- only http and https are fetched`;
  // THE TRAILING DOT IS STRIPPED FIRST, and without this the guard was
  // bypassable: `new URL('http://localhost./').hostname` is `localhost.`,
  // which is in no list and ends with neither `.localhost` nor `.internal`.
  // A fully-qualified name with the root label resolves to exactly the same
  // host, so it has to be compared as the same host.
  const host = url.hostname.toLowerCase().replace(/\.+$/, '');
  if (host === '') return 'no host in the URL';
  if (BLOCKED_HOSTNAMES.has(host))
    return `refusing '${host}' -- it names a local or metadata service`;
  if (isBlockedAddress(host))
    return `refusing '${url.hostname}' -- loopback, private, link-local or metadata address`;
  if (host.endsWith('.localhost') || host.endsWith('.internal'))
    return `refusing '${host}' -- a local-only name`;
  return null;
}
