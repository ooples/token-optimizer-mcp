/** Conservative recognition of an actual verification invocation, not words in its arguments. */
export function isVerificationCommand(command) {
  if (typeof command !== 'string' || /\|\||\|(?!\|)|(?<!&)&(?!&)/.test(command)) return false;
  const segments = command.split(/&&|;|\r?\n/).map((part) => part.trim()).filter(Boolean);
  if (!segments.length || segments.slice(0, -1).some((part) => !/^cd\s+/i.test(part))) return false;
  return /^(?:(?:npx|pnpm\s+exec|yarn\s+exec)\s+)?(?:jest|vitest|pytest|tsc)\b|^(?:dotnet|cargo|go)\s+(?:test|build|check)\b|^(?:npm|pnpm|yarn)\s+(?:test\b|(?:run\s+)?(?:build|check|verify|test)(?::[\w.-]+)?\b)/i.test(segments.at(-1));
}
