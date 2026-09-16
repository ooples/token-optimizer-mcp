import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compressResponses } from '../../dist/proxy/responses.js';
const raw = await mkdtemp(join(tmpdir(), 'headroom-gap-probe-'));
const rows = Array.from({ length: 80 }, (_, i) => ({
  id: i,
  status: 'healthy',
  description: 'The operation finished successfully',
  value: i * 3,
}));
const large = JSON.stringify(rows, null, 2);
const small = JSON.stringify(rows.slice(0, 6));
const item = (text, type = 'function_call_output', n = 1) => ({
  type,
  call_id: `c${n}`,
  output: text,
});
const payload = (input) => ({
  model: 'gpt-6-astra',
  stream: true,
  store: false,
  input: [
    { role: 'user', content: 'Inspect these diagnostic observations.' },
    ...input,
  ],
});
const cases = [
  ['repeat-1', payload([item(large)])],
  ['repeat-2', payload([item(large), item(large, 'function_call_output', 2)])],
  [
    'repeat-3',
    payload([
      item(large),
      item(large, 'function_call_output', 2),
      item(large, 'function_call_output', 3),
    ]),
  ],
  ['small', payload([item(small)])],
  ['small-nine-rows', payload([item(JSON.stringify(rows.slice(0, 9)))])],
  ['output-text', payload([item([{ type: 'output_text', text: large }])])],
  ['local-shell-array', payload([item(large, 'local_shell_call_output')])],
  [
    'local-shell',
    payload([
      {
        type: 'local_shell_call_output',
        id: 'lc1',
        status: 'completed',
        output: JSON.stringify({ stdout: large, stderr: '', exit_code: 0 }),
      },
    ]),
  ],
  [
    'apply-patch',
    payload([{ ...item(large, 'apply_patch_call_output'), status: 'failed' }]),
  ],
];
for (const n of [1, 2, 3]) {
  cases.push([
    `nested-repeat-${n}`,
    payload(
      Array.from({ length: n }, (_, i) =>
        item(
          [
            {
              type: 'input_text',
              text: `Script completed\nWall time 0.${i} seconds\nOutput:\n`,
            },
            {
              type: 'input_text',
              text: JSON.stringify({
                chunk_id: `chunk-${i}`,
                wall_time_seconds: i / 10,
                exit_code: 0,
                original_token_count: 4000,
                output: large,
              }),
            },
          ],
          'custom_tool_call_output',
          i + 1
        )
      )
    ),
  ]);
}
let received;
const upstream = createServer(async (req, res) => {
  const parts = [];
  for await (const p of req) parts.push(p);
  received = JSON.parse(Buffer.concat(parts));
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n'
  );
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const listener = createServer();
await new Promise((r) => listener.listen(0, '127.0.0.1', r));
const port = listener.address().port;
await new Promise((r) => listener.close(r));
const child = spawn(
  'python',
  [
    '-m',
    'headroom.cli',
    'proxy',
    '--port',
    String(port),
    '--openai-api-url',
    `http://127.0.0.1:${upstream.address().port}`,
  ],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
);
child.stdout.pipe(createWriteStream(join(raw, 'headroom.stdout')));
child.stderr.pipe(createWriteStream(join(raw, 'headroom.stderr')));
const wires = [];
try {
  let ready = false;
  for (let i = 0; i < 400; i++) {
    if (child.exitCode !== null) throw Error('HeadRoom exited');
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      await r.text();
      ready = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!ready) throw Error('Not ready');
  for (const [name, before] of cases) {
    const body = Buffer.from(JSON.stringify(before));
    const ours = JSON.parse(
      compressResponses(
        body,
        before,
        () => '/synthetic/recovery.txt'
      ).body.toString()
    );
    received = undefined;
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(30000),
    });
    await response.text();
    if (response.status !== 200 || !received)
      throw Error(`status ${response.status}`);
    wires.push({ name, before, ours, headroom: received });
  }
  await writeFile(join(raw, 'wire.json'), JSON.stringify(wires));
  const bytes = (x) => Buffer.byteLength(JSON.stringify(x));
  const summary = {
    raw,
    kind: 'offline synthetic route probe; no model tasks, no provider charges, bytes not tokens',
    cases: wires.map((x) => ({
      name: x.name,
      inputBytes: bytes(x.before),
      oursBytes: bytes(x.ours),
      headroomBytes: bytes(x.headroom),
    })),
    prefixStability: {
      ours: wires
        .slice(1, 3)
        .every(
          (x, i) =>
            JSON.stringify(
              x.ours.input.slice(0, wires[i].ours.input.length)
            ) === JSON.stringify(wires[i].ours.input)
        ),
      headroom: wires
        .slice(1, 3)
        .every(
          (x, i) =>
            JSON.stringify(
              x.headroom.input.slice(0, wires[i].headroom.input.length)
            ) === JSON.stringify(wires[i].headroom.input)
        ),
    },
  };
  await writeFile(
    join(raw, 'summary.json'),
    JSON.stringify(summary, null, 2) + '\n'
  );
  console.log(JSON.stringify(summary, null, 2));
} finally {
  if (child.exitCode === null)
    execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
  upstream.closeAllConnections();
  await new Promise((r) => upstream.close(r));
}
