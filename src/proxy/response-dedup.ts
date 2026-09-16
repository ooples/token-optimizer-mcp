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
