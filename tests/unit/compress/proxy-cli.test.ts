import { describe, it, expect, afterEach } from '@jest/globals';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The proxy's command-line entrypoint, run as a real process.
 *
 * SPAWNED, NOT IMPORTED, and that is the point. What this file is testing is a
 * CONTRACT WITH A SHELL: exactly one line on stdout, diagnostics on stderr, an
 * exit code per failure mode, and a listener that dies on SIGTERM. Importing
 * `run()` would exercise the logic while proving nothing about the stream
 * separation or the exit codes, which is the whole reason a launcher can use
 * this at all.
 */

// THE BUILT ARTIFACT, not the source. The bin entry in package.json points at
// dist/proxy/cli.js, so that is what a user runs and what has to work --
// importing the module would exercise the logic while proving nothing about
// the entry that ships.
const CLI = fileURLToPath(
  new URL('../../../dist/proxy/cli.js', import.meta.url)
);

interface Ran {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the CLI to completion. For the paths that are meant to exit. */
async function runToExit(
  args: readonly string[],
  env: NodeJS.ProcessEnv = {}
): Promise<Ran> {
  const child = spawn(process.execPath, [CLI, ...args], {
    env: {
      ...process.env,
      TOKEN_OPTIMIZER_PROXY: '',
      TOKEN_OPTIMIZER_MODE: '',
      ...env,
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => (stdout += chunk));
  child.stderr.on('data', (chunk: string) => (stderr += chunk));
  const [code] = (await once(child, 'exit')) as [number | null, string | null];
  return { code, stdout, stderr };
}

/** Starts the CLI and resolves once it has printed its URL. */
async function start(
  args: readonly string[],
  env: NodeJS.ProcessEnv = {}
): Promise<{
  child: ChildProcessWithoutNullStreams;
  url: string;
  stderr: () => string;
  stdout: () => string;
}> {
  const child = spawn(process.execPath, [CLI, ...args], {
    env: {
      ...process.env,
      TOKEN_OPTIMIZER_PROXY: '',
      TOKEN_OPTIMIZER_MODE: '',
      ...env,
    },
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => (stderr += chunk));
  child.stdout.setEncoding('utf8');

  // EVERY BYTE OF STDOUT IS KEPT, not just the bytes after the URL arrives.
  // The URL and a stray second line can land in ONE chunk, and this listener
  // consumes that chunk before any test can attach its own -- so a test that
  // watched for "extra output" afterwards saw nothing and passed over exactly
  // the violation it existed to catch. Parsing reads this buffer rather than a
  // private one, which makes the single-line contract assertable in full.
  let stdout = '';
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no URL within 15s; stderr was:\n${stderr}`)),
      15_000
    );
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.includes('\n')) {
        clearTimeout(timer);
        resolve(stdout.split('\n')[0].trim());
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `exited with ${code} before printing a URL; stderr:\n${stderr}`
        )
      );
    });
  });

  return { child, url, stderr: () => stderr, stdout: () => stdout };
}

const post = (
  url: string,
  body: string
): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const target = new URL('/v1/messages', url);
    const req = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      },
      (res) => {
        let received = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (received += chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: received })
        );
      }
    );
    req.on('error', reject);
    req.end(body);
  });

const stop = async (child: ChildProcessWithoutNullStreams): Promise<void> => {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await once(child, 'exit');
};

describe('the proxy command-line entrypoint', () => {
  const running: ChildProcessWithoutNullStreams[] = [];
  const servers: Server[] = [];

  it('is built', () => {
    // Every other test here spawns this path, and a missing build would make
    // them all fail with an opaque "exited with 1" instead of saying why.
    expect(existsSync(CLI)).toBe(true);
  });

  afterEach(async () => {
    await Promise.all(running.splice(0).map(stop));
    await Promise.all(
      servers
        .splice(0)
        .map(
          (server) => new Promise<void>((done) => server.close(() => done()))
        )
    );
  });

  /** An upstream that records what reached it, so "forwarded" is not assumed. */
  const upstream = async (): Promise<{ url: string; seen: () => string[] }> => {
    const bodies: string[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (body += chunk));
      req.on('end', () => {
        bodies.push(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    servers.push(server);
    await new Promise<void>((done) =>
      server.listen(0, '127.0.0.1', () => done())
    );
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    return { url: `http://127.0.0.1:${port}`, seen: () => bodies };
  };

  it('prints exactly one line on stdout, and it is the URL', async () => {
    const target = await upstream();
    const { child, url, stdout } = await start([
      '--upstream',
      target.url,
      '--quiet',
    ]);
    running.push(child);

    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    // The contract a launcher depends on: nothing else ever reaches stdout, so
    // `BASE_URL=$(token-optimizer-proxy ...)` cannot capture a summary line.
    // Asserted over the WHOLE stream, including whatever arrived in the same
    // chunk as the URL, and serving a request first because that is when a
    // stray log line would be written.
    await post(url, JSON.stringify({ model: 'x', messages: [] }));
    await new Promise((settle) => setTimeout(settle, 50));

    expect(stdout()).toBe(`${url}\n`);
  });

  it('forwards a request to the upstream it was given', async () => {
    const target = await upstream();
    const { child, url } = await start(['--upstream', target.url, '--quiet']);
    running.push(child);

    const sent = JSON.stringify({
      model: 'claude',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const response = await post(url, sent);

    expect(response.status).toBe(200);
    expect(response.body).toBe('{"ok":true}');
    expect(target.seen()).toHaveLength(1);
    expect(JSON.parse(target.seen()[0])).toMatchObject({ model: 'claude' });
  });

  it('reports each request on stderr unless asked not to', async () => {
    const target = await upstream();
    const { child, url, stderr } = await start(['--upstream', target.url]);
    running.push(child);

    await post(
      url,
      JSON.stringify({
        model: 'x',
        messages: [{ role: 'user', content: 'hi' }],
      })
    );
    // The write is async relative to the response; give it the event loop.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(stderr()).toMatch(/\/v1\/messages \d+B -> \d+B/);
  });

  it('exits on SIGTERM rather than outliving the launcher', async () => {
    const target = await upstream();
    const { child } = await start(['--upstream', target.url, '--quiet']);

    child.kill('SIGTERM');
    const [code, signal] = (await once(child, 'exit')) as [
      number | null,
      string | null,
    ];

    if (process.platform === 'win32') {
      // WINDOWS HAS NO SIGNALS. Node maps kill('SIGTERM') to TerminateProcess,
      // so the handler cannot run and the exit code is null by construction --
      // asserting 0 here would only be asserting the platform. What is still
      // worth pinning is that the process is gone rather than orphaned.
      expect(child.exitCode === null ? signal : code).toBeTruthy();
    } else {
      // Where the signal is real, a 0 proves the handler ran and closed the
      // listener, rather than the runtime tearing the process down.
      expect(code).toBe(0);
      expect(signal).toBeNull();
    }
  });

  it('refuses to start under the kill switch, with its own exit code', async () => {
    const ran = await runToExit([], { TOKEN_OPTIMIZER_MODE: 'off' });

    expect(ran.code).toBe(3);
    expect(ran.stderr).toContain('TOKEN_OPTIMIZER_MODE=off');
    // Nothing on stdout: a launcher that read a URL here would point a client
    // at a port nothing is listening on.
    expect(ran.stdout).toBe('');
  });

  it('refuses an upstream that would put credentials on the wire in cleartext', async () => {
    const ran = await runToExit(['--upstream', 'http://api.example.com']);

    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain('refusing to forward credentials');
    expect(ran.stdout).toBe('');
  });

  it('rejects a port that is not a number instead of binding a random one', async () => {
    // listen(NaN) binds an arbitrary free port, so a typo here would otherwise
    // hand back a URL on a port the caller never asked for.
    const ran = await runToExit(['--port', 'abc']);

    expect(ran.code).toBe(2);
    expect(ran.stderr).toContain('--port must be an integer 0-65535');
    expect(ran.stdout).toBe('');
  });

  it('rejects a flag whose value is the next flag', async () => {
    const ran = await runToExit(['--preset', '--quiet']);

    expect(ran.code).toBe(2);
    expect(ran.stderr).toContain('--preset needs a value');
  });

  it('listens on the port it was told to', async () => {
    const target = await upstream();
    // Borrow a free port from the OS, release it, then demand it back. Racy in
    // principle, reliable in practice, and the alternative -- a hardcoded port
    // -- fails on any machine already using it.
    const scout = createServer();
    await new Promise<void>((done) =>
      scout.listen(0, '127.0.0.1', () => done())
    );
    const address = scout.address();
    const wanted = typeof address === 'object' && address ? address.port : 0;
    await new Promise<void>((done) => scout.close(() => done()));

    const { child, url } = await start([
      '--port',
      String(wanted),
      '--upstream',
      target.url,
      '--quiet',
    ]);
    running.push(child);

    expect(url).toBe(`http://127.0.0.1:${wanted}`);
  });
});
