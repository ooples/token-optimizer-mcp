import { describe, expect, test } from '@jest/globals';
import {
  parseLiveCliTelemetry,
  parseStructuredModelJson,
  studyArmDecision,
} from '../../ucr/index.mjs';

describe('live study driver protocol helpers', () => {
  test('normalizes Codex JSONL without retaining model content', () => {
    const telemetry = parseLiveCliTelemetry(
      'codex',
      [
        JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: '{"correction":"verified"}' },
        }),
        JSON.stringify({
          type: 'turn.completed',
          usage: { input_tokens: 12, output_tokens: 3 },
        }),
      ].join('\n')
    );
    expect(telemetry).toMatchObject({
      providerRequestId: 'thread-1',
      usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
      structuredOutput: { correction: 'verified' },
    });
    expect(telemetry).not.toHaveProperty('objects');
  });

  test('finds nested Claude structured output', () => {
    const telemetry = parseLiveCliTelemetry(
      'claude-code',
      JSON.stringify({
        type: 'result',
        session_id: 'session-1',
        payload: { structured_output: { correction: 'nested result' } },
        usage: { input_tokens: 9, output_tokens: 2 },
      })
    );
    expect(telemetry).toMatchObject({
      providerRequestId: 'session-1',
      structuredOutput: { correction: 'nested result' },
      usage: { inputTokens: 9, outputTokens: 2, totalTokens: 11 },
    });
  });

  test('uses terminal cumulative usage instead of an early streamed snapshot', () => {
    const telemetry = parseLiveCliTelemetry(
      'claude-code',
      [
        JSON.stringify({
          type: 'message',
          usage: { input_tokens: 2, output_tokens: 1 },
        }),
        JSON.stringify({
          type: 'result',
          usage: { input_tokens: 62003, output_tokens: 812 },
          total_tokens: 62815,
          total_cost_usd: 0.42,
        }),
      ].join('\n')
    );
    expect(telemetry.usage).toEqual({
      inputTokens: 62003,
      cachedInputTokens: null,
      cacheCreationInputTokens: null,
      effectiveInputTokens: 62003,
      outputTokens: 812,
      totalTokens: 62815,
      costUsd: 0.42,
    });
  });

  test('counts Claude cache-backed input without double-counting other clients', () => {
    const sample = JSON.stringify({
      type: 'result',
      usage: {
        input_tokens: 2,
        cache_read_input_tokens: 55000,
        cache_creation_input_tokens: 700,
        output_tokens: 12,
      },
    });
    expect(parseLiveCliTelemetry('claude-code', sample).usage).toMatchObject({
      inputTokens: 2,
      cachedInputTokens: 55000,
      cacheCreationInputTokens: 700,
      effectiveInputTokens: 55702,
    });
    expect(
      parseLiveCliTelemetry('codex', sample).usage.effectiveInputTokens
    ).toBe(2);
  });

  test('does not let a later null structured output erase valid model JSON', () => {
    const telemetry = parseLiveCliTelemetry(
      'codex',
      [
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: '{"correction":"keep this"}' },
        }),
        JSON.stringify({ type: 'result', structured_output: null }),
      ].join('\n')
    );
    expect(telemetry.structuredOutput).toEqual({ correction: 'keep this' });
  });

  test('parses fenced model JSON and fails closed on prose', () => {
    expect(parseStructuredModelJson('```json\n{"ok":true}\n```')).toEqual({
      ok: true,
    });
    expect(parseStructuredModelJson('no structured result')).toBeNull();
  });

  test('delivers only applicable runtime or oracle context', () => {
    expect(
      studyArmDecision('runtime', null, {
        correction: 'use current evidence',
        verificationEvidence: 'evidence/current.json',
      })
    ).toMatchObject({ applicable: true, delivered: true });
    for (const arm of [
      'empty',
      'stale',
      'irrelevant',
      'contradictory',
      'harmful',
    ])
      expect(studyArmDecision(arm, 'hostile', {})).toMatchObject({
        applicable: false,
        delivered: false,
      });
  });
});
