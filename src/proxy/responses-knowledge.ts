import { createHash } from 'node:crypto';
import type { AnchorStore } from '../compress/anchor.js';
import { knowledgeBlock, type Finding } from '../compress/knowledge.js';
import type { Tuning } from '../compress/options.js';
import type { CompressionFacts } from './accounting.js';

// Owned by a proxy instance, never shared between project roots. Remember null
// too: discovering a finding later must not rewrite an existing cached prefix.
const blocks = new WeakMap<AnchorStore, Map<string, string | null>>();

export function withResponsesKnowledge(
  result: { body: Buffer; summary: CompressionFacts },
  request: Record<string, unknown>,
  anchors?: AnchorStore,
  findings: readonly Finding[] = [],
  tuning?: Tuning,
  sharedGraph?: boolean
): typeof result {
  if (!anchors || request.previous_response_id) return result;
  if (
    request.instructions !== undefined &&
    typeof request.instructions !== 'string'
  )
    return result;
  const input = request.input as Record<string, unknown>[];
  const opening = input.find((item) => item && item.role === 'user');
  if (!opening) return result;
  const context = `${request.instructions ?? ''}\n${JSON.stringify(opening)}`;
  const key = createHash('sha256').update(context).digest('hex');
  let cache = blocks.get(anchors);
  if (!cache) {
    cache = new Map();
    blocks.set(anchors, cache);
  }
  if (!cache.has(key)) {
    // Joining an established conversation must not invalidate its prefix.
    // CLI setup can contain many user/developer messages before the first
    // inference. Assistant/tool/reasoning history, not envelope count, signals
    // that this proxy joined an established conversation.
    const hasHistory = input.some(
      (item) =>
        item &&
        (item.role === 'assistant' ||
          (typeof item.type === 'string' &&
            !['message', 'additional_tools'].includes(item.type)))
    );
    const block = !hasHistory
      ? knowledgeBlock(findings, context, tuning?.knowledgeBudgetChars, {
          sharedGraph,
        })
      : null;
    if (cache.size >= 1000) cache.delete(cache.keys().next().value!);
    cache.set(key, block);
  }
  const block = cache.get(key);
  if (!block) return result;
  const next = JSON.parse(result.body.toString('utf8')) as Record<
    string,
    unknown
  >;
  const addition = `\n\n${block}`;
  next.instructions = `${request.instructions ?? ''}${addition}`;
  const body = Buffer.from(JSON.stringify(next));
  return {
    body,
    summary: {
      ...result.summary,
      afterBytes: body.length,
      injectedChars: addition.length,
    },
  };
}
