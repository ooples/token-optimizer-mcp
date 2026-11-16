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
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SERVER = join(process.cwd(), 'dist', 'server', 'index.js');

function initialize(
  env: NodeJS.ProcessEnv,
  dir: string,
  clientName = 'plugin-test'
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
          clientInfo: { name: clientName, version: '0' },
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
  // Neither marker leaks in from the session running the suite: a run inside
  // Claude Code carries CLAUDECODE=1, which would make every case Claude Code.
  const base = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => k !== 'CLAUDE_PLUGIN_ROOT' && k !== 'CLAUDECODE'
    )
  );
  const codexHome = join(dir, 'codex-home');
  let codexHooked: { child: ChildProcess; result: { instructions?: string } };
  let codexBare: { child: ChildProcess; result: { instructions?: string } };
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
    // Codex with nothing installed, then with the shipped hooks.json merged
    // into its home, as the install guide says. Same server, same env: only
    // the handshake's client name and the client's own wiring differ.
    codexBare = await initialize(
      { ...base, CODEX_HOME: codexHome },
      dir,
      'codex-mcp-client'
    );
    mkdirSync(codexHome, { recursive: true });
    copyFileSync(
      join(
        process.cwd(),
        'src',
        'integrations',
        'codex',
        'hooks',
        'hooks.json'
      ),
      join(codexHome, 'hooks.json')
    );
    codexHooked = await initialize(
      { ...base, CODEX_HOME: codexHome },
      dir,
      'codex-mcp-client'
    );
  }, 90_000);

  afterAll(async () => {
    await Promise.all([
      plugin && stop(plugin.child),
      generic && stop(generic.child),
      codexBare && stop(codexBare.child),
      codexHooked && stop(codexHooked.child),
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a plugin install is told not to load the tools just to read or search', () => {
    const text = plugin.result.instructions ?? '';
    expect(text).toContain(
      'Built-in Read, Grep and Bash output is already compacted'
    );
    expect(text).toContain('use those for ordinary reads and searches');
    expect(text).toContain(
      'Load one of these tools with ToolSearch only for what they cannot do'
    );
    expect(text).toContain('Never call an unlisted schema');
    // Enforce mode refuses large built-in reads and names smart_read: that wins.
    expect(text).toContain('or when a hook names one');
    // The code-mode catalog advice never applied to Claude Code (2026-11-07).
    expect(text).not.toContain('ALL_TOOLS');
    expect(text).not.toContain('mandatory routing policy');
    expect(text).not.toContain('the first time a large read');
  });

  it('every other client keeps the routing policy', () => {
    const text = generic.result.instructions ?? '';
    expect(text).toContain('mandatory routing policy, not a preference');
    expect(text).not.toContain('Do not load these tools with ToolSearch');
    expect(text).not.toContain('only for what they cannot do');
    expect(text).toContain('ALL_TOOLS');
  });

  it('a client with our hooks wired is told so at the handshake, whatever the client', () => {
    const hooked = codexHooked.result.instructions ?? '';
    expect(hooked).toContain("This install's hooks watch built-in file reads");
    expect(hooked).not.toContain('mandatory routing policy');
    expect(hooked).not.toContain('ToolSearch');
    // The same client without them keeps the routing policy.
    expect(codexBare.result.instructions ?? '').toContain(
      'mandatory routing policy'
    );
  });
});
