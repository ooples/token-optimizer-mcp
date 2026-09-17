import { describe, it, expect } from '@jest/globals';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activateShells } from '../../scripts/managed-shell.mjs';
import {
  codexRoute,
  executable,
  runClient,
} from '../../scripts/run-client.mjs';
import { createServer } from 'node:http';
import { sessionRouting } from '../../scripts/session-routing.mjs';
import { putNode } from '../../hooks-core/wiki.mjs';

describe('managed client installation', () => {
  it('adds OpenCode runtime integration without changing existing inline configuration', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'optimizer-opencode-launch-'));
    try {
      const file = join(dir, 'config.json');
      const script = join(dir, 'fake-opencode.mjs');
      writeFileSync(
        script,
        `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(file)},process.env.OPENCODE_CONFIG_CONTENT);`
      );
      const config = {
        provider: {
          custom: { options: { headers: { 'x-test': 'synthetic' } } },
        },
        plugin: ['existing-plugin'],
        mcp: { other: { enabled: true } },
      };
      const encoded = JSON.stringify(config);
      const env = {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: encoded,
        TOKEN_OPTIMIZER_PROXY: '1',
      };
      expect(
        await runClient('opencode', [script], {
          env,
          command: process.execPath,
        })
      ).toBe(0);
      const actual = JSON.parse(readFileSync(file, 'utf8'));
      expect(actual.provider).toEqual(config.provider);
      expect(actual.plugin[0]).toBe('existing-plugin');
      expect(actual.plugin[1]).toMatch(/opencode-plugin\.mjs$/);
      expect(actual.mcp.other).toEqual({ enabled: true });
      expect(actual.mcp['token-optimizer'].enabled).toBe(true);
      expect(env.OPENCODE_CONFIG_CONTENT).toBe(encoded);
      expect(
        await runClient('opencode', [script], {
          env: { ...env, TOKEN_OPTIMIZER_MODE: 'off' },
          command: process.execPath,
        })
      ).toBe(0);
      expect(readFileSync(file, 'utf8')).toBe(encoded);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('does not inject the launching project graph into a Claude-selected worktree', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'optimizer-worktree-'));
    const oldWiki = process.env.TOKEN_OPTIMIZER_WIKI_DIR;
    const oldKnowledge = process.env.TOKEN_OPTIMIZER_PROXY_KNOWLEDGE;
    const bodies = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        bodies.push(body);
        res.end('{"ok":true}');
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      process.env.TOKEN_OPTIMIZER_WIKI_DIR = join(dir, 'wiki');
      process.env.TOKEN_OPTIMIZER_PROXY_KNOWLEDGE = '1';
      putNode(join(dir, 'wiki'), {
        kind: 'finding',
        key: 'worktree-marker',
        claim: 'The worktree routing marker is ONLY_LAUNCHING_PROJECT.',
        confidence: 1,
        confidenceLabel: 'verified',
        scope: 'project',
        pinned: true,
        origin: 'human',
      });
      const script = join(dir, 'fake-claude.mjs');
      writeFileSync(
        script,
        `await fetch(process.env.ANTHROPIC_BASE_URL+'/v1/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({system:'worktree routing marker',messages:[{role:'user',content:'What is the worktree routing marker?'}]})});`
      );
      const env = {
        ...process.env,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
        TOKEN_OPTIMIZER_PROXY: '1',
        TOKEN_OPTIMIZER_MANAGED_MCP: '0',
      };
      for (const flags of [[], ['--worktree=feature'], ['-w', 'feature']])
        expect(
          await runClient(
            'claude',
            [script, '--setting-sources', '', ...flags],
            { command: process.execPath, env }
          )
        ).toBe(0);
      expect(bodies[0]).toContain('ONLY_LAUNCHING_PROJECT');
      expect(
        bodies
          .slice(1)
          .every((body) => !body.includes('ONLY_LAUNCHING_PROJECT'))
      ).toBe(true);
    } finally {
      if (oldWiki === undefined) delete process.env.TOKEN_OPTIMIZER_WIKI_DIR;
      else process.env.TOKEN_OPTIMIZER_WIKI_DIR = oldWiki;
      if (oldKnowledge === undefined)
        delete process.env.TOKEN_OPTIMIZER_PROXY_KNOWLEDGE;
      else process.env.TOKEN_OPTIMIZER_PROXY_KNOWLEDGE = oldKnowledge;
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not confuse startup or telemetry with model routing or savings', () => {
    const messages = [];
    const routing = sessionRouting('claude', (text) => messages.push(text));
    routing.observe({ path: '/api/hello', compressed: false });
    routing.finish();
    expect(messages.join('')).toContain('routing remains unverified');
    expect(messages.join('')).not.toContain('model request observed by');
  });

  it('reports routed model attempts and transformations without exposing URLs', () => {
    const messages = [];
    const routing = sessionRouting('codex', (text) => messages.push(text));
    routing.observe({
      path: '/backend-api/codex/responses?secret=hidden',
      compressed: true,
      beforeBytes: 100,
      afterBytes: 120,
    });
    routing.observe({
      path: '/v1/messages',
      compressed: true,
      injectedChars: 278,
      beforeBytes: 1000,
      afterBytes: 800,
    });
    routing.observe({
      path: '/v1/chat/completions/',
      compressed: true,
      beforeBytes: 1000,
      afterBytes: 900,
    });
    routing.finish();
    expect(
      messages.filter((text) => text.includes('model request observed by'))
    ).toHaveLength(1);
    expect(messages.join('')).toContain(
      '3 model requests observed; 2 smaller payloads; 1 enriched'
    );
    expect(messages.join('')).not.toContain('hidden');
    expect(messages.join('')).toContain(
      'does not establish model success or cost savings'
    );
  });

  it('routes Claude requests with unchanged auth and closes its session proxy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'optimizer-transport-'));
    let received;
    const server = createServer((req, res) => {
      received = { path: req.url, auth: req.headers['x-api-key'] };
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const result = join(dir, 'result.json');
      const script = join(dir, 'fake-claude.mjs');
      writeFileSync(
        script,
        `import fs from 'node:fs';\nconst base=process.env.ANTHROPIC_BASE_URL;\nconst reply=await fetch(base+'/v1/messages',{method:'POST',headers:{'x-api-key':'synthetic-test-key','content-type':'application/json'},body:JSON.stringify({messages:[{role:'user',content:'hello'}]})});\nfs.writeFileSync(${JSON.stringify(result)},JSON.stringify({base,status:reply.status,args:process.argv.slice(2)}));\n`
      );
      expect(
        await runClient('claude', [script, 'literal $() & | argument'], {
          command: process.execPath,
          env: {
            ...process.env,
            ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}/provider`,
            TOKEN_OPTIMIZER_PROXY: '1',
          },
        })
      ).toBe(0);
      const observed = JSON.parse(readFileSync(result, 'utf8'));
      expect(received).toEqual({
        path: '/provider/v1/messages',
        auth: 'synthetic-test-key',
      });
      expect(observed.status).toBe(200);
      expect(observed.args[0]).toBe('literal $() & | argument');
      expect(observed.args).toContain('--mcp-config');
      await expect(fetch(observed.base)).rejects.toThrow();
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('preserves user profile content, is idempotent, and removes activation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'optimizer-shell-'));
    try {
      const path = join(dir, 'profile.ps1');
      const original = '# personal settings\n$custom = 123\n';
      writeFileSync(path, original);
      const env = { TOKEN_OPTIMIZER_SHELL_PROFILES: JSON.stringify([path]) };
      activateShells({ env });
      const installed = readFileSync(path, 'utf8');
      expect(installed).toContain('function global:codex');
      expect(installed).toContain('function global:claude');
      expect(installed).toContain('function global:opencode');
      expect(installed.startsWith(original)).toBe(true);
      expect(activateShells({ env })).toEqual([]);
      activateShells({ env, remove: true });
      expect(readFileSync(path, 'utf8').trimEnd()).toBe(original.trimEnd());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves custom provider headers, auth and per-invocation overrides', () => {
    const dir = mkdtempSync(join(tmpdir(), 'optimizer-route-'));
    try {
      mkdirSync(join(dir, '.codex'));
      writeFileSync(
        join(dir, 'config.toml'),
        'model_provider="custom"\n[model_providers.custom]\nname="custom"\nbase_url="https://example.test/v1"\nenv_key="CUSTOM_KEY"\n[model_providers.custom.http_headers]\nX-Tenant="one"\n'
      );
      const result = codexRoute(
        ['-c', 'model_providers.custom.base_url="https://other.test/v2"'],
        { CODEX_HOME: dir }
      );
      expect(result.upstream).toBe('https://other.test/v2');
      expect(result.provider.env_key).toBe('CUSTOM_KEY');
      expect(result.provider.http_headers).toEqual({ 'X-Tenant': 'one' });
      expect(result.provider.requires_openai_auth).toBeUndefined();
      expect(readFileSync(join(dir, 'config.toml'), 'utf8')).toContain(
        'example.test'
      );
      writeFileSync(
        join(dir, 'config.toml'),
        'model_provider="openai"\n[profiles.company]\nmodel_provider="custom"\n[model_providers.custom]\nname="custom"\nbase_url="https://company.test/v1"\n'
      );
      expect(
        codexRoute(['-c', 'profile="company"'], { CODEX_HOME: dir }).upstream
      ).toBe('https://company.test/v1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves Windows npm shims without passing prompts through a shell', () => {
    if (process.platform !== 'win32') return;
    const dir = mkdtempSync(join(tmpdir(), 'optimizer-shim-'));
    try {
      writeFileSync(
        join(dir, 'codex.cmd'),
        '"%_prog%" "%dp0%\\node_modules\\codex\\index.js" %*'
      );
      expect(executable('codex', { PATH: dir })).toEqual({
        command: process.execPath,
        prefix: [join(dir, 'node_modules', 'codex', 'index.js')],
      });
      const native = join(dir, 'opencode.exe');
      writeFileSync(native, 'synthetic executable placeholder');
      writeFileSync(join(dir, 'opencode-shim.cmd'), '"%dp0%\\opencode.exe" %*');
      expect(executable('opencode-shim', { PATH: dir })).toEqual({
        command: native,
        prefix: [],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
