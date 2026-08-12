#!/usr/bin/env node
/**
 * Run real MCP calls from several client identities into one local target.
 *
 * This is deliberately not a database seeder: every row comes through the
 * shipped stdio transport, initialize handshake, dispatcher, disclosure policy,
 * token counter, and graceful analytics flush. It is useful when verifying the
 * dashboard's per-client attribution after an upgrade.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.argv[2] || process.cwd());
const target = resolve(
  process.argv[3] || `${root}/README.md`
);
const serverEntry = resolve('dist/server/index.js');

if (!existsSync(serverEntry))
  throw new Error(`${serverEntry} is missing; run npm run build first.`);
if (!existsSync(target)) throw new Error(`Target does not exist: ${target}`);

const clients = [
  { name: 'codex', model: 'gpt-5.6-sol' },
  { name: 'claude-code', model: 'claude-sonnet' },
  { name: 'gemini', model: 'gemini-pro' },
];

async function exercise(client) {
  const child = spawn(process.execPath, [serverEntry], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      TOKEN_OPTIMIZER_MODEL: client.model,
      TOKEN_OPTIMIZER_MODEL_VERSION: 'live-dashboard-proof',
    },
  });
  child.stdout.setEncoding('utf8');
  let buffer = '';
  let nextId = 1;
  const pending = new Map();

  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        try {
          const message = JSON.parse(line);
          const entry = pending.get(message.id);
          if (entry) {
            clearTimeout(entry.timer);
            pending.delete(message.id);
            if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
            else entry.resolve(message.result);
          }
        } catch {
          // Non-protocol diagnostics are ignored; stderr remains visible below.
        }
      }
      newline = buffer.indexOf('\n');
    }
  });

  const call = (method, params = undefined) => {
    const id = nextId++;
    return new Promise((resolveCall, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${client.name}: timed out waiting for ${method}`)),
        30_000
      );
      pending.set(id, { resolve: resolveCall, reject, timer });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`
      );
    });
  };

  try {
    await call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: client.name, version: 'live-dashboard-proof' },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`
    );
    const knowledge = await call('tools/call', {
      name: 'wiki_read',
      arguments: { projectRoot: root, limit: 3 },
    });
    const read = await call('tools/call', {
      name: 'smart_read',
      arguments: { path: target, maxSize: 8_000 },
    });
    const knowledgeChars = knowledge?.content?.[0]?.text?.length || 0;
    const readChars = read?.content?.[0]?.text?.length || 0;
    process.stdout.write(
      `${client.name}: wiki_read ${knowledgeChars} chars; smart_read ${readChars} chars\n`
    );
  } finally {
    child.stdin.end();
    await new Promise((resolveExit) => {
      const timer = setTimeout(() => {
        child.kill();
        resolveExit();
      }, 10_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolveExit();
      });
    });
  }
}

for (const client of clients) await exercise(client);
