/**
 * NAMED FULL-PROXY POSTURES, AND WHY THEY ARE NOT THE COMPRESSION PRESETS.
 *
 * `src/compress/options.ts` already has four names -- `balanced`, `aggressive`,
 * `conservative`, `lossless` -- and every one of them reaches exactly one thing:
 * the compression dials. Nothing a preset can say turns tool deferral on, nothing
 * it can say shapes a response, and nothing it can say changes how many tool
 * definitions stay loaded. An operator who wants the whole proxy leaned on has to
 * know eight environment variables by name and set them one at a time, which means
 * the configuration that actually saves the most is the one nobody can ask for.
 *
 * A POSTURE IS THAT ASK, AS ONE WORD. It names a compression preset, a set of
 * registry features, and the value-carrying variables that have no registry entry
 * because they carry a number rather than a yes. `applyPosture` seeds each of them
 * into the environment with setdefault semantics, so every reader in the package
 * keeps working untouched and an operator who set one explicitly still wins.
 *
 * THE NAME CARRIES THE CONSENT, WHICH IS THE WHOLE DESIGN.
 *
 * The features that are on in `Stable` are on because they were measured and kept,
 * and they are recoverable: a deferred tool schema is one search away, an elided
 * body is one `Read` away. The features that are NOT on by default in `Stable` are
 * a different kind of thing -- they change what the agent is given beyond what
 * shipping defaults chose, and some of them remove model reasoning that no offline
 * instrument can price. So:
 *
 *   A POSTURE MAY NAME A FEATURE THAT STABLE DOES NOT RUN BY DEFAULT ONLY IF THE
 *   POSTURE'S OWN NAME ENDS IN `-lossy`.
 *
 * That rule is derived from the registry rather than written down twice -- the
 * registry already records `defaultEnabledIn` for every feature -- and a test
 * enforces it, so a later posture cannot quietly acquire a response-side feature
 * while keeping a reassuring name. `max-lossy`, never `max`.
 *
 * AND THE CHANNEL STILL DECIDES. A posture does not set a feature's own variable;
 * it seeds `TOKEN_OPTIMIZER_FEATURES`, which is the existing "the operator asked
 * for it" channel, so `resolveRollout` applies exactly the rule it already applies
 * and reports `blocked_by_channel` for anything this channel does not carry. A
 * posture can ask. It cannot grant.
 *
 * WHAT A POSTURE MAY NEVER TOUCH. The four consent-bearing variables the feature
 * registry deliberately excludes -- proxy capture, the accounting ledger, and the
 * two measurement holdouts -- are absent here for the same reason they are absent
 * there: capture writes conversation content to a directory, a ledger writes a file,
 * and a holdout spends real money on a control arm. The operator has to say where
 * and how much, and a one-word posture cannot say it for them. A test pins this.
 */

import type { PresetName } from '../compress/options.js';
import { FeatureName, FEATURES } from '../rollout/features.js';
import { RolloutChannel } from '../rollout/channel.js';
import {
  DecisionReason,
  REQUEST_ENV,
  resolveRollout,
} from '../rollout/resolve.js';

/** The environment variable that names a posture. */
export const POSTURE_ENV = 'TOKEN_OPTIMIZER_POSTURE';

/**
 * The suffix a posture's name must carry to be allowed a non-default feature.
 *
 * NOT DECORATION. It is the only thing between an operator typing one word and a
 * proxy that drops thinking blocks out of the conversation, so it is checked by
 * `POSTURES`' own test rather than by whoever adds the next posture remembering.
 */
export const LOSSY_SUFFIX = '-lossy';

export const PostureName = {
  /** What the package ships. Named so an operator can say it back deliberately. */
  Default: 'default',
  /** Every lossless lever pulled: nothing here is unrecoverable. */
  Lean: 'lean',
  /** Deferral kept, elision held back. For a workload that re-reads. */
  Careful: 'careful',
  /** Nothing lossy at all, for comparing a transcript against an unmodified one. */
  Audit: 'audit',
  /** Lean, plus every response-side feature the channel will carry. */
  MaxLossy: 'max-lossy',
} as const;
export type PostureName = (typeof PostureName)[keyof typeof PostureName];

