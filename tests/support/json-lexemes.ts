/**
 * A LEXICAL ORACLE FOR JSON, BECAUSE `JSON.parse` DEEP-EQUAL IS TOO FORGIVING.
 *
 * `JSON.parse` normalises as it reads. `12345678901234567890` comes back as
 * `12345678901234567000`, `0.0500` as `0.05`, `1e3` as `1000`, `-0` as `0`,
 * and `"\u0041"` as `"A"`. An engine that silently rewrote any of those
 * round-trip through a parse-based comparison unchanged, so such a comparison
 * cannot gate a `lossless: true` claim -- it agrees with the very rewrites the
 * claim forbids.
 *
 * This scans the SOURCE TEXT instead. Every token is returned exactly as it was
 * written, whitespace excepted, because whitespace is the one thing the JSON
 * engine is allowed to drop. Two documents with equal lexeme streams differ at
 * most in their layout.
 */

/** One token, as written. Whitespace never appears. */
export type Lexeme = string;

const STRUCTURAL = new Set(['{', '}', '[', ']', ':', ',']);
const WHITESPACE = new Set([' ', '\t', '\n', '\r']);
const NUMBER_START = /[-0-9]/;
const NUMBER_BODY = /[-+0-9.eE]/;

function readString(text: string, from: number): number {
  let at = from + 1;
  while (at < text.length) {
    const ch = text[at];
    if (ch === '\\') {
      at += 2;
      continue;
    }
    if (ch === '"') return at + 1;
    at += 1;
  }
  throw new Error(`jsonLexemes: unterminated string at ${from}`);
}

/**
 * Splits JSON source into its tokens, each kept verbatim.
 *
 * Throws on anything that is not JSON, which is deliberate: an oracle that
 * quietly accepts garbage passes everything and gates nothing.
 */
export function jsonLexemes(text: string): Lexeme[] {
  const out: Lexeme[] = [];
  let at = 0;
  while (at < text.length) {
    const ch = text[at];
    if (WHITESPACE.has(ch)) {
      at += 1;
      continue;
    }
    if (STRUCTURAL.has(ch)) {
      out.push(ch);
      at += 1;
      continue;
    }
    if (ch === '"') {
      const end = readString(text, at);
      out.push(text.slice(at, end));
      at = end;
      continue;
    }
    if (NUMBER_START.test(ch)) {
      let end = at + 1;
      while (end < text.length && NUMBER_BODY.test(text[end])) end += 1;
      out.push(text.slice(at, end));
      at = end;
      continue;
    }
    const word = /^(?:true|false|null)/.exec(text.slice(at));
    if (word) {
      out.push(word[0]);
      at += word[0].length;
      continue;
    }
    throw new Error(
      `jsonLexemes: not JSON at ${at}: ${JSON.stringify(text.slice(at, at + 24))}`
    );
  }
  return out;
}
