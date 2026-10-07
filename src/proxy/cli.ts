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

import { accountingPath } from './accounting.js';
import { startProxy, proxyEnabled } from './server.js';
import { captureDir, captureNotice } from './capture.js';
import { POSTURES, postureEnv, postureNotice } from './posture.js';
import type { ProxySummary } from './server.js';

interface Args {
  readonly port: number;
  readonly upstream?: string;
  readonly preset?: string;
  readonly posture?: string;
  readonly projectRoot?: string;
  readonly quiet: boolean;
  readonly spill: boolean;
  readonly help: boolean;
  /**
   * Print what the named posture sets and exit, instead of listening.
   *
   * NOT A MODE OF THE PROXY, A QUESTION ABOUT A POSTURE. An operator who runs
   * their agent under their own launcher still wants the posture's dials; with
   * no way to read them out, the only way to get them is to run our proxy, and
   * a posture would be a setting you cannot adopt without adopting the channel.
   */
  readonly printEnv: boolean;
  /** Print that set as a JSON object rather than shell exports. */
  readonly json: boolean;
}

const DEFAULT_UPSTREAM = 'https://api.anthropic.com';

const USAGE = [
  'token-optimizer-proxy -- compression on the wire',
  '',
  '  token-optimizer-proxy [--port N] [--upstream URL] [--preset NAME]',
  '                        [--posture NAME] [--project-root DIR] [--quiet]',
  '                        [--spill]',
  '  token-optimizer-proxy --posture NAME --print-env [--json]',
  '',
  '  --port N          Listen on this port. Default 0, meaning any free port.',
  '  --upstream URL    Where to forward. Defaults to',
  '                    $TOKEN_OPTIMIZER_PROXY_UPSTREAM, else',
  '                    https://api.anthropic.com. Must be https, or http on',
  '                    loopback -- anything else is refused rather than putting',
  '                    your provider key on the wire in cleartext.',
  '  --preset NAME     balanced | aggressive | conservative | lossless.',
  `  --posture NAME    ${Object.keys(POSTURES)
    .sort((a, b) => a.localeCompare(b, 'en'))
    .join(' | ')}.`,
  '                    A posture is a preset AND the features AND the dials, as',
  '                    one word. It SEEDS each variable, so --preset and any',
  '                    variable you exported yourself still win. A name ending',
  '                    in -lossy is the only kind allowed to turn on a feature',
  '                    this channel does not run by default; what it turned on',
  '                    is printed on stderr at start, every time.',
  "  --project-root D  Where to read this project's knowledge graph from.",
  '                    Default: the current directory.',
  '  --print-env       With --posture, print what that posture sets and exit.',
  '                    Shell export lines on stdout, so `eval "$(...)"` adopts',
  '                    it in your own launcher without running this proxy.',
  '                    --json prints the same set as a JSON object. Nothing is',
  '                    started, nothing is read, and no variable that records',
  '                    consent is ever in the set.',
  '  --quiet           No per-request summaries on stderr.',
  '  --spill           Let bodies the engines cannot describe leave the',
  '                    request, recoverable with a Read. Smaller requests,',
  '                    at one round trip each. Off by default.',
  '',
  '  Point a client at the printed URL through its own base-URL variable --',
  '  ANTHROPIC_BASE_URL for Claude Code. `token-optimizer-doctor` reports which',
  '  variable each of the 16 clients reads, and which of them cannot be',
  '  redirected at all.',
  '',
  '  Enabled by default; TOKEN_OPTIMIZER_PROXY=0 opts out.',
  '  TOKEN_OPTIMIZER_MODE=off overrides it and the proxy refuses to start.',
  '',
  '  Stdout is exactly one line: the URL. Everything else is stderr. Under',
  '  --print-env stdout is the printed set instead, and no proxy is started.',
  '',
].join('\n');

class UsageError extends Error {}

/**
 * Whether the environment asks for spilling.
 *
 * SPILL WAS FLAG-ONLY, and that meant only a hand-started proxy could withhold
 * anything: the SUPERVISED proxy -- the one a client's base URL actually points
 * at -- had no way to be told, so measuring the fetch rate on real traffic
 * would have needed every client repointed at an ad-hoc port that dies with
 * the shell that started it.
 *
 * IT IS CONSENT-BEARING and must never be seeded by a posture. Withholding
 * takes content out of a request and buys it back with a round trip, which is
 * a decision about someone's traffic rather than a dial -- the same reason
 * TOKEN_OPTIMIZER_PROXY_CAPTURE and ..._ACCOUNTING are operator-set only.
 *
 * Unset is off, and the words an operator reaches for to mean off are honoured
 * rather than read as a truthy string.
 */
export function spillFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.TOKEN_OPTIMIZER_PROXY_SPILL ?? '').trim().toLowerCase();
  // AN ALLOW-LIST, NOT A DENY-LIST, because this variable carries consent.
  // The first version listed the words meaning off and returned true for
  // everything else, so TOKEN_OPTIMIZER_PROXY_SPILL=no turned withholding ON.
  // A deny-list cannot be complete, and the failure direction here is enabling
  // something on an operator's traffic that they were refusing, so an
  // unrecognised value is not consent.
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

