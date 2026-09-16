/** Responses API tool outputs, including Codex custom tools.
 * Keep instructions, tool definitions, call IDs, and encrypted reasoning intact.
 * Compression is a stable function of each output, so appending a turn does not
 * rewrite the already-compressed prefix based on a newer user query.
 */
import { cachedOutput } from './output-cache.js';
import type { Tuning } from '../compress/options.js';
import type { CompressionFacts } from './accounting.js';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function compressResponses(
  body: Buffer,
  request: Record<string, unknown>,
  spill: (content: string, hint: string) => string,
  tuning?: Tuning
): { body: Buffer; summary: CompressionFacts } {
  let elisions = 0;
  const input = request.input as unknown[];
  const next = input.map((item) => {
    if (
      !object(item) ||
      !['function_call_output', 'custom_tool_call_output'].includes(
        String(item.type)
      )
    )
      return item;
    const compress = (text: string): string => {
      if (text.length < 1024) return text;
      const result = cachedOutput(text, spill, tuning);
      if (result.text === text) return text;
      elisions += result.elisions.length;
      return result.text;
    };
    if (typeof item.output === 'string') {
      const output = compress(item.output);
      return output === item.output ? item : { ...item, output };
    }
    // Multimodal output keeps every non-text part, with all original metadata.
    if (Array.isArray(item.output)) {
      let output: unknown[] | undefined;
      for (let i = 0; i < item.output.length; i++) {
        const part: unknown = item.output[i];
        if (
          object(part) &&
          part.type === 'input_text' &&
          typeof part.text === 'string'
        ) {
          const text = compress(part.text);
          if (text !== part.text) {
            output ??= item.output.slice();
            output[i] = { ...part, text };
          }
        }
      }
      return output ? { ...item, output } : item;
    }
    return item;
  });
  const encoded = elisions
    ? Buffer.from(JSON.stringify({ ...request, input: next }))
    : body;
  const accepted = encoded.length < body.length;
  return {
    body: accepted ? encoded : body,
    summary: {
      beforeBytes: body.length,
      afterBytes: accepted ? encoded.length : body.length,
      compressed: accepted,
      elisions: accepted ? elisions : 0,
      reason: accepted ? undefined : 'no compressible Responses tool output',
      messagesChars: JSON.stringify(input).length,
      messageCount: input.length,
    },
  };
}
