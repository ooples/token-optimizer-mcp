#!/usr/bin/env node
/**
 * `token-optimizer-update` -- is this copy behind, and upgrade it if it is.
 *
 * WHY A SEPARATE BIN RATHER THAN A FLAG ON `doctor`. `doctor` reports; it must
 * stay safe to run on anything at any time. Upgrading changes what is
 * installed, so it is its own command that a person types on purpose. Nothing
 * in the server, the daemon or a hook calls this.
 *
 * WHAT IT WILL NOT DO. Four of the six install methods are refused by name --
 * an npx cache entry, a Claude Code plugin, a source checkout, and an install
 * this package did not place -- because running `npm install` for those would
 * either do nothing while reporting success or overwrite a developer's tree.
 * The refusal names the method and what to run instead. See `apply.ts`.
 *
 * NO NETWORK WRITES, NO TELEMETRY. The only request is the registry lookup
 * that `checkForUpdate` already makes for `doctor`.
 */

import { argv, stdout } from 'node:process';
import type { UpdateReport } from './check.js';
import { UpdateState, checkForUpdate, describeUpdate } from './check.js';
import type { ApplyOptions, UpgradeResult } from './apply.js';
import { UpgradeOutcome, applyUpdate } from './apply.js';

const USAGE = [
  'token-optimizer-update [options]',
  '',
  'Compares this install against the published version and upgrades it when a',
  'newer one exists. Prints what it would do and changes nothing with --dry-run.',
  '',
  '  --dry-run     print the command instead of running it',
  '  --force       run the install even when this copy is already current',
  '  --check       report only, and exit 1 when a newer version exists',
  '  --json        print the report and the outcome as JSON',
  '  -h, --help    this text',
];

interface Options {
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly checkOnly: boolean;
  readonly json: boolean;
  readonly help: boolean;
}

/**
 * Parse argv, refusing a flag this command does not have.
 *
 * An unknown flag is an error rather than ignored noise: `--dryrun` silently
 * ignored is an upgrade the reader did not ask for, performed because of a
 * typo.
 */
export function parseArguments(args: readonly string[]): Options | string {
  const options = {
    dryRun: false,
    force: false,
    checkOnly: false,
    json: false,
    help: false,
  };
  for (const arg of args) {
    switch (arg) {
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--force':
        options.force = true;
        break;
      case '--check':
        options.checkOnly = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        return `unknown option ${arg}`;
    }
  }
  if (options.checkOnly && (options.dryRun || options.force)) {
    return '--check reports only, so it cannot be combined with --dry-run or --force';
  }
  return options;
}

/**
 * The exit code for an outcome.
 *
 * `Planned` and `AlreadyCurrent` are zero: the command did what was asked.
 * `NotOurs` is 2 rather than 1 so a script can tell "this install is not mine
 * to upgrade" -- which no retry fixes -- from "the upgrade failed", which one
 * might.
 */
export function exitCode(outcome: UpgradeOutcome): number {
  switch (outcome) {
    case UpgradeOutcome.Upgraded:
    case UpgradeOutcome.AlreadyCurrent:
    case UpgradeOutcome.Planned:
      return 0;
    case UpgradeOutcome.Failed:
      return 1;
    case UpgradeOutcome.NotOurs:
      return 2;
  }
}

/**
 * The three things this command does to the outside world, injectable.
 *
 * The registry lookup, the package-manager spawn and the writing are passed in
 * rather than reached for so a test can drive every branch of this function
 * without a network request, a spawned `npm`, or output on the real stdout.
 * Nothing in production passes these -- the defaults are the real ones -- so
 * the shipped path is the same code the tests exercise, minus the seams.
 */
export interface MainDependencies {
  readonly check?: () => Promise<UpdateReport>;
  readonly apply?: (
    report: UpdateReport,
    options: ApplyOptions
  ) => Promise<UpgradeResult>;
  readonly write?: (text: string) => void;
}

export async function main(
  args: readonly string[],
  dependencies: MainDependencies = {}
): Promise<number> {
  const write =
    dependencies.write ?? ((text: string) => void stdout.write(text));
  const check = dependencies.check ?? checkForUpdate;
  const apply = dependencies.apply ?? applyUpdate;
  const parsed = parseArguments(args);
  if (typeof parsed === 'string') {
    write(`${parsed}\n\n${USAGE.join('\n')}\n`);
    return 2;
  }
  if (parsed.help) {
    write(`${USAGE.join('\n')}\n`);
    return 0;
  }

  const report = await check();

  if (parsed.checkOnly) {
    if (parsed.json) {
      write(`${JSON.stringify({ report }, null, 2)}\n`);
    } else {
      write(`${describeUpdate(report).join('\n')}\n`);
    }
    // A newer version existing is the one thing --check is asked about, so it
    // is reported through the exit code as well as the text.
    return report.state === UpdateState.Behind ? 1 : 0;
  }

  const result = await apply(report, {
    dryRun: parsed.dryRun,
    force: parsed.force,
  });

  if (parsed.json) {
    write(`${JSON.stringify({ report, result }, null, 2)}\n`);
  } else {
    write(`${describeUpdate(report).join('\n')}\n${result.message}\n`);
    if (result.output !== null) write(`${result.output}\n`);
  }
  return exitCode(result.outcome);
}

/*
 * Only when run as the bin. Imported by the tests, which call main()
 * directly, and importing this module for its parser must not reach the
 * registry.
 *
 * THE STATUS IS SET, NOT FORCED. Calling `process.exit()` here aborted the
 * process on Windows -- a libuv assertion in `async.c` -- because the
 * registry lookup's socket was still closing, and the shell saw 127 instead
 * of the 0, 1 or 2 this command decided on. Setting `exitCode` and letting
 * the loop drain reports the real status and still exits in milliseconds
 * once the response has been read.
 */
const invoked = process.argv[1] ?? '';
if (/update[\\/]cli\.(js|ts)$/.test(invoked)) {
  main(argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      stdout.write(
        `token-optimizer-update failed: ${error instanceof Error ? error.message : String(error)}\n`
      );
      process.exitCode = 1;
    }
  );
}
