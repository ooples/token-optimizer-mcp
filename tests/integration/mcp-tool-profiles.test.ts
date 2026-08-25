import { afterAll, describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  ATTESTATION_TOOL_NAMES,
  COGNITIVE_TOOL_NAMES,
  CONTINUITY_TOOL_NAMES,
  CORE_TOOL_NAMES,
} from '../../src/server/tool-profile.js';

const ROOT = process.cwd();
const SERVER = join(ROOT, 'dist', 'server', 'index.js');
const fixture = mkdtempSync(join(tmpdir(), 'mcp-tool-profiles-'));

// Real stdio startup loads the compiled server and can exceed Jest's five
// second unit-test default on Windows and shared CI runners. The child process
// retains its own stricter 30-second hang detector below.
jest.setTimeout(60_000);

interface ListedTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface RpcResponse {
  id?: number;
  result?: {
    tools?: ListedTool[];
    isError?: boolean;
    content?: Array<{ text: string }>;
  };
}

interface ServerResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  responses: RpcResponse[];
}

function runServer(
  profile?: string,
  toolCall?: string,
  arm?: string
): Promise<ServerResult> {
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
    TOKEN_OPTIMIZER_CACHE_DIR: join(
      fixture,
      profile || 'default',
      arm || 'full',
      'cache'
    ),
    TOKEN_OPTIMIZER_WIKI_DIR: join(
      fixture,
      profile || 'default',
      arm || 'full',
      'wiki'
    ),
    TOKEN_OPTIMIZER_STATE_DIR: join(
      fixture,
      profile || 'default',
      arm || 'full',
      'state'
    ),
  };
  if (profile !== undefined) env.TOKEN_OPTIMIZER_TOOL_PROFILE = profile;
  else delete env.TOKEN_OPTIMIZER_TOOL_PROFILE;
  if (arm !== undefined) env.TOKEN_OPTIMIZER_EXPERIMENT_ARM = arm;
  else delete env.TOKEN_OPTIMIZER_EXPERIMENT_ARM;

  const expectedResponseId = toolCall ? 3 : 2;
  const expectsResponse = profile !== 'everything';
  const input = `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      cwd: fixture,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const responses: RpcResponse[] = [];
    let stdout = '';
    let stderr = '';
    let stdoutBuffer = '';
    let inputClosed = false;
    let parseError: Error | undefined;

    const closeInput = () => {
      if (inputClosed) return;
      inputClosed = true;
      child.stdin.end();
    };
    const parseCompleteLines = () => {
      let newline = stdoutBuffer.indexOf('\n');
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line) {
          try {
            responses.push(JSON.parse(line) as RpcResponse);
          } catch (error) {
            parseError =
              error instanceof Error ? error : new Error(String(error));
            child.kill();
            return;
          }
        }
        newline = stdoutBuffer.indexOf('\n');
      }

      if (
        expectsResponse &&
        responses.some((response) => response.id === expectedResponseId)
      ) {
        closeInput();
      }
    };

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`MCP profile server timed out; stderr: ${stderr}`));
    }, 30_000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      stdoutBuffer += chunk;
      parseCompleteLines();
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (status, signal) => {
      clearTimeout(timeout);
      if (parseError) {
        reject(parseError);
        return;
      }
      if (stdoutBuffer.trim()) {
        reject(
          new Error(
            `MCP profile server closed with an incomplete JSON-RPC response (${stdoutBuffer.length} buffered bytes)`
          )
        );
        return;
      }
      if (
        expectsResponse &&
        !responses.some((response) => response.id === expectedResponseId)
      ) {
        reject(
          new Error(
            `MCP profile server closed before response ${expectedResponseId}; stderr: ${stderr}`
          )
        );
        return;
      }
      resolve({ status, signal, stdout, stderr, responses });
    });

    child.stdin.write(input);
    if (!expectsResponse) closeInput();
  });
}

afterAll(() => {
  try {
    rmSync(fixture, { recursive: true, force: true });
  } catch {
    // A test result matters more than reclaiming a temporary directory.
  }
});

describe('MCP tool profiles over the real stdio transport', () => {
  it('ships the bounded core profile by default', async () => {
    expect(existsSync(SERVER)).toBe(true);
    const result = await runServer();
    expect(result.status).toBe(0);

    const tools = result.responses.find((message) => message.id === 2)?.result
      ?.tools as ListedTool[];
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [...CORE_TOOL_NAMES].sort()
    );
  });

  it('keeps the complete 104-tool catalog behind the full profile', async () => {
    const [core, full] = await Promise.all([runServer(), runServer('full')]);
    expect(full.status).toBe(0);

    const coreTools = core.responses.find((message) => message.id === 2)?.result
      ?.tools as ListedTool[];
    const fullTools = full.responses.find((message) => message.id === 2)?.result
      ?.tools as ListedTool[];
    expect(fullTools).toHaveLength(104);
    expect(fullTools.map((tool) => tool.name)).toContain('cache_benchmark');
    expect(JSON.stringify(coreTools).length).toBeLessThan(
      JSON.stringify(fullTools).length * 0.35
    );
  });

  it('refuses a specialist tool that the active profile did not advertise', async () => {
    const result = await runServer(undefined, 'cache_benchmark');
    expect(result.status).toBe(0);

    const response = result.responses.find(
      (message) => message.id === 3
    )?.result;
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text).error).toContain(
      'TOKEN_OPTIMIZER_TOOL_PROFILE=full'
    );
  });

  it('fails clearly on an invalid profile instead of guessing', async () => {
    const result = await runServer('everything');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Invalid TOKEN_OPTIMIZER_TOOL_PROFILE');
  });

  it('offers cognition plus bounded receipt attestation as an opt-in profile', async () => {
    const [result, core] = await Promise.all([
      runServer('cognitive'),
      runServer('core'),
    ]);
    expect(result.status).toBe(0);
    const tools = result.responses.find((message) => message.id === 2)?.result
      ?.tools as ListedTool[];
    const coreTools = core.responses.find((message) => message.id === 2)?.result
      ?.tools as ListedTool[];
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [...COGNITIVE_TOOL_NAMES].sort()
    );
    expect(JSON.stringify(tools).length).toBeLessThan(
      JSON.stringify(coreTools).length * 0.35
    );
  });

  it('offers only capture and query in the continuity profile', async () => {
    const [continuity, cognitive] = await Promise.all([
      runServer('continuity'),
      runServer('cognitive'),
    ]);
    expect(continuity.status).toBe(0);
    const tools = continuity.responses.find((message) => message.id === 2)
      ?.result?.tools as ListedTool[];
    const cognitiveTools = cognitive.responses.find((message) => message.id === 2)
      ?.result?.tools as ListedTool[];
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [...CONTINUITY_TOOL_NAMES].sort()
    );
    expect(JSON.stringify(tools).length).toBeLessThan(
      JSON.stringify(cognitiveTools).length
    );
  });

  it('offers only receipt verification in the attestation profile', async () => {
    const result = await runServer('attestation');
    expect(result.status).toBe(0);
    const tools = result.responses.find((message) => message.id === 2)?.result
      ?.tools as ListedTool[];
    expect(tools.map((tool) => tool.name)).toEqual([
      ...ATTESTATION_TOOL_NAMES,
    ]);
    expect(JSON.stringify(tools).length).toBeLessThan(600);
  });

  it('isolates the four causal experiment arms at the server boundary', async () => {
    const names = async (arm: string) => {
      const result = await runServer(undefined, undefined, arm);
      expect(result.status).toBe(0);
      return (
        result.responses.find((message) => message.id === 2)?.result
          ?.tools as ListedTool[]
      ).map((tool) => tool.name);
    };

    const [baseline, optimizer, retrieval, full] = await Promise.all([
      names('baseline'),
      names('optimizer'),
      names('retrieval'),
      names('full'),
    ]);

    expect(baseline).toEqual([]);
    expect(optimizer).not.toEqual(
      expect.arrayContaining(['wiki_read', 'wiki_write'])
    );
    expect(retrieval).toContain('wiki_read');
    expect(retrieval).not.toContain('wiki_write');
    expect(full).toEqual(expect.arrayContaining(['wiki_read', 'wiki_write']));
  });
});
