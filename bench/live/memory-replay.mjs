/** Replay a captured request without provider calls, inside a constrained child. */
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

if (process.argv[2] === 'worker') {
  const { startProxy } = await import('../../dist/proxy/server.js');
  const { captureRequest } = await import('../../dist/proxy/capture.js');
  const dir = process.argv[4];
  const proxy = await startProxy({ upstream: process.argv[3], port: 0 });
  const samples = [];
  const timer = setInterval(() => samples.push(process.memoryUsage()), 100);
  process.on('message', async (message) => {
    if (message.type === 'snapshot') {
      // A marker in the same destination waits for previous accepted captures.
      while (
        !(await captureRequest(dir, '/memory-replay-marker', Buffer.alloc(0)))
      )
        await pause(10);
      global.gc();
      process.send({ type: 'snapshot', memory: process.memoryUsage() });
    } else if (message.type === 'stop') {
      clearInterval(timer);
      proxy.server.closeAllConnections();
      await new Promise((r) => proxy.server.close(r));
      process.send({ type: 'stopped', samples });
      process.disconnect();
    }
  });
  process.send({ type: 'ready', port: proxy.port });
} else {
  const source = resolve(process.argv[2]);
  const out = resolve(process.argv[3]);
  const mode = process.argv[4] ?? 'sustained';
  assert.ok(['sustained', 'overload'].includes(mode));
  await mkdir(out, { recursive: true });
  const captures = (await readFile(source, 'utf8'))
    .trim()
    .split(/\r?\n/)
    .map(JSON.parse);
  const record = captures.find((r) => r.path.endsWith('/responses'));
  assert.ok(record, 'Captured Responses request required');
  const body = record.body;
  const expected = sha(body);
  let forwarded = 0;
  let changed = 0;
  const upstream = createServer(async (req, res) => {
    const hash = createHash('sha256');
    for await (const part of req) hash.update(part);
    if (hash.digest('hex') !== expected) changed++;
    forwarded++;
    if (mode === 'sustained') await pause(20);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n'
    );
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith('TOKEN_OPTIMIZER_PROXY') || key === 'NODE_OPTIONS')
      delete env[key];
  env.TOKEN_OPTIMIZER_PROXY = '1';
  env.TOKEN_OPTIMIZER_PROXY_CAPTURE = join(out, 'capture');
  const child = fork(
    fileURLToPath(import.meta.url),
    [
      'worker',
      `http://127.0.0.1:${upstream.address().port}`,
      env.TOKEN_OPTIMIZER_PROXY_CAPTURE,
    ],
    {
      execArgv: ['--max-old-space-size=32', '--expose-gc'],
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    }
  );
  const stdout = createWriteStream(join(out, 'proxy.stdout'));
  const stderr = createWriteStream(join(out, 'proxy.stderr'));
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  const received = [],
    waiting = [];
  child.on('message', (message) => {
    if (waiting.length) waiting.shift().resolve(message);
    else received.push(message);
  });
  let exit;
  const finished = new Promise((r) =>
    child.once('exit', (code, signal) => {
      exit = { code, signal };
      while (waiting.length)
        waiting.shift().reject(Error(`Worker exited: ${JSON.stringify(exit)}`));
      r(exit);
    })
  );
  const next = () =>
    received.length
      ? Promise.resolve(received.shift())
      : exit
        ? Promise.reject(Error('Worker exited'))
        : new Promise((resolve, reject) => waiting.push({ resolve, reject }));
  const snapshots = [];
  try {
    const ready = await next();
    const run = async (count) => {
      let cursor = 0;
      await Promise.all(
        Array.from({ length: 8 }, async () => {
          while (cursor++ < count) {
            const response = await fetch(
              `http://127.0.0.1:${ready.port}${record.path}`,
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body,
                signal: AbortSignal.timeout(15000),
              }
            );
            assert.equal(response.status, 200);
            await response.text();
          }
        })
      );
      child.send({ type: 'snapshot' });
      snapshots.push({ completed: forwarded, ...(await next()).memory });
    };
    await run(64);
    await run(640);
    await run(640);
    child.send({ type: 'stop' });
    const stopped = await next();
    const status = await finished;
    assert.equal(status.code, 0);
    assert.equal(
      changed,
      0,
      'The original pre-tool request must remain byte-identical'
    );
    const log = await readFile(join(out, 'capture', 'requests.jsonl'), 'utf8');
    const rows = log
      .trim()
      .split(/\r?\n/)
      .map(JSON.parse)
      .filter((r) => r.path === record.path);
    assert.ok(rows.every((r) => sha(r.body) === expected));
    const result = {
      scope:
        'Local replay of the original pre-tool request; no provider calls, model quality or cost inference. Child V8 old space capped at 32 MiB (not total heap or RSS); explicit GC only at diagnostic snapshots.',
      source,
      mode,
      upstreamDelayMs: mode === 'sustained' ? 20 : 0,
      bodyBytes: Buffer.byteLength(body),
      bodySha256: expected,
      captureComplete: rows.length === forwarded,
      rejectedCaptures: forwarded - rows.length,
      forwarded,
      changed,
      captures: rows.length,
      concurrency: 8,
      heapLimitMiB: 32,
      snapshots,
      peakSampled: Object.fromEntries(
        ['rss', 'heapUsed', 'external', 'arrayBuffers'].map((key) => [
          key,
          Math.max(...stopped.samples.map((s) => s[key])),
        ])
      ),
      exit: status,
    };
    await writeFile(
      join(out, 'result.json'),
      JSON.stringify(result, null, 2) + '\n',
      { flag: 'wx' }
    );
    console.log(JSON.stringify(result, null, 2));
    if (mode === 'sustained')
      assert.equal(
        rows.length,
        forwarded,
        'Sustained load must retain all captures'
      );
  } finally {
    if (!exit) child.kill();
    upstream.closeAllConnections();
    await new Promise((r) => upstream.close(r));
  }
}