export interface Posture {
  readonly name: PostureName;
  /** One line, printed in the disclosure. */
  readonly summary: string;
  /** The compression preset this posture implies. */
  readonly compression: PresetName;
  /**
   * Registry features the posture ASKS for, seeded through `TOKEN_OPTIMIZER_FEATURES`.
   * The channel decides whether the ask is granted.
   */
  readonly features: readonly FeatureName[];
  /**
   * Value-carrying variables the posture pins.
   *
   * These have no registry entry because a registry entry is a yes-or-no and these
   * are numbers; every one of them must still be read by a shipped reader, which is
   * what `posture-readers.test.ts` proves by calling the reader rather than by
   * grepping for the name.
   */
  readonly values: Readonly<Record<string, string>>;
}

/** How many large tool definitions a lean posture keeps loaded. */
const LEAN_KEEP_TOOLS = '0';
/** Below how many characters a definition is exempt. Zero means nothing is. */
const LEAN_SMALL_TOOL_CHARS = '0';

export const POSTURES: Readonly<Record<PostureName, Posture>> = {
  [PostureName.Default]: {
    name: PostureName.Default,
    summary: 'shipping defaults, unchanged',
    compression: 'balanced',
    features: [],
    values: {},
  },
  [PostureName.Lean]: {
    name: PostureName.Lean,
    summary:
      'every lossless lever: aggressive compression, and no tool definition ' +
      'exempt from deferral',
    compression: 'aggressive',
    features: [],
    values: {
      TOKEN_OPTIMIZER_PROXY_KEEP_TOOLS: LEAN_KEEP_TOOLS,
      TOKEN_OPTIMIZER_PROXY_SMALL_TOOL_CHARS: LEAN_SMALL_TOOL_CHARS,
    },
  },
  [PostureName.Careful]: {
    name: PostureName.Careful,
    summary:
      'deferral kept, elision held back: for a workload that re-reads what it ' +
      'was sent',
    compression: 'conservative',
    features: [],
    values: {
      TOKEN_OPTIMIZER_PROXY_KEEP_TOOLS: '8',
      TOKEN_OPTIMIZER_PROXY_SMALL_TOOL_CHARS: '1500',
    },
  },
  [PostureName.Audit]: {
    name: PostureName.Audit,
    summary: 'nothing lossy: the request leaves recoverable in full',
    compression: 'lossless',
    features: [],
    values: {},
  },
  [PostureName.MaxLossy]: {
    name: PostureName.MaxLossy,
    summary:
      'lean, plus every response-side feature this channel carries -- shaped ' +
      'output, dropped thinking blocks, and a net-saving floor',
    compression: 'aggressive',
    features: [
      FeatureName.NetSavingGuard,
      FeatureName.OutputShaper,
      FeatureName.DropThinking,
      FeatureName.Substitution,
      FeatureName.ToolCodeMode,
    ],
    values: {
      TOKEN_OPTIMIZER_PROXY_KEEP_TOOLS: LEAN_KEEP_TOOLS,
      TOKEN_OPTIMIZER_PROXY_SMALL_TOOL_CHARS: LEAN_SMALL_TOOL_CHARS,
    },
  },
};

/** The variable a posture seeds to choose the compression dials. */
export const COMPRESSION_ENV = 'TOKEN_OPTIMIZER_COMPRESSION';

/**
 * Does a posture's name permit it the features it names?
 *
 * Exported because the test that enforces the rule has to ask the same question
 * the table was built to answer, and a rule checked by a copy of itself is not
 * checked at all.
 */
export function postureIsHonestlyNamed(posture: Posture): boolean {
  const reachesFurther = posture.features.some(
    (name) => FEATURES[name].defaultEnabledIn !== RolloutChannel.Stable
  );
  return !reachesFurther || posture.name.endsWith(LOSSY_SUFFIX);
}

/** Every variable any posture can write. Nothing outside this set is seeded. */
export function postureVariables(): readonly string[] {
  const names = new Set<string>([COMPRESSION_ENV, REQUEST_ENV]);
  for (const posture of Object.values(POSTURES)) {
    for (const name of Object.keys(posture.values)) names.add(name);
  }
  return [...names].sort((a, b) => a.localeCompare(b, 'en'));
}

export interface AppliedPosture {
  /** What the operator typed, verbatim. */
  readonly requested: string;
  /** Null when the name matched no posture. */
  readonly posture: Posture | null;
  /** Variables this call wrote, because nothing had set them. */
  readonly seeded: readonly string[];
  /** Variables left exactly as the operator had them. */
  readonly respected: readonly string[];
}

/** The posture the environment names, or undefined when it names none. */
export function postureFromEnv(
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const raw = env[POSTURE_ENV];
  if (raw === undefined || raw.trim() === '') return undefined;
  return raw.trim();
}

