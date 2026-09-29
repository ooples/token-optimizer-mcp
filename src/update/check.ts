/**
 * One line for `doctor`: what is installed, what is published, and what to run.
 *
 * WHY THIS EXISTS AS A SEPARATE STEP FROM THE LOOKUP. A version behind is only
 * actionable alongside the install method -- `npm install -g` fixes a stale
 * global and silently does nothing for a stale copy in a project's
 * `node_modules`. Composing the two here keeps `doctor` from having to know the
 * rules, and keeps the rules testable without a network.
 *
 * AND WHY IT NEVER SAYS "UP TO DATE" WHEN IT DOES NOT KNOW. A check that cannot
 * reach the registry reports that it could not, because a reassuring line
 * printed from a failed lookup is worse than no line: it is the reader's
 * evidence that they looked.
 */

import { libraryVersion } from '../telemetry/recorder.js';
import {
  InstallMethod,
  describeInstallMethod,
  detectInstallMethod,
  upgradeCommand,
} from './install-method.js';
import { compareVersions, latestVersion } from './latest.js';

/** Where a copy stands against what is published. */
export enum UpdateState {
  /** Installed version equals the published one. */
  Current = 'Current',
  /** Something newer is published. */
  Behind = 'Behind',
  /** Installed version is newer -- a prerelease, or a local build. */
  Ahead = 'Ahead',
  /** The lookup did not answer, or a version could not be parsed. */
  Unknown = 'Unknown',
}

export interface UpdateReport {
  readonly state: UpdateState;
  readonly installed: string;
  readonly latest: string | null;
  readonly method: InstallMethod;
  /** What to run, or null when there is nothing this package should suggest. */
  readonly command: string | null;
  /** Why the state is Unknown, or null. */
  readonly refused: string | null;
}

/**
 * Ask, compare, and say what to do about it.
 *
 * `moduleUrl` defaults to this module's own location, which is the one that
 * answers the question for a real install; a test passes a path instead.
 */
export async function checkForUpdate(
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly fetcher?: typeof fetch;
    readonly moduleUrl?: string;
    readonly installed?: string;
  } = {}
): Promise<UpdateReport> {
  const method = detectInstallMethod(options.moduleUrl ?? import.meta.url);
  const installed = options.installed ?? libraryVersion();
  const lookup = await latestVersion({
    env: options.env,
    fetcher: options.fetcher,
  });
  if (lookup.version === undefined)
    return {
      state: UpdateState.Unknown,
      installed,
      latest: null,
      method,
      command: null,
      refused: lookup.refused,
    };

  const order = compareVersions(installed, lookup.version);
  if (order === null)
    return {
      state: UpdateState.Unknown,
      installed,
      latest: lookup.version,
      method,
      command: null,
      // `libraryVersion` answers 'unknown' rather than throwing when it cannot
      // find the manifest, so this branch is reached by a real installation and
      // has to name what happened rather than blame the registry.
      refused:
        installed === 'unknown'
          ? 'the installed version could not be read'
          : `${installed} is not a version this can compare`,
    };

  if (order === 0)
    return {
      state: UpdateState.Current,
      installed,
      latest: lookup.version,
      method,
      command: null,
      refused: null,
    };
  if (order > 0)
    return {
      state: UpdateState.Ahead,
      installed,
      latest: lookup.version,
      method,
      command: null,
      refused: null,
    };
  return {
    state: UpdateState.Behind,
    installed,
    latest: lookup.version,
    method,
    command: upgradeCommand(method),
    refused: null,
  };
}

/** The report as the lines `doctor` prints, without any leading indent. */
export function describeUpdate(report: UpdateReport): string[] {
  const where = describeInstallMethod(report.method);
  switch (report.state) {
    case UpdateState.Current:
      return [`version: ${report.installed}, the published latest, from ${where}`];
    case UpdateState.Ahead:
      return [
        `version: ${report.installed}, ahead of the published ${String(report.latest)}, from ${where}`,
      ];
    case UpdateState.Behind: {
      const lines = [
        `version: ${report.installed}, behind the published ${String(report.latest)}, from ${where}`,
      ];
      if (report.command === null)
        lines.push(
          '  this install is not one npm placed, so no upgrade command is suggested'
        );
      else lines.push(`  upgrade with: ${report.command}`);
      return lines;
    }
    case UpdateState.Unknown:
      return [
        `version: ${report.installed}, from ${where}`,
        `  whether that is current is unknown: ${report.refused ?? 'no reason given'}`,
      ];
  }
}