import { spawn } from 'node:child_process';

function sendJson(proc, msg) {
  proc.stdin.write(`${JSON.stringify(msg)}\n`);
}

function once(proc, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const onData = (d) => {
      const s = d.toString();
      chunks.push(s);
      const lines = s.split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (predicate(obj)) {
            cleanup();
            resolve({ obj, raw: chunks.join('') });
            return;
          }
        } catch {}
      }
    };
    const onErr = (d) => chunks.push(d.toString());
    const onExit = () => {
      cleanup();
      reject(new Error('server exited before response'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      proc.stdout.off('data', onData);
      proc.stderr.off('data', onErr);
      proc.off('exit', onExit);
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onErr);
    proc.on('exit', onExit);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timeout waiting for response'));
    }, timeoutMs);
  });
}

async function main() {
  const server = spawn(process.execPath, ['dist/server/index.js'], {
    stdio: 'pipe',
  });

  try {
    // Request tool list
    sendJson(server, { jsonrpc: '2.0', id: '1', method: 'tools/list' });
    const list = await once(server, (o) => o.id === '1' && o.result);
    console.log('tools/list result count:', list.obj.result.tools.length);

    // Call optimize_text with a compressible payload
    const text = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(400);
    sendJson(server, {
      jsonrpc: '2.0',
      id: '2',
      method: 'tools/call',
      params: {
        name: 'optimize_text',
        arguments: { text, key: 'mcp-live-key', quality: 11 },
      },
    });
    const call = await once(server, (o) => o.id === '2' && (o.result || o.error), 15000);
    if (call.obj.error) {
      console.error('optimize_text error:', call.obj.error);
    } else {
      console.log('optimize_text ok');
      const payload = call.obj.result?.content?.[0]?.text || '';
      console.log('payload snippet:', payload.slice(0, 200));
    }
  } finally {
    server.kill('SIGTERM');
  }
}

main().catch((e) => {
  console.error(e.stack || e.message || String(e));
  process.exit(1);
});
