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

const tool = (name: string, size = 3000): Record<string, unknown> => ({
  name,
  description: 'x'.repeat(size),
  input_schema: { type: 'object', properties: {} },
});

/** A large tool whose description is real prose, so ranking can tell them apart. */
const described = (name: string, text: string): Record<string, unknown> => ({
  name,
  description: `${text}. ${(text + ' ').repeat(120)}`,
  input_schema: { type: 'object', properties: {} },
});

/** An MCP-named tool, which is the deferrable kind. */
const mcp = (name: string, size = 3000): Record<string, unknown> =>
  tool(`mcp__s__${name}`, size);

const req = (over: Record<string, unknown>): ProviderRequest =>
  ({ model: 'claude', messages: [], ...over }) as unknown as ProviderRequest;

describe('deferring tool definitions', () => {
  it('marks tools deferred and puts the search tool first', () => {
    const out = deferTools(
      req({
        tools: [
          mcp('alpha'),
          mcp('beta'),
          mcp('gamma'),
          mcp('delta'),
          mcp('epsilon'),
          mcp('zeta'),
          mcp('eta'),
        ],
      }),
      { keepRelevant: 0 }
    );
    const tools = (
      out.request as unknown as { tools: Record<string, unknown>[] }
    ).tools;

    expect(tools[0]).toEqual({
      type: TOOL_SEARCH_TYPE,
      name: TOOL_SEARCH_NAME,
    });
    expect(tools[1].defer_loading).toBe(true);
    expect(tools[2].defer_loading).toBe(true);
    expect(out.deferredCount).toBe(7);
    expect(out.deferredChars).toBeGreaterThan(0);
  });

  it('keeps every tool definition intact apart from the added flag', () => {
    // Deferral must not be a rewrite. The definition still has to be correct
    // when the model asks for it.
    const original = mcp('alpha', 3000);
    const out = deferTools(req({ tools: [original] }), { keepRelevant: 0 });
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
        tools: [mcp('alpha'), mcp('beta')],
        tool_choice: { type: 'tool', name: 'mcp__s__beta' },
      }),
      { keepRelevant: 0 }
    );
    const tools = (
      out.request as unknown as { tools: Record<string, unknown>[] }
    ).tools;
    const forced = tools.find((t) => t.name === 'mcp__s__beta');
    const other = tools.find((t) => t.name === 'mcp__s__alpha');

    expect(forced?.defer_loading).toBeUndefined();
    expect(other?.defer_loading).toBe(true);
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
      req({ tools: [{ ...mcp('alpha'), defer_loading: false }] })
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
          mcp('alpha'),
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
      req({ tools: [null, 42, { name: '' }, mcp('alpha')] } as never),
      { keepRelevant: 0 }
    );

    // Only the one real definition is deferred; the rest pass through.
    expect(out.deferredCount).toBe(1);
  });
});

describe('small definitions are never deferred', () => {
  it('keeps small definitions and defers the large ones', () => {
    // SIZE IS THE SIGNAL, measured rather than assumed. A live capture showed
    // all 31 tools were built-ins and the ten largest -- PowerShell at 9,244
    // characters, DesignSync 8,930, Monitor 7,492 -- were about 64% of the
    // schema, while Read, Edit, Bash and Grep were all small. Keeping the small
    // ones is what preserves the agent's core loop without naming it, and
    // naming it would have rotted anyway.
    const out = deferTools(
      req({
        tools: [
          tool('Read', 200),
          tool('Bash', 200),
          tool('PowerShell', 9000),
          tool('DesignSync', 8000),
        ],
      }),
      { keepRelevant: 0 }
    );
    const tools = (
      out.request as unknown as { tools: Record<string, unknown>[] }
    ).tools;

    expect(tools.find((t) => t.name === 'Read')?.defer_loading).toBeUndefined();
    expect(tools.find((t) => t.name === 'Bash')?.defer_loading).toBeUndefined();
    expect(tools.find((t) => t.name === 'PowerShell')?.defer_loading).toBe(
      true
    );
    expect(tools.find((t) => t.name === 'DesignSync')?.defer_loading).toBe(
      true
    );
    expect(out.deferredCount).toBe(2);
  });

  it('keeps the tools the task looks like it needs, so nothing is searched for', () => {
    // The saving is real only if discovery never fires. We can see the task and
    // every description in the same request, so we choose rather than let the
    // model go looking.
    const out = deferTools(
      req({
        tools: [
          // Descriptions carry real words: a ranker cannot discriminate
          // between definitions padded with the same filler, and a fixture
          // that cannot discriminate proves nothing about ranking.
          described(
            'query_postgres_database',
            'run SQL against the postgres database'
          ),
          described(
            'scrape_a_web_page',
            'fetch and parse a web page over http'
          ),
          described('send_an_email', 'deliver a message to a mail recipient'),
        ],
      }),
      { query: 'query the postgres database for user rows', keepRelevant: 1 }
    );
    const tools = (
      out.request as unknown as { tools: Record<string, unknown>[] }
    ).tools;
    const kept = tools.filter(
      (t) => typeof t.name === 'string' && !t.type && !t.defer_loading
    );

    expect(kept).toHaveLength(1);
    expect(kept[0].name).toBe('query_postgres_database');
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
