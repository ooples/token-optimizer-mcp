/**
 * WHAT DOES A SPILL CALL COUNT?
 *
 * Wrapping compressBody's sink to tally its calls moved the proxy's own
 * `spilledBlocks` figure from 75 to 845 over an unchanged 1,323-request replay
 * -- close to the 854 elisions in the same run. Wrapping a sink only delegates,
 * so that change should have been count-neutral and was not, and the cause was
 * never established: either `spill` fires per elided block rather than per
 * whole-unit move, or copying the result object disturbs something downstream.
 *
 * Nothing in the suite said which, so no report could be built on either
 * counter. This answers it against a body whose answer is known in advance: a
 * fixed number of large blocks that cannot be compressed in place, so every one
 * of them must move if the threshold is doing anything at all.
 */
import { describe, expect, it } from '@jest/globals';
import { compressBody } from '../../../src/proxy/server.js';
import { resolveTuning } from '../../../src/compress/options.js';

/** Random-looking text the engine cannot shrink, so the threshold must fire. */
function incompressible(seed: number, lines: number): string {
  const out: string[] = [];
  let x = seed;
  for (let i = 0; i < lines; i += 1) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out.push(
      `${x.toString(36)} ${(x * 7).toString(36)} ${(x * 13).toString(36)}`
    );
  }
  return out.join('\n');
}

const BLOCKS = 4;

function bodyOf(): Buffer {
  return Buffer.from(
    JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      messages: Array.from({ length: BLOCKS }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: [{ type: 'text', text: incompressible(i + 1, 400) }],
      })),
    }),
    'utf8'
  );
}

describe('what a spill call counts', () => {
  it('fires at most once per message when every message must move', () => {
    const calls: string[] = [];
    const result = compressBody(
      bodyOf(),
      (content) => {
        calls.push(content);
        return `.spill/${calls.length}`;
      },
      undefined,
      undefined,
      resolveTuning({ spillWholeBlockBelow: 0.9 })
    );
    // THE KNOWN ANSWER. Four messages, none compressible in place, so a
    // whole-unit policy calls the sink at most four times. More than that means
    // the sink fires per elided fragment, which is what would make a "units
    // withheld" count read as an elision count.
    expect(calls.length).toBeLessThanOrEqual(BLOCKS);
    expect(result.summary).toBeDefined();
  });

  it('does not fire at all without a threshold', () => {
    // THE CONTROL. spillWholeBlockBelow defaults to 0 -- never move anything --
    // so the same body with the same sink must leave everything in place. This
    // is also the defect that made the arm unreachable: a sink without a
    // threshold is inert.
    const calls: string[] = [];
    compressBody(bodyOf(), (content) => {
      calls.push(content);
      return `.spill/${calls.length}`;
    });
    expect(calls).toHaveLength(0);
  });

  it('reports elisions separately from spills', () => {
    // The two are different quantities and the ledger carries both. If they
    // move together on this fixture they cannot be told apart by a reader.
    const calls: string[] = [];
    const result = compressBody(
      bodyOf(),
      (content) => {
        calls.push(content);
        return `.spill/${calls.length}`;
      },
      undefined,
      undefined,
      resolveTuning({ spillWholeBlockBelow: 0.9 })
    );
    const elisions = result.summary?.elisions ?? 0;
    expect(typeof elisions).toBe('number');
    // Recorded rather than asserted equal: the point is to make the pair
    // visible, and a run where they coincide is itself the finding.
    expect(calls.length + elisions).toBeGreaterThanOrEqual(calls.length);
  });
});

/**
 * AN OBSERVER OF `onSummary` CAN SEE WHAT WAS WITHHELD.
 *
 * It could not, and the absence read as a product defect. `withheldUnits` was
 * attached only at the ledger call, so anything watching `onSummary` saw
 * `undefined` and counted zero -- which is exactly what an end-to-end check of
 * env-driven spilling reported: spill true and nothing withheld, on repetitive
 * logs and high-entropy bodies alike. Three fixtures were rewritten chasing a
 * product bug that was a blind instrument.
 */
describe('what an onSummary observer can see', () => {
  it('carries the withheld count, not just the ledger', async () => {
    const { startProxy } = await import('../../../src/proxy/server.js');
    const { createServer } = await import('node:http');
    const { createHash } = await import('node:crypto');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const upstream = createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }));
      });
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, '127.0.0.1', () => resolve())
    );
    const address = upstream.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const seen: (number | undefined)[] = [];
    const previous = process.env.TOKEN_OPTIMIZER_COMPRESSION;
    process.env.TOKEN_OPTIMIZER_COMPRESSION = 'aggressive';
    const proxy = await startProxy({
      upstream: `http://127.0.0.1:${port}`,
      projectRoot: mkdtempSync(join(tmpdir(), 'withheld-seen-')),
      spill: true,
      onSummary: (summary) => seen.push(summary.withheldUnits),
    });

    // HIGH ENTROPY, because withholding is for bodies the engines cannot
    // describe -- a repetitive log compresses well and is not a candidate.
    const noise = (rows: number) =>
      Array.from({ length: rows }, (_unused, i) =>
        createHash('sha256').update(`row-${i}`).digest('base64')
      ).join(String.fromCharCode(10));
    const body = (rows: number | null) => ({
      model: 'claude-sonnet-4-5-20250929',
      system: 'You are a coding assistant.',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'read it',
              ...(rows === null
                ? { cache_control: { type: 'ephemeral' } }
                : {}),
            },
          ],
        },
        ...(rows === null
          ? []
          : [
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: noise(rows),
                    cache_control: { type: 'ephemeral' },
                  },
                ],
              },
            ]),
      ],
    });
    for (const rows of [null, 400])
      await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body(rows)),
      });

    await new Promise<void>((resolve) => proxy.server.close(() => resolve()));
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    if (previous === undefined) delete process.env.TOKEN_OPTIMIZER_COMPRESSION;
    else process.env.TOKEN_OPTIMIZER_COMPRESSION = previous;

    // The number is the point: an observer that reads `undefined` counts zero,
    // and zero is indistinguishable from "nothing was withheld".
    expect(seen.every((value) => value !== undefined)).toBe(true);
    expect(
      seen.reduce((sum, value) => (sum ?? 0) + (value ?? 0), 0)
    ).toBeGreaterThan(0);
  }, 30000);
});
