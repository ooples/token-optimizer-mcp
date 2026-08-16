import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// @ts-expect-error -- hooks-core ships as plain ESM with no type declarations.
import { probeServer } from '../../hooks-core/doctor.mjs';

/**
 * Issue #307: "MCP server exits before registering tools on Windows."
 *
 * The server was in fact printing its exception. The doctor ran it with
 * `stdio: [..., 'ignore']` for stderr and then reported `error.message`, which
 * for `execFileSync` is the bare string "Command failed: <node> <entry>". So the
 * one tool whose job was to find the cause discarded it, and the user was left
 * with a sentence that names only the command. It then suggested `npm run build`
 * -- inside `node_modules`, where there is no src/ and no compiler.
 *
 * Two obligations, both tested here: a failing probe reports what the server
 * actually said, and the remedy is one the reader can carry out.
 */

let fixture: string;

/** A package root whose `dist/server/index.js` is whatever we say it is. */
function givenServer(body: string, { asSourceCheckout = false } = {}) {
  const root = mkdtempSync(join(fixture, 'root-'));
  mkdirSync(join(root, 'dist', 'server'), { recursive: true });
  writeFileSync(join(root, 'dist', 'server', 'index.js'), body);
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: '@ooples/token-optimizer-mcp', version: '5.7.0' })
  );

  if (asSourceCheckout) {
    mkdirSync(join(root, 'src', 'server'), { recursive: true });
    writeFileSync(join(root, 'src', 'server', 'index.ts'), '// source\n');
    writeFileSync(join(root, 'tsconfig.json'), '{}\n');
  }

  return root;
}

/** A server that answers the handshake and lists the tools it is given. */
const respondingServer = (tools: string[]) => `
let buffered = '';
process.stdin.on('data', (chunk) => {
  buffered += chunk.toString();
  let index;
  while ((index = buffered.indexOf('\\n')) !== -1) {
    const line = buffered.slice(0, index);
    buffered = buffered.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === 'initialize') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05' },
      }) + '\\n');
    }
    if (message.method === 'tools/list') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: { tools: ${JSON.stringify(tools)}.map((name) => ({ name })) },
      }) + '\\n');
    }
  }
});
`;

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'doctor-server-'));
});

afterEach(() => {
  rmSync(fixture, { recursive: true, force: true });
});

describe('probeServer on a server that dies at startup', () => {
  it('reports what the server printed, not just that a command failed', async () => {
    const root = givenServer(
      `console.error('SqliteError: unable to open database file');\nprocess.exit(1);\n`
    );

    const [check] = await probeServer({ root, timeoutMs: 15_000 });

    expect(check.pass).toBe(false);
    expect(check.detail).toContain('SqliteError: unable to open database file');
  });

  it('reports the exit status, so a silent death is still attributable', async () => {
    const root = givenServer(`process.exit(1);\n`);

    const [check] = await probeServer({ root, timeoutMs: 15_000 });

    expect(check.pass).toBe(false);
    expect(check.detail).toContain('exit code 1');
  });

  it('keeps the message and drops the stack frames around it', async () => {
    // A real uncaught exception buries the one useful line under
    // `at node:internal/modules/...` frames. Tailing the raw stderr showed
    // six frames and no message.
    const root = givenServer(
      `throw new Error('better_sqlite3.node was compiled against a different Node.js version');\n`
    );

    const [check] = await probeServer({ root, timeoutMs: 15_000 });

    expect(check.detail).toContain('compiled against a different Node.js version');
    expect(check.detail).not.toMatch(/^\s*at\s/m);
  });
});

describe('the remedy names something the reader can actually do', () => {
  it('does not tell an installed package to run a build it has no compiler for', async () => {
    const root = givenServer(`process.exit(1);\n`);

    const [check] = await probeServer({ root, timeoutMs: 15_000 });

    expect(check.remedy).not.toContain('npm run build');
    expect(check.remedy).toContain('reinstall');
  });

  it('does say `npm run build` in a source checkout, where it is the fix', async () => {
    const root = givenServer(`process.exit(1);\n`, { asSourceCheckout: true });

    const [check] = await probeServer({ root, timeoutMs: 15_000 });

    expect(check.remedy).toContain('npm run build');
  });

  it('says the build output is missing when there is no entry at all', async () => {
    const root = mkdtempSync(join(fixture, 'empty-'));

    const [check] = await probeServer({ root, timeoutMs: 15_000 });

    expect(check.pass).toBe(false);
    expect(check.detail).toContain('not found');
  });
});

describe('probeServer on a healthy server', () => {
  /**
   * The probe used to send `tools/list` alone and close stdin in the same
   * breath (`execFileSync` with `input`). A stdio MCP server reads stdin
   * closing as "my client died" -- correctly, since Windows gives it no other
   * orphan signal -- so the probe raced the server's own shutdown against the
   * reply it was waiting for. This asserts the handshake and that stdin stays
   * open long enough to hear the answer.
   */
  it('completes the handshake and reads the tool list', async () => {
    const root = givenServer(respondingServer(['smart_read', 'wiki_write']));

    const [check] = await probeServer({ root, timeoutMs: 15_000 });

    expect(check.pass).toBe(true);
    expect(check.detail).toContain('2 tools listed');
  });

  it('fails when the profile registered nothing', async () => {
    const root = givenServer(respondingServer([]));

    const [check] = await probeServer({ root, timeoutMs: 15_000 });

    expect(check.pass).toBe(false);
    expect(check.detail).toContain('listed no tools');
  });

  it('fails when wiki_write is missing, because harvesting needs it', async () => {
    const root = givenServer(respondingServer(['smart_read']));

    const [check] = await probeServer({ root, timeoutMs: 15_000 });

    expect(check.pass).toBe(false);
    expect(check.detail).toContain('wiki_write is missing');
  });

  /**
   * A server that answers after the client has already given up is, from the
   * user's chair, a server that registered no tools. Codex kills a stdio server
   * that has not started within `startup_timeout_sec` (default 10s), and
   * `npx -y ...@latest` spends part of that budget on the registry before node
   * runs at all. The doctor holds the only stopwatch, so it has to report.
   */
  it('flags a start slow enough for a client to kill it', async () => {
    const root = givenServer(
      `setTimeout(() => {${respondingServer(['smart_read', 'wiki_write'])}}, 10500);\n`
    );

    const [check] = await probeServer({ root, timeoutMs: 20_000 });

    expect(check.pass).toBe(false);
    expect(check.detail).toMatch(/startup took 1[0-9]\.\ds/);
    expect(check.remedy).toContain('startup_timeout_sec');
  }, 30_000);

  it('reports how long a healthy start took, so the margin is visible', async () => {
    const root = givenServer(respondingServer(['smart_read', 'wiki_write']));

    const [check] = await probeServer({ root, timeoutMs: 15_000 });

    expect(check.pass).toBe(true);
    expect(check.detail).toMatch(/in \d+\.\ds/);
  });

  it('gives up on a server that never answers, and says how long it waited', async () => {
    // Holds stdin open and says nothing: the hang, as distinct from the crash.
    const root = givenServer(`process.stdin.resume();\n`);

    const [check] = await probeServer({ root, timeoutMs: 1500 });

    expect(check.pass).toBe(false);
    expect(check.detail).toContain('1500ms');
  });
});
