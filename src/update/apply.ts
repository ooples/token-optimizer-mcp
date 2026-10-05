/**
 * Performing the upgrade, for the two install methods where performing it is
 * ours to do.
 *
 * `check.ts` answers whether a copy is behind and prints the command. This
 * module runs it -- and, just as importantly, refuses to run it for the four
 * methods where running it would be wrong:
 *
 *   - `NpxCache` has nothing to upgrade. The cache entry is immutable; the
 *     next `npx -y <pkg>@latest` fetches the newer one. Running that command
 *     here would EXECUTE this package rather than upgrade anything, and would
 *     then report success for work it did not do.
 *   - `ClaudePlugin` is upgraded by the client, through `/plugin update`. That
 *     is a slash command typed into an agent, not a program this process can
 *     spawn.
 *   - `SourceCheckout` is a developer's working tree. `npm install -g` over it
 *     replaces their work with a published copy.
 *   - `Unknown` is an install this package did not place and cannot speak for.
 *
 * So the surface is four named refusals and two real upgrades, and a refusal
 * says what to run instead whenever there is something to run. The alternative
 * -- one `upgrade()` that always claims to have done something -- is the
 * fabricated-success shape this repo has spent its whole history removing.
 *
 * NOTHING HERE RUNS ON ITS OWN. The upgrade happens when a person invokes
 * `token-optimizer-update`, never from the server, a hook or a check. An
 * installer that upgrades itself because it noticed a new version is an
 * install the operator did not consent to.
 */

import { execFileSafe } from '../utils/safe-exec.js';
import { UpdateState, type UpdateReport } from './check.js';
import {
  InstallMethod,
  PACKAGE_NAME,
  UPGRADABLE_METHODS,
  upgradeCommand,
} from './install-method.js';

/** How long an upgrade may take before it is abandoned. */
export const UPGRADE_TIMEOUT_MS = 300_000;

/** What happened, and the only values `applyUpdate` reports. */
export enum UpgradeOutcome {
  /** The upgrade command ran and exited zero. */
  Upgraded = 'Upgraded',
  /** Nothing to do: the installed copy is already the published one. */
  AlreadyCurrent = 'AlreadyCurrent',
  /** `--dry-run`: the command was printed and not run. */
  Planned = 'Planned',
  /** This install method is not one this package may upgrade in place. */
  NotOurs = 'NotOurs',
  /** The command ran and failed. */
  Failed = 'Failed',
}

export interface UpgradeResult {
  readonly outcome: UpgradeOutcome;
  /** The argv that ran, would have run, or null when there is none. */
  readonly argv: readonly string[] | null;
  /** One sentence naming what happened and what the reader should do. */
  readonly message: string;
  /** The command runner's output, when it ran. */
  readonly output: string | null;
}

/**
 * The upgrade command as argv, for the methods this package may upgrade.
 *
 * SEPARATE FROM `upgradeCommand` AND PINNED AGAINST IT. A shell string cannot
 * be spawned safely -- `shell: false` is what keeps a package name out of a
 * shell -- so the argv is the executable form and the string is the printable
 * one. A test asserts the two spell the same command for every enum member,
 * because two hand-written copies of one command is exactly how a tool ends up
 * printing one thing and running another.
 */
export function upgradeArgv(method: InstallMethod): readonly string[] | null {
  switch (method) {
    case InstallMethod.GlobalNpm:
      return Object.freeze(['npm', 'install', '-g', `${PACKAGE_NAME}@latest`]);
    case InstallMethod.ProjectDependency:
      return Object.freeze(['npm', 'install', `${PACKAGE_NAME}@latest`]);
    case InstallMethod.NpxCache:
      return Object.freeze(['npx', '-y', `${PACKAGE_NAME}@latest`]);
    case InstallMethod.ClaudePlugin:
    case InstallMethod.SourceCheckout:
    case InstallMethod.Unknown:
      return null;
  }
}

