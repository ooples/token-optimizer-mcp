import { describe, it, expect } from '@jest/globals';
import {
  isAfter,
  isSigned,
  lastCacheBreakpoint,
  messageIsSigned,
  type ProviderRequest,
} from '../../../src/compress/frontier.js';
import {
  STRATEGIES,
  v1Frontier,
  ccrStyle,
} from '../../../src/compress/strategy.js';
import { classify, compressBlock } from '../../../src/compress/router.js';

/**
 * The strategies, the cache frontier, and the two failure modes taken straight
 * from HeadRoom's issue tracker.
 *
 * These are the tests that would have caught the defects THEY are carrying:
 * #3486, one shared router keeping per-request state so concurrent requests
 * cross-contaminate, and #3456, rewriting a message with signed thinking blocks
 * and earning a permanent upstream 400.
 */

const rows = (n: number) =>
  JSON.stringify(
    Array.from({ length: n }, (_, i) => ({
      id: `doc_${i}`,
      score: 0.5,
      title: 'A reasonably long result title for bulk',
      metadata: { author: 'Someone', category: 'technical' },
    }))
  );

/**
 * A sink for elided content.
 *
 * Every caller in production has one -- the proxy writes under the OS temp
 * directory. An engine with nowhere to put what it removes keeps the content
 * instead, which `proxy.test.ts` pins directly; here the point is what the
 * strategies do when there IS somewhere.
 */
let spilled = 0;
const spill = (_content: string, hint: string): string =>
  `/spill/${(spilled += 1)}-${hint}`;

/** A request whose first message is cached and whose last is fresh. */
function request(cached: string, fresh: string): ProviderRequest {
  return {
    system: 'You are an agent.',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: cached, cache_control: { type: 'ephemeral' } },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: fresh }] },
    ],
    tools: [],
  };
}

const textOf = (r: ProviderRequest): string =>
  (r.messages ?? [])
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .map((b) => (typeof b.text === 'string' ? b.text : ''))
    .join('\n');

describe('frontier', () => {
  it('finds the last cache breakpoint, not the first', () => {
    const r: ProviderRequest = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'a', cache_control: { type: 'ephemeral' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'b', cache_control: { type: 'ephemeral' } },
          ],
        },
        { role: 'user', content: [{ type: 'text', text: 'c' }] },
      ],
    };
    expect(lastCacheBreakpoint(r)).toEqual({ message: 1, block: 0 });
  });

  it('reports no breakpoint when nothing is cached', () => {
    expect(
      lastCacheBreakpoint({
        messages: [{ role: 'user', content: [{ text: 'a' }] }],
      })
    ).toBeNull();
  });

  it('treats everything as fresh when there is no frontier', () => {
    expect(isAfter({ message: 0, block: 0 }, null)).toBe(true);
  });

  it('orders positions by message then block', () => {
    const f = { message: 1, block: 2 };
    expect(isAfter({ message: 1, block: 3 }, f)).toBe(true);
    expect(isAfter({ message: 1, block: 2 }, f)).toBe(false);
    expect(isAfter({ message: 2, block: 0 }, f)).toBe(true);
    expect(isAfter({ message: 0, block: 9 }, f)).toBe(false);
  });

  it('recognises a signed thinking block by signature or by type', () => {
    expect(isSigned({ signature: 'abc' })).toBe(true);
    expect(isSigned({ type: 'thinking' })).toBe(true);
    expect(isSigned({ type: 'redacted_thinking' })).toBe(true);
    expect(isSigned({ type: 'text', text: 'hello' })).toBe(false);
  });

  it('marks the whole message unsafe when any block in it is signed', () => {
    // The signature covers the message as the provider received it, so a
    // sibling block cannot be rewritten either.
    expect(
      messageIsSigned({
        content: [
          { type: 'thinking', signature: 's' },
          { type: 'text', text: 'x' },
        ],
      })
    ).toBe(true);
  });
});

