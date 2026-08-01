import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { createServer, Server } from 'http';
import { createHash } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { TokenCounter } from '../../../src/core/token-counter.js';
import { MetricsCollector } from '../../../src/core/metrics.js';
import { SmartWebSocket } from '../../../src/tools/api-database/smart-websocket.js';

/**
 * A tool that says "sent" must have sent something.
 *
 * `connect()` was fixed earlier to dial for real -- it used to sleep briefly
 * and set the state to 'connected' without contacting anything. Its siblings
 * were left simulated, which is the worse of the two states: `sendMessage()`
 * built a message record, pushed it into the history and returned it with
 * direction 'sent' having transmitted nothing, and `disconnect()` flipped the
 * state without closing, so every real connection leaked until process exit.
 *
 * The only witness that cannot be fooled is the other end of the wire. The
 * server below performs a real RFC 6455 handshake and records what it actually
 * receives, so "sent" is checked against bytes rather than against a field the
 * tool set itself.
 */

let server: Server;
let url: string;
let dir: string;
let cache: CacheEngine;
let tool: SmartWebSocket;

const received: string[] = [];
let sawClose = false;
// An upgraded socket is detached from the Server, so server.close() does not
// end it. Held here and destroyed in teardown, or the jest worker cannot exit
// and the run ends with a "failed to exit gracefully" warning that trains
// everyone to ignore it.
const upgraded: import('net').Socket[] = [];

beforeAll(async () => {
  server = createServer();
  server.on('upgrade', (req, socket) => {
    upgraded.push(socket);
    const accept = createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );

    socket.on('data', (buf: Buffer) => {
      let i = 0;
      while (i < buf.length) {
        const opcode = buf[i] & 0x0f;
        let len = buf[i + 1] & 0x7f;
        let off = i + 2;
        if (len === 126) { len = buf.readUInt16BE(off); off += 2; }
        else if (len === 127) { len = Number(buf.readBigUInt64BE(off)); off += 8; }
        const mask = buf.subarray(off, off + 4);
        off += 4;
        const payload = Buffer.alloc(len);
        for (let j = 0; j < len; j++) payload[j] = buf[off + j] ^ mask[j % 4];
        if (opcode === 0x8) sawClose = true;
        else if (opcode === 0x1) received.push(payload.toString('utf8'));
        i = off + len;
      }
    });
    socket.on('error', () => { /* client vanished */ });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  url = `ws://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/`;

  dir = mkdtempSync(join(tmpdir(), 'ws-real-'));
  cache = new CacheEngine(join(dir, 'c.db'));
  tool = new SmartWebSocket(cache, new TokenCounter(), new MetricsCollector());
});

afterAll(async () => {
  try { cache.close(); } catch { /* */ }
  for (const s of upgraded) {
    try { s.destroy(); } catch { /* already gone */ }
  }
  await new Promise<void>((r) => server.close(() => r()));
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
});

const settle = () => new Promise((r) => setTimeout(r, 300));

describe('smart_websocket really talks to the server', () => {
  it('delivers a message it reports as sent', async () => {
    await tool.run({ action: 'connect', url });
    await tool.run({ action: 'send', url, message: 'THE-SENTINEL-PAYLOAD' });
    await settle();

    // Checked at the far end. A record with direction 'sent' proves nothing.
    expect(received).toContain('THE-SENTINEL-PAYLOAD');
  });

  it('closes the socket on disconnect instead of leaking it', async () => {
    await tool.run({ action: 'disconnect', url });
    await settle();
    expect(sawClose).toBe(true);
  });

  it('refuses to send when there is no connection', async () => {
    // Before, this returned a message record for a socket that never existed.
    await expect(
      tool.run({ action: 'send', url: 'ws://127.0.0.1:1/nope', message: 'x' })
    ).rejects.toThrow();
  });
});
