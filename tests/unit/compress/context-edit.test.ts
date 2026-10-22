import { describe, it, expect } from '@jest/globals';
import {
  addToolClearing,
  CLEAR_TOOL_USES,
  clearingFromEnv,
  DEFAULT_CLEARING,
  withBeta,
} from '../../../src/compress/context-edit.js';
import type { ProviderRequest } from '../../../src/compress/frontier.js';

const request = (extra: Record<string, unknown> = {}): ProviderRequest =>
  ({
    tools: [{ name: 'Read', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: 'go' }],
    ...extra,
  }) as unknown as ProviderRequest;

const editsOf = (r: ProviderRequest) =>
  (r as unknown as { context_management: { edits: { type: string }[] } })
    .context_management.edits;

describe('server-side clearing of old tool results', () => {
  it("goes after Claude Code's clear_thinking, which the API requires first", () => {
    const out = addToolClearing(
      request({
        context_management: {
          edits: [{ type: 'clear_thinking_20251015', keep: 'all' }],
        },
      }),
      DEFAULT_CLEARING
    );
    expect(out.added).toBe(true);
    expect(editsOf(out.request).map((e) => e.type)).toEqual([
      'clear_thinking_20251015',
      CLEAR_TOOL_USES,
    ]);
    expect(editsOf(out.request)[1]).toEqual({
      type: CLEAR_TOOL_USES,
      trigger: { type: 'input_tokens', value: 60_000 },
      keep: { type: 'tool_uses', value: 5 },
      clear_at_least: { type: 'input_tokens', value: 30_000 },
      exclude_tools: ['Agent', 'Task'],
    });
  });

  it('leaves a client that clears tool uses itself, and a request with no tools', () => {
    const managed = request({
      context_management: { edits: [{ type: CLEAR_TOOL_USES }] },
    });
    expect(addToolClearing(managed, DEFAULT_CLEARING).added).toBe(false);
    expect(
      addToolClearing(request({ tools: [] }), DEFAULT_CLEARING).added
    ).toBe(false);
  });

  it('is configurable and can be turned off', () => {
    expect(clearingFromEnv({})).toEqual(DEFAULT_CLEARING);
    expect(
      clearingFromEnv({ TOKEN_OPTIMIZER_PROXY_CLEAR_TOOL_USES: '0' })
    ).toBeNull();
    expect(
      clearingFromEnv({
        TOKEN_OPTIMIZER_PROXY_CLEAR_TOOL_USES_TRIGGER: '90000',
      })?.triggerTokens
    ).toBe(90_000);
  });

  it('adds its beta without dropping the client’s', () => {
    expect(withBeta('a,b', 'c')).toBe('a,b,c');
    expect(withBeta(['a', 'c'], 'c')).toBe('a,c');
    expect(withBeta(undefined, 'c')).toBe('c');
  });
});
