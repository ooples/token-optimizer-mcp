/** Local shipped-proxy comparison. No provider calls or model-cost claims. */
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { heldoutFixture } from './heldout-cases.mjs';

if (process.platform !== 'win32')
  throw Error(
    'This process-tree benchmark requires Windows (PowerShell/CIM sampling).'
  );
const root = resolve('.');
const raw = await mkdtemp(join(tmpdir(), 'local-proxy-performance-'));
const repetitions = 40;
const arms = ['proxy', 'headroom', 'control'];
const records = [];
let failure = null;
let receivedBytes = 0;
const upstream = createServer((req, res) => {
  let bytes = 0;
  req.on('data', (chunk) => {
    bytes += chunk.length;
  });
  req.on('end', () => {
    receivedBytes = bytes;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'resp_local',
        object: 'response',
        status: 'completed',
        output: [],
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
          input_tokens_details: { cached_tokens: 0 },
        },
      })
    );
  });
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${upstream.address().port}`;
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function processSample(pid) {
  return JSON.parse(
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$all=Get-CimInstance Win32_Process; $ids=[System.Collections.Generic.HashSet[int]]::new(); [void]$ids.Add(${pid}); do { $count=$ids.Count; foreach($entry in $all) { if($ids.Contains([int]$entry.ParentProcessId)) { [void]$ids.Add([int]$entry.ProcessId) } } } while($ids.Count -ne $count); $samples=@(foreach($processId in $ids) { Get-Process -Id $processId -ErrorAction SilentlyContinue }); @{cpuMs=($samples | ForEach-Object {$_.TotalProcessorTime.TotalMilliseconds} | Measure-Object -Sum).Sum; privateBytes=($samples | Measure-Object PrivateMemorySize64 -Sum).Sum; workingSetBytes=($samples | Measure-Object WorkingSet64 -Sum).Sum; processIds=@($samples.Id)} | ConvertTo-Json -Compress`,
      ],
      { encoding: 'utf8', windowsHide: true }
    )
  );
}
const active = new Set();
async function stop(child) {
  if (child.exitCode !== null) return;
  const done = new Promise((resolve) => child.once('close', resolve));
  if (process.platform === 'win32')
    execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
  else child.kill('SIGTERM');
  await done;
  active.delete(child);
}
try {
  for (let round = 0; round < 3; round++) {
    for (let position = 0; position < arms.length; position++) {
      const arm = arms[(round + position) % arms.length];
      const port = await freePort();
      const env = { ...process.env };
      for (const key of Object.keys(env))
        if (key.startsWith('TOKEN_OPTIMIZER_PROXY_')) delete env[key];
      env.TOKEN_OPTIMIZER_PROXY = '1';
      env.TOKEN_OPTIMIZER_PROXY_NULL = arm === 'control' ? '1' : '0';
      const out = openSync(join(raw, `${round}-${arm}.stdout`), 'w');
      const err = openSync(join(raw, `${round}-${arm}.stderr`), 'w');
      const args =
        arm === 'headroom'
          ? [
              '-m',
              'headroom.cli',
              'proxy',
              '--port',
              String(port),
              '--openai-api-url',
              base,
              '--no-rate-limit',
            ]
          : ['dist/proxy/cli.js', '--port', String(port), '--upstream', base];
      const start = performance.now();
      const child = spawn(
        arm === 'headroom' ? 'python' : process.execPath,
        args,
        { cwd: root, env, windowsHide: true, stdio: ['ignore', out, err] }
      );
      closeSync(out);
      closeSync(err);
      active.add(child);
      let ready = false;
      for (let i = 0; i < 900; i++) {
        if (child.exitCode !== null)
          throw Error(`${arm} exited before readiness`);
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
      if (!ready) throw Error(`${arm} readiness timeout`);
      const startupMs = performance.now() - start;
      for (const task of ['logs', 'json', 'code']) {
        for (const mode of ['repeated', 'unique']) {
          // Precompute fixtures outside timed requests and process CPU samples.
          const bodies = Array.from({ length: repetitions + 5 }, (_, i) => {
            const fixture = heldoutFixture(
              task,
              1800000000 + (mode === 'unique' ? i : 0)
            );
            return JSON.stringify({
              model: 'gpt-6-astra',
              stream: false,
              store: false,
              input: [
                { role: 'user', content: fixture.question },
                {
                  type: 'function_call',
                  name: 'read_file',
                  call_id: 'call_local',
                  arguments: '{}',
                },
                {
                  type: 'function_call_output',
                  call_id: 'call_local',
                  output: fixture.content,
                },
              ],
            });
          });
          const send = async (body) => {
            receivedBytes = 0;
            const begin = performance.now();
            const response = await fetch(
              `http://127.0.0.1:${port}/backend-api/codex/responses`,
              {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  authorization: 'Bearer local-benchmark-only',
                },
                body,
                signal: AbortSignal.timeout(20000),
              }
            );
            const reply = await response.json();
            if (!response.ok || reply.id !== 'resp_local' || !receivedBytes)
              throw Error(`${arm} local forwarding failed: ${response.status}`);
            return {
              milliseconds: performance.now() - begin,
              sentBytes: Buffer.byteLength(body),
              forwardedBytes: receivedBytes,
            };
          };
          for (const body of bodies.slice(0, 5)) await send(body);
          const before = processSample(child.pid);
          const samples = [];
          for (const body of bodies.slice(5)) samples.push(await send(body));
          const after = processSample(child.pid);
          records.push({
            round,
            position,
            arm,
            task,
            mode,
            startupMs,
            processCpuMs: after.cpuMs - before.cpuMs,
            before,
            after,
            samples,
          });
          console.log(
            JSON.stringify({
              round,
              arm,
              task,
              mode,
              meanMs:
                samples.reduce((n, s) => n + s.milliseconds, 0) /
                samples.length,
            })
          );
        }
      }
      await stop(child);
    }
  }
} catch (error) {
  failure = String(error);
  throw error;
} finally {
  for (const child of active) await stop(child);
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
  await writeFile(
    join(raw, 'results.json'),
    JSON.stringify(
      {
        raw,
        complete: failure === null,
        failure,
        headroomOverrides: ['--no-rate-limit', 'local --openai-api-url'],
        repetitions,
        records,
        limitations: [
          'Local Responses forwarding only; no model or task-quality inference.',
          'Memory is sampled process footprint, not allocation volume.',
          'Repeated and unique outputs are separate; process warmup is excluded from timed samples.',
          'Three rotated orders; Python and Node include their respective runtime costs.',
        ],
      },
      null,
      2
    ) + '\n'
  );
  console.log(JSON.stringify({ raw, groups: records.length }));
}