export function parseArgs(argv: readonly string[]): Args {
  let port = 0;
  let upstream: string | undefined;
  let preset: string | undefined;
  let posture: string | undefined;
  let projectRoot: string | undefined;
  let quiet = false;
  // `--spill` still wins; this is the default it starts from.
  let spill = spillFromEnv();
  let help = false;
  let printEnv = false;
  let json = false;

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
      case '--posture':
        posture = value();
        break;
      case '--project-root':
        projectRoot = value();
        break;
      case '--quiet':
        quiet = true;
        break;
      case '--spill':
        spill = true;
        break;
      case '--print-env':
        printEnv = true;
        break;
      case '--json':
        json = true;
        break;
      case '--help':
      case '-h':
        help = true;
        break;
      default:
        throw new UsageError(`unknown option '${flag}'`);
    }
  }

  // A FLAG THAT NAMES NOTHING IS A TYPO, NOT A DEFAULT. `--print-env` with no
  // posture has no answer to print, and guessing one -- the default posture, or
  // every posture at once -- would hand back a set the caller never asked for.
  if (printEnv && posture === undefined) {
    throw new UsageError('--print-env needs --posture NAME');
  }
  if (json && !printEnv) {
    throw new UsageError('--json only applies to --print-env');
  }

  return {
    port,
    upstream,
    preset,
    posture,
    projectRoot,
    quiet,
    spill,
    help,
    printEnv,
    json,
  };
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

/**
 * One value, quoted so a shell hands it back unchanged.
 *
 * SINGLE QUOTES, NOT JSON. A JSON string is double-quoted, and a double-quoted
 * shell word still expands `$`, a backtick and a backslash -- so the moment a
 * posture carried a value with one of those in it, `eval` would adopt something
 * other than what we printed. Inside single quotes a shell expands nothing; the
 * only character that needs handling is the quote itself, which closes the
 * string, is escaped outside it, and is reopened after.
 *
 * Exported for its own test: no posture carries a quote today, so a test that
 * only read real postures would pass with no quoting at all.
 */
export function shellQuote(value: string): string {
  const quote = "'";
  // A closing quote, an escaped quote, then a reopening one: '\''
  const escaped = quote + '\\' + quote + quote;
  return quote + value.split(quote).join(escaped) + quote;
}

/**
 * What `--print-env` writes to stdout: the posture's set, and nothing else.
 *
 * SORTED, because this output is something an operator will diff against their
 * own launcher and against the next release; insertion order is an accident of
 * how the posture table happens to be written.
 */
function renderPostureEnv(
  values: Readonly<Record<string, string>>,
  json: boolean
): string {
  const keys = Object.keys(values).sort((a, b) => a.localeCompare(b, 'en'));
  if (json) {
    const ordered: Record<string, string> = {};
    for (const key of keys) ordered[key] = values[key];
    return JSON.stringify(ordered, null, 2) + '\n';
  }
  return keys
    .map((key) => 'export ' + key + '=' + shellQuote(values[key]) + '\n')
    .join('');
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

  // ANSWERING A QUESTION IS NOT RUNNING, so this sits above the kill switch and
  // above every check that belongs to starting a listener. Nothing is bound,
  // nothing is read from disk, and the environment of this process is not
  // touched -- `postureEnv` reports what the posture means, not what it would
  // change here.
  if (args.printEnv && args.posture !== undefined) {
    const values = postureEnv(args.posture);
    if (values === null) {
      process.stderr.write(
        `token-optimizer-proxy: no posture named '${args.posture}'. ` +
          `Known: ${Object.keys(POSTURES)
            .sort((a, b) => a.localeCompare(b, 'en'))
            .join(', ')}.
`
      );
      return 2;
    }
    process.stdout.write(renderPostureEnv(values, args.json));
    return 0;
  }

  // THE KILL SWITCH STILL WINS over running this deliberately. Someone who set
  // TOKEN_OPTIMIZER_MODE=off has said the product must do nothing, and a proxy
  // that ignored that would be the one component able to override it.
  if (!proxyEnabled(process.env)) {
    process.stderr.write(
      'token-optimizer-proxy: disabled (TOKEN_OPTIMIZER_MODE=off or TOKEN_OPTIMIZER_PROXY=0).\n'
    );
    return 3;
  }
  // Running the command IS the opt-in, so the flag is set here for the checks
  // downstream that read it, rather than demanded of the caller as well.

  let started: Awaited<ReturnType<typeof startProxy>>;
  try {
    started = await startProxy({
      port: args.port,
      upstream: args.upstream,
      preset: args.preset,
      posture: args.posture,
      projectRoot: args.projectRoot,
      spill: args.spill,
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
    // ANNOUNCED EVERY TIME, never once and never quietly. Capture writes
    // conversation content to disk, which is the opposite of what this proxy
    // otherwise promises, so an operator must not be able to leave it on by
    // accident and not notice.
    (captureDir() ? `${captureNotice(captureDir() ?? '')}\n` : '') +
      // THE SAME PROMISE, FOR THE SAME REASON. A posture is one word that can turn
      // on five features and pin six variables, so the word is not evidence anyone
      // understood what it did. This block is: it names what the resolver actually
      // enabled, what the channel refused, and the variable that turns each off.
      // Unknown names are announced too, rather than silently running defaults.
      (started.posture === null
        ? ''
        : `${postureNotice(started.posture)}
`) +
      `token-optimizer proxy listening on ${url}, forwarding to ` +
      `${args.upstream || process.env.TOKEN_OPTIMIZER_PROXY_UPSTREAM || DEFAULT_UPSTREAM}` +
      // NAMED HERE because whoever reads this line is the one reader who will
      // later want it: a proxy that has just started saves nothing yet, and the
      // question "did that actually do anything" arrives a few turns later with
      // nothing on screen to answer it.
      // TWO QUESTIONS, NOT ONE. `inspect` answers what happened to the last
      // few requests; the money question is answered by `savings`, and only
      // if a ledger is being written -- so when there is none, the line says
      // what to set instead of naming a command that would find nothing.
      `\nask what it did: token-optimizer-inspect\n` +
      (accountingPath() === null
        ? `total what it saves: set TOKEN_OPTIMIZER_PROXY_ACCOUNTING to a path, then run token-optimizer-savings\n`
        : `what it saved: token-optimizer-savings\n`)
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
