import { describe, it, expect } from '@jest/globals';
import {
  deferTools,
  withAdvancedToolUse,
  TOOL_SEARCH_TYPE,
  TOOL_SEARCH_NAME,
  ADVANCED_TOOL_USE_BETA,
} from '../../../src/compress/tools.js';
import type { ProviderRequest } from '../../../src/compress/frontier.js';

/**
 * Tool deferral, and the cases where it must decline.
 *
 * This is the largest lever in the request -- measured live, tool definitions
 * were 85,546 of 179,564 bytes -- which is exactly why the refusals matter more
 * than the savings. A compressor that declines costs nothing; one that mangles
 * a tools array costs the session.
 */

const tool = (name: string, size = 200): Record<string, unknown> => ({
  name,
  description: 'x'.repeat(size),
  input_schema: { type: 'object', properties: {} },
});

const req = (over: Record<string, unknown>): ProviderRequest =>
  ({ model: 'claude', messages: [], ...over }) as unknown as ProviderRequest;

describe('deferring tool definitions', () => {
  it('marks tools deferred and puts the search tool first', () => {
    const out = deferTools(req({ tools: [tool('Read'), tool('Bash')] }));
    const tools = (
      out.request as unknown as { tools: Record<string, unknown>[] }
    ).tools;

    expect(tools[0]).toEqual({
      type: TOOL_SEARCH_TYPE,
      name: TOOL_SEARCH_NAME,
    });
    expect(tools[1].defer_loading).toBe(true);
    expect(tools[2].defer_loading).toBe(true);
    expect(out.deferredCount).toBe(2);
    expect(out.deferredChars).toBeGreaterThan(0);
  });

  it('keeps every tool definition intact apart from the added flag', () => {
    // Deferral must not be a rewrite. The definition still has to be correct
    // when the model asks for it.
    const original = tool('Read', 50);
    const out = deferTools(req({ tools: [original] }));
    const sent = (
      out.request as unknown as { tools: Record<string, unknown>[] }
    ).tools[1];

    expect(sent).toEqual({ ...original, defer_loading: true });
  });

  it('never defers a tool the caller has forced', () => {
    // THE CASE THAT WOULD BREAK A SESSION. `tool_choice` naming a tool requires
    // the model to call it; deferring that definition asks it to call something
    // it cannot see.
    const out = deferTools(
      req({
        tools: [tool('Read'), tool('Bash')],
        tool_choice: { type: 'tool', name: 'Bash' },
      })
    );
    const tools = (
      out.request as unknown as { tools: Record<string, unknown>[] }
    ).tools;
    const bash = tools.find((t) => t.name === 'Bash');
    const read = tools.find((t) => t.name === 'Read');

    expect(bash?.defer_loading).toBeUndefined();
    expect(read?.defer_loading).toBe(true);
  });

  it('leaves a request with no tools exactly as it was', () => {
    const original = req({ messages: [{ role: 'user', content: 'hi' }] });
    const out = deferTools(original);

    expect(out.request).toBe(original);
    expect(out.deferredCount).toBe(0);
  });

  it('declines when the caller is already deferring', () => {
    // Their decision, not ours to second-guess.
    const out = deferTools(
      req({ tools: [{ ...tool('Read'), defer_loading: false }] })
    );

    expect(out.deferredCount).toBe(0);
    expect((out.request as unknown as { tools: unknown[] }).tools).toHaveLength(
      1
    );
  });

  it('declines when a search tool is already present', () => {
    const out = deferTools(
      req({
        tools: [
          { type: TOOL_SEARCH_TYPE, name: TOOL_SEARCH_NAME },
          tool('Read'),
        ],
      })
    );

    expect(out.deferredCount).toBe(0);
  });

  it('does not defer server tools, which are not definitions', () => {
    // A code-execution or computer-use entry is a capability the server
    // provides, not a schema we can withhold.
    const out = deferTools(
      req({ tools: [{ type: 'code_execution_20250825', name: 'code' }] })
    );

    expect(out.deferredCount).toBe(0);
    expect(out.request).toBe(out.request);
  });

  it('adds nothing when there is nothing to defer', () => {
    // The search tool costs tokens. Adding it while deferring none would make
    // the request BIGGER, which is the one outcome this must never produce.
    const before = req({ tools: [{ type: 'code_execution_20250825' }] });
    const out = deferTools(before);

    expect(out.request).toBe(before);
  });

  it('survives a malformed tools array without throwing', () => {
    const out = deferTools(
      req({ tools: [null, 42, { name: '' }, tool('Read')] } as never)
    );

    // Only the one real definition is deferred; the rest pass through.
    expect(out.deferredCount).toBe(1);
  });
});

describe('the beta header', () => {
  it('adds the beta when none is set', () => {
    expect(withAdvancedToolUse(undefined)).toBe(ADVANCED_TOOL_USE_BETA);
  });

  it('APPENDS rather than replacing what the client already asked for', () => {
    // Overwriting would silently switch off betas the client needs, and the
    // failure would surface far from here.
    const out = withAdvancedToolUse(
      'prompt-caching-2024-07-31,fine-grained-tool-streaming-2025-05-14'
    );

    expect(out).toContain('prompt-caching-2024-07-31');
    expect(out).toContain('fine-grained-tool-streaming-2025-05-14');
    expect(out).toContain(ADVANCED_TOOL_USE_BETA);
  });

  it('does not add the beta twice', () => {
    const out = withAdvancedToolUse(ADVANCED_TOOL_USE_BETA);
    expect(
      out.split(',').filter((p) => p === ADVANCED_TOOL_USE_BETA)
    ).toHaveLength(1);
  });

  it('accepts the array form a header can arrive in', () => {
    const out = withAdvancedToolUse(['a-beta', 'b-beta']);
    expect(out).toBe(`a-beta,b-beta,${ADVANCED_TOOL_USE_BETA}`);
  });
});