describe('v1 frontier strategy', () => {
  it('rewrites the fresh block and leaves the cached prefix byte-identical', () => {
    const cached = rows(60);
    const req = request(cached, rows(60));
    const out = v1Frontier(req, { spill });

    const messages = out.request.messages ?? [];
    const prefix = Array.isArray(messages[0].content)
      ? messages[0].content[0].text
      : '';
    const fresh = Array.isArray(messages[1].content)
      ? messages[1].content[0].text
      : '';

    expect(prefix).toBe(cached);
    expect(fresh!.length).toBeLessThan(cached.length);
  });

  it('injects nothing at all -- no system message, no tool, no hash', () => {
    const req = request(rows(60), rows(60));
    const out = v1Frontier(req, {});
    expect(out.injectedChars).toBe(0);
    expect(out.request.tools).toEqual([]);
    expect(out.request.system).toBe('You are an agent.');
    expect(textOf(out.request)).not.toContain('<<ccr:');
  });

  // HeadRoom #3456.
  it('never rewrites a message carrying signed thinking blocks', () => {
    // Their issue: the signature stops matching, the provider returns 400, and
    // because the poisoned block is now in history EVERY later request fails.
    const bulk = rows(60);
    const req: ProviderRequest = {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', signature: 'sig-abc', text: 'reasoning' },
            { type: 'text', text: bulk },
          ],
        },
      ],
    };
    const out = v1Frontier(req, {});
    const content = out.request.messages?.[0].content;
    expect(Array.isArray(content) ? content[1].text : '').toBe(bulk);
  });
});

describe('ccr control arm', () => {
  it('charges itself for the preamble it injects', () => {
    // Their published reduction figures appear not to include this, and the
    // user is billed for it.
    const out = ccrStyle(request(rows(60), rows(60)), { spill });
    expect(out.injectedChars).toBeGreaterThan(0);
    expect(JSON.stringify(out.request.tools)).toContain('headroom_retrieve');
    expect(String(out.request.system)).toContain(
      'Compressed Context Available'
    );
  });

  it('emits opaque markers, which is the design being compared against', () => {
    const out = ccrStyle(request(rows(60), rows(60)), { spill });
    expect(textOf(out.request)).toContain('<<ccr:');
  });

  it('respects signed messages too, so the comparison is fair', () => {
    // The control must not be handicapped by a bug we chose not to give it.
    const bulk = rows(60);
    const req: ProviderRequest = {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', signature: 's' },
            { type: 'text', text: bulk },
          ],
        },
      ],
    };
    const content = ccrStyle(req, {}).request.messages?.[0].content;
    expect(Array.isArray(content) ? content[1].text : '').toBe(bulk);
  });
});

describe('router', () => {
  it('classifies each content type, and checks diff before code', () => {
    expect(classify('{"a":1}')).toBe('json');
    expect(
      classify(
        'src/a.ts:1: x\nsrc/a.ts:2: y\nsrc/a.ts:3: z\nsrc/a.ts:4: w\nsrc/a.ts:5: v\nsrc/a.ts:6: u'
      )
    ).toBe('search');
    expect(classify('diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b')).toBe('unknown');
  });

  it('never returns output larger than its input', () => {
    // "Compression increasing prompt size" is a defect their own changelog
    // records fixing elsewhere, and it is trivially preventable by measuring.
    for (const sample of ['{}', '[]', 'a', '{"a":null}', 'x'.repeat(50)]) {
      expect(compressBlock(sample).text.length).toBeLessThanOrEqual(
        sample.length
      );
    }
  });

  // HeadRoom #3486.
  it('does not cross-contaminate between concurrent calls', async () => {
    // Their issue: one shared ContentRouter keeps per-request state on `self`,
    // so request A's options decide how request B's content is compressed. The
    // engines here are pure functions, so the same content with different
    // options must give the same answer regardless of interleaving.
    const payload = rows(60);

    const withSpill = () => {
      const seen: string[] = [];
      return compressBlock(payload, {
        spill: (c) => {
          seen.push(c);
          return `/spill/${seen.length}.json`;
        },
      });
    };
    const withoutSpill = () => compressBlock(payload, {});

    const serialA = withSpill().text;
    const serialB = withoutSpill().text;

    const interleaved = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        Promise.resolve().then(() =>
          i % 2 ? withoutSpill().text : withSpill().text
        )
      )
    );

    for (const [i, text] of interleaved.entries()) {
      expect(text).toBe(i % 2 ? serialB : serialA);
    }
  });
});

