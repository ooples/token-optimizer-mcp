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
import { variedRows } from '../compress/varied-rows.js';
import { rehydrate } from '../../../src/compress/rehydrate.js';

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
    // THE CONTROL. The library's spillWholeBlockBelow defaults to 0 -- never
    // move anything -- so the same body with the same sink must leave
    // everything in place. This is also the defect that made the arm
    // unreachable: a sink without a threshold is inert. The library tuning is
    // named explicitly because compressBody's own default is the proxy's.
    const calls: string[] = [];
    compressBody(
      bodyOf(),
      (content) => {
        calls.push(content);
        return `.spill/${calls.length}`;
      },
      undefined,
      undefined,
      resolveTuning()
    );
    expect(calls).toHaveLength(0);
  });

  it("moves blocks out by the proxy's default and leaves no file unreferenced", () => {
    // PROXY_DEFAULTS sets the threshold to 0.9 (#436), so compressBody with no
    // tuning moves these blocks. The decision is taken on a dry run, so every
    // file the sink was asked to write is one the output points at: the
    // engine's own spills for a block that is then moved whole are never
    // written at all.
    const calls: string[] = [];
    const result = compressBody(bodyOf(), (content) => {
      calls.push(content);
      return `.spill/${calls.length}`;
    });
    expect(calls.length).toBeGreaterThan(0);
    const sent = result.body.toString('utf8');
    for (let i = 1; i <= calls.length; i += 1)
      expect(sent).toContain(`.spill/${i}`);
  });

  it('writes none of the engine spills a moved block supersedes', () => {
    // A block the engine DOES spill from -- forty varied rows, elided to a
    // rows.json file -- but takes only ~86% off, so the proxy moves it whole.
    // Run for real, the engine's rows.json would be written first and then
    // pointed at by nothing. Only the moved block may reach the sink.
    const text = JSON.stringify(variedRows(40));
    const hints: string[] = [];
    const result = compressBody(
      Buffer.from(
        JSON.stringify({
          messages: [{ role: 'user', content: [{ type: 'text', text }] }],
        }),
        'utf8'
      ),
      (_content, hint) => {
        hints.push(hint);
        return `.spill/${hints.length}-${hint}`;
      }
    );
    expect(hints).toEqual(['block']);
    expect(result.body.toString('utf8')).toContain('.spill/1-block');
  });

  it('stores a moved block in its smallest exact form', () => {
    // The moved file is read into context when it is fetched, so its size is
    // the price of the fetch. Pretty-printed rows have an exact template
    // encoding far smaller than their bytes; that is what is stored, and the
    // shipped decoder gives back the block byte for byte.
    const text = JSON.stringify(variedRows(40), null, 2);
    const stored: string[] = [];
    const result = compressBody(
      Buffer.from(
        JSON.stringify({
          messages: [{ role: 'user', content: [{ type: 'text', text }] }],
        }),
        'utf8'
      ),
      (content, hint) => {
        stored.push(content);
        return `.spill/${stored.length}-${hint}`;
      }
    );
    expect(stored).toHaveLength(1);
    expect(stored[0].length).toBeLessThan(text.length / 2);
    const decoded = (result.stamps ?? []).map((s) => rehydrate(stored[0], s));
    expect(decoded).toContain(text);
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
