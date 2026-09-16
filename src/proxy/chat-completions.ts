import { compressResponses } from './responses.js';
import { withResponsesKnowledge } from './responses-knowledge.js';
import type { AnchorStore } from '../compress/anchor.js';
import type { Finding } from '../compress/knowledge.js';
import type { Tuning } from '../compress/options.js';
import type { CompressionFacts } from './accounting.js';

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Reuse bounded tool-output compression; never send Responses fields to Chat.
 * Only string tool results are eligible. All other message and provider fields
 * remain exact, including reasoning, multimodal parts, tools and call metadata.
 */
export function compressChatCompletions(
  body: Buffer,
  request: Record<string, unknown>,
  spill: (content: string, hint: string) => string,
  anchors?: AnchorStore,
  findings: readonly Finding[] = [],
  tuning?: Tuning,
  sharedGraph?: boolean
): { body: Buffer; summary: CompressionFacts } {
  const messages = request.messages as unknown[];
  const input: Record<string, unknown>[] = [];
  const outputs = new Map<number, number>();
  const ids = new Map<string, number>();
  for (const message of messages)
    if (
      object(message) &&
      message.role === 'tool' &&
      typeof message.tool_call_id === 'string'
    )
      ids.set(message.tool_call_id, (ids.get(message.tool_call_id) ?? 0) + 1);
  for (const [index, message] of messages.entries()) {
    if (!object(message)) continue;
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      input.push({
        type: 'message',
        role: 'assistant',
        content: message.content,
      });
      for (const call of message.tool_calls)
        if (object(call) && call.type === 'function' && object(call.function))
          input.push({
            type: 'function_call',
            call_id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
          });
    } else if (
      message.role === 'tool' &&
      typeof message.content === 'string' &&
      typeof message.tool_call_id === 'string' &&
      ids.get(message.tool_call_id) === 1
    ) {
      outputs.set(input.length, index);
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id,
        output: message.content,
      });
    } else
      input.push({
        type: message.role === 'tool' ? 'unhandled_tool_output' : 'message',
        role: message.role,
        content: message.content,
      });
  }
  // Include all initial instructions in the graph's conversation identity.
  const instructions = JSON.stringify(
    messages.filter(
      (message) =>
        object(message) &&
        ['system', 'developer'].includes(String(message.role))
    )
  );
  const normalized = { instructions, input };
  const normalizedBody = Buffer.from(JSON.stringify(normalized));
  const knowledge = withResponsesKnowledge(
    {
      body: normalizedBody,
      summary: {
        beforeBytes: body.length,
        afterBytes: body.length,
        compressed: false,
      },
    },
    normalized,
    anchors,
    findings,
    tuning,
    sharedGraph
  );
  const added = knowledge.summary.injectedChars
    ? (
        JSON.parse(knowledge.body.toString()) as { instructions: string }
      ).instructions.slice(instructions.length)
    : '';
  const compressed = compressResponses(
    normalizedBody,
    normalized,
    spill,
    tuning,
    (index) => `messages[${outputs.get(index)! + (added ? 1 : 0)}].content`
  );
  const transformed = compressed.summary.compressed
    ? (
        JSON.parse(compressed.body.toString()) as {
          input: Record<string, unknown>[];
        }
      ).input
    : input;
  const next = messages.slice();
  let changed = false;
  for (const [source, destination] of outputs) {
    if (transformed[source].output === input[source].output) continue;
    next[destination] = {
      ...(messages[destination] as Record<string, unknown>),
      content: transformed[source].output,
    };
    changed = true;
  }
  const encoded = changed
    ? Buffer.from(JSON.stringify({ ...request, messages: next }))
    : body;
  const accepted = encoded.length < body.length;
  let result = accepted ? next : messages;
  if (added)
    result = [{ role: 'system', content: added.trimStart() }, ...result];
  const final = added
    ? Buffer.from(JSON.stringify({ ...request, messages: result }))
    : accepted
      ? encoded
      : body;
  return {
    body: final,
    summary: {
      ...compressed.summary,
      beforeBytes: body.length,
      afterBytes: final.length,
      compressed: accepted,
      injectedChars: added.length,
      elisions: accepted ? compressed.summary.elisions : 0,
      reason: accepted
        ? undefined
        : 'no compressible Chat Completions tool output',
    },
  };
}
