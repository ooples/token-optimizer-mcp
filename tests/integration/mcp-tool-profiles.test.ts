import { afterAll, describe, expect, it } from '@jest/globals';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CORE_TOOL_NAMES } from '../../src/server/tool-profile.js';

const ROOT = process.cwd();
const SERVER = join(ROOT, 'dist', 'server', 'index.js');
const fixture = mkdtempSync(join(tmpdir(), 'mcp-tool-profiles-'));

interface ListedTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

function runServer(profile?: string, toolCall?: string) {
  const messages: object[] = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'tool-profile-test', version: '0.0.0' },
      },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ];
  if (toolCall) {
    messages.push({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: toolCall, arguments: {} },
    });
  }

  const env = {
    ...process.env,
    TOKEN_OPTIMIZER_CACHE_DIR: join(fixture, profile || 'default', 'cache'),
    TOKEN_OPTIMIZER_WIKI_DIR: join(fixture, profile || 'default', 'wiki'),
    TOKEN_OPTIMIZER_STATE_DIR: join(fixture, profile || 'default', 'state'),
  };
  if (profile !== undefined) env.TOKEN_OPTIMIZER_TOOL_PROFILE = profile;
  else delete env.TOKEN_OPTIMIZER_TOOL_PROFILE;

  const result = spawnSync(process.execPath, [SERVER], {
    cwd: fixture,
    env,
    input: `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`,
    encoding: 'utf8',
    timeout: 30_000,
  });
  const responses = result.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  return { ...result, responses };
}

afterAll(() => {
  try {
    rmSync(fixture, { recursive: true, force: true });
  } catch {
    // A test result matters more than reclaiming a temporary directory.
  }
});

describe('MCP tool profiles over the real stdio transport', () => {
  it('ships the bounded core profile by default', () => {
    expect(existsSync(SERVER)).toBe(true);
    const result = runServer();
    expect(result.status).toBe(0);

    const tools = result.responses.find((message) => message.id === 2)?.result
      ?.tools as ListedTool[];
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [...CORE_TOOL_NAMES].sort()
    );
  });

  it('keeps the complete 98-tool catalog behind the full profile', () => {
    const core = runServer();
    const full = runServer('full');
    expect(full.status).toBe(0);

    const coreTools = core.responses.find((message) => message.id === 2)?.result
      ?.tools as ListedTool[];
    const fullTools = full.responses.find((message) => message.id === 2)?.result
      ?.tools as ListedTool[];
    expect(fullTools).toHaveLength(98);
    expect(fullTools.map((tool) => tool.name)).toContain('cache_benchmark');
    expect(JSON.stringify(coreTools).length).toBeLessThan(
      JSON.stringify(fullTools).length * 0.35
    );
  });

  it('refuses a specialist tool that the active profile did not advertise', () => {
    const result = runServer(undefined, 'cache_benchmark');
    expect(result.status).toBe(0);

    const response = result.responses.find((message) => message.id === 3)?.result;
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text).error).toContain(
      'TOKEN_OPTIMIZER_TOOL_PROFILE=full'
    );
  });

  it('fails clearly on an invalid profile instead of guessing', () => {
    const result = runServer('everything');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Invalid TOKEN_OPTIMIZER_TOOL_PROFILE');
  });
});
