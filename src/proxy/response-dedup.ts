/** Forward-only, request-local references. Never rewrite a previous observation.
 * Exact string keys verify equality, not just a digest. The budget bounds retained
 * text and reference metadata; eviction only loses compression opportunities.
 */
export class ResponseDedup {
  private readonly seen = new Map<string, { at: string; bytes: number }>();
  private bytes = 0;

  replace(text: string, at: string): string {
    if (text.length < 512 || text.length > 1024 * 1024) return text;
    const prior = this.seen.get(text);
    if (prior)
      return `[Repeated observation: identical content to ${prior.at}.]`;
    const bytes = 2 * (text.length + at.length);
    while (this.seen.size >= 256 || this.bytes + bytes > 4 * 1024 * 1024) {
      const first = this.seen.keys().next().value!;
      this.bytes -= this.seen.get(first)!.bytes;
      this.seen.delete(first);
    }
    this.seen.set(text, { at, bytes });
    this.bytes += bytes;
    return text;
  }
}

/** Only peel the complete, known Codex transport header. Preserve it on every
 * observation, including exit status. Arbitrary content containing "Output:"
 * is not a transport envelope and must never be split heuristically.
 */
export function responseEnvelope(text: string): {
  header: string;
  body: string;
} {
  const match =
    /^(Chunk ID: [^\r\n]+\r?\nWall time: [^\r\n]+\r?\n(?:Process exited with code -?\d+|Process running with session ID \d+)\r?\n(?:Final output:\r?\n|Output:\r?\n))/.exec(
      text
    );
  return match
    ? { header: match[0], body: text.slice(match[0].length) }
    : { header: '', body: text };
}

type ShellEnvelope = {
  output: string;
  field?: { start: number; end: number } | null;
};
const shellEnvelopes = new Map<string, ShellEnvelope>();
let shellBytes = 0;

/** Patch just one JSON string value, preserving every other lexical byte. An
 * ambiguous duplicate/nested key is deliberately ineligible. JSON parsing is
 * used for validation, never to reserialize large integers or unknown metadata.
 */
export function replaceJsonText(
  text: string,
  key: 'output' | 'stdout' | 'stderr',
  value: string
): string {
  const envelope = key === 'output' ? shellEnvelopes.get(text) : undefined;
  let position = envelope?.field;
  if (position === undefined) {
    const field = new RegExp(`"${key}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`, 'g');
    const match = field.exec(text);
    position = null;
    if (match && !field.exec(text)) {
      const start = match.index + match[0].length - match[1].length;
      position = { start, end: start + match[1].length };
    }
    if (envelope) envelope.field = position;
  }
  if (!position) return text;
  return (
    text.slice(0, position.start) +
    JSON.stringify(value) +
    text.slice(position.end)
  );
}

/** The actual functions.exec wire payload wraps shell output in JSON with a
 * changing chunk ID and wall time. Preserve that envelope on every observation.
 */
export function responseJsonEnvelope(text: string): string | undefined {
  const hit = shellEnvelopes.get(text);
  if (hit) return hit.output;
  if (
    !text.startsWith('{') ||
    !text.includes('"chunk_id"') ||
    !text.includes('"wall_time_seconds"')
  )
    return undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      return undefined;
    const record = value as Record<string, unknown>;
    if (
      typeof record.chunk_id === 'string' &&
      typeof record.wall_time_seconds === 'number' &&
      (typeof record.exit_code === 'number' || record.exit_code === null) &&
      typeof record.output === 'string'
    ) {
      // Exact text keys keep changing status/metadata distinct. Account for both
      // UTF-16 strings and cap entries; historical turns need no repeated parse
      // or regex scan, and oversized observations are never retained.
      const bytes = 2 * (text.length + record.output.length);
      if (bytes <= 1024 * 1024) {
        while (
          shellEnvelopes.size >= 128 ||
          shellBytes + bytes > 2 * 1024 * 1024
        ) {
          const oldest = shellEnvelopes.keys().next().value!;
          shellBytes -=
            2 * (oldest.length + shellEnvelopes.get(oldest)!.output.length);
          shellEnvelopes.delete(oldest);
        }
        shellEnvelopes.set(text, { output: record.output });
        shellBytes += bytes;
      }
      return record.output;
    }
  } catch {
    /* Not a known shell envelope. */
  }
  return undefined;
}
