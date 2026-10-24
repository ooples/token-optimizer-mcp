/**
 * The instructions a Claude Code plugin install receives at initialize.
 *
 * There the hooks compact built-in Read, Grep and Bash output already, so the
 * server must not send agents off to load its tools for ordinary reads and
 * searches: each ToolSearch load re-writes the prompt cache. Every other client
 * keeps the routing policy (mcp-stdio-contract.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SERVER = join(process.cwd(), 'dist', 'server', 'index.js');

function initialize(
  env: NodeJS.ProcessEnv,
  dir: string
): Promise<{ child: ChildProcess; result: { instructions?: string } }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      cwd: dir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...env,
        TOKEN_OPTIMIZER_WIKI_DIR: join(dir, '.wiki'),
        TOKEN_OPTIMIZER_SHARED_DIR: join(dir, '.wiki'),
        TOKEN_OPTIMIZER_STATE_DIR: join(dir, '.state'),
        TOKEN_OPTIMIZER_LOG_DIR: join(dir, '.logs'),
        TOKEN_OPTIMIZER_DEFAULT_ROUTING: '0',
      },
    });
    let buffer = '';
    const timer = setTimeout(
      () => reject(new Error('no initialize response')),
      30_000
    );
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      buffer += chunk;
      for (const line of buffer.split('\n')) {
        try {
          const message = JSON.parse(line);
          if (message.id === 1) {
            clearTimeout(timer);
            resolve({ child, result: message.result });
          }
        } catch {
          // A partial line or a diagnostic.
        }
      }
    });
    child.stdin!.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'plugin-test', version: '0' },
        },
      })}\n`
    );
  });
}

const stop = (child: ChildProcess) =>
  new Promise<void>((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill();
  });

describe('instructions by install kind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-plugin-instr-'));
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k !== 'CLAUDE_PLUGIN_ROOT')
  );
  let plugin: { child: ChildProcess; result: { instructions?: string } };
  let generic: { child: ChildProcess; result: { instructions?: string } };

  beforeAll(async () => {
    if (!existsSync(SERVER))
      throw new Error(`${SERVER} is missing -- run \`npm run build\``);
    plugin = await initialize(
      { ...base, CLAUDE_PLUGIN_ROOT: join(dir, 'plugin') },
      dir
    );
    generic = await initialize(base, dir);
  }, 60_000);

  afterAll(async () => {
    await Promise.all([
      plugin && stop(plugin.child),
      generic && stop(generic.child),
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a plugin install is told not to load the tools just to read or search', () => {
    const text = plugin.result.instructions ?? '';
    expect(text).toContain(
      'already compact the output of the built-in Read, Grep and Bash tools'
    );
    expect(text).toContain(
      'Do not load these tools with ToolSearch just to read or search'
    );
    expect(text).toContain('Never call or redirect to an unlisted schema');
    // Enforce mode refuses large built-in reads and names smart_read: that wins.
    expect(text).toContain(
      'when a hook refuses a built-in call and names one of these tools'
    );
    expect(text).not.toContain('mandatory routing policy');
    expect(text).not.toContain('the first time a large read');
  });

  it('every other client keeps the routing policy', () => {
    const text = generic.result.instructions ?? '';
    expect(text).toContain('mandatory routing policy, not a preference');
    expect(text).not.toContain('Do not load these tools with ToolSearch');
  });
});
