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
  let out = String(text ?? '');
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out.length > max ? `${out.slice(0, Math.max(0, max - 1))}…` : out;
}
