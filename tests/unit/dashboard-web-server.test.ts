import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { app } from '../../src/server/web-server.js';

let server: Server;
let baseUrl: string;
let temporaryDirectory: string | null = null;
const originalLogDirectory = process.env.TOKEN_OPTIMIZER_LOG_DIR;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

afterEach(() => {
  if (originalLogDirectory === undefined)
    delete process.env.TOKEN_OPTIMIZER_LOG_DIR;
  else process.env.TOKEN_OPTIMIZER_LOG_DIR = originalLogDirectory;

  if (temporaryDirectory) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
  }
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe('dashboard web routes', () => {
  it('serves the extensionless wiki route through the working static asset path', async () => {
    const alias = await fetch(`${baseUrl}/wiki`, { redirect: 'manual' });

    expect(alias.status).toBe(302);
    expect(alias.headers.get('location')).toBe('/wiki.html');

    const page = await fetch(new URL(alias.headers.get('location')!, baseUrl));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(
      '<title>What it knows &middot; Token Optimizer</title>'
    );
  });

  it('reports Claude Code plugin activity from the cross-client ledger', async () => {
    temporaryDirectory = mkdtempSync(
      join(tmpdir(), 'token-optimizer-dashboard-')
    );
    const logDirectory = join(temporaryDirectory, 'logs');
    mkdirSync(logDirectory);
    process.env.TOKEN_OPTIMIZER_LOG_DIR = logDirectory;
    writeFileSync(
      join(logDirectory, 'hook-events-2026-08-25.jsonl'),
      `${JSON.stringify({
        schemaVersion: 2,
        timestamp: new Date().toISOString(),
        event: 'hook.completed',
        invocationId: 'claude-plugin-invocation',
        client: 'claude-code',
        hookEvent: 'pre-tool',
        toolName: 'Read',
        outcome: 'success',
        durationMs: 12,
      })}\n`,
      'utf8'
    );

    const response = await fetch(
      `${baseUrl}/api/diagnostics/hooks?hours=1&limit=10`
    );
    const report = (await response.json()) as {
      summary: {
        available: boolean;
        actions: number;
        byClient: Record<string, { total: number }>;
      };
    };

    expect(response.status).toBe(200);
    expect(report.summary).toMatchObject({ available: true, actions: 1 });
    expect(report.summary.byClient['claude-code']).toMatchObject({ total: 1 });
  });
});
