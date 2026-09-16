/** Actual shipped proxies, hostile small/opaque/append-only payloads and concurrent requests. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { adversarialFixture } from './adversarial-cases.mjs';

const raw = await mkdtemp(join(tmpdir(), 'adversarial-local-'));
const records = [];
const upstream = createServer((req, res) => {
  if (req.method !== 'POST') {
    res.end('{}');
    return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({ bytes: body.length, forwarded: JSON.parse(body) })
    );
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${upstream.address().port}`;
async function port() {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const p = server.address().port;
  await new Promise((r) => server.close(r));
  return p;
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const done = new Promise((r) => child.once('close', r));
  if (process.platform === 'win32')
    execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
  else child.kill('SIGTERM');
  await done;
}
let child,
  error = null;
try {
  for (let round = 0; round < 2; round++) {
    for (const arm of round ? ['headroom', 'proxy'] : ['proxy', 'headroom']) {
      const p = await port();
      const out = openSync(join(raw, `${round}-${arm}.stdout`), 'w');
      const err = openSync(join(raw, `${round}-${arm}.stderr`), 'w');
      const env = { ...process.env };
      for (const key of Object.keys(env))
        if (key.startsWith('TOKEN_OPTIMIZER_PROXY')) delete env[key];
      env.TOKEN_OPTIMIZER_PROXY = '1';
      child = spawn(
        arm === 'headroom' ? 'python' : process.execPath,
        arm === 'headroom'
          ? [
              '-m',
              'headroom.cli',
              'proxy',
              '--port',
              String(p),
              '--openai-api-url',
              base,
              '--no-rate-limit',
            ]
          : ['dist/proxy/cli.js', '--port', String(p), '--upstream', base],
        {
          cwd: resolve('.'),
          env,
          windowsHide: true,
          stdio: ['ignore', out, err],
        }
      );
      closeSync(out);
      closeSync(err);
      let ready = false;
      for (let i = 0; i < 900; i++) {
        if (child.exitCode !== null) throw Error('Proxy exited');
        try {
          const r = await fetch(`http://127.0.0.1:${p}/health`, {
            signal: AbortSignal.timeout(1000),
          });
          await r.arrayBuffer();
          ready = true;
          break;
        } catch {
          await delay(100);
        }
      }
      if (!ready) throw Error('Readiness timed out');
      for (const task of [
        'tiny',
        'entropy',
        'numeric',
        'nullable',
        'json',
        'code',
      ]) {
        for (const mode of ['repeated', 'unique', 'append']) {
          for (const concurrency of [1, 8]) {
            let priorOutput;
            const fixture = adversarialFixture(task, 810001);
            const bodies = Array.from({ length: 20 }, (_, i) => {
              const f =
                mode === 'unique'
                  ? adversarialFixture(task, 810001 + i)
                  : fixture;
              return JSON.stringify({
                model: 'gpt-6-astra',
                stream: false,
                prompt_cache_key: 'adversarial-local-stable',
                input: [
                  { role: 'user', content: f.question },
                  {
                    type: 'function_call',
                    name: 'read_file',
                    call_id: 'read',
                    arguments: '{}',
                  },
                  {
                    type: 'function_call_output',
                    call_id: 'read',
                    output: f.content,
                  },
                  ...(mode === 'append'
                    ? Array.from({ length: i }, (_, n) => ({
                        role: 'user',
                        content: `Continue step ${n}`,
                      }))
                    : []),
                ],
              });
            });
            const send = async (body) => {
              const start = performance.now();
              const r = await fetch(
                `http://127.0.0.1:${p}/backend-api/codex/responses`,
                {
                  method: 'POST',
                  headers: {
                    'content-type': 'application/json',
                    authorization: 'Bearer local-only',
                  },
                  body,
                  signal: AbortSignal.timeout(60000),
                }
              );
              const result = await r.json();
              const ms = performance.now() - start;
              assert.equal(r.status, 200);
              assert.equal(
                result.forwarded.prompt_cache_key,
                'adversarial-local-stable'
              );
              const output = result.forwarded.input[2].output;
              if (arm === 'proxy' && ['tiny', 'entropy'].includes(task))
                assert.equal(output, JSON.parse(body).input[2].output);
              if (mode === 'append') {
                if (priorOutput !== undefined)
                  assert.equal(
                    output,
                    priorOutput,
                    `${arm}: old output changed after append`
                  );
                priorOutput = output;
              }
              return {
                ms,
                sentBytes: Buffer.byteLength(body),
                forwardedBytes: result.bytes,
              };
            };
            // Warm process/output caches equally; unique measurements use fresh content after this seed.
            await send(bodies[0]);
            const samples = [];
            for (let i = 0; i < bodies.length; i += concurrency)
              samples.push(
                ...(await Promise.all(
                  bodies.slice(i, i + concurrency).map(send)
                ))
              );
            records.push({ round, arm, task, mode, concurrency, samples });
          }
        }
        console.log(
          JSON.stringify({ round, arm, task, groups: records.length })
        );
      }
      await stop(child);
      child = null;
    }
  }
} catch (e) {
  error = String(e);
  throw e;
} finally {
  await stop(child);
  upstream.closeAllConnections();
  await new Promise((r) => upstream.close(r));
  await writeFile(
    join(raw, 'results.json'),
    JSON.stringify(
      {
        raw,
        error,
        records,
        scope:
          'Local static upstream. Latency and wire bytes; no provider cost or model-quality inference. HeadRoom rate limiter disabled equally for all workloads.',
      },
      null,
      2
    )
  );
  console.log(JSON.stringify({ raw, error, groups: records.length }));
}
