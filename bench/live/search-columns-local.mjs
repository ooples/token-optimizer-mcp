/** Focused shipped-proxy follow-up: exact transmitted bodies, local upstream. */
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { get_encoding } from 'tiktoken';
import { heldoutFixture } from './heldout-cases.mjs';

const raw = await mkdtemp(join(tmpdir(), 'search-columns-local-'));
const encoder = get_encoding('o200k_base');
const rows = [];
const replayPrior = process.argv.includes('--replay-prior');
const casesPerArm = replayPrior ? 40 : 4;
const callId = replayPrior ? 'call_local' : 'search';
let forwarded;
const upstream = createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    forwarded = Buffer.concat(chunks).toString('utf8');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        id: 'local_search',
        object: 'response',
        status: 'completed',
        output: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      })
    );
  });
});
await new Promise((done) => upstream.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${upstream.address().port}`;
async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}
let active;
async function stop() {
  if (!active || active.exitCode !== null) return;
  const done = new Promise((resolve) => active.once('close', resolve));
  if (process.platform === 'win32')
    execFileSync('taskkill', ['/PID', String(active.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
  else active.kill('SIGTERM');
  await done;
  active = null;
}
let complete = false;
try {
  for (let round = 0; round < (replayPrior ? 1 : 2); round++) {
    for (const arm of replayPrior
      ? ['proxy']
      : round === 0
        ? ['proxy', 'headroom']
        : ['headroom', 'proxy']) {
      const port = await freePort();
      const env = { ...process.env };
      for (const key of Object.keys(env))
        if (key.startsWith('TOKEN_OPTIMIZER_PROXY_')) delete env[key];
      env.TOKEN_OPTIMIZER_PROXY = '1';
      const logs = ['stdout', 'stderr'].map((suffix) =>
        openSync(join(raw, `${round}-${arm}.${suffix}`), 'w')
      );
      active = spawn(
        arm === 'proxy' ? process.execPath : 'python',
        arm === 'proxy'
          ? ['dist/proxy/cli.js', '--port', String(port), '--upstream', base]
          : [
              '-m',
              'headroom.cli',
              'proxy',
              '--port',
              String(port),
              '--openai-api-url',
              base,
              '--no-rate-limit',
            ],
        {
          cwd: resolve('.'),
          env,
          windowsHide: true,
          stdio: ['ignore', ...logs],
        }
      );
      logs.forEach(closeSync);
      let ready = false;
      for (let attempt = 0; attempt < 300; attempt++) {
        if (active.exitCode !== null) throw Error(`${arm} exited at startup`);
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health`, {
            signal: AbortSignal.timeout(1000),
          });
          await response.arrayBuffer();
          ready = true;
          break;
        } catch {
          await delay(100);
        }
      }
      if (!ready) throw Error(`${arm} startup timeout`);
      for (let index = 0; index < casesPerArm; index++) {
        const seed = replayPrior
          ? 1800000005 + index
          : 1900000201 + round * 4 + index;
        const fixture = heldoutFixture('code', seed);
        const body = JSON.stringify({
          model: 'gpt-6-astra',
          stream: false,
          store: false,
          input: [
            { role: 'user', content: fixture.question },
            {
              type: 'function_call',
              name: 'read_file',
              call_id: callId,
              arguments: '{}',
            },
            {
              type: 'function_call_output',
              call_id: callId,
              output: fixture.content,
            },
          ],
        });
        forwarded = null;
        const started = performance.now();
        const response = await fetch(
          `http://127.0.0.1:${port}/backend-api/codex/responses`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: 'Bearer local-benchmark-only',
            },
            body,
            signal: AbortSignal.timeout(30000),
          }
        );
        const answer = await response.json();
        const milliseconds = performance.now() - started;
        if (!response.ok || answer.id !== 'local_search' || !forwarded)
          throw Error(`${arm} forwarding failed: ${response.status}`);
        await writeFile(join(raw, `${seed}-${arm}.json`), forwarded);
        rows.push({
          round,
          arm,
          seed,
          milliseconds,
          rawBytes: Buffer.byteLength(body),
          forwardedBytes: Buffer.byteLength(forwarded),
          estimatedO200kTokens: encoder.encode(forwarded).length,
        });
      }
      await stop();
      console.log(JSON.stringify({ round, arm, completeCases: casesPerArm }));
    }
  }
  complete = true;
} finally {
  await stop();
  upstream.closeAllConnections();
  await new Promise((done) => upstream.close(done));
  encoder.free();
  await writeFile(
    join(raw, 'results.json'),
    JSON.stringify(
      {
        complete,
        replayPrior,
        localUpstreamOnly: true,
        headroomOverrides: ['--no-rate-limit'],
        tokenizer: 'o200k_base estimate, not observed model usage',
        rows,
      },
      null,
      2
    ) + '\n'
  );
  console.log(JSON.stringify({ raw, complete }));
}
