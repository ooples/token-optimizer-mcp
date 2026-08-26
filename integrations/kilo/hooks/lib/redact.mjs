// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/redact.mjs. Regenerate with `npm run sync:hooks`.
// hooks-core/redact.mjs
/**
 * Redaction for anything derived from captured output.
 *
 * WHY THIS IS MANDATORY RATHER THAN PRUDENT. derive.mjs builds claims out of
 * command stderr. A claim is INJECTED into model context and EXPORTED to
 * markdown, so a secret that reaches a claim reaches two more places than the
 * terminal it came from. Pattern matching is imperfect and that is stated in the
 * spec, but "imperfect" beats "absent" by a wide margin here.
 */

const PATTERNS = [
  // Bearer / API-key shaped tokens.
  [/\b(bearer\s+)[A-Za-z0-9._~+/-]{12,}/gi, '$1[redacted]'],
  [/\b(sk|pk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9._-]{10,}/gi, '[redacted]'],
  // KEY=value where the key name suggests a secret.
  [/\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY|PRIVATE_KEY|CREDENTIAL)[A-Z0-9_]*)\s*[=:]\s*\S+/g, '$1=[redacted]'],
  // Credentials inside a URL.
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@]+@/gi, '$1:[redacted]@'],
  // PEM blocks.
  [/-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g, '[redacted key]'],
];

export function redact(text, { max = 400 } = {}) {
  // `?? ''` matters even though String(null)/String(undefined) never throw:
  // without it a missing value becomes the literal 4-11 character string
  // "null"/"undefined" -- a garbage claim that silently reaches the graph
  // and model context instead of surfacing as an error.
  let out = String(text ?? '');
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  // Redact BEFORE truncating, never the reverse. Several patterns above rely
  // on a minimum-length quantifier (e.g. `{10,}`, `{12,}`) plus a prefix.
  // Truncating first can cut a match down to fewer characters than that
  // quantifier requires, so the shortened fragment no longer satisfies the
  // pattern and a live partial secret would pass through in cleartext. By
  // redacting the full, untruncated string first, every pattern always sees
  // the complete secret and removes it before any character budget is
  // spent; the cap below can then only ever cut into already-redacted text
  // (a label, or the "[redacted]" placeholder itself), never into raw
  // secret bytes.
  return out.length > max ? `${out.slice(0, Math.max(0, max - 1))}…` : out;
}