/** Why a method is not ours to upgrade, and what to do instead. */
function refusal(method: InstallMethod): string {
  switch (method) {
    case InstallMethod.NpxCache:
      return (
        'this copy is an npx cache entry, which is replaced rather than upgraded: ' +
        `run \`${upgradeCommand(method) ?? ''}\` when you next want the published version`
      );
    case InstallMethod.ClaudePlugin:
      return (
        'this copy was installed as a Claude Code plugin, so the client upgrades it: ' +
        `run \`${upgradeCommand(method) ?? ''}\` in your agent`
      );
    case InstallMethod.SourceCheckout:
      return (
        'this copy is a source checkout, and installing the published package over it ' +
        'would replace your working tree: pull and rebuild instead'
      );
    case InstallMethod.GlobalNpm:
    case InstallMethod.ProjectDependency:
    case InstallMethod.Unknown:
      return (
        'this copy is not in a location this package placed, so it will not be ' +
        'upgraded in place: reinstall it the way you installed it'
      );
  }
}

export interface ApplyOptions {
  /** Print the command instead of running it. */
  readonly dryRun?: boolean;
  /**
   * Upgrade even when the check says the installed copy is current. A reader
   * who has just been told they are current and asks anyway is answered.
   */
  readonly force?: boolean;
  /** Injected so a test never spawns a package manager. */
  readonly runner?: (
    file: string,
    args: readonly string[]
  ) => Promise<{ stdout: string; stderr: string }>;
  readonly cwd?: string;
}

/**
 * Upgrade this install, or say exactly why it was not touched.
 *
 * The report is passed in rather than fetched here so the decision and the
 * lookup stay separable: a caller that already ran `checkForUpdate` for its
 * own output does not ask the registry twice, and a test needs no network.
 */
export async function applyUpdate(
  report: UpdateReport,
  options: ApplyOptions = {}
): Promise<UpgradeResult> {
  const argv = upgradeArgv(report.method);

  if (!UPGRADABLE_METHODS.includes(report.method)) {
    return {
      outcome: UpgradeOutcome.NotOurs,
      argv: null,
      message: refusal(report.method),
      output: null,
    };
  }

  if (argv === null) {
    /*
     * Unreachable while UPGRADABLE_METHODS and upgradeArgv agree, and a test
     * pins that they do. It is here rather than asserted because a future
     * method added to one list and not the other must refuse, not run `npm`
     * with no arguments.
     */
    return {
      outcome: UpgradeOutcome.NotOurs,
      argv: null,
      message: `no upgrade command is defined for ${report.method}`,
      output: null,
    };
  }

  if (report.state === UpdateState.Current && options.force !== true) {
    return {
      outcome: UpgradeOutcome.AlreadyCurrent,
      argv,
      message: `already on ${report.installed}, the published latest; pass --force to install it again`,
      output: null,
    };
  }

  if (options.dryRun === true) {
    return {
      outcome: UpgradeOutcome.Planned,
      argv,
      message: `would run: ${argv.join(' ')}`,
      output: null,
    };
  }

  const [file, ...args] = argv;
  const run =
    options.runner ??
    ((executable: string, argumentList: readonly string[]) =>
      execFileSafe(executable, argumentList, {
        timeout: UPGRADE_TIMEOUT_MS,
        cwd: options.cwd,
      }));

  try {
    const { stdout, stderr } = await run(file, args);
    return {
      outcome: UpgradeOutcome.Upgraded,
      argv,
      message: `ran: ${argv.join(' ')}`,
      output: [stdout, stderr].filter((part) => part.length > 0).join('\n'),
    };
  } catch (error) {
    /*
     * The command's own output is what says why -- a registry 404, an EACCES
     * on a global prefix -- so it is reported rather than replaced with a
     * sentence of ours. There is nothing private in an npm install's output
     * for this package's own public name.
     */
    const parts =
      error && typeof error === 'object'
        ? [
            String((error as { stdout?: unknown }).stdout ?? ''),
            String((error as { stderr?: unknown }).stderr ?? ''),
          ].filter((part) => part.length > 0)
        : [];
    const reason = error instanceof Error ? error.message : String(error);
    return {
      outcome: UpgradeOutcome.Failed,
      argv,
      message: `\`${argv.join(' ')}\` failed: ${reason}`,
      output: parts.length > 0 ? parts.join('\n') : null,
    };
  }
}
