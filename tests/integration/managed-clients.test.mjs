import { describe, it, expect } from '@jest/globals';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activateShells } from '../../scripts/managed-shell.mjs';
import { codexRoute, executable, runClient } from '../../scripts/run-client.mjs';
import { createServer } from 'node:http';

describe('managed client installation', () => {
  it('routes Claude requests with unchanged auth and closes its session proxy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'optimizer-transport-'));
    let received;
    const server = createServer((req, res) => {
      received = { path: req.url, auth: req.headers['x-api-key'] };
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const result = join(dir, 'result.json');
      const script = join(dir, 'fake-claude.mjs');
      writeFileSync(script, `import fs from 'node:fs';\nconst base=process.env.ANTHROPIC_BASE_URL;\nconst reply=await fetch(base+'/v1/messages',{method:'POST',headers:{'x-api-key':'synthetic-test-key','content-type':'application/json'},body:JSON.stringify({messages:[{role:'user',content:'hello'}]})});\nfs.writeFileSync(${JSON.stringify(result)},JSON.stringify({base,status:reply.status,args:process.argv.slice(2)}));\n`);
      expect(await runClient('claude', [script, 'literal $() & | argument'], { command: process.execPath, env: { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}/provider`, TOKEN_OPTIMIZER_PROXY: '1' } })).toBe(0);
      const observed = JSON.parse(readFileSync(result, 'utf8'));
      expect(received).toEqual({path:'/provider/v1/messages',auth:'synthetic-test-key'});
      expect(observed.status).toBe(200);
      expect(observed.args[0]).toBe('literal $() & | argument');
      expect(observed.args).toContain('--mcp-config');
      await expect(fetch(observed.base)).rejects.toThrow();
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      rmSync(dir, { recursive:true, force:true });
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
      expect(installed.startsWith(original)).toBe(true);
      expect(activateShells({ env })).toEqual([]);
      activateShells({ env, remove: true });
      expect(readFileSync(path, 'utf8').trimEnd()).toBe(original.trimEnd());
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('preserves custom provider headers, auth and per-invocation overrides', () => {
    const dir = mkdtempSync(join(tmpdir(), 'optimizer-route-'));
    try {
      mkdirSync(join(dir, '.codex'));
      writeFileSync(join(dir, 'config.toml'), 'model_provider="custom"\n[model_providers.custom]\nname="custom"\nbase_url="https://example.test/v1"\nenv_key="CUSTOM_KEY"\n[model_providers.custom.http_headers]\nX-Tenant="one"\n');
      const result = codexRoute(['-c', 'model_providers.custom.base_url="https://other.test/v2"'], { CODEX_HOME: dir });
      expect(result.upstream).toBe('https://other.test/v2');
      expect(result.provider.env_key).toBe('CUSTOM_KEY');
      expect(result.provider.http_headers).toEqual({ 'X-Tenant': 'one' });
      expect(result.provider.requires_openai_auth).toBeUndefined();
      expect(readFileSync(join(dir, 'config.toml'), 'utf8')).toContain('example.test');
      writeFileSync(join(dir, 'config.toml'), 'model_provider="openai"\n[profiles.company]\nmodel_provider="custom"\n[model_providers.custom]\nname="custom"\nbase_url="https://company.test/v1"\n');
      expect(codexRoute(['-c', 'profile="company"'], { CODEX_HOME: dir }).upstream).toBe('https://company.test/v1');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('resolves Windows npm shims without passing prompts through a shell', () => {
    if (process.platform !== 'win32') return;
    const dir = mkdtempSync(join(tmpdir(), 'optimizer-shim-'));
    try {
      writeFileSync(join(dir, 'codex.cmd'), '"%_prog%" "%dp0%\\node_modules\\codex\\index.js" %*');
      expect(executable('codex', { PATH: dir })).toEqual({ command: process.execPath, prefix: [join(dir, 'node_modules', 'codex', 'index.js')] });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
