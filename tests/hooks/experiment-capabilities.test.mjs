import { describe, expect, test } from '@jest/globals';
import {
  CLIENT_CAPABILITIES, CAPABILITY_TIERS, capabilitySummary, nativeClientProfiles,
} from '../../hooks-core/capabilities.mjs';
import { EXPERIMENT_ARMS, featuresForArm, episodeMeta, usageFrom } from '../../hooks-core/experiment.mjs';

describe('cross-client capability contract', () => {
  test('names all sixteen clients and keeps rules-only promises bounded', () => {
    expect(Object.keys(CLIENT_CAPABILITIES)).toHaveLength(16);
    expect(Object.keys(nativeClientProfiles())).toHaveLength(10);
    const rules = capabilitySummary().filter((client) => client.tier === CAPABILITY_TIERS.RULES);
    expect(rules).toHaveLength(6);
    expect(rules.every((client) => client.structuralCapture === 'mcp-visible-only')).toBe(true);
  });
});

describe('experiment arms and metadata', () => {
  test('isolates optimizer, retrieval, and semantic harvest contributions', () => {
    expect(EXPERIMENT_ARMS).toEqual(['baseline', 'optimizer', 'retrieval', 'full']);
    expect(featuresForArm('baseline')).toEqual({ routing: false, retrieval: false, capture: false, harvest: false });
    expect(featuresForArm('optimizer')).toEqual({ routing: true, retrieval: false, capture: false, harvest: false });
    expect(featuresForArm('retrieval')).toEqual({ routing: true, retrieval: true, capture: true, harvest: false });
    expect(featuresForArm('full')).toEqual({ routing: true, retrieval: true, capture: true, harvest: true });
  });

  test('normalizes causal ids and token dimensions', () => {
    const meta = episodeMeta({
      client: 'codex',
      raw: { session_id: 's1', turn_id: 't1', tool_use_id: 'c1', model: 'm1', client_version: 'v1' },
      env: { TOKEN_OPTIMIZER_EXPERIMENT_ARM: 'retrieval', TOKEN_OPTIMIZER_PAIR_ID: 'p1' },
    });
    expect(meta).toMatchObject({
      episodeId: 's1', sessionId: 's1', turnId: 't1', toolCallId: 'c1',
      client: 'codex', clientVersion: 'v1', model: 'm1', arm: 'retrieval', pairId: 'p1',
    });
    expect(usageFrom({ usage: { uncached_input_tokens: 10, cached_input_tokens: 20, output_tokens: 3 } }))
      .toEqual({
        uncachedInputTokens: 10, cachedInputTokens: 20,
        cacheWrite5mInputTokens: null, cacheWrite1hInputTokens: null,
        cacheWriteInputTokens: null, outputTokens: 3, totalTokens: null,
        usageMeasurementId: null,
      });
  });

  test('keeps provider cache semantics separate instead of double counting input', () => {
    expect(usageFrom({ requestId: 'claude-1', usage: {
      input_tokens: 2,
      cache_read_input_tokens: 26_065,
      cache_creation_input_tokens: 30_372,
      cache_creation: { ephemeral_1h_input_tokens: 30_372, ephemeral_5m_input_tokens: 0 },
      output_tokens: 165,
    } })).toMatchObject({
      uncachedInputTokens: 2,
      cachedInputTokens: 26_065,
      cacheWrite5mInputTokens: 0,
      cacheWrite1hInputTokens: 30_372,
      cacheWriteInputTokens: 0,
      outputTokens: 165,
      usageMeasurementId: 'claude-1',
    });
    expect(usageFrom({ responseId: 'gemini-1', usageMetadata: {
      promptTokenCount: 9_070,
      cachedContentTokenCount: 8_408,
      candidatesTokenCount: 34,
      thoughtsTokenCount: 218,
      totalTokenCount: 9_322,
    } })).toMatchObject({
      uncachedInputTokens: 662,
      cachedInputTokens: 8_408,
      outputTokens: 252,
      totalTokens: 9_322,
      usageMeasurementId: 'gemini-1',
    });
  });
});
