/**
 * What the provider bills as prompt is not what we put on the wire.
 *
 * Tool deferral is the one transformation in this proxy that makes the request
 * BIGGER on purpose: it marks schemas `defer_loading: true`, prepends a search
 * tool, and relies on the provider to leave the marked schemas out of context.
 * Every accounting surface here used to count the wire, so a deferred request
 * -- the default configuration -- was measured as an expansion and charged
 * against the headline, when it is the single largest saving the proxy makes.
 *
 * These tests pin the correction at the only place it can be made correctly:
 * the body is reconstructed from the schemas we hold, so the prompt-side count
 * is counted rather than estimated, and anything that cannot be reconstructed
 * refuses rather than falling back to the wire figure it replaces.
 */

import { describe, it, expect } from '@jest/globals';
import { promptSideBody } from '../../../src/proxy/server.js';
import { deferTools } from '../../../src/compress/tools.js';
import type { ProviderRequest } from '../../../src/compress/types.js';

/** A request with enough tools that deferral has something to defer. */
function requestWithTools(count: number): Record<string, unknown> {
  return {
    model: 'claude-opus-4-20250514',
    messages: [
      { role: 'user', content: 'rename the handler in src/server.ts' },
    ],
    tools: Array.from({ length: count }, (_unused, index) => ({
      name: `tool_${index}`,
      description:
        `Operates on resource ${index}. ` +
        'Takes a path and a mode and reports what it did, at some length, ' +
        'because a real tool schema is prose and not a name.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'The file to operate on.' },
          mode: { type: 'string', description: 'One of read, write, append.' },
        },
        required: ['path'],
      },
    })),
  };
}

const buf = (value: unknown): Buffer =>
  Buffer.from(JSON.stringify(value), 'utf8');

const toolsOf = (body: Buffer): Record<string, unknown>[] =>
  (JSON.parse(body.toString('utf8')) as { tools: Record<string, unknown>[] })
    .tools;

describe('the prompt a deferred request becomes', () => {
  it('is far smaller than the wire body, which is larger than the original', () => {
    const original = requestWithTools(40);
    const sent = deferTools(original as unknown as ProviderRequest, {
      query: 'rename the handler in src/server.ts',
    });
    expect(sent.deferredCount).toBeGreaterThan(0);

    const wire = buf(sent.request);
    const prompt = promptSideBody(wire, sent.deferredCount);
    expect(prompt).not.toBeNull();
    if (prompt === null) throw new Error('unreachable');

    // THE SIGN, WHICH IS THE WHOLE DEFECT. On the wire the request grew; the
    // prompt it becomes is a fraction of what we were given. A measurement
    // that reads the first of these reports a debit on the proxy's best work.
    const before = buf(original).length;
    expect(wire.length).toBeGreaterThan(before);
    expect(prompt.length).toBeLessThan(before / 2);

    // Counted, not estimated: the schemas left are exactly the ones the
    // provider will place in context, and nothing was dropped by accident.
    expect(toolsOf(prompt)).toHaveLength(
      toolsOf(wire).length - sent.deferredCount
    );
    for (const tool of toolsOf(prompt))
      expect(tool.defer_loading).not.toBe(true);
  });

  it('leaves a request nobody deferred byte-identical', () => {
    const wire = buf(requestWithTools(3));
    // SAME BUFFER, not an equal one: an untouched request must not pay a parse
    // and a re-serialise, and identity is the only assertion that proves it.
    expect(promptSideBody(wire)).toBe(wire);

    // POSITIVE CONTROL: the identity above is cheap to satisfy by returning the
    // argument unconditionally, so prove the function does reconstruct when
    // there is something to reconstruct.
    const marked = buf({
      ...requestWithTools(3),
      tools: [{ name: 'kept' }, { name: 'gone', defer_loading: true }],
    });
    const prompt = promptSideBody(marked);
    expect(prompt).not.toBe(marked);
    expect(prompt === null ? [] : toolsOf(prompt)).toEqual([{ name: 'kept' }]);
  });

  it('drops the client’s own markers from both sides', () => {
    // A CLIENT MAY DEFER ITS OWN TOOLS, and `deferTools` passes those through
    // untouched and does not count them. They were never in the client's
    // prompt, so a before side that still holds them credits the proxy with a
    // saving the provider was already making.
    const clientSide = buf({
      ...requestWithTools(2),
      tools: [{ name: 'a' }, { name: 'b', defer_loading: true }],
    });
    const prompt = promptSideBody(clientSide);
    expect(prompt).not.toBeNull();
    expect(prompt === null ? [] : toolsOf(prompt)).toEqual([{ name: 'a' }]);
  });
});

describe('what it refuses rather than guess', () => {
  // NULL IS NOT AN ERROR PATH, it is the instruction to leave the row
  // uncounted. The alternative -- falling back to the wire figure -- is the
  // wrong-signed number this function exists to replace, and a wrong count is
  // indistinguishable from a right one once it is in the ledger.
  it('refuses a claimed deferral whose body carries no marker', () => {
    const wire = buf(requestWithTools(4));
    expect(promptSideBody(wire, 4)).toBeNull();

    // POSITIVE CONTROL: the same body with no claim against it is counted, so
    // the refusal above is about the inconsistency and not about the body.
    expect(promptSideBody(wire)).toBe(wire);
  });

  it('refuses a claimed deferral whose body will not parse', () => {
    const broken = Buffer.from('{"tools":[{"defer_loading":true}', 'utf8');
    expect(promptSideBody(broken, 1)).toBeNull();

    // POSITIVE CONTROL: a parsable body carrying the same marker and the same
    // claim is counted.
    const whole = buf({ tools: [{ name: 'x', defer_loading: true }] });
    expect(promptSideBody(whole, 1)).not.toBeNull();
  });

  it('refuses a claimed deferral with no tools array to read', () => {
    // The marker appears in prose rather than on a schema, so there is nothing
    // to remove and the claim cannot be honoured.
    const prose = buf({
      messages: [{ role: 'user', content: 'what does defer_loading do?' }],
    });
    expect(promptSideBody(prose, 2)).toBeNull();

    // POSITIVE CONTROL: without a claim the same body is passed through, which
    // is what keeps a request that merely MENTIONS the marker countable.
    expect(promptSideBody(prose)).toBe(prose);
  });

  it('refuses a claimed deferral that removed nothing', () => {
    // Every marker is `false`, so the provider places every schema in context
    // and the prompt is the wire body -- while the summary says two schemas
    // were deferred. One of the two is wrong and neither can be trusted.
    const none = buf({
      tools: [
        { name: 'a', defer_loading: false },
        { name: 'b', defer_loading: false },
      ],
    });
    expect(promptSideBody(none, 2)).toBeNull();
    expect(promptSideBody(none)).toBe(none);
  });
});
