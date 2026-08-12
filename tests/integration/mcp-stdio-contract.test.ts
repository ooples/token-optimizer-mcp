import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  statSync,
  readdirSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/** Newest mtime of any .ts under a directory, walked recursively. */
function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(full));
    } else if (entry.name.endsWith('.ts')) {
      newest = Math.max(newest, statSync(full).mtimeMs);
    }
  }
  return newest;
}

/**
 * What a REAL CLIENT receives, over the real transport.
 *
 * Every other test in this repository calls the tool classes in-process. That is
 * a different thing from what an MCP client gets, and the gap is not theoretical:
 * `smart_grep`'s count mode returned its per-file counts as a `Map`, which is a
 * perfectly good object in-process and serialises to `{}` the moment it crosses
 * the wire. Callers saw:
 *
 *     { "metadata": { "totalMatches": 11 }, "counts": {} }
 *
 * An in-process assertion passes on the Map and proves nothing. Nothing in the
 * suite drove the server over stdio, so nothing could have caught it.
 *
 * This spawns the BUILT server exactly as a client does -- `dist/server/index.js`,
 * the file `package.json` lists in `bin` -- speaks JSON-RPC over stdin/stdout,
 * and asserts on the parsed response. Anything that cannot survive
 * JSON.stringify fails here.
 *
 * The server is started once and shared: startup dominates the cost, and these
 * are read-only calls against fixtures in a temp directory.
 */

const ROOT = process.cwd();
const SERVER = join(ROOT, 'dist', 'server', 'index.js');

let server: ChildProcessWithoutNullStreams;
let fixtures: string;
let nextId = 1;
let stdoutBuffer = '';
let initializeResult: any;
const pending = new Map<number, (value: unknown) => void>();

