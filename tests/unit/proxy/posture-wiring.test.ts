/**
 * A POSTURE MUST REACH THE PROXY, NOT JUST THE ENVIRONMENT OBJECT.
 *
 * posture.test.ts proves `applyPosture` seeds variables and that shipped readers
 * honour them. That is one joint short of the claim. The claim is that naming a
 * posture changes what leaves the proxy, and between the two there is an ORDERING
 * that nothing in a unit test can see: every dial in server.ts reads `process.env`
 * for itself, so a seed written after its reader ran would be a posture that
 * reported five features and changed nothing.
 *
 * Which is this package's recurring defect in the shape it keeps coming back in:
 * registered, green, and never reached. So this test starts a real listener, sends
 * a real request through it, and counts markers on the body the UPSTREAM received
 * -- the only observation that cannot be satisfied by anything but the whole path.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { startProxy } from '../../../src/proxy/server.js';
import {
  COMPRESSION_ENV,
  POSTURE_ENV,
  PostureName,
} from '../../../src/proxy/posture.js';

const WATCHED = [
  POSTURE_ENV,
  COMPRESSION_ENV,
  'TOKEN_OPTIMIZER_PROXY_KEEP_TOOLS',
  'TOKEN_OPTIMIZER_PROXY_SMALL_TOOL_CHARS',
  'TOKEN_OPTIMIZER_FEATURES',
  'TOKEN_OPTIMIZER_PROXY_ACCOUNTING',
] as const;

const PRIOR = new Map<string, string | undefined>();

let upstream: Server;
let upstreamUrl: string;
let received: Record<string, unknown> | null;
let proxy: Awaited<ReturnType<typeof startProxy>> | null = null;

/** Thirty verbose definitions, so deferral has something to choose among. */
function body(): string {
  return JSON.stringify({
    model: 'claude-sonnet-4',
    system: 'You are a coding agent.',
    messages: [
      {
        role: 'user',
        content: [{ type: 'tool_result', content: 'x'.repeat(40_000) }],
      },
    ],
    tools: Array.from({ length: 30 }, (_, i) => ({
      name: `tool_${i}`,
      description: `Does thing number ${i}. ${'detail '.repeat(120)}`,
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'detail '.repeat(60) },
          flag: { type: 'boolean', description: 'detail '.repeat(60) },
        },
        required: ['path'],
      },
    })),
  });
}

/** How many definitions the upstream was asked to defer. */
function marked(): number {
  const tools = received?.tools;
  if (!Array.isArray(tools)) return -1;
  return tools.filter(
    (tool) => (tool as { defer_loading?: unknown }).defer_loading === true
  ).length;
}

async function send(): Promise<void> {
  const port = proxy?.port ?? 0;
  await new Promise<void>((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      (res) => {
        res.resume();
        res.on('end', resolve);
      }
    );
    req.on('error', reject);
    req.end(body());
  });
}

beforeEach(async () => {
  for (const name of WATCHED) PRIOR.set(name, process.env[name]);
  // A CLEAN SLATE, NOT THE RUNNER'S. A variable inherited from the shell would
  // be respected by setdefault, and the test would then measure the shell.
  for (const name of WATCHED) delete process.env[name];
  process.env.TOKEN_OPTIMIZER_PROXY_ACCOUNTING = '';
  received = null;
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
        string,
        unknown
      >;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 2413, output_tokens: 806 },
        })
      );
    });
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, '127.0.0.1', resolve)
  );
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  proxy = null;
});

afterEach(async () => {
  if (proxy)
    await new Promise<void>((resolve) => proxy?.server.close(() => resolve()));
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  for (const name of WATCHED) {
    const prior = PRIOR.get(name);
    if (prior === undefined) delete process.env[name];
    else process.env[name] = prior;
  }
});

describe('a posture reaches the wire', () => {
  it('defers every definition under lean, and fewer without it', async () => {
    proxy = await startProxy({ upstream: upstreamUrl });
    await send();
    const byDefault = marked();
    // THE CONTROL ARM, AND IT HAS TO BE A REAL ONE. Deferral is on by default, so
    // an unconfigured proxy already marks most definitions; the claim is that the
    // posture moves the number, which needs the number it moved FROM.
    expect(byDefault).toBeGreaterThan(0);
    expect(byDefault).toBeLessThan(30);
    await new Promise<void>((resolve) =>
      proxy?.server.close(() => {
        proxy = null;
        resolve();
      })
    );

    received = null;
    proxy = await startProxy({
      upstream: upstreamUrl,
      posture: PostureName.Lean,
    });
    await send();
    expect(marked()).toBe(30);
    expect(marked()).toBeGreaterThan(byDefault);
  }, 20_000);

  it('reports the posture it applied, for the banner to disclose', async () => {
    process.env[POSTURE_ENV] = PostureName.Lean;
    proxy = await startProxy({ upstream: upstreamUrl });
    expect(proxy.posture?.posture?.name).toBe(PostureName.Lean);
    expect(proxy.posture?.seeded).toContain(COMPRESSION_ENV);
    // Seeded into the REAL environment, which is what makes every other reader
    // in the process -- the inspector, the doctor -- report the same truth.
    expect(process.env[COMPRESSION_ENV]).toBe('aggressive');
  }, 20_000);

  it('reports nothing when no posture was named', async () => {
    proxy = await startProxy({ upstream: upstreamUrl });
    expect(proxy.posture).toBeNull();
    // The control: the field is populated when there IS one, so null above is an
    // absent posture and not a field that is always null.
    const second = await startProxy({
      upstream: upstreamUrl,
      posture: PostureName.Audit,
    });
    expect(second.posture?.posture?.name).toBe(PostureName.Audit);
    // CLOSED HERE, not left to afterEach, which only knows about one proxy. A
    // listener left open holds the runner's event loop and the suite hangs.
    await new Promise<void>((resolve) => second.server.close(() => resolve()));
  }, 20_000);
});
