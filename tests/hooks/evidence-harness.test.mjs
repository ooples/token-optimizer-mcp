import { describe, expect, test } from '@jest/globals';
import { evaluationSchedule, parseUsage } from '../../scripts/run-evidence-eval.mjs';

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
});