/** One JSON-RPC round trip. Resolves with the `result` object. */
function call(
  method: string,
  params: unknown,
  timeoutMs = 30_000
): Promise<any> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${method} (id ${id})`)),
      timeoutMs
    );
    pending.set(id, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
    server.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
    );
  });
}

/** The tool payload, parsed back out of the text content block. */
async function callTool(name: string, args: unknown): Promise<any> {
  const result = await call('tools/call', { name, arguments: args });
  const text = result?.content?.[0]?.text;
  expect(typeof text).toBe('string');
  return JSON.parse(text);
}

beforeAll(async () => {
  // The built output is what ships and what a client runs. Testing src/ here
  // would miss anything the build itself changes.
  if (!existsSync(SERVER)) {
    throw new Error(
      `${SERVER} is missing -- run \`npm run build\` before the integration suite`
    );
  }

  // A STALE dist is worse than a missing one. Missing fails loudly; stale runs
  // the previous build's code and reports green, which is precisely the false
  // reassurance this suite exists to remove -- it would have "passed" against
  // the Map-returning grep after the fix was written but before it was compiled.
  const built = statSync(SERVER).mtimeMs;
  const newestSource = newestMtime(join(ROOT, 'src'));
  if (newestSource > built) {
    throw new Error(
      `${SERVER} is older than src/ -- run \`npm run build\`, or this suite ` +
        `tests the previous build and passes for the wrong reason`
    );
  }

  fixtures = mkdtempSync(join(tmpdir(), 'mcp-contract-'));
  mkdirSync(join(fixtures, 'src'), { recursive: true });
  writeFileSync(
    join(fixtures, 'src', 'a.ts'),
    'export function one() {}\nexport function two() {}\n'
  );
  writeFileSync(join(fixtures, 'src', 'b.ts'), 'export function three() {}\n');
  writeFileSync(join(fixtures, 'src', 'quiet.ts'), 'const x = 1;\n');
  writeFileSync(
    join(fixtures, 'ten.txt'),
    'L01\nL02\nL03\nL04\nL05\nL06\nL07\nL08\nL09\nL10\n'
  );
  // A dot-directory, because those were invisible to search entirely.
  mkdirSync(join(fixtures, '.github', 'workflows'), { recursive: true });
  writeFileSync(
    join(fixtures, '.github', 'workflows', 'ci.yml'),
    'name: CI\njobs:\n  build:\n    env:\n      T: ${{ secrets.GITHUB_TOKEN }}\n'
  );

  server = spawn(process.execPath, [SERVER], {
    cwd: fixtures,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // Keep the server's own graph and state out of the developer's real ones.
      TOKEN_OPTIMIZER_WIKI_DIR: join(fixtures, '.wiki'),
      TOKEN_OPTIMIZER_SHARED_DIR: join(fixtures, '.wiki'),
      TOKEN_OPTIMIZER_STATE_DIR: join(fixtures, '.state'),
      TOKEN_OPTIMIZER_LOG_DIR: join(fixtures, '.logs'),
    },
  });

  server.stdout.setEncoding('utf8');
  server.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk;
    // JSON-RPC over stdio is newline-delimited; a chunk may carry part of a line.
    let newline = stdoutBuffer.indexOf('\n');
    while (newline !== -1) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line) {
        try {
          const message = JSON.parse(line);
          const resolver = pending.get(message.id);
          if (resolver) {
            pending.delete(message.id);
            resolver(message.result ?? message.error);
          }
        } catch {
          // Server diagnostics on stdout are not our concern here.
        }
      }
      newline = stdoutBuffer.indexOf('\n');
    }
  });

  initializeResult = await call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'contract-test', version: '0.0.0' },
  });
  server.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`
  );
}, 60_000);

afterAll(async () => {
  // AWAIT THE EXIT before removing the directory. `kill()` only signals, and on
  // Windows the still-open handles make rmSync throw EBUSY -- which fails the
  // whole suite after every assertion has already passed.
  if (server && server.exitCode === null) {
    await new Promise<void>((resolve) => {
      const done = setTimeout(resolve, 5_000);
      server.once('exit', () => {
        clearTimeout(done);
        resolve();
      });
      try {
        server.kill();
      } catch {
        clearTimeout(done);
        resolve();
      }
    });
  }

  // Best effort: a leftover temp directory is not worth failing a green run.
  try {
    rmSync(fixtures, { recursive: true, force: true });
  } catch {
    /* the OS reclaims it */
  }
});

describe('the server answers over stdio at all', () => {
  it('advertises the package version clients actually installed', () => {
    const packageVersion = JSON.parse(
      readFileSync(join(ROOT, 'package.json'), 'utf8')
    ).version;
    expect(initializeResult?.serverInfo).toMatchObject({
      name: 'token-optimizer-mcp',
      version: packageVersion,
    });
  });

  it('lists its tools', async () => {
    // If this fails everything below is meaningless, so it is asserted first
    // rather than assumed.
    const result = await call('tools/list', {});

    expect(Array.isArray(result?.tools)).toBe(true);
    expect(result.tools.length).toBeGreaterThan(0);
    expect(result.tools.map((t: { name: string }) => t.name)).toContain(
      'smart_grep'
    );

    const byName = new Map(
      result.tools.map((tool: { name: string }) => [tool.name, tool])
    );
    expect(byName.get('smart_read')).toMatchObject({
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    });
    expect(byName.get('wiki_write')).toMatchObject({
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    });
  });
});

describe('smart_grep over the wire', () => {
  it('delivers per-file counts, which a Map could not', async () => {
    // THE REGRESSION THIS FILE EXISTS FOR. `counts` was a Map and arrived as {}.
    const payload = await callTool('smart_grep', {
      pattern: 'export function',
      path: fixtures,
      count: true,
    });

    expect(payload.metadata.totalMatches).toBe(3);
    expect(Object.keys(payload.counts ?? {}).length).toBeGreaterThan(0);

    const summed = Object.values(
      payload.counts as Record<string, number>
    ).reduce((a, b) => a + b, 0);
    expect(summed).toBe(payload.metadata.totalMatches);
  });

  it('finds content inside a dot-directory', async () => {
    // Dot-directories were skipped entirely, and the answer was a confident zero
    // over a large filesSearched.
    const payload = await callTool('smart_grep', {
      pattern: 'GITHUB_TOKEN',
      path: fixtures,
    });

    expect(payload.metadata.totalMatches).toBeGreaterThan(0);
  });

  it('says so when a literal search buried a regex', async () => {
    // A CONFIDENT ZERO. `pattern` is matched literally unless `regex: true`, so
    // an alternation finds nothing and the result is indistinguishable from a
    // thorough search over a tree that genuinely does not contain the term:
    //
    //     { "success": true, "metadata": { "totalMatches": 0,
    //                                      "filesSearched": 7 } }
    //
    // This is not hypothetical. Searching this repository's workflows for
    // `npm test|test:ci|npm run build` returned exactly that, and the zero was
    // taken at face value -- the conclusion drawn was "CI never runs tests",
    // which is false. The same shape fooled the same reader twice in one
    // session, so the tool has to say something rather than leave the caller to
    // notice that `|` meant nothing.
    //
    // Zero matches stays a legitimate answer and success stays true. What is
    // added is the one fact the caller cannot see: the pattern WOULD have
    // matched had it been read as a regex.
    const payload = await callTool('smart_grep', {
      pattern: 'GITHUB_TOKEN|nothing-like-this',
      path: fixtures,
    });

    expect(payload.metadata.totalMatches).toBe(0);
    expect(payload.hint).toMatch(/regex/i);
  });

  it('stays quiet when a zero is a real zero', async () => {
    // The other half: a hint on every empty result would be noise, and a caller
    // that learns to ignore it is no better off than before.
    const payload = await callTool('smart_grep', {
      pattern: 'zzz-absent|qqq-also-absent',
      path: fixtures,
    });

    expect(payload.metadata.totalMatches).toBe(0);
    expect(payload.hint).toBeUndefined();
  });

  it('stays quiet when the literal pattern found something', async () => {
    const payload = await callTool('smart_grep', {
      pattern: 'export function',
      path: fixtures,
    });

    expect(payload.metadata.totalMatches).toBeGreaterThan(0);
    expect(payload.hint).toBeUndefined();
  });

  it('searches a single file when path names one', async () => {
    const payload = await callTool('smart_grep', {
      pattern: 'export function',
      path: join(fixtures, 'src', 'a.ts'),
    });

    expect({
      matches: payload.metadata.totalMatches,
      searched: payload.metadata.filesSearched,
    }).toEqual({ matches: 2, searched: 1 });
  });

  it('reports a path that does not exist rather than answering zero', async () => {
    const payload = await callTool('smart_grep', {
      pattern: 'anything',
      path: join(fixtures, 'no-such-dir'),
    });

    expect(payload.success).toBe(false);
  });
});

describe('smart_glob over the wire', () => {
  it('returns files from a dot-directory', async () => {
    const payload = await callTool('smart_glob', {
      pattern: '**/*.yml',
      path: fixtures,
    });

    expect(payload.files?.length).toBeGreaterThan(0);
  });
});

describe('smart_edit over the wire', () => {
  it('reports the real line count for a file ending in a newline', async () => {
    const payload = await callTool('smart_edit', {
      path: join(fixtures, 'ten.txt'),
      operations: [{ type: 'replace', startLine: 1, endLine: 1, content: 'X' }],
    });

    expect(payload.metadata.originalLines).toBe(10);
    expect(payload.metadata.finalLines).toBe(10);
  });

  // ONE PAST THE END, OVER THE WIRE.
  //
  // These are here because the in-process tests for this defect were the ones
  // that lied. They called `edit(path, { operations: [...] })` when the
  // signature is `edit(path, operations, options)`, so the tool received a
  // single object that is not an operation, did nothing, and truthfully
  // reported "nothing applied, file unchanged" -- every assertion passed
  // without reaching the behaviour it named. Reasoning from those results, the
  // corruption looked already-fixed when it was not.
  //
  // A wire call cannot make that mistake: the argument shape is the tool's
  // published schema, and the server does the mapping. Measured against a build
  // with the bound removed, `replace` and `delete` at line 11 of a 10-line file
  // both succeed, append, and DESTROY THE TRAILING NEWLINE.
  const TEN = 'L01\nL02\nL03\nL04\nL05\nL06\nL07\nL08\nL09\nL10\n';

  it.each([
    ['replace', { type: 'replace', startLine: 11, content: 'PHANTOM' }],
    ['delete', { type: 'delete', startLine: 11 }],
  ])(
    'refuses %s past the last line and leaves the bytes alone',
    async (name, operation) => {
      const path = join(fixtures, `past-end-${name}.txt`);
      writeFileSync(path, TEN);

      const payload = await callTool('smart_edit', {
        path,
        operations: [operation],
      });

      expect(payload.success).toBe(false);
      // Byte-identical, so a lost trailing newline fails here too.
      expect(readFileSync(path, 'utf8')).toBe(TEN);
    }
  );

  it('still appends when insert targets the append position', async () => {
    // The other half of the bound: refusing everything at `totalLines + 1`
    // would also satisfy the two assertions above while breaking appending,
    // which is the one legitimate use of that position.
    const path = join(fixtures, 'append-insert.txt');
    writeFileSync(path, TEN);

    const payload = await callTool('smart_edit', {
      path,
      operations: [{ type: 'insert', startLine: 11, content: 'L11' }],
    });

    expect(payload.success).toBe(true);

    const after = readFileSync(path, 'utf8');
    expect(after.startsWith(TEN)).toBe(true);
    expect(after).toContain('L11');
    expect(after.endsWith('\n')).toBe(true);
  });
});

describe('production MCP diagnostics over the wire', () => {
  it('records the real handshake, inventory, and every tool outcome', async () => {
    // Exercise an early-return audit tool as well as normal tools. Before the
    // central observer was added these calls bypassed diagnostics completely.
    const audit = await call('tools/call', {
      name: 'cache_audit',
      arguments: {},
    });
    expect(audit?.isError).not.toBe(true);

    const directory = join(fixtures, '.logs');
    const rows = readdirSync(directory)
      .filter((name) => name.startsWith('mcp-events-'))
      .flatMap((name) =>
        readFileSync(join(directory, name), 'utf8')
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      );

    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'mcp.process_started' }),
        expect.objectContaining({
          event: 'mcp.client_initialized',
          client: 'contract-test',
        }),
        expect.objectContaining({
          event: 'mcp.tools_listed',
          toolCount: expect.any(Number),
        }),
        expect.objectContaining({
          event: 'mcp.tool_completed',
          toolName: 'cache_audit',
          outcome: 'success',
        }),
      ])
    );
    expect(rows.some((row) => 'arguments' in row || 'output' in row)).toBe(
      false
    );
  });
});
