import { describe, it, expect } from '@jest/globals';
// @ts-expect-error -- the fixture builder is plain ESM, deliberately: it is
// bench infrastructure and is loaded by the benchmark harness as well as here.
import {
  wireShapeRequest,
  composition,
  numbered,
  PRODUCTION_SHAPE,
} from '../../../bench/compression/wire-shape.mjs';
import { v1Frontier } from '../../../src/compress/strategy.js';
import { anchorStore } from '../../../src/compress/anchor.js';
import { classify, engineNameFor } from '../../../src/compress/router.js';
import type { ProviderRequest } from '../../../src/compress/frontier.js';

/**
 * The ratchet against a green gate that means nothing.
 *
 * This package's compressor removed 0 bytes from every real Claude Code request
 * for the whole life of two paid benchmark campaigns, while its fixture suite
 * passed on every workload. The fixtures were the reason: zero `tool_result`
 * blocks, `tools: []` on every request, and no line-numbered read anywhere --
 * so none of the three defects that produced the inertness could be expressed,
 * let alone caught.
 *
 * These tests assert the two things that failure needed and did not have: that
 * the corpus still looks like the wire, and that compression still actually
 * removes bytes from it.
 */

const ROOT = new URL('../../../', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1'
);

const fixture = (): ProviderRequest =>
  wireShapeRequest({
    root: ROOT,
    // This repository's own source, so the code engine meets real code.
    readFiles: ['src/compress/log.ts', 'src/compress/json.ts'],
  }) as ProviderRequest;

describe('the fixture still looks like the wire', () => {
  it('is dominated by tool definitions, as a real request is', () => {
    // Measured on the wire: tools 56% of a 265,036-byte request, the
    // conversation 40%, the system prompt under 4%. A corpus built with
    // `tools: []` -- which is what fixtures.mjs does -- cannot represent the
    // request at all, and every percentage taken against it is a percentage of
    // the smallest term.
    const parts = composition(fixture());
    const share = (n: number): number => n / parts.total;

    expect(share(parts.tools)).toBeGreaterThan(0.4);
    expect(share(parts.messages)).toBeGreaterThan(0.2);
    expect(
      Math.abs(share(parts.tools) - PRODUCTION_SHAPE.shares.tools)
    ).toBeLessThan(0.2);
  });

  it('carries tool results linked to the calls that produced them', () => {
    // The link is load-bearing, not decorative: compressCode resolves its
    // language from a path, a tool_result has none, and the only place the path
    // exists is the matching tool_use in the same request. Without this pairing
    // the engine returns its input untouched and reports 0.0%.
    const request = fixture();
    const ids = new Set<string>();
    const results: { tool_use_id?: string }[] = [];

    for (const message of request.messages ?? []) {
      const content = (message as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const raw of content) {
        const block = raw as {
          type?: string;
          id?: string;
          input?: { file_path?: string };
          tool_use_id?: string;
        };
        if (block.type === 'tool_use') {
          expect(typeof block.input?.file_path).toBe('string');
          if (block.id) ids.add(block.id);
        }
        if (block.type === 'tool_result') results.push(block);
      }
    }

    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(ids.has(result.tool_use_id ?? '')).toBe(true);
    }
  });

  it('delivers reads line-numbered, which is what defeats the detectors', () => {
    // As sent, a numbered read classifies as `unknown` with no engine selected;
    // stripped of the prefix the same bytes classify as `code`. A fixture
    // carrying raw file content instead would never exercise that path.
    const source =
      'const a = 1;\nconst b = 2;\nconst c = 3;\nexport { a, b, c };';
    const asSent = numbered(source);

    expect(asSent.startsWith(`1${String.fromCharCode(9)}`)).toBe(true);
    expect(classify(asSent)).toBe('unknown');
    expect(engineNameFor(asSent)).toBeNull();
  });

  it('puts cache_control on the last message only, as the client does', () => {
    // Which is why "compress only after the frontier" finds nothing: there is
    // never anything after it.
    const request = fixture();
    const messages = request.messages ?? [];
    const marked: number[] = [];

    messages.forEach((message, i) => {
      if (JSON.stringify(message).includes('cache_control')) marked.push(i);
    });

    expect(marked).toEqual([messages.length - 1]);
  });
});

/** The payload text of a message, ignoring markers the client moves itself. */
const payloadOf = (message: unknown): string => {
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (
    content
      .map((raw) => {
        const block = raw as {
          type?: string;
          text?: string;
          content?: unknown;
        };
        if (typeof block.text === 'string') return block.text;
        if (block.type === 'tool_result') {
          if (typeof block.content === 'string') return block.content;
          if (Array.isArray(block.content))
            return block.content
              .map((x) => (x as { text?: string })?.text ?? '')
              .join('');
        }
        return JSON.stringify(block);
      })
      // Built rather than written as an escape. A literal control character in
      // source is exactly what `no-stray-control-characters` exists to catch,
      // and a heredoc collapsing the escape into one real byte is how one got
      // here.
      .join(String.fromCharCode(0))
  );
};

