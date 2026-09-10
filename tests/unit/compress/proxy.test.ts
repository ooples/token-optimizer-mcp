import { describe, it, expect, afterEach } from '@jest/globals';
import { createServer, request as httpRequest, type Server } from 'node:http';
import {
  compressBody,
  proxyEnabled,
  startProxy,
  upstreamIsSafe,
  requestPath,
} from '../../../src/proxy/server.js';

/**
 * The proxy, against a real upstream rather than a mock.
 *
 * The request that goes on the wire is the thing under test, so these run a
 * stand-in HTTP server and assert what it actually received -- the same
 * standard the harvest dialect tests are held to. A mock would let the proxy
 * pass while sending something the provider would reject.
 */

const rows = (n: number) =>
  JSON.stringify(
    Array.from({ length: n }, (_, i) => ({
      id: `doc_${i}`,
      score: 0.5,
      title:
        'A reasonably long result title so the payload has some bulk to it',
      metadata: { author: 'Someone', category: 'technical' },
    }))
  );

const bodyOf = (messages: unknown) =>
  Buffer.from(JSON.stringify({ messages }), 'utf8');
/**
 * A sink that works, and one that does not.
 *
 * The proxy's real sink returns an empty string when the write fails, and an
 * empty string is not a path. Both cases are exercised: with a home for the
 * content the engines elide, without one they must keep it.
 */
let spilled: string[] = [];
const spill = (content: string, hint: string): string => {
  spilled.push(content);
  return `/spill/${spilled.length}-${hint}`;
};
const noSpill = () => '';

let servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.map((s) => new Promise<void>((r) => s.close(() => r())))
  );
  servers = [];
  spilled = [];
});

/** A stand-in provider that records what it was sent. */
function upstream(
  handler?: (body: string) => {
    status?: number;
    headers?: Record<string, string>;
    body?: string;
  }
) {
  const seen: {
    body?: string;
    headers?: Record<string, unknown>;
    url?: string;
  } = {};
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.body = raw;
      seen.headers = req.headers;
      seen.url = req.url;
      const reply = handler?.(raw) ?? {};
      res.writeHead(reply.status ?? 200, {
        'content-type': 'application/json',
        ...(reply.headers ?? {}),
      });
      res.end(reply.body ?? '{"ok":true}');
    });
  });
  servers.push(server);
  return new Promise<{ url: string; seen: typeof seen }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, seen });
    });
  });
}

describe('proxyEnabled', () => {
  it('is off unless explicitly asked for', () => {
    expect(proxyEnabled({})).toBe(false);
    expect(proxyEnabled({ TOKEN_OPTIMIZER_PROXY: '1' })).toBe(true);
    expect(proxyEnabled({ TOKEN_OPTIMIZER_PROXY: 'true' })).toBe(true);
  });

  it('yields to the kill switch even when asked for', () => {
    expect(
      proxyEnabled({ TOKEN_OPTIMIZER_PROXY: '1', TOKEN_OPTIMIZER_MODE: 'off' })
    ).toBe(false);
  });
});

describe('compressBody', () => {
  it('compresses a large provider request', () => {
    const body = bodyOf([
      { role: 'user', content: [{ type: 'text', text: rows(80) }] },
    ]);
    const out = compressBody(body, spill);
    expect(out.summary.compressed).toBe(true);
    expect(out.body.length).toBeLessThan(body.length);
  });

  it('keeps rows it has nowhere to spill, and still minifies', () => {
    // A failed sink is reported as an empty string. Eliding against it would
    // leave a marker naming a row count and offering no way back -- the
    // dangling reference this whole design exists to avoid. The rows survive,
    // and the lossless half of the work is still done.
    const payload = rows(80);
    const body = bodyOf([
      { role: 'user', content: [{ type: 'text', text: payload }] },
    ]);
    const out = compressBody(body, noSpill);
    const sent = JSON.parse(out.body.toString('utf8'));
    expect(sent.messages[0].content[0].text).toBe(payload);
  });

  // FAIL OPEN, every branch.
  it('forwards a body that is not JSON untouched', () => {
    const body = Buffer.from('x'.repeat(9000), 'utf8');
    const out = compressBody(body, noSpill);
    expect(out.body).toBe(body);
    expect(out.summary.reason).toBe('body is not JSON');
  });

  it('forwards JSON with no messages array untouched', () => {
    const body = Buffer.from(
      JSON.stringify({ prompt: 'x'.repeat(9000) }),
      'utf8'
    );
    expect(compressBody(body, noSpill).summary.reason).toBe(
      'no messages array'
    );
  });

  it('leaves a small body alone', () => {
    const body = bodyOf([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ]);
    expect(compressBody(body, noSpill).summary.reason).toBe(
      'below the size floor'
    );
  });

  it('never sends more than it was given', () => {
    // Incompressible bulk: the result must be the original, not a larger
    // rewrite. "Compression increasing prompt size" is a real defect class.
    const noise = Array.from({ length: 9000 }, (_, i) =>
      String.fromCharCode(33 + (i % 90))
    ).join('');
    const body = bodyOf([
      { role: 'user', content: [{ type: 'text', text: noise }] },
    ]);
    const out = compressBody(body, noSpill);
    expect(out.body.length).toBeLessThanOrEqual(body.length);
  });

  it('does not touch content at or before the cache breakpoint', () => {
    const cached = rows(80);
    const body = bodyOf([
      {
        role: 'user',
        content: [
          { type: 'text', text: cached, cache_control: { type: 'ephemeral' } },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: rows(80) }] },
    ]);
    const out = compressBody(body, spill);
    const sent = JSON.parse(out.body.toString('utf8'));
    expect(sent.messages[0].content[0].text).toBe(cached);
    expect(sent.messages[1].content[0].text.length).toBeLessThan(cached.length);
  });
});

