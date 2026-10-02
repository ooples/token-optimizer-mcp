/**
 * `token-optimizer-inspect` -- what did the proxy do to my last few requests?
 *
 * WHY THIS EXISTS. Every number this command prints was already being computed
 * on the request path, in full, for every request: `AccountingRecord` carries
 * the bytes before and after, the elisions, the deferred tools, the injected
 * knowledge and the provider's own billed token counts. It was built only when
 * an environment variable named a ledger file, and the only two things in the
 * repository that ever read that file are benchmark scripts. So the proxy could
 * tell you exactly what it had saved you, and there was no way to ask.
 *
 * READS NOTHING IT SHOULD NOT. The live window holds counts, durations,
 * statuses, fixed-vocabulary reasons and tool names -- no message, no system
 * prompt, no tool body, no response text. See the header of
 * `proxy/transformations.ts` for why that distinction is load-bearing: it is
 * what lets this be on by default instead of opt-in like `proxy/capture.ts`.
 *
 * TWO SOURCES, DELIBERATELY. With no arguments it asks the running supervisor,
 * which needs no setup and is what someone wants ten seconds after a turn felt
 * expensive. With `--ledger <path>` it reads a JSONL accounting ledger, which
 * survives a restart but only exists if it was configured in advance. Offering
 * only the second would have made the common question the harder one to ask.
 */

import { argv, stdout } from 'node:process';
import {
  supervisorTransformations,
  type TransformationWindow,
} from '../proxy/supervisor.js';
import { readLedger, type LedgerRead } from './ledger.js';
import { renderTransformations, totalsFor } from './render.js';
import type { AccountingRecord } from '../proxy/accounting.js';

const DEFAULT_LAST = 10;

/** What the command was asked to show. */
export interface Options {
  readonly last: number;
  readonly port: number | null;
  readonly ledger: string | null;
  readonly full: boolean;
  readonly json: boolean;
  readonly help: boolean;
}

const USAGE = [
  'token-optimizer-inspect -- what the proxy did to recent requests',
  '',
  'usage: token-optimizer-inspect [options]',
  '',
  '  --last <n>        how many transformations to show (default 10)',
  '  --port <n>        only the proxy listening on this port',
  '  --ledger <path>   read a JSONL accounting ledger instead of the live proxy',
  '  --full            every recorded field, not just the columns',
  '  --json            machine-readable output',
  '  -h, --help        this message',
  '',
  'With no --ledger it asks the running supervisor, which needs no setup and',
  'remembers the last 128 requests per listener in memory. A ledger is durable',
  'but has to be asked for in advance:',
  '  TOKEN_OPTIMIZER_PROXY_ACCOUNTING=/path/to/ledger.jsonl',
  '',
  // THE OTHER HALF OF THE SAME QUESTION. This command answers what happened
  // to individual requests; the money it added up to is a different bin, and
  // a reader who got this far is exactly the one who wants it.
  'This is the per-request view. For what the traffic was worth in money,',
  'token-optimizer-savings totals a ledger alongside MCP tool traffic.',
];

/**
 * Parses argv, or returns the refusal to print.
 *
 * A STRING IS A REFUSAL, which is the shape the other bins in this package use:
 * it keeps the parser pure and total, so every bad input is a value a test can
 * assert on rather than an exception or a process exit.
 */
export function parseArguments(args: readonly string[]): Options | string {
  let last = DEFAULT_LAST;
  let port: number | null = null;
  let ledger: string | null = null;
  let full = false;
  let json = false;
  let help = false;
  // A value that is itself a flag is a missing value, not a value. `--last
  // --json` means someone forgot the number, and silently reading `--json` as
  // the count would print a refusal about `--json` not being a number.
  const valueAt = (index: number): string | null => {
    const next = args[index + 1];
    return next === undefined || next.startsWith('--') ? null : next;
  };
  const positive = (raw: string): number | null => {
    const value = Number.parseInt(raw, 10);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '-h' || arg === '--help') help = true;
    else if (arg === '--full') full = true;
    else if (arg === '--json') json = true;
    else if (arg === '--last' || arg === '--port') {
      const raw = valueAt(index);
      if (raw === null) return `${arg} needs a number`;
      const value = positive(raw);
      if (value === null) return `${arg} must be a positive whole number`;
      if (arg === '--last') last = value;
      else port = value;
      index++;
    } else if (arg === '--ledger') {
      const raw = valueAt(index);
      if (raw === null) return `${arg} needs a path`;
      ledger = raw;
      index++;
    } else return `unknown option ${arg}`;
  }
  if (ledger !== null && port !== null)
    return '--port names a live listener, so it cannot be combined with --ledger';
  return { last, port, ledger, full, json, help };
}

/**
 * The outside world, injectable.
 *
 * The supervisor query, the ledger read and the writing are passed in rather
 * than reached for, so a test can drive every branch without a listening
 * supervisor, a file on disk, or output on the real stdout. Nothing in
 * production passes these -- the defaults are the real ones.
 */
export interface MainDependencies {
  readonly live?: (options: {
    readonly last?: number;
    readonly port?: number;
  }) => Promise<readonly TransformationWindow[] | null>;
  readonly ledger?: (path: string, last: number) => Promise<LedgerRead>;
  readonly write?: (text: string) => void;
}

