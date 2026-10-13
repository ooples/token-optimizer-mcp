import { describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { pathToFileURL } from 'url';
import { agentForCall } from '../../../src/tools/shared/session-scope.js';
import { SmartReadTool } from '../../../src/tools/file-operations/smart-read.js';
import { SmartWriteTool } from '../../../src/tools/file-operations/smart-write.js';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { TokenCounter } from '../../../src/core/token-counter.js';
import { MetricsCollector } from '../../../src/core/metrics.js';
import { callContext } from '../../../src/tools/shared/call-context.js';

/**
 * #488, the subagent half: a Claude subagent shares its parent's MCP server and
 * session id, so a session-scoped cache handed it `// No changes` for a file
 * only its parent had read. The PreToolUse hook records which agent made each
 * call (by toolUseId); the server adds that agent to the cache scope.
 */
const agentScope = (await import(
  pathToFileURL(resolve('hooks-core', 'agent-scope.mjs')).href
)) as {
  agentKey(path: string): string;
  agentForCall(id: string): string | null;
  recordAgentForCall(id: string, path: string): boolean;
  agentScopeDirectory(): string;
};

const saved = {
  state: process.env.TOKEN_OPTIMIZER_STATE_DIR,
  session: process.env.TOKEN_OPTIMIZER_SESSION_ID,
};
let dir: string;
let cache: CacheEngine;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-scope-'));
  process.env.TOKEN_OPTIMIZER_STATE_DIR = join(dir, 'state');
  process.env.TOKEN_OPTIMIZER_SESSION_ID = 'one-session';
  cache = new CacheEngine(join(dir, 'cache.db'));
});

afterEach(() => {
  try {
    cache.close();
  } catch {
    // already closed
  }
  for (const [key, value] of [
    ['TOKEN_OPTIMIZER_STATE_DIR', saved.state],
    ['TOKEN_OPTIMIZER_SESSION_ID', saved.session],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

const PARENT = 'C:/Users/u/.claude/projects/p/session.jsonl';
const SUBAGENT =
  'C:/Users/u/.claude/projects/p/session/subagents/agent-a1.jsonl';
let calls = 0;

/** One MCP call by `transcript`: the hook records it, then the tool runs under its id. */
async function asAgent<T>(
  transcript: string | null,
  run: () => Promise<T>
): Promise<T> {
  const toolUseId = `toolu_test_${++calls}`;
  if (transcript) agentScope.recordAgentForCall(toolUseId, transcript);
  return callContext.run({ toolUseId }, run);
}

const reader = () =>
  new SmartReadTool(cache, new TokenCounter(), new MetricsCollector());

describe('the call-to-agent record', () => {
  it('records and returns the agent for a call', () => {
    expect(agentScope.recordAgentForCall('toolu_abc', SUBAGENT)).toBe(true);
    expect(agentScope.agentForCall('toolu_abc')).toBe(
      agentScope.agentKey(SUBAGENT)
    );
    expect(agentScope.agentKey(PARENT)).not.toBe(agentScope.agentKey(SUBAGENT));
  });

  it("the server's reader reads exactly what the hook's writer writes", () => {
    // Two implementations of one format (the server cannot load the hook's
    // ES module on Node 22.0-22.11), so this is what keeps them in step.
    agentScope.recordAgentForCall('toolu_shared', SUBAGENT);
    expect(agentForCall('toolu_shared')).toBe(agentScope.agentKey(SUBAGENT));
    expect(agentForCall('toolu_shared')).toBe(
      agentScope.agentForCall('toolu_shared')
    );
    expect(agentForCall('toolu_absent')).toBeNull();
    expect(agentForCall('../escape')).toBeNull();
  });

  it('knows nothing of an unrecorded call, and refuses an id that is not a plain id', () => {
    expect(agentScope.agentForCall('toolu_never')).toBeNull();
    expect(agentScope.recordAgentForCall('../escape', SUBAGENT)).toBe(false);
    expect(agentScope.agentForCall('../escape')).toBeNull();
    expect(agentScope.recordAgentForCall('toolu_x', '')).toBe(false);
  });

  it('the hook entry point records the pair from a PreToolUse payload', () => {
    const result = spawnSync(
      process.execPath,
      [resolve('plugin', 'hooks', 'agent-scope.mjs')],
      {
        input: JSON.stringify({
          hook_event_name: 'PreToolUse',
          tool_name: 'mcp__token-optimizer__smart_read',
          tool_use_id: 'toolu_from_hook',
          transcript_path: SUBAGENT,
        }),
        encoding: 'utf8',
        env: { ...process.env },
      }
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(''); // an empty reply lets the call through
    expect(agentScope.agentForCall('toolu_from_hook')).toBe(
      agentScope.agentKey(SUBAGENT)
    );
  });
});

describe('smart_read scoped per agent within one session', () => {
  it('gives a subagent the file the parent already read, and each its own repeat saving', async () => {
    const file = join(dir, 'shared.txt');
    writeFileSync(file, 'alpha\nbeta\ngamma\n');
    const tool = reader();

    expect((await asAgent(PARENT, () => tool.read(file))).content).toBe(
      'alpha\nbeta\ngamma\n'
    );
    // THE DEFECT: the subagent never read it, so it must get the file.
    expect((await asAgent(SUBAGENT, () => tool.read(file))).content).toBe(
      'alpha\nbeta\ngamma\n'
    );
    // Positive controls: each agent's own repeat still saves.
    expect((await asAgent(PARENT, () => tool.read(file))).content).toBe(
      '// No changes'
    );
    expect((await asAgent(SUBAGENT, () => tool.read(file))).content).toBe(
      '// No changes'
    );
  });

  it("does not hand a subagent the parent's smart_write as a base", async () => {
    const file = join(dir, 'written.txt');
    await asAgent(PARENT, () =>
      new SmartWriteTool(
        cache,
        new TokenCounter(),
        new MetricsCollector()
      ).write(file, 'one\ntwo\n')
    );
    expect((await asAgent(SUBAGENT, () => reader().read(file))).content).toBe(
      'one\ntwo\n'
    );
    expect((await asAgent(PARENT, () => reader().read(file))).content).toBe(
      '// No changes'
    );
  });

  it('keeps the session scope when no agent was recorded for the call', async () => {
    // Another client, or a hook that did not run: today's behaviour, unchanged.
    const file = join(dir, 'unrecorded.txt');
    writeFileSync(file, 'alpha\n');
    const tool = reader();
    expect((await asAgent(null, () => tool.read(file))).content).toBe(
      'alpha\n'
    );
    expect((await asAgent(null, () => tool.read(file))).content).toBe(
      '// No changes'
    );
    expect(existsSync(agentScope.agentScopeDirectory())).toBe(false);
  });
});