describe('the proxy on the wire', () => {
  it('forwards the compressed body and returns the upstream response', async () => {
    const { url, seen } = await upstream();
    const { server, port } = await startProxy({ upstream: url });
    servers.push(server);

    const payload = JSON.stringify({
      messages: [{ role: 'user', content: [{ type: 'text', text: rows(80) }] }],
    });
    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'sk-test-secret',
      },
      body: payload,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(seen.url).toBe('/v1/messages');
    expect(seen.body!.length).toBeLessThan(payload.length);
  });

  it('forwards credentials verbatim, without storing them', async () => {
    const { url, seen } = await upstream();
    const { server, port } = await startProxy({ upstream: url });
    servers.push(server);

    await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'sk-test-secret',
      },
      body: JSON.stringify({
        messages: [
          { role: 'user', content: [{ type: 'text', text: rows(80) }] },
        ],
      }),
    });

    expect(seen.headers!['x-api-key']).toBe('sk-test-secret');
  });

  // HeadRoom #3463.
  it('preserves response headers, including Location', async () => {
    // Their issue is a proxy losing Location on the way back. Headers are
    // copied rather than reconstructed for exactly this reason.
    const { url } = await upstream(() => ({
      status: 302,
      headers: { location: 'https://example.test/moved', 'x-trace': 'abc123' },
    }));
    const { server, port } = await startProxy({ upstream: url });
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      }),
      redirect: 'manual',
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://example.test/moved');
    expect(response.headers.get('x-trace')).toBe('abc123');
  });

  it('reports an upstream failure instead of hanging', async () => {
    const { server, port } = await startProxy({
      upstream: 'http://127.0.0.1:1',
    });
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    });
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('upstream request failed');
  });

  it('summarises sizes without ever seeing a payload', async () => {
    const { url } = await upstream();
    const summaries: unknown[] = [];
    const { server, port } = await startProxy({
      upstream: url,
      onSummary: (s) => summaries.push(s),
    });
    servers.push(server);

    await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'user', content: [{ type: 'text', text: rows(80) }] },
        ],
      }),
    });

    expect(summaries).toHaveLength(1);
    const summary = summaries[0] as Record<string, unknown>;
    expect(summary.compressed).toBe(true);
    expect(Number(summary.beforeBytes)).toBeGreaterThan(
      Number(summary.afterBytes)
    );
    // The summary carries sizes and a path, never content.
    expect(JSON.stringify(summary)).not.toContain('doc_0');
  });

  it('binds loopback only', async () => {
    const { server } = await startProxy({ upstream: 'http://127.0.0.1:1' });
    servers.push(server);
    const address = server.address();
    expect(typeof address === 'object' && address ? address.address : '').toBe(
      '127.0.0.1'
    );
  });
});

