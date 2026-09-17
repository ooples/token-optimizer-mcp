// Run before and after a build. Fresh processes; no model requests or credentials.
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const mode = process.argv[2];
const started = performance.now();
const initialRss = process.memoryUsage().rss;
if (mode === 'counter') {
  const { TokenCounter } = await import('../../dist/core/token-counter.js');
  const counter = new TokenCounter('gpt-4');
  const constructedMs = performance.now() - started;
  const constructedRss = process.memoryUsage().rss - initialRss;
  const count = counter.count('Hello, world!');
  const countedMs = performance.now() - started;
  const countedRss = process.memoryUsage().rss - initialRss;
  counter.free();
  console.log(JSON.stringify({ constructedMs, constructedRss, countedMs, countedRss, tokens: count.tokens }));
} else if (mode === 'mcp') {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({ name: 'startup-probe', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/server/index.js')], stderr: 'ignore' });
  try {
    await client.connect(transport);
    const connectedMs = performance.now() - started;
    const result = await client.listTools();
    console.log(JSON.stringify({ connectedMs, listedMs: performance.now() - started, tools: result.tools.length }));
  } finally { await client.close(); }
} else {
  const rows = [];
  for (let repetition = 0; repetition < 4; repetition++) {
    const row = { repetition };
    for (const kind of ['counter', 'mcp']) {
      row[kind] = JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url), kind], { encoding: 'utf8', timeout: 30000, windowsHide: true }));
    }
    rows.push(row);
  }
  console.log(JSON.stringify({ node: process.version, platform: process.platform, rows }, null, 2));
}
