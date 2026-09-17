import { describe, it, expect } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { probeVersion, probeSessionStart, renderDiagnosis } from '../../hooks-core/doctor.mjs';
import { SmartGrepTool } from '../../src/tools/file-operations/smart-grep.js';
import { CacheEngine } from '../../src/core/cache-engine.js';
import { TokenCounter } from '../../src/core/token-counter.js';
import { MetricsCollector } from '../../src/core/metrics.js';
import { redactV7Proof } from '../../scripts/export-v7-proof.mjs';

describe('v7 user reports', () => {
  it('exports portable proof records without changing measured evidence or private inputs', () => {
    const input = { runtime: 'C:/Users/example/runtime', root: '/home/example/package', work: '/tmp/private', plugin: { launch: 'C:\\Users\\example\\launch.mjs' }, opencode: { work: '/tmp/other-private', code: 0 }, statuses: [200], tarballSha256: 'unchanged', requests: [{ path: '/v1/messages' }] };
    expect(redactV7Proof(input)).toEqual({ runtime: '<runtime-directory>', root: '<installed-package-directory>', work: '<verification-workspace>', plugin: { launch: '<plugin-launcher>' }, opencode: { work: '<verification-workspace>', code: 0 }, statuses: [200], tarballSha256: 'unchanged', requests: [{ path: '/v1/messages' }] });
    expect(input.plugin.launch).toBe('C:\\Users\\example\\launch.mjs');
  });

  it('reports a broken session hook when enforce-mode output has no policy', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'optimizer-missing-policy-'));
    try {
      writeFileSync(join(workspace, 'session-start.mjs'), 'console.log(JSON.stringify({hookSpecificOutput:{additionalContext:process.env.TOKEN_OPTIMIZER_MODE}}));');
      const checks = await probeSessionStart({ root: process.cwd(), workspace, hooksDir: workspace });
      expect(checks[0].pass).toBe(false);
      expect(checks[0].detail).toBe('ran, but produced no policy text');
      expect(checks[0].remedy).toContain('reinstall');
      expect(checks[0].remedy).toContain('report');
      expect(checks[0].remedy).not.toContain('TOKEN_OPTIMIZER_MODE');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
  it.each(['7.0.0', '6.0.2-beta.1'])('#389 rejects hooks %s ahead of or different from the served package', (installedVersion) => {
    const checks = probeVersion({ install: { method: 'plugin', installedVersion, packageVersion: '6.0.2', sameTree: false } });
    const skew = checks.find((check: { name: string }) => check.name === 'other clients agree with this package');
    expect(skew.pass).toBe(false);
    expect(skew.detail).toContain(installedVersion);
    expect(skew.detail).toContain('6.0.2');
    expect(skew.remedy).toContain('runtime');
  });

  it('#390 probes the real session hook independently of the opted-out runtime', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'optimizer-mode-off-'));
    const old = process.env.TOKEN_OPTIMIZER_MODE;
    try {
      process.env.TOKEN_OPTIMIZER_MODE = ' OFF ';
      const checks = await probeSessionStart({ root: process.cwd(), workspace });
      expect(checks[0].pass).toBe(true);
      const report = renderDiagnosis({ checks, passed: 1, total: 1, healthy: true, mode: 'off' });
      expect(report).toContain('disabled by TOKEN_OPTIMIZER_MODE=off');
      expect(report).not.toContain('Enforcement is live');
    } finally {
      if (old === undefined) delete process.env.TOKEN_OPTIMIZER_MODE;
      else process.env.TOKEN_OPTIMIZER_MODE = old;
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('#391 searches CRLF lines without terminators and preserves context, columns and file bytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'optimizer-crlf-grep-'));
    const cache = new CacheEngine(join(dir, 'cache.db'));
    const file = join(dir, 'fixture.txt');
    const before = 'before\r\n  NEEDLE\r\nafter\ninternal\rreturn\n';
    try {
      writeFileSync(file, before);
      const tool = new SmartGrepTool(cache, new TokenCounter(), new MetricsCollector());
      const result = await tool.grep('^  NEEDLE$', { path: dir, files: ['fixture.txt'], regex: true, includeColumn: true, includeContext: true, contextBefore: 1, contextAfter: 1 });
      expect(result.success).toBe(true);
      expect(result.matches).toEqual([{ file: 'fixture.txt', lineNumber: 2, column: 0, line: '  NEEDLE', match: '  NEEDLE', before: ['before'], after: ['after'] }]);
      const embedded = await tool.grep('internal', { path: dir, files: ['fixture.txt'] });
      expect(embedded.matches?.[0].line).toBe('internal\rreturn');
      expect(readFileSync(file, 'utf8')).toBe(before);
    } finally {
      cache.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
