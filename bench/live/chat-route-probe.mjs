/** Actual HTTP proxies, synthetic Chat Completions traffic and local upstream.
 * Measures transport/transform latency and wire sizes, not model quality or cost.
 */
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get_encoding } from 'tiktoken';
import { startProxy } from '../../dist/proxy/server.js';
import { auditChatProbe } from './chat-route-audit.mjs';

const raw = await mkdtemp(join(tmpdir(), 'chat-route-comparison-'));
let received;
const upstream = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  received = Buffer.concat(chunks).toString();
  res.setHeader('content-type', 'application/json');
  res.end('{"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}');
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
const ours = await startProxy({ upstream: upstreamUrl, knowledge: false });
const reserve = createServer();
await new Promise((resolve) => reserve.listen(0, '127.0.0.1', resolve));
const port = reserve.address().port;
await new Promise((resolve) => reserve.close(resolve));
const python = process.env.PYTHON || 'python';
const competitor = spawn(
  python,
  [
    '-m',
    'headroom.cli',
    'proxy',
    '--port',
    String(port),
    '--openai-api-url',
    upstreamUrl,
    '--no-rate-limit',
  ],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
);
competitor.stdout.pipe(createWriteStream(join(raw, 'headroom.stdout')));
competitor.stderr.pipe(createWriteStream(join(raw, 'headroom.stderr')));
const samples = [];
let encoder;
try {
  let ready = false;
  for (let i = 0; i < 600; i++) {
    if (competitor.exitCode !== null)
      throw Error('HeadRoom exited before readiness');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      await response.text();
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) throw Error('HeadRoom readiness timeout');
  for (let sample = 0; sample < 8; sample++) {
    const rows = Array.from({ length: 80 + sample }, (_, id) => ({
      id: `case-${sample}-row-${id}`,
      state: id === 17 ? 'failed' : 'ready',
      region: 'east',
      description: 'Shared diagnostic record description',
      value: id * 17 + sample,
    }));
    const output = JSON.stringify(rows, null, 2);
    const messages = [
      { role: 'system', content: 'Inspect diagnostic records.' },
      { role: 'user', content: 'Report the failed record and its value.' },
    ];
    for (let repeat = 0; repeat < (sample % 3) + 1; repeat++)
      messages.push(
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: `call-${repeat}`,
              type: 'function',
              function: { name: 'list_records', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: `call-${repeat}`, content: output }
      );
    const request = { model: 'gpt-4.1', messages };
    const body = JSON.stringify(request);
    for (const arm of sample % 2
      ? ['headroom', 'proxy']
      : ['proxy', 'headroom']) {
      received = undefined;
      const started = performance.now();
      const response = await fetch(
        `http://127.0.0.1:${arm === 'proxy' ? ours.port : port}/v1/chat/completions`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(30000),
        }
      );
      await response.text();
      const milliseconds = performance.now() - started;
      if (!response.ok || !received)
        throw Error('Proxy failed to forward the request');
      const sent = JSON.parse(received);
      const preserved =
        sent.model === request.model &&
        Array.isArray(sent.messages) &&
        sent.messages.length === messages.length &&
        messages.every((message, index) =>
          message.role === 'tool'
            ? sent.messages[index].role === message.role &&
              sent.messages[index].tool_call_id === message.tool_call_id
            : JSON.stringify(sent.messages[index]) === JSON.stringify(message)
        );
      samples.push({
        sample,
        arm,
        milliseconds,
        beforeBytes: Buffer.byteLength(body),
        afterBytes: Buffer.byteLength(received),
        preserved,
        wire: received,
      });
    }
  }
  // Tokenizer loading/counting is outside every timed interval.
  encoder = get_encoding('o200k_base');
  for (const sample of samples)
    sample.estimatedWireTokens = encoder.encode(sample.wire, [], []).length;
  await writeFile(join(raw, 'wire.json'), JSON.stringify(samples));
  // Recovery files belong to the running proxy and disappear on shutdown.
  const audit = await auditChatProbe(raw);
  if (!audit.passed) throw Error('Chat route recovery/answer audit failed');
  const summary = {
    audit,
    kind: 'Synthetic local HTTP probe; no model task or billed cost; first requests include cold transforms',
    raw,
    headroom: execFileSync(
      python,
      ['-c', 'import headroom; print(headroom.__version__)'],
      { encoding: 'utf8', windowsHide: true }
    ).trim(),
    headroomOverrides: ['--no-rate-limit'],
    optimizerOverrides: ['knowledge:false; isolated compression probe'],
    samples: samples.map(({ wire, ...sample }) => sample),
  };
  await writeFile(join(raw, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
} finally {
  encoder?.free();
  if (competitor.exitCode === null) {
    if (process.platform === 'win32')
      execFileSync('taskkill', ['/PID', String(competitor.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    else competitor.kill('SIGTERM');
  }
  ours.server.closeAllConnections();
  await new Promise((resolve) => ours.server.close(resolve));
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
}
