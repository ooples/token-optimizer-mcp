/** Responses API tool outputs, including Codex custom tools.
 * Keep instructions, call IDs, and encrypted reasoning intact. Tool definitions
 * are untouched unless the explicit tool-code whitespace experiment is enabled.
 * Compression is a stable function of each output, so appending a turn does not
 * rewrite the already-compressed prefix based on a newer user query.
 */
import { cachedOutput } from './output-cache.js';
import { compactToolDefinitions } from './tool-code.js';
import {
  ResponseDedup,
  responseEnvelope,
  responseJsonEnvelope,
  replaceJsonText,
} from './response-dedup.js';
import { tokenBenefit } from './token-gate.js';
import { classify } from '../compress/router.js';
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
  let dedupReferences = 0;
  let definitionsChanged = false;
  const compactDefinitions =
    process.env.TOKEN_OPTIMIZER_PROXY_TOOL_CODE === '1';
  const input = request.input as unknown[];
  const dedup = new ResponseDedup();
  const readCalls = new Map<string, boolean>();
  const next = input.map((item, itemIndex) => {
    if (
      object(item) &&
      ['function_call', 'custom_tool_call', 'local_shell_call'].includes(
        String(item.type)
      )
    ) {
      const id = typeof item.call_id === 'string' ? item.call_id : item.id;
      if (typeof id === 'string' && id.length <= 256) {
        const name = String(item.name ?? '');
        const args =
          typeof item.arguments === 'string'
            ? item.arguments
            : typeof item.input === 'string'
              ? item.input
              : '';
        const read =
          /(?:^|[._])(?:read|read_file|smart_read)$/i.test(name) ||
          /\b(?:Get-Content|cat|sed|head|tail|type)\b/i.test(
            args.slice(0, 16384)
          );
        if (readCalls.size >= 512)
          readCalls.delete(readCalls.keys().next().value!);
        readCalls.set(id, read);
      }
    }
    if (
      compactDefinitions &&
      object(item) &&
      item.type === 'additional_tools'
    ) {
      const tools = compactToolDefinitions(item.tools);
      if (tools !== item.tools) {
        definitionsChanged = true;
        return { ...item, tools };
      }
      return item;
    }
    if (
      !object(item) ||
      ![
        'function_call_output',
        'custom_tool_call_output',
        'local_shell_call_output',
        'apply_patch_call_output',
      ].includes(String(item.type))
    )
      return item;
    const transform = (text: string, at: string, depth = 0): string => {
      if (text.length < 512) return text;
      const shellOutput = depth < 2 ? responseJsonEnvelope(text) : undefined;
      if (shellOutput !== undefined) {
        const priorElisions = elisions;
        const priorReferences = dedupReferences;
        const inner = transform(
          shellOutput,
          `${at} JSON field "output"`,
          depth + 1
        );
        const candidate =
          inner === shellOutput ? text : replaceJsonText(text, 'output', inner);
        if (tokenBenefit(text, candidate)) return candidate;
        elisions = priorElisions;
        dedupReferences = priorReferences;
        return text;
      }
      const { header, body: content } = responseEnvelope(text);
      const id = typeof item.call_id === 'string' ? item.call_id : item.id;
      if (
        typeof id === 'string' &&
        readCalls.get(id) &&
        classify(content) === 'code'
      )
        return text;
      const reference = dedup.replace(
        content,
        header ? `${at} (body after transport header)` : at
      );
      if (reference !== content && tokenBenefit(text, header + reference)) {
        elisions++;
        dedupReferences++;
        return header + reference;
      }
      const result = cachedOutput(text, spill, tuning);
      if (!tokenBenefit(text, result.text)) return text;
      elisions += Math.max(1, result.elisions.length);
      return result.text;
    };
    const compress = (text: string, at: string): string => {
      if (text.length < 512) return text;
      // Keep JSON local-shell envelopes valid. Their structured status and
      // output fields must not become an unparseable table or prose reference.
      if (item.type === 'local_shell_call_output') {
        try {
          const shell: unknown = JSON.parse(text);
          if (!object(shell)) return text;
          let changed = false;
          const priorElisions = elisions;
          const priorReferences = dedupReferences;
          let nextShell = text;
          for (const key of ['stdout', 'stderr', 'output']) {
            const value = shell[key];
            if (typeof value !== 'string' || value.length < 512) continue;
            const candidate = transform(
              value,
              `${at} JSON field ${JSON.stringify(key)}`
            );
            if (candidate !== value) {
              nextShell = replaceJsonText(
                nextShell,
                key as 'stdout' | 'stderr' | 'output',
                candidate
              );
              changed = true;
            }
          }
          const candidate = changed ? nextShell : text;
          if (!tokenBenefit(text, candidate)) {
            elisions = priorElisions;
            dedupReferences = priorReferences;
            return text;
          }
          return candidate;
        } catch {
          return text;
        }
      }
      return transform(text, at);
    };
    if (typeof item.output === 'string') {
      const output = compress(item.output, `input[${itemIndex}].output`);
      return output === item.output ? item : { ...item, output };
    }
    // Multimodal output keeps every non-text part, with all original metadata.
    if (Array.isArray(item.output)) {
      let output: unknown[] | undefined;
      for (let i = 0; i < item.output.length; i++) {
        const part: unknown = item.output[i];
        if (
          object(part) &&
          (part.type === 'input_text' || part.type === 'output_text') &&
          typeof part.text === 'string'
        ) {
          const text = compress(
            part.text,
            `input[${itemIndex}].output[${i}].text`
          );
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
  const encoded =
    elisions || definitionsChanged
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
      dedupReferences: accepted ? dedupReferences : 0,
      reason: accepted ? undefined : 'no compressible Responses tool output',
      messagesChars: JSON.stringify(input).length,
      messageCount: input.length,
    },
  };
}
