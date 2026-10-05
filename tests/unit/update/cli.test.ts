/**
 * The `token-optimizer-update` command.
 *
 * The exit codes are the part a script reads, so they are pinned one by one:
 * `NotOurs` is 2 and not 1 because no retry fixes "this install is not mine to
 * upgrade", while a failed install might succeed next time. And an unknown
 * flag is an error rather than ignored noise -- `--dryrun` quietly dropped is
 * a real upgrade performed because of a typo.
 *
 * Nothing here reaches the registry or spawns a package manager: the lookup,
 * the apply and the writing are injected.
 */
import { describe, it, expect } from '@jest/globals';
import { exitCode, main, parseArguments } from '../../../src/update/cli.js';
import {
  UpgradeOutcome,
  type UpgradeResult,
} from '../../../src/update/apply.js';
import { UpdateState, type UpdateReport } from '../../../src/update/check.js';
import {
  InstallMethod,
  upgradeCommand,
} from '../../../src/update/install-method.js';

function report(
  state: UpdateState,
  method = InstallMethod.GlobalNpm
): UpdateReport {
  return {
    state,
    installed: '7.3.0',
    latest: state === UpdateState.Behind ? '7.4.0' : '7.3.0',
    method,
    command: upgradeCommand(method),
    refused: null,
  };
}

const UPGRADED: UpgradeResult = {
  outcome: UpgradeOutcome.Upgraded,
  argv: ['npm', 'install', '-g', 'x@latest'],
  message: 'ran: npm install -g x@latest',
  output: 'added 1 package',
};

/** Collects what the command printed, and what options it passed on. */
function harness(result: UpgradeResult = UPGRADED, state = UpdateState.Behind) {
  const written: string[] = [];
  const applied: unknown[] = [];
  return {
    text: () => written.join(''),
    applied,
    deps: {
      check: async () => report(state),
      apply: async (_report: UpdateReport, options: unknown) => {
        applied.push(options);
        return result;
      },
      write: (text: string) => void written.push(text),
    },
  };
}

describe('parseArguments', () => {
  it('defaults to upgrading, reporting, and no force', () => {
    expect(parseArguments([])).toEqual({
      dryRun: false,
      force: false,
      checkOnly: false,
      json: false,
      help: false,
    });
  });

  it('reads each flag it documents', () => {
    const parsed = parseArguments(['--dry-run', '--json']);
    expect(parsed).toMatchObject({ dryRun: true, json: true, force: false });
    expect(parseArguments(['--force'])).toMatchObject({ force: true });
    expect(parseArguments(['--check'])).toMatchObject({ checkOnly: true });
    expect(parseArguments(['-h'])).toMatchObject({ help: true });
    expect(parseArguments(['--help'])).toMatchObject({ help: true });
  });

  it('refuses an unknown flag instead of ignoring it', () => {
    expect(parseArguments(['--dryrun'])).toBe('unknown option --dryrun');
    expect(parseArguments(['--dry-run', '--wat'])).toBe('unknown option --wat');
  });

  it('refuses a positional argument, which this command has none of', () => {
    expect(parseArguments(['7.4.0'])).toBe('unknown option 7.4.0');
  });

  it('refuses --check combined with a flag that would change something', () => {
    const message =
      '--check reports only, so it cannot be combined with --dry-run or --force';
    expect(parseArguments(['--check', '--dry-run'])).toBe(message);
    expect(parseArguments(['--check', '--force'])).toBe(message);
  });

  it('allows --check with --json, which changes nothing', () => {
    expect(parseArguments(['--check', '--json'])).toMatchObject({
      checkOnly: true,
      json: true,
    });
  });
});

