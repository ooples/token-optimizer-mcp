// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/verification.mjs. Regenerate with `npm run sync:hooks`.
/** Conservative recognition of an actual verification invocation, not words in its arguments. */
export function isVerificationCommand(command) {
  if (typeof command !== 'string') return false;
  const withoutRedirects = command.replace(/\d*>&\d+|&>>?/g, '');
  if (/\|\||\|(?!\|)|(?<!&)&(?!&)/.test(withoutRedirects)) return false;
  if (/(?:^|\s)--(?:listTests|list-tests|collect-only|co|list|help|version|showConfig|show-config)(?:\s|=|$)/i.test(command) || /(?:^|\s)-[hV](?:\s|=|$)/.test(command)) return false;
  const segments = command.split(/&&|;|\r?\n/).map((part) => part.trim()).filter(Boolean);
  if (!segments.length || segments.slice(0, -1).some((part) => !/^cd\s+/i.test(part))) return false;
  const invocation = segments.at(-1);
  // -v is verbose for these runners, but prints a version in jest/vitest/tsc/npm.
  if (/(?:^|\s)-v(?:\s|=|$)/.test(invocation) && !/^(?:(?:npx|pnpm\s+exec|yarn\s+exec)\s+)?pytest\b|^(?:dotnet|cargo|go)\s+(?:test|build|check)\b/i.test(invocation)) return false;
  return /^(?:(?:npx|pnpm\s+exec|yarn\s+exec)\s+)?(?:jest|vitest|pytest|tsc)\b|^(?:dotnet|cargo|go)\s+(?:test|build|check)\b|^(?:npm|pnpm|yarn)\s+(?:test\b|(?:run\s+)?(?:build|check|verify|test)(?::[\w.-]+)?\b)/i.test(invocation);
}
