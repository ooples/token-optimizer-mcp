/** Complete JSON documents printed alongside labels or other file contents.
 * Only column-zero document boundaries qualify. Never reconstruct partial JSON
 * or remove the text around it (which may carry instructions or diagnostics).
 */
import { compressJson } from './json.js';
import type { CompressionResult, Elision, EngineContext } from './types.js';
import { unchanged } from './types.js';

export function looksLikeJsonSections(text: string): boolean {
  // Truncated shell output belongs to the exact fragment codec, which must
  // preserve the explicit gap instead of trying to parse a whole document.
  return (
    !/^Warning: truncated output\b/.test(text) &&
    !jsonSections(text).next().done
  );
}

function* jsonSections(text: string) {
  const start = /^[\[{][ \t]*\r?$/gm;
  for (let match; (match = start.exec(text)); ) {
    const stack: string[] = [];
    let quoted = false,
      escaped = false,
      end = match.index;
    for (; end < text.length; end++) {
      const char = text[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === '[' || char === '{') stack.push(char);
      else if (char === ']' || char === '}') {
        if (stack.pop() !== (char === ']' ? '[' : '{')) {
          end++;
          break;
        }
        if (!stack.length) {
          end++;
          break;
        }
      }
    }
    // Skip the whole candidate even when malformed; do not salvage its tail.
    start.lastIndex = end;
    if (stack.length || quoted || end - match.index < 1024) continue;
    const lineEnd = text.indexOf('\n', end);
    if (text.slice(end, lineEnd < 0 ? text.length : lineEnd).trim()) continue;
    const candidate = text.slice(match.index, end);
    try {
      JSON.parse(candidate);
    } catch {
      continue;
    }
    yield { index: match.index, end, candidate };
  }
}

export function compressJsonSections(
  text: string,
  ctx: EngineContext = {}
): CompressionResult {
  let result = '',
    cursor = 0,
    lossless = true;
  const elisions: Elision[] = [];
  for (const { index, end, candidate } of jsonSections(text)) {
    const compressed = compressJson(candidate, ctx);
    if (compressed.text.length >= candidate.length) continue;
    result += text.slice(cursor, index) + compressed.text;
    cursor = end;
    elisions.push(...compressed.elisions);
    lossless &&= compressed.lossless;
  }
  return cursor
    ? { text: result + text.slice(cursor), elisions, lossless }
    : unchanged(text);
}
