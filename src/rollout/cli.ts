#!/usr/bin/env node
/**
 * `token-optimizer-rollout` -- which behaviours are on, and why.
 *
 * WHY A COMMAND AND NOT JUST THE DOCTOR SECTION. `doctor` answers the question
 * for the environment it is running in. The question a person actually has is
 * conditional: "if I set the canary channel and ask for these two features,
 * what would I get?" Answering that through `doctor` means exporting variables
 * into a shell, running it, and remembering to unset them -- and if the answer
 * is "nothing changed" they cannot tell a wrong channel name from a feature
 * their channel does not carry.
 *
 * `resolveRollout` already took `requested`, `disabled` and `strict`, and no
 * shipped caller passed any of them. This is the surface those parameters were
 * written for: the doc comment on `parseChannel` calls it "the inspector".
 *
 * WHY --strict EXITS NON-ZERO. A typo in `TOKEN_OPTIMIZER_FEATURES` is
 * normally ignored on purpose, because a hook that dies over a misspelled flag
 * is worse than one that runs with a default. That leniency is wrong in CI,
 * where the whole point is to find out. `--strict` turns every refusal into a
 * failure so a pipeline can assert its own configuration is spelled correctly.
 *
 * READS NOTHING AND WRITES NOTHING. No cache, no network, no files: this
 * command resolves variables and prints the result.
 */

import { argv, env as processEnv, stdout } from 'node:process';
import { RolloutConfigurationError, allChannels } from './channel.js';
import {
  CHANNEL_ENV,
  DISABLE_ENV,
  REQUEST_ENV,
  ROLLOUT_SCHEMA_VERSION,
  type RolloutSnapshot,
  resolveRollout,
} from './resolve.js';
import { describeEveryFeature, describeRollout } from './describe.js';
import { POSTURE_ENV, applyPosture, postureFromEnv } from '../proxy/posture.js';

const USAGE = [
  'token-optimizer-rollout [options]',
  '',
  'Resolves the runtime feature rollout and prints what is on and why. This is',
  'runtime behaviour, not package releases -- for the published version see',
  'token-optimizer-update.',
  '',
  `  --channel <name>            try a channel instead of ${CHANNEL_ENV}`,
  `                              (${allChannels().join(', ')})`,
  `  --features <a,b>            request these as well as ${REQUEST_ENV}`,
  `  --disable-features <a,b>    switch these off as well as ${DISABLE_ENV}`,
  '  --all                       every feature and its state, not just a summary',
  '  --json                      the resolved snapshot as JSON',
  '  --strict                    exit 1 on any input that could not be used',
  '  -h, --help                  this text',
  '',
  `A posture named by ${POSTURE_ENV} is resolved here the same way the proxy`,
  'resolves it, so what this prints is what that proxy would run.',
];

interface Options {
  readonly channel: string | null;
  readonly requested: readonly string[];
  readonly disabled: readonly string[];
  readonly all: boolean;
  readonly json: boolean;
  readonly strict: boolean;
  readonly help: boolean;
}

/**
 * Parse argv, refusing a flag this command does not have and a flag that was
 * given no value.
 *
 * `--channel` with nothing after it silently becoming "no channel" is the
 * failure mode worth spending an error on: the reader asked a conditional
 * question and would be shown the unconditional answer.
 */
export function parseArguments(args: readonly string[]): Options | string {
  let channel: string | null = null;
  const requested: string[] = [];
  const disabled: string[] = [];
  let all = false;
  let json = false;
  let strict = false;
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const takesValue =
      arg === '--channel' ||
      arg === '--features' ||
      arg === '--disable-features';
    if (takesValue) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--'))
        return `${arg} needs a value`;
      index += 1;
      if (arg === '--channel') channel = value;
      else if (arg === '--features') requested.push(value);
      else disabled.push(value);
      continue;
    }
    switch (arg) {
      case '--all':
        all = true;
        break;
      case '--json':
        json = true;
        break;
      case '--strict':
        strict = true;
        break;
      case '-h':
      case '--help':
        help = true;
        break;
      default:
        return `unknown option ${arg}`;
    }
  }
  return { channel, requested, disabled, all, json, strict, help };
}

/**
 * The snapshot as plain data.
 *
 * Built field by field rather than handed to `JSON.stringify`, because the
 * snapshot carries methods: stringifying it directly would quietly drop
 * `digest()` -- the one field that lets two runs be compared -- and would pick
 * up whatever is added to the interface later without anyone deciding that it
 * belongs in a published shape.
 */
