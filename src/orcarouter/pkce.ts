/**
 * PKCE, in the four lines it actually takes.
 *
 * The verifier is the only secret in the flow: it never leaves this process, so an intercepted auth
 * code cannot be redeemed by whoever intercepted it. Three properties matter and all three are
 * tested rather than asserted:
 *
 *   FRESH PER ATTEMPT, from `randomBytes`. A verifier derived from a timestamp, a username or a
 *   fixed salt is guessable, and one reused across attempts means a leaked code from attempt one is
 *   redeemable during attempt two.
 *
 *   NEVER LOGGED OR PUT IN A URL. Nothing here returns the verifier except `createPkcePair`, and
 *   the URL builder in `endpoints.ts` accepts a challenge only, so a caller cannot pass the
 *   verifier into an authorize URL by mistake.
 *
 *   S256, ALWAYS. `plain` sends the verifier itself on the authorize URL, where it lands in browser
 *   history, proxy logs and request logs. The consent screen lets the user pick "Show me a code"
 *   even on a loopback flow, so a code can always end up in human hands: S256 is sent on every
 *   flow, not only the out-of-band one.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 32 bytes of entropy, base64url without padding, per RFC 7636's 43-character minimum. */
const VERIFIER_BYTES = 32;

/** The state is a CSRF token echoed back verbatim; 16 bytes is plenty for a single round trip. */
const STATE_BYTES = 16;

export interface PkcePair {
  /** Secret. Stays in this process until the exchange. */
  readonly verifier: string;
  /** Public. Safe on an authorize URL. */
  readonly challenge: string;
  /** Public. Compared against the callback's `state` in constant time. */
  readonly state: string;
}

export function base64Url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

/** `base64url(sha256(verifier))` with no padding, which is what S256 means. */
export function challengeFor(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier).digest());
}

/**
 * A verifier, its challenge, and a fresh state.
 *
 * @param random - Injectable only so a test can prove the values come from the RNG it was given.
 *                 Production callers pass nothing.
 */
export function createPkcePair(
  random: (size: number) => Buffer = randomBytes
): PkcePair {
  const verifier = base64Url(random(VERIFIER_BYTES));
  const state = base64Url(random(STATE_BYTES));
  return { verifier, challenge: challengeFor(verifier), state };
}

/**
 * Compare the echoed state against the one we sent, in constant time.
 *
 * Length is checked first because `timingSafeEqual` throws on a length mismatch, and a thrown
 * exception is not a security decision -- it is a crash in the middle of an authorization.
 */
export function stateMatches(
  expected: string,
  received: string | null
): boolean {
  if (typeof received !== 'string') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
