#!/usr/bin/env node
/**
 * Starts the compression proxy and prints the URL to point a client at.
 *
 * WHY A SEPARATE ENTRYPOINT. `startProxy` was reachable only as a library
 * function, so nothing could actually run it: not a user, not `doctor`, and not
 * the THOL rig, which launches a client inside a container and has nowhere to
 * call a TypeScript function from. The compression work therefore had no
 * end-to-end measurement available at all -- a gap that reads like "not
 * measured yet" and is really "cannot be measured yet".
 *
 * The output contract is deliberately narrow so a launcher can consume it:
 *
 *   STDOUT is exactly one line, the base URL.
 *   STDERR carries the banner and the per-request summaries.
 *
 * Nothing else is ever written to stdout, so a shell can capture it without
 * filtering, and a summary line can never be mistaken for the URL.
 */

import { startProxy, proxyEnabled } from './server.js';
import type { ProxySummary } from './server.js';

interface Args {
  readonly port: number;
  readonly upstream?: string;
  readonly preset?: string;
  readonly projectRoot?: string;
  readonly quiet: boolean;
  readonly help: boolean;
}

const DEFAULT_UPSTREAM = 'https://api.anthropic.com';

const USAGE = [
  'token-optimizer-proxy -- compression on the wire',
  '',
  '  token-optimizer-proxy [--port N] [--upstream URL] [--preset NAME]',
  '                        [--project-root DIR] [--quiet]',
  '',
  '  --port N          Listen on this port. Default 0, meaning any free port.',
  '  --upstream URL    Where to forward. Defaults to',
  '                    $TOKEN_OPTIMIZER_PROXY_UPSTREAM, else',
  '                    https://api.anthropic.com. Must be https, or http on',
  '                    loopback -- anything else is refused rather than putting',
  '                    your provider key on the wire in cleartext.',
  '  --preset NAME     balanced | aggressive | conservative | lossless.',
  "  --project-root D  Where to read this project's knowledge graph from.",
  '                    Default: the current directory.',
  '  --quiet           No per-request summaries on stderr.',
  '',
  '  Point a client at the printed URL through its own base-URL variable --',
  '  ANTHROPIC_BASE_URL for Claude Code. `token-optimizer-doctor` reports which',
  '  variable each of the 16 clients reads, and which of them cannot be',
  '  redirected at all.',
  '',
  '  Enable with TOKEN_OPTIMIZER_PROXY=1; running this command counts as that.',
  '  TOKEN_OPTIMIZER_MODE=off overrides it and the proxy refuses to start.',
  '',
  '  Stdout is exactly one line: the URL. Everything else is stderr.',
  '',
].join('\n');

class UsageError extends Error {}

export function parseArgs(argv: readonly string[]): Args {
  let port = 0;
  let upstream: string | undefined;
  let preset: string | undefined;
  let projectRoot: string | undefined;
  let quiet = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = (): string => {
      const next = argv[index + 1];
      // A missing value would otherwise swallow the NEXT flag as this one's
      // argument, so `--preset --quiet` would silently select a preset named
      // "--quiet" and drop the quiet flag.
      if (next === undefined || next.startsWith('--')) {
        throw new UsageError(`${flag} needs a value`);
      }
      index += 1;
      return next;
    };
    switch (flag) {
      case '--port': {
        const raw = value();
        const parsed = Number.parseInt(raw, 10);
        // Unparseable becomes NaN, and listen(NaN) quietly binds a RANDOM
        // port -- so the caller is told one thing and gets another.
        if (
          !Number.isInteger(parsed) ||
          String(parsed) !== raw.trim() ||
          parsed < 0 ||
          parsed > 65535
        ) {
          throw new UsageError(
            `--port must be an integer 0-65535, not '${raw}'`
          );
        }
        port = parsed;
        break;
      }
      case '--upstream':
        upstream = value();
        break;
      case '--preset':
        preset = value();
        break;
      case '--project-root':
        projectRoot = value();
        break;
      case '--quiet':
        quiet = true;
        break;
      case '--help':
      case '-h':
        help = true;
        break;
      default:
        throw new UsageError(`unknown option '${flag}'`);
    }
  }

  return { port, upstream, preset, projectRoot, quiet, help };
}

function summaryLine(summary: ProxySummary): string {
  const saved = summary.beforeBytes - summary.afterBytes;
  const percent =
    summary.beforeBytes > 0
      ? ((saved / summary.beforeBytes) * 100).toFixed(1)
      : '0.0';
  const injected = summary.injectedChars
    ? ` +${summary.injectedChars} injected`
    : '';
  const why = summary.compressed ? '' : ` (${summary.reason ?? 'skipped'})`;
  return (
    `${summary.path} ${summary.beforeBytes}B -> ${summary.afterBytes}B ` +
    `(${percent}%)${injected}${why}\n`
  );
}

export async function run(argv: readonly string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n\n${USAGE}`);
    return 2;
  }

  if (args.help) {
    process.stderr.write(USAGE);
    return 0;
  }

  // THE KILL SWITCH STILL WINS over running this deliberately. Someone who set
  // TOKEN_OPTIMIZER_MODE=off has said the product must do nothing, and a proxy
  // that ignored that would be the one component able to override it.
  if (process.env.TOKEN_OPTIMIZER_MODE === 'off') {
    process.stderr.write(
      'token-optimizer-proxy: TOKEN_OPTIMIZER_MODE=off, refusing to start.\n'
    );
    return 3;
  }
  // Running the command IS the opt-in, so the flag is set here for the checks
  // downstream that read it, rather than demanded of the caller as well.
  if (!proxyEnabled(process.env)) process.env.TOKEN_OPTIMIZER_PROXY = '1';

  let started: Awaited<ReturnType<typeof startProxy>>;
  try {
    started = await startProxy({
      port: args.port,
      upstream: args.upstream,
      preset: args.preset,
      projectRoot: args.projectRoot,
      onSummary: args.quiet
        ? undefined
        : (summary) => void process.stderr.write(summaryLine(summary)),
    });
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    return 1;
  }

  // ARMED BEFORE THE URL IS ANNOUNCED, because the URL is what tells a launcher the
  // proxy is ready -- and a launcher that reads it and immediately signals would
  // otherwise land in the window before these handlers exist and be killed by the
  // default disposition rather than shutting down. Caught by CI on Linux, where the
  // child exited with a null code and a SIGTERM signal; Windows hid it, because a
  // signal there is a forced termination either way.
  const stopped = new Promise<void>((resolve) => {
    const stop = (): void => {
      started.server.close(() => resolve());
      // Accepted sockets keep the server alive, and a streaming response can hold
      // one open for minutes. A proxy asked to stop should stop.
      started.server.closeAllConnections?.();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });

  const url = `http://127.0.0.1:${started.port}`;
  process.stdout.write(`${url}\n`);
  process.stderr.write(
    `token-optimizer proxy listening on ${url}, forwarding to ` +
      `${args.upstream || process.env.TOKEN_OPTIMIZER_PROXY_UPSTREAM || DEFAULT_UPSTREAM}\n`
  );

  await stopped;

  return 0;
}

// Only when run as a program. Importing this module -- which the tests do --
// must not start a listener.
if (process.argv[1] && /proxy[\\/]cli\.js$/.test(process.argv[1])) {
  run(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`token-optimizer-proxy: ${String(error)}\n`);
      process.exitCode = 1;
    }
  );
}
