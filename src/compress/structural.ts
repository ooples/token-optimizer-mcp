/**
 * Tokens no transform may touch: identifiers, credentials, hashes.
 *
 * WHAT THIS EXISTS FOR, measured before it was written. The log templater
 * builds its grouping shape by replacing every digit run with a placeholder,
 * and digit runs occur INSIDE identifiers. On a line carrying a correlation id
 * and an API key it produced:
 *
 *   #-#-#T#:#:#Z INFO request #f#a#c#-#b#d-#e#-#a#-ffedcba# authorised with
 *   sk-ant-api#-QmFzZTY#TG#va#luZ#NlY#JldFZhbHVlSGVy
 *
 * That is not an elision, it is CORRUPTION. The original was
 * `3f2a9c14-8b7d-4e56-9a01-ffedcba98765`, and what survives looks enough like
 * an identifier that a model may quote it back or search for it. A dropped
 * value is visibly missing; a shredded one is invisibly wrong, which is worse.
 *
 * HeadRoom's masks.py carries the same idea and names the same threshold: a
 * length floor of 20, because "normalized Shannon entropy alone cannot tell a
 * 40-char API key from an 8-char diverse word", matching what trufflehog and
 * detect-secrets use. That floor is adopted here for the same reason.
 *
 * NOT A SECRET SCANNER. The goal is not to find every credential -- it is to
 * stop our own transforms mangling anything that looks like an identifier a
 * reader might need verbatim. False positives cost a few tokens; false
 * negatives corrupt data.
 */

/** Below this a high-entropy run is just a word. Matches trufflehog's floor. */
const MIN_SECRET_LENGTH = 20;

/**
 * Shannon entropy floors -- necessary, and measured to be insufficient alone.
 *
 * Sampling real secrets against long ordinary tokens showed the two classes
 * OVERLAP, so no threshold can separate them:
 *
 *   4.663  wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY   secret
 *   4.190  application/json;charset=utf-8             not a secret
 *   4.173  dGhpcyBpcyBhIHRlc3Qgc2VjcmV0IHZhbHVl       secret
 *   3.781  TOKEN_OPTIMIZER_HARVEST_ENDPOINT           not a secret
 *   3.684  AKIAIOSFODNN7EXAMPLE                       secret
 *
 * Set the bar at 4.2 and a real base64 blob is missed; set it at 3.6 and every
 * screaming-case environment variable in a log line is protected, which costs
 * compression on exactly the lines that repeat most.
 *
 * COMPOSITION IS THE DISCRIMINATOR, not density. A key mixes digits with
 * letters and usually with case or base64 padding; a header, an identifier or
 * an English word does not. The entropy floor stays as a second condition --
 * `aaaa1111aaaa1111aaaa` mixes classes and is plainly not a secret -- and the
 * well-known formats are matched by shape above, so this path only has to be a
 * backstop for the ones we have not enumerated.
 */
const HEX_ENTROPY = 3.0;
const BASE64_ENTROPY = 3.6;

/**
 * Shapes worth protecting whatever their entropy.
 *
 * A UUID scores LOW on Shannon entropy -- sixteen hex characters and four
 * hyphens in a fixed layout -- so an entropy test alone would let the templater
 * shred exactly the identifier a debugging session cares most about.
 */
const SHAPES: readonly RegExp[] = [
  // UUID, any version.
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  // Vendor-prefixed keys: sk-, ghp_, gho_, AKIA, xox[bp]-, and friends.
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bAKIA[0-9A-Z]{12,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  // JWT: three base64url segments.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // Git object ids and other long hex runs.
  /\b[0-9a-f]{32,}\b/gi,
];

/** Characters that can appear inside one candidate token. */
const TOKEN = /[A-Za-z0-9+/=_-]{8,}/g;

/** Shannon entropy in bits per character. */
export function entropy(value: string): number {
  if (!value) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * Is this token dense enough, and long enough, to be a credential?
 *
 * The length floor does the work the entropy score cannot: `password` has
 * respectable entropy per character and is plainly not a key, while a
 * forty-character base64 run is one whatever it spells.
 */
export function isSecretLike(token: string): boolean {
  if (token.length < MIN_SECRET_LENGTH) return false;

  // A long pure-hex run is a hash or an id whatever its composition, and the
  // hex alphabet makes the entropy test meaningful on its own.
  if (/^[0-9a-f]+$/i.test(token)) return entropy(token) >= HEX_ENTROPY;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(token)) return false;

  // Composition, per the note on the thresholds above: digits AND letters, plus
  // one of mixed case or base64 padding. `TOKEN_OPTIMIZER_HARVEST_ENDPOINT` and
  // `Content-Security-Policy` carry no digits; `internationalization` carries
  // neither digits nor case variety; a key carries both.
  const hasDigit = /[0-9]/.test(token);
  const hasLetter = /[A-Za-z]/.test(token);
  const mixedCase = /[a-z]/.test(token) && /[A-Z]/.test(token);
  const base64ish = /[+/=]/.test(token);
  if (!hasDigit || !hasLetter || !(mixedCase || base64ish)) return false;

  return entropy(token) >= BASE64_ENTROPY;
}

/**
 * Character ranges in `text` that must survive any transform, merged and
 * sorted.
 *
 * Ranges rather than tokens because callers need to ask "does this match
 * overlap something protected", which is a position question.
 */
export function structuralRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];

  for (const shape of SHAPES) {
    // The patterns are module-level and carry /g, so lastIndex must be reset
    // or the second call over different text starts mid-string.
    shape.lastIndex = 0;
    for (let m = shape.exec(text); m; m = shape.exec(text)) {
      ranges.push([m.index, m.index + m[0].length]);
      if (m[0].length === 0) shape.lastIndex += 1;
    }
  }

  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(text); m; m = TOKEN.exec(text)) {
    if (isSecretLike(m[0])) ranges.push([m.index, m.index + m[0].length]);
  }

  if (ranges.length < 2) return ranges;
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [ranges[0]];
  for (const [start, end] of ranges.slice(1)) {
    const last = merged[merged.length - 1];
    if (start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/** Does [start, end) touch anything protected? */
export function overlapsStructural(
  ranges: readonly (readonly [number, number])[],
  start: number,
  end: number
): boolean {
  for (const [from, to] of ranges) {
    if (start < to && end > from) return true;
  }
  return false;
}

/** Does this passage carry an identifier or credential at all? */
export function containsStructural(text: string): boolean {
  return structuralRanges(text).length > 0;
}
