import { describe, it, expect } from '@jest/globals';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runClient } from '../../scripts/run-client.mjs';
import opencodePlugin from '../../scripts/opencode-plugin.mjs';
import {
  MANAGED_CLIENTS,
  CLIENT_PROXY_ENV,
  upstreamFor,
} from '../../hooks-core/capabilities.mjs';

describe('every supported managed CLI recovers a recorded stale proxy endpoint', () => {
  it.each(Object.keys(MANAGED_CLIENTS))(
    '%s refuses ambiguous recorded providers',
    async (id) => {
      const home = mkdtempSync(join(tmpdir(), 'ambiguous-route-'));
      const value = 'http://127.0.0.1:12345';
      const variable = CLIENT_PROXY_ENV[id];
      try {
        writeFileSync(
          join(home, 'default-routing.json'),
          JSON.stringify({
            schema: 1,
            entries: {
              a: { value, variable, upstream: 'https://first.example' },
              b: { value, variable, upstream: 'https://second.example' },
            },
          })
        );
        expect(() =>
          upstreamFor(id, { TOKEN_OPTIMIZER_HOME: home, [variable]: value })
        ).toThrow(/ambiguous/i);
        const env = {
          ...process.env,
          TOKEN_OPTIMIZER_HOME: home,
          TOKEN_OPTIMIZER_PROXY: '1',
          TOKEN_OPTIMIZER_MODE: 'assist',
          TOKEN_OPTIMIZER_MANAGED_MCP: '0',
          CODEX_HOME: home,
          CLAUDE_CONFIG_DIR: home,
          [variable]: value,
        };
        writeFileSync(
          join(home, 'config.toml'),
          `model_provider="custom"\n[model_providers.custom]\nbase_url="${value}"\n`
        );
        if (id === 'opencode') {
          const previous = process.env.TOKEN_OPTIMIZER_HOME;
          const hooks = await opencodePlugin({ directory: home });
          try {
            process.env.TOKEN_OPTIMIZER_HOME = home;
            await expect(
              hooks.config({
                provider: {
                  test: {
                    npm: '@ai-sdk/openai-compatible',
                    options: { baseURL: value },
                  },
                },
              })
            ).rejects.toThrow(/ambiguous/i);
          } finally {
            if (previous === undefined) delete process.env.TOKEN_OPTIMIZER_HOME;
            else process.env.TOKEN_OPTIMIZER_HOME = previous;
            await hooks.dispose();
          }
        } else {
          const script = join(home, 'client.mjs');
          writeFileSync(script, 'process.exit(99)');
          await expect(
            runClient(
              MANAGED_CLIENTS[id].command,
              [
                script,
                ...(id === 'claude-code' ? ['--setting-sources', ''] : []),
              ],
              { command: process.execPath, env }
            )
          ).rejects.toThrow(/ambiguous/i);
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  );
  it.each(Object.entries(MANAGED_CLIENTS))(
    '%s reaches its original provider instead of the dead proxy',
    async (id, { command }) => {
      const home = mkdtempSync(join(tmpdir(), 'all-cli-recovery-'));
      const upstream = createServer((req, res) => {
        req.resume();
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ client: id, path: req.url }));
      });
      await new Promise((done) => upstream.listen(0, '127.0.0.1', done));
      const endpoint = `http://127.0.0.1:${upstream.address().port}/v1`;
      const stale = 'http://127.0.0.1:1/v1';
      const variable = CLIENT_PROXY_ENV[id];
      writeFileSync(
        join(home, 'default-routing.json'),
        JSON.stringify({
          schema: 1,
          entries: {
            [join(home, 'settings.json')]: {
              variable,
              value: stale,
              upstream: endpoint,
              previous: endpoint,
            },
          },
        })
      );
      const env = {
        ...process.env,
        TOKEN_OPTIMIZER_HOME: home,
        TOKEN_OPTIMIZER_PROXY: '1',
        TOKEN_OPTIMIZER_MODE: 'assist',
        TOKEN_OPTIMIZER_MANAGED_MCP: '0',
        CODEX_HOME: home,
        CLAUDE_CONFIG_DIR: home,
        [variable]: stale,
      };
      const script = join(home, 'client.mjs');
      const result = join(home, 'result.json');
      writeFileSync(
        script,
        `import fs from 'node:fs';
      const response = await fetch(process.env[${JSON.stringify(variable)}] + '/messages', {
        method: 'POST', headers: {'content-type':'application/json'},
        body: JSON.stringify({model:'test', messages:[{role:'user',content:'hello'}]}),
        signal: AbortSignal.timeout(3000)
      });
      fs.writeFileSync(${JSON.stringify(result)}, await response.text());`
      );
      writeFileSync(
        join(home, 'config.toml'),
        `model_provider="custom"\n[model_providers.custom]\nbase_url="${stale}"\n`
      );
      let hooks;
      const originalHome = process.env.TOKEN_OPTIMIZER_HOME;
      try {
        if (id === 'opencode') {
          process.env.TOKEN_OPTIMIZER_HOME = home;
          hooks = await opencodePlugin({ directory: home });
          const config = {
            provider: {
              test: {
                npm: '@ai-sdk/openai-compatible',
                options: { baseURL: stale },
              },
            },
          };
          await hooks.config(config);
          const response = await fetch(
            `${config.provider.test.options.baseURL}/messages`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                model: 'test',
                messages: [{ role: 'user', content: 'hello' }],
              }),
              signal: AbortSignal.timeout(3000),
            }
          );
          expect(await response.json()).toEqual({
            client: id,
            path: '/v1/messages',
          });
        } else {
          const args = [
            script,
            ...(id === 'claude-code' ? ['--setting-sources', ''] : []),
          ];
          expect(
            await runClient(command, args, { command: process.execPath, env })
          ).toBe(0);
          expect(JSON.parse(readFileSync(result, 'utf8'))).toEqual({
            client: id,
            path: '/v1/messages',
          });
        }
      } finally {
        if (originalHome === undefined) delete process.env.TOKEN_OPTIMIZER_HOME;
        else process.env.TOKEN_OPTIMIZER_HOME = originalHome;
        await hooks?.dispose();
        upstream.closeAllConnections();
        await new Promise((done) => upstream.close(done));
        rmSync(home, { recursive: true, force: true });
      }
    },
    15000
  );
});