describe('the compressed prefix is reproducible turn over turn', () => {
  it('sends every earlier message byte-identically as the session grows', () => {
    // THE PROPERTY THE WHOLE CACHE ARGUMENT RESTS ON. Compression is only worth
    // anything because the provider re-reads the prefix at 0.1x; if our output
    // for a message changes between turns the provider misses instead, and the
    // saving inverts into a 1.25x rewrite of everything from that point on.
    //
    // It has been broken twice. The floor used to be the client's cache marker,
    // which advances every turn, so a span compressed on turn N fell below the
    // floor on turn N+1 and was sent uncompressed; and the already-anchored path
    // re-derived the whole history, touching content the provider held in a form
    // we had chosen. Both are silent -- the compressor reports a healthy saving
    // either way, and only the next turn's bill knows.
    //
    // COMPARED ON PAYLOAD TEXT, NOT WHOLE MESSAGES, and that distinction cost a
    // wrongly-retracted finding: the client relocates its own cache_control
    // marker every turn, so nineteen of twenty apparent instabilities in one
    // measurement were the client's doing and not ours.
    const anchors = anchorStore();
    const files = [
      'src/compress/log.ts',
      'src/compress/json.ts',
      'src/compress/prose.ts',
      'src/compress/dedup.ts',
      'src/compress/code.ts',
    ];
    let previousOurs: string[] | null = null;
    let previousTheirs: string[] | null = null;
    let ourChanges = 0;
    let compared = 0;

    for (let i = 1; i <= files.length; i += 1) {
      const request = wireShapeRequest({
        root: ROOT,
        readFiles: files.slice(0, i),
      }) as ProviderRequest;
      const out = v1Frontier(request, { anchors });
      if (out.anchor) anchors.remember(out.anchor.key, out.anchor.record);

      const ours = (out.request.messages ?? []).map(payloadOf);
      const theirs = (request.messages ?? []).map(payloadOf);
      if (previousOurs && previousTheirs) {
        for (let k = 0; k < previousOurs.length; k += 1) {
          compared += 1;
          // Only our own changes count; a message the CLIENT rewrote would have
          // missed the cache whatever we did.
          if (theirs[k] === previousTheirs[k] && ours[k] !== previousOurs[k])
            ourChanges += 1;
        }
      }
      previousOurs = ours;
      previousTheirs = theirs;
    }

    expect(compared).toBeGreaterThan(0);
    expect(ourChanges).toBe(0);
  });
});

describe('compression is not inert on a wire-shaped request', () => {
  it('removes bytes on a continuing conversation', () => {
    // THE RATCHET. Every defect this suite exists for produced exactly one
    // symptom -- zero bytes removed -- and nothing in the old corpus could see
    // it. A first turn legitimately removes nothing, because a first request
    // carries instructions and the tool schema and no tool_result at all, so
    // the assertion is made on the SECOND turn, where the conversation has
    // grown and the provider has not yet cached what it grew by.
    const anchors = anchorStore();
    const first = fixture();
    const firstOut = v1Frontier(first, { anchors });
    if (firstOut.anchor)
      anchors.remember(firstOut.anchor.key, firstOut.anchor.record);

    const second = wireShapeRequest({
      root: ROOT,
      readFiles: [
        'src/compress/log.ts',
        'src/compress/json.ts',
        'src/compress/prose.ts',
      ],
    }) as ProviderRequest;
    const before = JSON.stringify(second).length;
    const out = v1Frontier(second, { anchors });
    const removed = before - JSON.stringify(out.request).length;

    expect(removed).toBeGreaterThan(0);
    expect(out.elisions.length).toBeGreaterThan(0);
  });

  it('leaves the line numbers on the lines it keeps', () => {
    // The numbers are what the model uses to address an edit, so a compressor
    // that stripped them would trade a token saving for a broken edit.
    const anchors = anchorStore();
    const first = fixture();
    const firstOut = v1Frontier(first, { anchors });
    if (firstOut.anchor)
      anchors.remember(firstOut.anchor.key, firstOut.anchor.record);

    const second = wireShapeRequest({
      root: ROOT,
      readFiles: [
        'src/compress/log.ts',
        'src/compress/json.ts',
        'src/compress/prose.ts',
      ],
    }) as ProviderRequest;
    const before = JSON.stringify(second).length;
    const out = v1Frontier(second, { anchors });

    // DISCRIMINATING, which the first version of this was not: asserting that a
    // numbered line exists passes just as well on a compressor that changed
    // nothing, because the input was numbered to begin with. The assertion has
    // to be that bytes went AND numbers stayed.
    expect(JSON.stringify(out.request).length).toBeLessThan(before);

    const text = JSON.stringify(out.request);
    expect(/\\n\d+\\t/.test(text)).toBe(true);
  });
});