/** One window's provenance, so a reader knows whose numbers these are. */
function heading(window: TransformationWindow): string {
  const parts = [`proxy on port ${window.port}`];
  if (window.upstream) parts.push(`-> ${window.upstream}`);
  if (window.project) parts.push(`(${window.project})`);
  if (window.dropped > 0)
    parts.push(`[${window.dropped} older records already evicted]`);
  return parts.join(' ');
}

/**
 * The machine-readable form.
 *
 * TOTALS ARE COMPUTED HERE RATHER THAN LEFT TO THE CALLER, because the one
 * thing that is genuinely easy to get wrong about these records is which
 * denominator a saving is taken over -- see `totalsFor`. A consumer that has to
 * re-derive it will eventually derive it differently from the table above it.
 */
export function inspectJson(
  source: 'proxy' | 'ledger',
  windows: readonly TransformationWindow[],
  skipped: number
): Record<string, unknown> {
  const all: AccountingRecord[] = windows.flatMap((window) => [
    ...window.records,
  ]);
  return {
    source,
    totals: totalsFor(all),
    ...(skipped > 0 ? { skipped } : {}),
    windows: windows.map((window) => ({
      port: window.port,
      ...(window.upstream ? { upstream: window.upstream } : {}),
      ...(window.project ? { project: window.project } : {}),
      held: window.held,
      dropped: window.dropped,
      records: window.records,
    })),
  };
}

export async function main(
  args: readonly string[],
  dependencies: MainDependencies = {}
): Promise<number> {
  const write =
    dependencies.write ?? ((text: string) => void stdout.write(text));
  const live =
    dependencies.live ??
    ((options) => supervisorTransformations(process.env, options));
  const ledger = dependencies.ledger ?? readLedger;
  const line = (text: string): void => write(`${text}\n`);
  const parsed = parseArguments(args);
  if (typeof parsed === 'string') {
    line(parsed);
    line('');
    for (const usage of USAGE) line(usage);
    return 2;
  }
  if (parsed.help) {
    for (const usage of USAGE) line(usage);
    return 0;
  }

  let source: 'proxy' | 'ledger';
  let windows: readonly TransformationWindow[];
  let skipped = 0;
  if (parsed.ledger !== null) {
    source = 'ledger';
    let read: LedgerRead;
    try {
      read = await ledger(parsed.ledger, parsed.last);
    } catch (error: unknown) {
      // The path is the caller's own and is the one thing they cannot derive
      // from a generic failure, so it is named; the reason comes from the
      // error because a permissions problem and a missing file need different
      // fixes and only the error knows which it was.
      line(
        `cannot read ledger ${parsed.ledger}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return 1;
    }
    skipped = read.skipped;
    // A ledger is one file, not a set of listeners, so it is presented as a
    // single window with a port of 0 rather than given a second output shape.
    windows = [
      {
        port: 0,
        held: read.records.length,
        dropped: 0,
        records: read.records,
      },
    ];
  } else {
    source = 'proxy';
    const found = await live({
      last: parsed.last,
      ...(parsed.port === null ? {} : { port: parsed.port }),
    });
    if (found === null) {
      line('no token-optimizer proxy is listening on this machine');
      line('');
      line('Start one, or let the hook start it, and run this again. A ledger');
      line('written by an earlier run can be read directly:');
      line('  token-optimizer-inspect --ledger <path>');
      return 1;
    }
    windows = found;
  }

  if (parsed.json) {
    line(JSON.stringify(inspectJson(source, windows, skipped), null, 2));
    return 0;
  }

  const carrying = windows.filter((window) => window.records.length > 0);
  if (carrying.length === 0) {
    // NOT AN ERROR. A proxy that is up and has served nothing yet is working
    // exactly as intended, and exiting non-zero here would make a healthy
    // machine look broken to whatever script asked.
    line(
      source === 'ledger'
        ? 'the ledger holds no transformation records'
        : 'the proxy is running but has not transformed a request yet'
    );
    if (skipped > 0)
      line(`${skipped} unreadable ${skipped === 1 ? 'line' : 'lines'} skipped`);
    return 0;
  }
  carrying.forEach((window, index) => {
    if (index > 0) line('');
    // A ledger has no port to name, and printing `proxy on port 0` would be a
    // lie about where the numbers came from.
    if (source === 'proxy') line(heading(window));
    for (const text of renderTransformations(window.records, {
      full: parsed.full,
    }))
      line(text);
  });
  if (skipped > 0)
    line(`${skipped} unreadable ${skipped === 1 ? 'line' : 'lines'} skipped`);
  return 0;
}

/*
 * Only when run as the bin -- the tests import this module and call main()
 * directly, and importing it for its parser must not open a socket.
 *
 * THE STATUS IS SET, NOT FORCED, for the reason recorded at the same place in
 * `update/cli.ts`: calling `process.exit()` while a socket is still closing
 * aborts the process on Windows with a libuv assertion, and the shell sees 127
 * instead of the status this command decided on. This one talks to a loopback
 * control port, so it has exactly that kind of handle open.
 */
const invoked = argv[1] ?? '';
if (/inspect[\\/]cli\.(js|ts)$/.test(invoked)) {
  main(argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      stdout.write(
        `token-optimizer-inspect failed: ${error instanceof Error ? error.message : String(error)}\n`
      );
      process.exitCode = 1;
    }
  );
}