describe('the upstream a proxy will talk to', () => {
  it('refuses cleartext to anywhere but this machine', () => {
    // Every request through here carries the user's provider key in a header,
    // forwarded verbatim. An http upstream puts that key on the wire in the
    // clear, and the override that sets it is one environment variable.
    expect(upstreamIsSafe('http://api.example.com')).toBe(false);
    expect(upstreamIsSafe('http://10.0.0.5:8080')).toBe(false);
    expect(upstreamIsSafe('ftp://example.com')).toBe(false);
    expect(upstreamIsSafe('not a url')).toBe(false);
  });

  it('allows https anywhere, and http on loopback', () => {
    // Loopback has to stay allowed: the stand-in provider in this very file
    // runs on 127.0.0.1, and so does anyone debugging with a local recorder.
    expect(upstreamIsSafe('https://api.anthropic.com')).toBe(true);
    expect(upstreamIsSafe('http://127.0.0.1:8123')).toBe(true);
    expect(upstreamIsSafe('http://localhost:8123')).toBe(true);
    expect(upstreamIsSafe('http://[::1]:8123')).toBe(true);
  });

  it('refuses to start against an unsafe upstream instead of leaking quietly', async () => {
    // The one place in this file that does NOT fail open. Carrying on would
    // send credentials in cleartext, and doing that quietly is the harm.
    await expect(
      startProxy({ upstream: 'http://api.example.com' })
    ).rejects.toThrow(/refusing to forward credentials/);
  });
});

describe('hop-by-hop headers', () => {
  /**
   * Sent with `node:http`, not `fetch`.
   *
   * undici treats `Connection` and `Transfer-Encoding` as forbidden header
   * names and drops them, so a fetch-based test cannot construct the request
   * that exposes the bug -- it would pass against the broken code too. The
   * whole point here is a client that really does send chunked framing.
   */
  const sendChunked = (
    port: number,
    body: string,
    headers: Record<string, string>
  ) =>
    new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/v1/messages',
          headers: { 'content-type': 'application/json', ...headers },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve());
        }
      );
      req.on('error', reject);
      req.end(body);
    });

  it('does not forward transfer-encoding alongside its own content-length', async () => {
    // A chunked client request carries `transfer-encoding: chunked`. The body
    // is rewritten here, so content-length must be set -- and sending both is
    // two conflicting framing headers, which a strict upstream rejects.
    const { url, seen } = await upstream();
    const { server, port } = await startProxy({ upstream: url });
    servers.push(server);

    await sendChunked(
      port,
      JSON.stringify({
        messages: [
          { role: 'user', content: [{ type: 'text', text: rows(80) }] },
        ],
      }),
      {
        'transfer-encoding': 'chunked',
        connection: 'keep-alive, x-custom-hop',
        'x-custom-hop': 'should not survive',
      }
    );

    expect(seen.headers!['transfer-encoding']).toBeUndefined();
    expect(seen.headers!['content-length']).toBeDefined();
    // A header the client named in `Connection` is single-hop by its own say-so.
    expect(seen.headers!['x-custom-hop']).toBeUndefined();
  });
});

describe('the destination is ours to choose', () => {
  it('refuses a request target that names its own host', () => {
    // HTTP allows an absolute-form target, and a proxy is what that form
    // exists for -- so it arrives here legitimately shaped. `new URL(req.url,
    // upstream)` ignores the base entirely and resolves to the host in the
    // target, which would send the provider key to whoever asked.
    expect(requestPath('http://elsewhere.example/v1/messages')).toBeNull();
    expect(requestPath('https://elsewhere.example/v1/messages')).toBeNull();
    // Protocol-relative: same theft, our scheme.
    expect(requestPath('//elsewhere.example/v1/messages')).toBeNull();
    // A backslash reads as a slash to several parsers.
    expect(requestPath('/\\elsewhere.example/v1/messages')).toBeNull();
  });

  it('accepts an ordinary path and query', () => {
    expect(requestPath('/v1/messages')).toBe('/v1/messages');
    expect(requestPath('/v1/messages?beta=true')).toBe(
      '/v1/messages?beta=true'
    );
    expect(requestPath(undefined)).toBe('/');
  });

  it('sends credentials to the configured upstream and nowhere else', async () => {
    // The end-to-end version: a stand-in attacker and a stand-in provider,
    // and an absolute-form target aimed at the attacker. The key must not
    // arrive there, and the proxy must say why rather than forward it.
    const attacker = await upstream();
    const provider = await upstream();
    const { server, port } = await startProxy({ upstream: provider.url });
    servers.push(server);

    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          // Absolute form, aimed away from the configured upstream.
          path: `${attacker.url}/v1/messages`,
          headers: {
            'content-type': 'application/json',
            'x-api-key': 'sk-test-secret',
          },
        },
        (res) => {
          expect(res.statusCode).toBe(400);
          res.resume();
          res.on('end', () => resolve());
        }
      );
      req.on('error', reject);
      req.end(
        JSON.stringify({
          messages: [
            { role: 'user', content: [{ type: 'text', text: rows(80) }] },
          ],
        })
      );
    });

    expect(attacker.seen.headers).toBeUndefined();
    expect(attacker.seen.body).toBeUndefined();
  });
});
