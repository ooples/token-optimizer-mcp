import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  readMcpDiagnosticEvents,
  recordMcpDiagnostic,
  summarizeMcpDiagnostics,
} from '../../src/server/mcp-diagnostics.js';

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mcp-diagnostics-'));
  process.env.TOKEN_OPTIMIZER_LOG_DIR = directory;
});

afterEach(() => {
  delete process.env.TOKEN_OPTIMIZER_LOG_DIR;
  rmSync(directory, { recursive: true, force: true });
});

describe('MCP production diagnostics', () => {
  it('records handshakes, inventory and outcomes without payloads', () => {
    recordMcpDiagnostic({
      serviceVersion: '5.7.0',
      event: 'mcp.process_started',
      outcome: 'success',
    });
    recordMcpDiagnostic({
      serviceVersion: '5.7.0',
      event: 'mcp.client_initialized',
      outcome: 'success',
      client: 'codex-mcp-client',
      clientVersion: '1.2.3',
    });
    recordMcpDiagnostic({
      serviceVersion: '5.7.0',
      event: 'mcp.tools_listed',
      outcome: 'success',
      client: 'codex-mcp-client',
      toolCount: 18,
    });
    recordMcpDiagnostic({
      serviceVersion: '5.7.0',
      event: 'mcp.tool_completed',
      outcome: 'success',
      client: 'codex-mcp-client',
      toolName: 'wiki_write',
      durationMs: 12,
    });

    expect(summarizeMcpDiagnostics()).toMatchObject({
      available: true,
      processes: 1,
      initializedClients: 1,
      advertisedTools: 18,
      toolCalls: 1,
      failures: 0,
      healthStatus: 'healthy',
    });
    expect(readMcpDiagnosticEvents()).toHaveLength(4);

    const text = readdirSync(directory)
      .filter((name) => name.startsWith('mcp-events-'))
      .map((name) => readFileSync(join(directory, name), 'utf8'))
      .join('\n');
    expect(text).not.toContain('arguments');
    expect(text).not.toContain('prompt');
    expect(text).not.toContain('output');
  });

  it('separates startup failures from successful tool calls', () => {
    recordMcpDiagnostic({
      serviceVersion: '5.7.0',
      event: 'mcp.startup_failed',
      outcome: 'failure',
      error: new Error('handshake timed out'),
    });

    const summary = summarizeMcpDiagnostics() as {
      failures: number;
      healthStatus: string;
      recentFailures: Array<{ error?: { message?: string } }>;
    };
    expect(summary.failures).toBe(1);
    expect(summary.healthStatus).toBe('failing');
    expect(summary.recentFailures[0].error?.message).toContain('handshake');
  });
});
