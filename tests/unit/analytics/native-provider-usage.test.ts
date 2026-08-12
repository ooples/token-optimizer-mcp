import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from '@jest/globals';
import {
  readClaudeUsageFile,
  readCodexUsageFile,
  readGeminiUsageFile,
  nativeUsageRecordFromHookEvent,
  summarizeProviderUsage,
} from '../../../src/analytics/native-provider-usage.js';

const temporary: string[] = [];
function tempFile(name: string, contents: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-usage-'));
  temporary.push(directory);
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, contents);
  return filePath;
}
afterEach(() => {
  for (const directory of temporary.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe('native provider usage adapters', () => {
  it('subtracts Codex cached input and drops duplicate cumulative snapshots', async () => {
    const filePath = tempFile(
      'codex.jsonl',
      [
        {
          type: 'session_meta',
          payload: { session_id: 's1', cwd: 'p1', model_provider: 'openai' },
        },
        { type: 'turn_context', payload: { model: 'gpt-5.6-sol' } },
        {
          timestamp: '2026-08-12T12:00:00Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: 90,
                cached_input_tokens: 60,
                cache_write_input_tokens: 10,
                output_tokens: 10,
                total_tokens: 100,
              },
              last_token_usage: {
                input_tokens: 90,
                cached_input_tokens: 60,
                cache_write_input_tokens: 10,
                output_tokens: 10,
              },
            },
            rate_limits: { plan_type: 'pro' },
          },
        },
        {
          timestamp: '2026-08-12T12:00:01Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: 90,
                cached_input_tokens: 60,
                cache_write_input_tokens: 10,
                output_tokens: 10,
                total_tokens: 100,
              },
              last_token_usage: {
                input_tokens: 90,
                cached_input_tokens: 60,
                cache_write_input_tokens: 10,
                output_tokens: 10,
              },
            },
            rate_limits: { plan_type: 'pro' },
          },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join('\n')
    );
    const records = await readCodexUsageFile(filePath);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      model: 'gpt-5.6-sol',
      plan: 'pro',
      usage: {
        uncachedInputTokens: 20,
        cachedInputTokens: 60,
        cacheWriteInputTokens: 10,
        outputTokens: 10,
      },
    });
  });

  it('deduplicates Claude request ids and retains 1-hour cache writes', async () => {
    const row = {
      timestamp: '2026-08-12T12:00:00Z',
      requestId: 'r1',
      sessionId: 's1',
      cwd: 'p1',
      message: {
        model: 'claude-opus-5',
        usage: {
          input_tokens: 2,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 200,
          output_tokens: 3,
          cache_creation: {
            ephemeral_1h_input_tokens: 200,
            ephemeral_5m_input_tokens: 0,
          },
        },
      },
    };
    const finalRow = {
      ...row,
      timestamp: '2026-08-12T12:00:01Z',
      message: {
        ...row.message,
        usage: { ...row.message.usage, output_tokens: 30 },
      },
    };
    const records = await readClaudeUsageFile(
      tempFile(
        'claude.jsonl',
        `${JSON.stringify(row)}\n${JSON.stringify(finalRow)}`
      )
    );

    expect(records).toHaveLength(1);
    expect(records[0].usage).toMatchObject({
      uncachedInputTokens: 2,
      cachedInputTokens: 100,
      cacheWrite1hInputTokens: 200,
      cacheWriteInputTokens: 0,
      outputTokens: 30,
    });
  });

  it('treats Gemini cached input as a subset and thoughts as priced output', () => {
    const records = readGeminiUsageFile(
      tempFile(
        'gemini.json',
        JSON.stringify({
          sessionId: 's1',
          messages: [
            {
              timestamp: '2026-08-12T12:00:00Z',
              model: 'gemini-2.5-flash',
              tokens: {
                input: 9_070,
                cached: 8_408,
                output: 34,
                thoughts: 218,
              },
            },
          ],
        })
      )
    );

    expect(records[0].usage).toMatchObject({
      uncachedInputTokens: 662,
      cachedInputTokens: 8_408,
      outputTokens: 252,
    });
  });

  it('reports price coverage separately from total observed usage', () => {
    const base = {
      measurementId: 'm1',
      timestamp: '2026-08-12T12:00:00Z',
      client: 'codex' as const,
      provider: 'openai',
      billingRoute: 'codex-pro',
      pricingRoute: 'openai-api',
      model: 'gpt-5.6-sol',
      plan: 'pro',
      project: null,
      sessionId: 's1',
      usage: {
        uncachedInputTokens: 1_000_000,
        cachedInputTokens: 0,
        cacheWrite5mInputTokens: 0,
        cacheWrite1hInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 0,
      },
      nativeReportedCost: null,
      nativeReportedCurrency: null,
      source: 'fixture',
    };
    const report = summarizeProviderUsage([
      base,
      { ...base, measurementId: 'm2', model: 'unknown-model' },
    ]);

    expect(report).toMatchObject({
      requestCount: 2,
      pricedRequestCount: 1,
      unpricedRequestCount: 1,
      pricingCoveragePercent: 50,
      apiEquivalentCost: { USD: 10 },
    });
  });

  it('accepts native usage from other CLI hook payloads without guessing a price', () => {
    const record = nativeUsageRecordFromHookEvent({
      kind: 'tool-outcome',
      at: Date.parse('2026-08-12T12:00:00Z'),
      usageMeasurementId: 'copilot-request-1',
      client: 'copilot',
      model: 'gpt-5.6-sol',
      uncachedInputTokens: 100,
      cachedInputTokens: 200,
      cacheWriteInputTokens: 0,
      outputTokens: 30,
    });

    expect(record).toMatchObject({
      measurementId: 'hook:copilot:copilot-request-1',
      client: 'copilot',
      provider: 'github',
      pricingRoute: 'github-copilot',
      model: 'gpt-5.6-sol',
      usage: {
        uncachedInputTokens: 100,
        cachedInputTokens: 200,
        outputTokens: 30,
      },
    });
  });
});