describe('exitCode', () => {
  it('is zero for the three outcomes that did what was asked', () => {
    expect(exitCode(UpgradeOutcome.Upgraded)).toBe(0);
    expect(exitCode(UpgradeOutcome.AlreadyCurrent)).toBe(0);
    expect(exitCode(UpgradeOutcome.Planned)).toBe(0);
  });

  it('separates a failed upgrade from one that was never ours to try', () => {
    expect(exitCode(UpgradeOutcome.Failed)).toBe(1);
    expect(exitCode(UpgradeOutcome.NotOurs)).toBe(2);
  });

  it('answers every outcome the enum has', () => {
    const outcomes = Object.values(UpgradeOutcome);
    expect(outcomes.length).toBeGreaterThan(0);
    for (const outcome of outcomes) {
      expect(Number.isInteger(exitCode(outcome))).toBe(true);
    }
  });
});

describe('main', () => {
  it('prints usage and exits clean for --help', async () => {
    const h = harness();
    await expect(main(['--help'], h.deps)).resolves.toBe(0);
    expect(h.text()).toContain('token-optimizer-update [options]');
    expect(h.applied).toHaveLength(0);
  });

  it('prints the message and usage for a bad flag, and exits 2', async () => {
    const h = harness();
    await expect(main(['--nope'], h.deps)).resolves.toBe(2);
    expect(h.text()).toContain('unknown option --nope');
    expect(h.text()).toContain('--dry-run');
    expect(h.applied).toHaveLength(0);
  });

  it('upgrades by default, and prints both the report and the result', async () => {
    const h = harness();
    await expect(main([], h.deps)).resolves.toBe(0);
    expect(h.applied).toEqual([{ dryRun: false, force: false }]);
    expect(h.text()).toContain('ran: npm install -g x@latest');
    expect(h.text()).toContain('added 1 package');
  });

  it('passes --dry-run and --force through to the apply', async () => {
    const h = harness();
    await main(['--dry-run'], h.deps);
    await main(['--force'], h.deps);
    expect(h.applied).toEqual([
      { dryRun: true, force: false },
      { dryRun: false, force: true },
    ]);
  });

  it('upgrades nothing with --check, and exits 1 when a newer version exists', async () => {
    const h = harness(UPGRADED, UpdateState.Behind);
    await expect(main(['--check'], h.deps)).resolves.toBe(1);
    expect(h.applied).toHaveLength(0);
    expect(h.text().length).toBeGreaterThan(0);
  });

  it('exits clean with --check when this copy is current', async () => {
    const h = harness(UPGRADED, UpdateState.Current);
    await expect(main(['--check'], h.deps)).resolves.toBe(0);
    expect(h.applied).toHaveLength(0);
  });

  it('exits clean with --check when the lookup could not answer', async () => {
    const h = harness(UPGRADED, UpdateState.Unknown);
    await expect(main(['--check'], h.deps)).resolves.toBe(0);
  });

  it('returns the outcome exit code, so a failed install is visible to a script', async () => {
    const failed: UpgradeResult = {
      outcome: UpgradeOutcome.Failed,
      argv: ['npm', 'install', '-g', 'x@latest'],
      message: '`npm install -g x@latest` failed: exit 1',
      output: 'npm error code EACCES',
    };
    const h = harness(failed);
    await expect(main([], h.deps)).resolves.toBe(1);
    expect(h.text()).toContain('npm error code EACCES');
  });

  it('returns 2 for an install that is not ours to upgrade', async () => {
    const notOurs: UpgradeResult = {
      outcome: UpgradeOutcome.NotOurs,
      argv: null,
      message: 'this copy is a source checkout',
      output: null,
    };
    const h = harness(notOurs);
    await expect(main([], h.deps)).resolves.toBe(2);
    expect(h.text()).toContain('source checkout');
  });

  it('emits parseable JSON carrying both the report and the result', async () => {
    const h = harness();
    await expect(main(['--json'], h.deps)).resolves.toBe(0);
    const parsed = JSON.parse(h.text()) as {
      report: UpdateReport;
      result: UpgradeResult;
    };
    expect(parsed.report.installed).toBe('7.3.0');
    expect(parsed.result.outcome).toBe(UpgradeOutcome.Upgraded);
  });

  it('emits JSON with only the report for --check --json', async () => {
    const h = harness();
    await expect(main(['--check', '--json'], h.deps)).resolves.toBe(1);
    const parsed = JSON.parse(h.text()) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['report']);
  });
});
