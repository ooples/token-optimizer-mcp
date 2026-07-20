/**
 * Unit tests for the analytics auto-recording bridge.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  extractSavings,
  recordToolAnalytics,
  currentHookPhase,
} from '../../../src/analytics/record-tool-analytics.js';
import { AnalyticsManager } from '../../../src/analytics/analytics-manager.js';
import { SqliteAnalyticsStorage } from '../../../src/analytics/analytics-storage.js';
import path from 'path';
import os from 'os';

function mcpResult(payload: unknown, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    isError,
  };
}

describe('extractSavings', () => {
  it('reads the canonical optimize_text triplet', () => {
    expect(
      extractSavings({
        originalTokens: 2001,
        compressedTokens: 60,
        tokensSaved: 1941,
      })
    ).toEqual({ originalTokens: 2001, optimizedTokens: 60, tokensSaved: 1941 });
  });

  it('reconstructs a missing member from the other two', () => {
    // only original + saved present → optimized = original - saved
    expect(extractSavings({ originalTokens: 100, tokensSaved: 30 })).toEqual({
      originalTokens: 100,
      optimizedTokens: 70,
      tokensSaved: 30,
    });
  });

  it('accepts optimizedTokens alias and derives savings', () => {
    expect(
      extractSavings({ originalTokens: 100, optimizedTokens: 40 })
    ).toEqual({ originalTokens: 100, optimizedTokens: 40, tokensSaved: 60 });
  });

  it('finds a triplet nested one level deep', () => {
    expect(
      extractSavings({
        success: true,
        metadata: { originalTokens: 500, tokensSaved: 450 },
      })
    ).toEqual({ originalTokens: 500, optimizedTokens: 50, tokensSaved: 450 });
  });

  it('returns null when there is no measurable triplet', () => {
    expect(extractSavings({ tokens: 2001, characters: 9000 })).toBeNull();
    expect(extractSavings({ success: true, message: 'ok' })).toBeNull();
    expect(extractSavings(null)).toBeNull();
    expect(extractSavings('a string')).toBeNull();
  });

  it('rejects impossible negative counts', () => {
    expect(
      extractSavings({ originalTokens: -5, optimizedTokens: 1 })
    ).toBeNull();
  });

  it('keeps genuine zero-savings measurements out (pure noise) but real ones in', () => {
    // both zero → noise
    expect(
      extractSavings({ originalTokens: 0, optimizedTokens: 0, tokensSaved: 0 })
    ).toBeNull();
    // real measurement that happened to save nothing
    expect(
      extractSavings({ originalTokens: 50, optimizedTokens: 50, tokensSaved: 0 })
    ).toEqual({ originalTokens: 50, optimizedTokens: 50, tokensSaved: 0 });
  });
});

describe('currentHookPhase', () => {
  it('defaults to Unknown and honors a valid env override', () => {
    delete process.env.TOKEN_OPTIMIZER_HOOK_PHASE;
    expect(currentHookPhase()).toBe('Unknown');
    process.env.TOKEN_OPTIMIZER_HOOK_PHASE = 'PostToolUse';
    expect(currentHookPhase()).toBe('PostToolUse');
    process.env.TOKEN_OPTIMIZER_HOOK_PHASE = 'bogus';
    expect(currentHookPhase()).toBe('Unknown');
    delete process.env.TOKEN_OPTIMIZER_HOOK_PHASE;
  });
});

describe('recordToolAnalytics', () => {
  let manager: AnalyticsManager;

  beforeEach(() => {
    const dbPath = path.join(os.tmpdir(), `rec-analytics-${Date.now()}-${Math.round(performance.now())}.db`);
    manager = new AnalyticsManager(new SqliteAnalyticsStorage(dbPath));
  });

  it('records a savings triplet from a real tool result', async () => {
    await recordToolAnalytics(
      manager,
      'smart_read',
      mcpResult({ originalTokens: 1000, optimizedTokens: 100, tokensSaved: 900 })
    );
    const action = await manager.getActionAnalytics();
    expect(action.summary.totalOperations).toBe(1);
    expect(action.summary.totalTokensSaved).toBe(900);
    expect(action.byAction[0].name).toBe('smart_read');
  });

  it('does not record error results, in-band failures, or non-JSON output', async () => {
    await recordToolAnalytics(
      manager,
      'smart_read',
      mcpResult({ originalTokens: 1, optimizedTokens: 0, tokensSaved: 1 }, true)
    );
    await recordToolAnalytics(
      manager,
      'smart_read',
      mcpResult({ success: false, originalTokens: 1000, tokensSaved: 900 })
    );
    await recordToolAnalytics(manager, 'x', {
      content: [{ type: 'text', text: 'not json' }],
    });
    await recordToolAnalytics(manager, 'count_tokens', mcpResult({ tokens: 2001 }));
    expect(await manager.count()).toBe(0);
  });
});
