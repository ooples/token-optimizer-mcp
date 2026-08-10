import { describe, expect, test } from '@jest/globals';
import {
  evaluationSchedule, parseRunIdentity, parseUsage,
} from '../../scripts/run-evidence-eval.mjs';

describe('live evidence harness', () => {
  test('counterbalances every four-arm pair', () => {
    const schedule = evaluationSchedule([{ id: 'task' }], 4);
    expect(schedule).toHaveLength(16);
    for (let repetition = 0; repetition < 4; repetition++) {
      const run = schedule.filter((item) => item.repetition === repetition);
      expect(new Set(run.map((item) => item.arm))).toEqual(
        new Set(['baseline', 'optimizer', 'retrieval', 'full'])
      );
      expect(run[0].arm).toBe(['baseline', 'optimizer', 'retrieval', 'full'][repetition]);
    }
  });

  test('keeps missing usage null and reads JSONL usage without inventing zeros', () => {
    expect(parseUsage('ordinary output')).toMatchObject({ totalTokens: null, costUsd: null, toolCalls: null });
    expect(parseUsage('{"usage":{"uncached_input_tokens":10,"cached_input_tokens":20,"output_tokens":4,"total_tokens":34}}'))
      .toMatchObject({ uncachedInputTokens: 10, cachedInputTokens: 20, outputTokens: 4, totalTokens: 34 });
  });

  test('reads Claude cache dimensions, exact identity, and tool calls from stream JSON', () => {
    const stream = [
      JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-5', claude_code_version: '2.1.225', session_id: 's1' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Read' }] } }),
      JSON.stringify({ type: 'result', total_cost_usd: 0.25, usage: { input_tokens: 2, cache_creation_input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 4 } }),
    ].join('\n');
    expect(parseUsage(stream)).toMatchObject({
      uncachedInputTokens: 2, cacheCreationInputTokens: 10, cachedInputTokens: 20,
      outputTokens: 4, totalTokens: 36, toolCalls: 1, failedToolCalls: 0, costUsd: 0.25,
    });
    expect(parseRunIdentity(stream)).toEqual({
      modelVersion: 'claude-sonnet-5', clientVersion: '2.1.225', sessionId: 's1',
    });
  });

  test('does not let later sparse events overwrite the authoritative run identity', () => {
    const stream = [
      JSON.stringify({
        type: 'system', subtype: 'init', model: 'model-first',
        claude_code_version: 'client-first', session_id: 'session-first',
      }),
      JSON.stringify({
        type: 'thread.started', thread_id: 'session-later',
        model_version: 'model-later', client_version: 'client-later',
      }),
    ].join('\n');

    expect(parseRunIdentity(stream)).toEqual({
      modelVersion: 'model-first', clientVersion: 'client-first', sessionId: 'session-first',
    });
  });
});
