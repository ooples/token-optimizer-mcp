import { describe, it, expect } from '@jest/globals';
import { routeReadOnlySubagent, isReadOnlySubagent, readOnlyRouteFromEnv } from '../../../src/compress/model-route.js';
import type { ProviderRequest } from '../../../src/compress/frontier.js';

const subagent = (model: string, task: string, sub = true): ProviderRequest =>
  ({
    model,
    system: [{ type: 'text', text: `x-anthropic-billing-header: cc_version=2.1.302;${sub ? ' cc_is_subagent=true;' : ''}` }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'context' }, { type: 'text', text: task }] }],
  }) as unknown as ProviderRequest;

describe('read-only subagents one tier down', () => {
  it('routes a declared read-only triage agent', () => {
    const r = routeReadOnlySubagent(subagent('claude-sonnet-5-5', 'You are a TRIAGE agent (read-only: do not edit code).'), 'down');
    expect(r.to).toBe('claude-haiku-5-5');
    expect((r.request as { model: string }).model).toBe('claude-haiku-5-5');
    expect(routeReadOnlySubagent(subagent('claude-opus-5-5', 'This is a read-only audit of X.'), 'down').to).toBe('claude-sonnet-5-5');
  });

  it('does not take a prohibition in shared rules for a read-only role', () => {
    // Real campaign rule text, given to agents that edit and commit.
    const fixer = 'Never edit another worktree. Do not modify tests to make them pass. Fix issue #12 and commit.';
    expect(routeReadOnlySubagent(subagent('claude-opus-5-5', fixer), 'down').to).toBeNull();
  });

  it('leaves writers, the main session and unknown families alone', () => {
    expect(routeReadOnlySubagent(subagent('claude-opus-5-5', 'Fix issue #12 and commit.'), 'down').to).toBeNull();
    expect(routeReadOnlySubagent(subagent('claude-opus-5-5', '(read-only) audit', false), 'down').to).toBeNull();
    expect(routeReadOnlySubagent(subagent('some-other-model', '(read-only) audit'), 'down').to).toBeNull();
  });

  it('decides the same way on every turn of a conversation', () => {
    const turn1 = subagent('claude-opus-5-5', 'You are a read-only research agent.');
    const turn2 = { ...turn1, messages: [...(turn1.messages ?? []), { role: 'assistant', content: 'ok' }] } as ProviderRequest;
    expect(routeReadOnlySubagent(turn2, 'down').to).toBe(routeReadOnlySubagent(turn1, 'down').to);
  });

  it('honours an explicit target and the off switch', () => {
    expect(routeReadOnlySubagent(subagent('claude-opus-5-5', '(read-only) list the files'), 'claude-haiku-5-5').to).toBe('claude-haiku-5-5');
    expect(readOnlyRouteFromEnv({ TOKEN_OPTIMIZER_PROXY_READONLY_ROUTE: '0' })).toBe('off');
    expect(readOnlyRouteFromEnv({})).toBe('down');
    expect(isReadOnlySubagent(subagent('claude-opus-5-5', 'Write the fix.'))).toBe(false);
  });
});
