import { describe, it, expect } from '@jest/globals';
import { createServer } from 'node:http';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { putNode } from '../../hooks-core/wiki.mjs';
import plugin from '../../scripts/opencode-plugin.mjs';

describe('OpenCode provider-scoped routing', () => {
  it('uses the repository graph when the client starts in a subdirectory', async () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'optimizer-nested-project-'));
    let sent;
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        sent = JSON.parse(body);
        res.end('{"choices":[]}');
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    fs.mkdirSync(join(root, '.git'));
    fs.mkdirSync(join(root, 'nested'));
    putNode(join(root, '.token-optimizer/wiki'), {
      kind: 'finding',
      key: 'nested-marker',
      claim: 'The project marker is NESTED_GRAPH_7.',
      confidence: 1,
      confidenceLabel: 'verified',
      scope: 'project',
      pinned: true,
      origin: 'human',
    });
    const hooks = await plugin({ directory: join(root, 'nested') });
    const config = {
      provider: {
        custom: {
          npm: '@ai-sdk/openai-compatible',
          options: { baseURL: `http://127.0.0.1:${server.address().port}/v1` },
        },
      },
    };
    try {
      await hooks.config(config);
      const reply = await fetch(
        config.provider.custom.options.baseURL + '/chat/completions',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            messages: [{ role: 'user', content: 'Find the project marker.' }],
          }),
        }
      );
      await reply.text();
      expect(sent.messages[0].content).toContain('NESTED_GRAPH_7');
    } finally {
      await hooks.dispose();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('retains native routing for unsupported and non-loopback HTTP endpoints', async () => {
    const hooks = await plugin({ directory: process.cwd() });
    const config = {
      provider: {
        plain: {
          npm: '@ai-sdk/openai-compatible',
          options: { baseURL: 'http://gateway.example/v1' },
        },
        other: {
          npm: '@ai-sdk/google',
          options: { baseURL: 'https://google.example' },
        },
      },
    };
    const before = JSON.stringify(config);
    try {
      await hooks.config(config);
      expect(JSON.stringify(config)).toBe(before);
    } finally {
      await hooks.dispose();
    }
  });
  it('routes Chat Completions with original headers and preserves configuration', async () => {
    let received;
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        received = {
          path: req.url,
          key: req.headers['x-provider-key'],
          body: JSON.parse(body),
        };
        res.end('{"choices":[]}');
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const hooks = await plugin({ directory: process.cwd() });
    const original = `http://127.0.0.1:${server.address().port}/v1`;
    const config = {
      provider: {
        custom: {
          npm: '@ai-sdk/openai-compatible',
          options: {
            baseURL: original,
            headers: { 'x-provider-key': 'synthetic-only' },
          },
          models: { test: { limit: { context: 10000, output: 1000 } } },
        },
      },
      mcp: { existing: { enabled: true } },
    };
    try {
      await hooks.config(config);
      const base = config.provider.custom.options.baseURL;
      expect(base).not.toBe(original);
      const payload = {
        model: 'test',
        messages: [
          { role: 'user', content: 'List records' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'one',
                type: 'function',
                function: { name: 'list_records', arguments: '{}' },
              },
            ],
          },
          {
            role: 'tool',
            tool_call_id: 'one',
            content: JSON.stringify(
              Array.from({ length: 100 }, (_, id) => ({
                id,
                state: 'ready',
                details: 'Shared record details with a long description',
              }))
            ),
          },
        ],
      };
      const reply = await fetch(base + '/chat/completions?api-version=test', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...config.provider.custom.options.headers,
        },
        body: JSON.stringify(payload),
      });
      expect(reply.status).toBe(200);
      await reply.text();
      expect(received.path).toBe('/v1/chat/completions?api-version=test');
      expect(received.key).toBe('synthetic-only');
      expect(received.body.messages[2].content.length).toBeLessThan(
        payload.messages[2].content.length
      );
      expect(received.body.messages.slice(0, 2)).toEqual(
        payload.messages.slice(0, 2)
      );
      expect(received.body).not.toHaveProperty('input');
      expect(config.mcp).toEqual({ existing: { enabled: true } });
      await hooks.config(config);
      expect(config.provider.custom.options.baseURL).toBe(base);
      const duplicate = await plugin({ directory: process.cwd() });
      await duplicate.config(config);
      expect(config.provider.custom.options.baseURL).toBe(base);
      await duplicate.dispose();
      await hooks.dispose();
      await expect(fetch(base)).rejects.toThrow();
    } finally {
      await hooks.dispose();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