export function snapshotJson(
  snapshot: RolloutSnapshot
): Record<string, unknown> {
  return {
    schemaVersion: ROLLOUT_SCHEMA_VERSION,
    channel: snapshot.channel,
    registryDigest: snapshot.registryDigest,
    digest: snapshot.digest(),
    enabled: [...snapshot.enabled],
    refusals: [...snapshot.refusals],
    decisions: snapshot.decisions.map((decision) => ({
      name: decision.name,
      enabled: decision.enabled,
      reason: decision.reason,
      by: decision.by,
      availableIn: decision.availableIn,
      defaultEnabledIn: decision.defaultEnabledIn,
      env: decision.env,
    })),
  };
}

/** Injected so a test never reads the real environment or the real stdout. */
export interface MainDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly write?: (text: string) => void;
}

export async function main(
  args: readonly string[],
  dependencies: MainDependencies = {}
): Promise<number> {
  const write =
    dependencies.write ?? ((text: string) => void stdout.write(text));
  const baseEnv = dependencies.env ?? processEnv;

  const parsed = parseArguments(args);
  if (typeof parsed === 'string') {
    write(`${parsed}\n\n${USAGE.join('\n')}\n`);
    return 2;
  }
  if (parsed.help) {
    write(`${USAGE.join('\n')}\n`);
    return 0;
  }

  /*
   * A --channel is applied by overriding the variable rather than by a separate
   * code path, so the flag and the variable cannot disagree about what a name
   * means: both go through `parseChannel`, including its aliases and its
   * refusal for an unknown one.
   */
  const env: NodeJS.ProcessEnv =
    parsed.channel === null
      ? baseEnv
      : { ...baseEnv, [CHANNEL_ENV]: parsed.channel };

  /*
   * A POSTURE IS RESOLVED HERE TOO, OR THIS COMMAND UNDER-REPORTS.
   *
   * An operator who exported TOKEN_OPTIMIZER_POSTURE has asked for features by
   * name, and the proxy will seed them at start -- so an inspector that read the
   * variable and did not interpret it would print "not_requested" for every one
   * of them and be wrong about the process it exists to describe.
   *
   * ON A COPY, ALWAYS. This command reads and writes nothing, and that includes
   * its own environment: seeding `processEnv` would leave a resolved posture
   * behind for whatever else this process goes on to do.
   */
  const seeded: NodeJS.ProcessEnv = { ...env };
  const posture = applyPosture(postureFromEnv(env), seeded);
  const resolveEnv = posture === null ? env : seeded;

  let snapshot: RolloutSnapshot;
  try {
    snapshot = resolveRollout(resolveEnv, {
      requested: parsed.requested,
      disabled: parsed.disabled,
      strict: parsed.strict,
    });
  } catch (error) {
    if (error instanceof RolloutConfigurationError) {
      write(`${error.message}\n`);
      return 1;
    }
    throw error;
  }

  if (parsed.json) {
    write(`${JSON.stringify(snapshotJson(snapshot), null, 2)}\n`);
  } else {
    const body = parsed.all
      ? describeEveryFeature(snapshot)
      : describeRollout(snapshot);
    // NAMED BEFORE THE FEATURES, so a reader knows why half of them are on. The
    // unknown case is named too: a typo that resolved nothing prints exactly like
    // a plain default, which is the one output a reader must not have to guess at.
    const heading =
      posture === null
        ? []
        : [
            posture.posture === null
              ? `${POSTURE_ENV}="${posture.requested}" is not a posture this version knows; ignored.`
              : `posture ${posture.posture.name}, from ${POSTURE_ENV}`,
            '',
          ];
    write(`${[...heading, ...body].join('\n')}\n`);
  }

  /*
   * Without --strict a refusal is reported and the run is still a success,
   * which is the leniency the hooks depend on. With it, the refusal IS the
   * answer the caller asked for.
   */
  return parsed.strict && snapshot.refusals.length > 0 ? 1 : 0;
}

/*
 * Only when run as the bin. The tests import the parser and `main`, and that
 * import must not print anything.
 *
 * The status is set rather than forced, for the reason `update/cli.ts`
 * records: forcing the exit while a handle is closing aborts the process on
 * Windows and the shell sees 127 instead of the status this command decided.
 */
const invoked = process.argv[1] ?? '';
if (/rollout[\\/]cli\.(js|ts)$/.test(invoked)) {
  main(argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      stdout.write(
        `token-optimizer-rollout failed: ${error instanceof Error ? error.message : String(error)}\n`
      );
      process.exitCode = 1;
    }
  );
}