/**
 * Seed a posture's variables into the environment, without overriding any.
 *
 * SETDEFAULT, NOT ASSIGNMENT, and the distinction is the whole reason this is
 * safe to call at start-up. An operator who set `TOKEN_OPTIMIZER_PROXY_KEEP_TOOLS`
 * meant it; a posture that overwrote it would make the inspector, the doctor and
 * every reader in the package agree on a value the operator never chose. So an
 * already-set variable is reported as respected and left alone.
 *
 * A BLANK VARIABLE COUNTS AS UNSET, because every reader in this package already
 * treats it that way -- `keepToolsFromEnv`, `smallToolCharsFromEnv` and
 * `presetFromEnv` all fall through on an empty string. Treating it as set here
 * would mean `VAR= token-optimizer-proxy` quietly defeated the posture while
 * nothing else in the process could tell the difference.
 *
 * AN UNKNOWN NAME IS NOT FATAL AND NOT SILENT. The proxy fails open everywhere but
 * the cleartext-upstream check, so a typo must not take a session down -- but it
 * must not be swallowed either, which is why the name travels back on the result
 * for `postureNotice` to print.
 *
 * Returns null when no posture was asked for, which is the normal case.
 */
export function applyPosture(
  requested: string | undefined = postureFromEnv(),
  env: NodeJS.ProcessEnv = process.env
): AppliedPosture | null {
  if (requested === undefined || requested.trim() === '') return null;
  const name = requested.trim();
  const posture: Posture | undefined = (
    POSTURES as Readonly<Record<string, Posture>>
  )[name];
  if (posture === undefined) {
    return { requested: name, posture: null, seeded: [], respected: [] };
  }

  const wanted: Record<string, string> = {
    [COMPRESSION_ENV]: posture.compression,
    ...posture.values,
  };
  if (posture.features.length > 0) {
    wanted[REQUEST_ENV] = posture.features.join(',');
  }

  const seeded: string[] = [];
  const respected: string[] = [];
  for (const [key, value] of Object.entries(wanted)) {
    const existing = env[key];
    if (existing !== undefined && existing.trim() !== '') {
      respected.push(key);
      continue;
    }
    env[key] = value;
    seeded.push(key);
  }
  return { requested: name, posture, seeded, respected };
}

/**
 * The start-up disclosure. One block, printed every time, never once.
 *
 * MODELLED ON `captureNotice` DELIBERATELY, for the reason that notice gives: an
 * operator must not be able to leave something on by accident and not notice. A
 * posture is one word that can turn on five features, so the word is not evidence
 * that anyone understood what it did -- the block is. It names what is on, what the
 * channel refused, what of the operator's own settings it left alone, and the exact
 * variable that turns each thing off.
 *
 * IT REPORTS THE RESOLVER'S ANSWER, NOT THE POSTURE'S REQUEST. The posture asks;
 * `resolveRollout` decides. Printing the ask would claim features this channel
 * never carried, which is the failure this package keeps finding in its own code:
 * a capability that is named everywhere and reached nowhere.
 */
export function postureNotice(
  applied: AppliedPosture,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (applied.posture === null) {
    const known = Object.keys(POSTURES)
      .sort((a, b) => a.localeCompare(b, 'en'))
      .join(', ');
    return (
      `token-optimizer proxy: UNKNOWN POSTURE "${applied.requested}" -- IGNORED.\n` +
      `  Running shipping defaults. Known postures: ${known}.`
    );
  }

  const posture = applied.posture;
  const lines = [
    `token-optimizer proxy: POSTURE ${posture.name} -- ${posture.summary}.`,
  ];

  const snapshot = resolveRollout(env);
  const named = new Set<FeatureName>(posture.features);
  const on = snapshot.decisions.filter((d) => named.has(d.name) && d.enabled);
  const blocked = snapshot.decisions.filter(
    (d) => named.has(d.name) && d.reason === DecisionReason.BlockedByChannel
  );

  for (const decision of on) {
    lines.push(`  ON: ${decision.name} -- ${decision.env}=0 turns it off.`);
  }
  if (blocked.length > 0) {
    const names = blocked.map((d) => d.name).join(', ');
    lines.push(
      `  asked for, not carried by channel ${snapshot.channel}: ${names}.`
    );
  }
  if (applied.respected.length > 0) {
    lines.push(
      `  left as you set it: ${[...applied.respected].sort((a, b) => a.localeCompare(b, 'en')).join(', ')}.`
    );
  }
  lines.push(`  Unset ${POSTURE_ENV} to stop.`);
  return lines.join('\n');
}
