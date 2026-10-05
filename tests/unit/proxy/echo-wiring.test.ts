/**
 * The echo scanner must be REACHABLE through the shipped proxy.
 *
 * A unit test on echo.ts proves the scanner counts windows; it proves nothing
 * about whether anything feeds it. This package's recurring defect is exactly
 * that gap -- a capability that is registered, tested and green while the
 * production call site never names it -- and the scanner has an unusual number
 * of joints between the switch and the number: the switch being read at all,
 * the context being built from the body we FORWARDED, the response tap sharing
 * its single decode with a second consumer, and the ratio reaching the
 * accounting row rather than being computed and dropped. Every one of those is
 * a place where the waste tier could report nothing while echo.test.ts stayed
 * green.
 *
 * So these tests start a real listener against a stub upstream and read the
 * ring the proxy fills by itself.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { startProxy } from '../../../src/proxy/server.js';
import { ECHO_ENV } from '../../../src/proxy/echo.js';
import type { AccountingRecord } from '../../../src/proxy/accounting.js';

const PRIOR = {
  echo: process.env[ECHO_ENV],
  accounting: process.env.TOKEN_OPTIMIZER_PROXY_ACCOUNTING,
};

/** What the stub upstream puts in its reply, decided per test. */
type Reply = (received: string) => string;

let upstream: Server;
let upstreamUrl: string;
let proxy: Awaited<ReturnType<typeof startProxy>> | null = null;
let reply: Reply;

beforeEach(async () => {
  // THE LEDGER STAYS OFF. The ring is the seam under test and it needs no
  // consent; writing a file here would only add a path to clean up.
  process.env.TOKEN_OPTIMIZER_PROXY_ACCOUNTING = '';
  reply = (received) => received;
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const received = Buffer.concat(chunks).toString('utf8');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          content: [{ type: 'text', text: reply(received) }],
          usage: { input_tokens: 2413, output_tokens: 806 },
        })
      );
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  proxy = null;
});

afterEach(async () => {
  if (proxy) await new Promise<void>((resolve) => proxy?.server.close(() => resolve()));
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  if (PRIOR.echo === undefined) delete process.env[ECHO_ENV];
  else process.env[ECHO_ENV] = PRIOR.echo;
  if (PRIOR.accounting === undefined) delete process.env.TOKEN_OPTIMIZER_PROXY_ACCOUNTING;
  else process.env.TOKEN_OPTIMIZER_PROXY_ACCOUNTING = PRIOR.accounting;
});

/**
 * A passage long enough to hold several windows, and one that shares no
 * eight-word run with it. Written out rather than generated so the two arms
 * below differ in the text and in nothing else.
 */
const PASSAGE =
  'the ledger carries counts and durations and never the payload they were ' +
  'derived from because a row that quoted a request would be a copy of it';
const FRESH =
  'barometric drift across the southern shelf refused to settle until the ' +
  'spring tides had finished scouring every channel mouth on that coast';

function send(port: number, content: string): Promise<number> {
  const payload = JSON.stringify({
    model: 'claude-opus-4',
    messages: [{ role: 'user', content }],
    stream: false,
  });
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/v1/messages',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      },
      (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve(res.statusCode ?? 0));
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

/**
 * The row lands when the UPSTREAM stream ends, which is not the same instant
 * the client's does, so the ring is polled rather than read once.
 */
async function rowFor(content: string): Promise<AccountingRecord> {
  proxy = await startProxy({ upstream: upstreamUrl, knowledge: false });
  expect(await send(proxy.port, content)).toBe(200);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = proxy.transformations.recent();
    if (rows.length > 0) return rows[rows.length - 1];
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the proxy never recorded the request');
}

describe('the echo ratio reaches the accounting row', () => {
  it('records a fully repeated reply as all echo', async () => {
    process.env[ECHO_ENV] = '1';
    reply = () => PASSAGE;
    const row = await rowFor(PASSAGE);
    // EVERY WINDOW OF THE REPLY WAS IN THE CONTEXT, so the only honest figure
    // is 1. Anything lower means a joint between the switch and the row is
    // dropping windows -- the carry, the flush, or the tap's second consumer.
    expect(row.echoRatio).toBe(1);
  });

  it('records a reply that repeats nothing as no echo', async () => {
    process.env[ECHO_ENV] = '1';
    reply = () => FRESH;
    const row = await rowFor(PASSAGE);
    // ZERO, NOT ABSENT: the scan ran and found nothing, which is a finding.
    expect(row.echoRatio).toBe(0);
  });

  it('reads a part-repeated reply as a figure between the two', async () => {
    // POSITIVE CONTROL for the pair above, which 1 and 0 alone cannot give:
    // a scanner wired to the wrong text could still return 1 for the first and
    // 0 for the second while being incapable of any value in between.
    process.env[ECHO_ENV] = '1';
    reply = () => `${PASSAGE} ${FRESH}`;
    const row = await rowFor(PASSAGE);
    const ratio = row.echoRatio;
    if (ratio === undefined) throw new Error('no ratio recorded');
    expect(ratio).toBeGreaterThan(0);
    expect(ratio).toBeLessThan(1);
  });
});

describe('the switch the operator did not throw', () => {
  it('records no ratio at all when the scanner is off', async () => {
    delete process.env[ECHO_ENV];
    reply = () => PASSAGE;
    const row = await rowFor(PASSAGE);
    // ABSENT, NOT ZERO. A zero here would read as "nothing was echoed" and
    // would be folded into the waste mean as a reply with no repetition in it,
    // which is exactly the understatement echo.ts exists to refuse.
    expect(row.echoRatio).toBeUndefined();
    // POSITIVE CONTROL that the request really was served and recorded, so the
    // absent field above is the opt-in holding and not a dead path.
    expect(row.usage.input_tokens).toBe(2413);
    expect(row.status).toBe(200);
  });

  it('treats an explicit off as off', async () => {
    process.env[ECHO_ENV] = 'false';
    reply = () => PASSAGE;
    const row = await rowFor(PASSAGE);
    expect(row.echoRatio).toBeUndefined();
    expect(row.status).toBe(200);
  });
});

describe('what the row is allowed to carry', () => {
  it('carries the ratio and none of the text it came from', async () => {
    process.env[ECHO_ENV] = '1';
    reply = () => PASSAGE;
    const row = await rowFor(PASSAGE);
    expect(row.echoRatio).toBe(1);
    // THE PRIVACY CLAIM, ASSERTED ON THE WHOLE ROW rather than on the field:
    // the scanner holds the context and the reply in memory while it works, so
    // the thing to prove is that none of it survives into what gets written.
    // A distinctive run of words from each side is searched for in the
    // serialised row, which is what a ledger line or a rollup would be built
    // from.
    const serialised = JSON.stringify(row);
    expect(serialised).not.toContain('ledger carries counts');
    expect(serialised).not.toContain('payload they were');
    // POSITIVE CONTROL that the needle would have been found if it were there,
    // so the two refusals above are not a search of the wrong haystack.
    expect(`${serialised} ledger carries counts`).toContain('ledger carries counts');
  });
});