describe('every strategy', () => {
  it('is registered and returns a well-formed request', () => {
    const req = request(rows(60), rows(60));
    for (const [name, run] of Object.entries(STRATEGIES)) {
      const out = run(req, { spill });
      expect(Array.isArray(out.request.messages)).toBe(true);
      expect(out.request.messages).toHaveLength(2);
      expect(typeof out.injectedChars).toBe('number');
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it('leaves the original request object untouched', () => {
    // The proxy will hold the original for a retry; mutating it in place would
    // corrupt that.
    const req = request(rows(60), rows(60));
    const before = JSON.stringify(req);
    for (const run of Object.values(STRATEGIES)) run(req, { spill });
    expect(JSON.stringify(req)).toBe(before);
  });
});

describe('a tool result is compressed like any other content', () => {
  // THE DEFECT THIS PINS MADE THE WHOLE PRODUCT INERT ON REAL TRAFFIC.
  //
  // `mapBlocks` keyed on `block.text`. A tool_result has no `text` -- the file
  // that was read, the command output, the search hits all sit under `content`,
  // either as a plain string or as nested text blocks -- so every one was
  // returned untouched. A coding agent's conversation is overwhelmingly tool
  // results, which is precisely the content this engine exists to compress.
  //
  // Measured through the rig on 23 real requests before the fix: 2.79 MB of
  // traffic, largest request 128 KB, and 23 of 23 reported "compression did not
  // pay" having removed 0 bytes.
  const NEWLINE = String.fromCharCode(10);
  const payload = Array.from(
    { length: 120 },
    (_, i) =>
      `export function helper${i}(input: number): number {` +
      NEWLINE +
      `  const doubled = input * 2;` +
      NEWLINE +
      `  const shifted = doubled + ${i};` +
      NEWLINE +
      `  return shifted;` +
      NEWLINE +
      `}`
  ).join(NEWLINE);

  const ask = {
    role: 'user',
    content: [{ type: 'text', text: 'read the helpers file' }],
  };
  const call = {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'tu_1',
        name: 'Read',
        input: { file_path: 'h.ts' },
      },
    ],
  };

  const shrink = (request: ProviderRequest): number => {
    const before = JSON.stringify(request).length;
    const out = v1Frontier(request, { spill: () => '/spill/x.txt' });
    return before - JSON.stringify(out.request).length;
  };

  it('compresses a tool result whose content is an array of blocks', () => {
    const removed = shrink({
      messages: [
        ask,
        call,
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_1',
              content: [{ type: 'text', text: payload }],
            },
          ],
        },
      ],
    } as unknown as ProviderRequest);

    expect(removed).toBeGreaterThan(1000);
  });

  it('compresses a tool result whose content is a plain string', () => {
    // The API accepts both shapes and clients use both, so a fix for one that
    // missed the other would leave the defect live for half of real traffic.
    const removed = shrink({
      messages: [
        ask,
        call,
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu_1', content: payload },
          ],
        },
      ],
    } as unknown as ProviderRequest);

    expect(removed).toBeGreaterThan(1000);
  });

  it('leaves a tool_use input alone', () => {
    // A tool_use block also carries structured fields, and it must NOT be
    // rewritten: its input is an argument the model chose, not output to be
    // summarised. Rewriting it would change what the tool is asked to do.
    const request = {
      messages: [
        ask,
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu_1',
              name: 'Write',
              input: { file_path: 'h.ts', contents: payload },
            },
          ],
        },
      ],
    } as unknown as ProviderRequest;

    const out = v1Frontier(request, { spill: () => '/spill/x.txt' });
    const sent = JSON.stringify(out.request);

    // The argument survives intact, character for character.
    expect(sent).toContain('helper119');
    expect(sent).toContain('helper0');
  });
});
