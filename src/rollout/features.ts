/**
 * The feature registry: what can be turned on, where it lives, and who decides.
 *
 * WHY THIS FILE EXISTS. This package reads 129 distinct TOKEN_OPTIMIZER_* switches
 * spread across src/ and hooks-core/, each parsed at its own call site with its own
 * idea of what counts as "on". There was no way to ask which of them were active,
 * no way to learn one had been set to a value that does nothing, and no way to
 * turn on a group of experiments without knowing all their names. This registry is
 * the inventory those switches never had, for the subset that are genuinely
 * behaviour flags.
 *
 * WHAT IS DELIBERATELY NOT HERE. A switch that carries a VALUE is not a feature
 * flag, even when it reads like one. TOKEN_OPTIMIZER_PROXY_CAPTURE names a
 * directory, TOKEN_OPTIMIZER_PROXY_ACCOUNTING names a ledger path,
 * TOKEN_OPTIMIZER_CROSS_PROJECT_SCAN is a count, TOKEN_OPTIMIZER_OUTPUT_HOLDOUT is
 * a fraction. Registering those would let a channel default enable them, and "the
 * channel turned capture on" means conversation content written to a directory
 * nobody chose. capture.ts says exactly this at its own read and it is right: the
 * operator has to say WHERE, which is the proof they decided to keep it.
 *
 * WHY THE HOOK SWITCHES ARE ABSENT. hooks-core/ imports nothing from dist/ -- the
 * hook binaries have to run when the build is broken, which is the case the doctor
 * exists for. So a channel resolved here cannot reach TOKEN_OPTIMIZER_HARVEST_FULL
 * or TOKEN_OPTIMIZER_OUTPUT_DISCIPLINE, and registering them would make the
 * inspector claim a channel controls something no channel can touch. A registry
 * entry has to be wired to a call site that reads it, or it is documentation
 * pretending to be a mechanism.
 * * THE ENV NAME IS THE CONTRACT. Each feature keeps the switch it already shipped
 * with, and that switch still wins over the channel -- see resolve.ts for why
 * silently overriding a variable a user has already set is not an option.
 */

import { RolloutChannel, normalise } from './channel.js';
import { createHash } from 'node:crypto';

export enum FeatureName {
  DeferTools = 'defer_tools',
  DropThinking = 'drop_thinking',
  Substitution = 'substitution',
  ToolCodeMode = 'tool_code_mode',
  OutputShaper = 'output_shaper',
  NetSavingGuard = 'net_saving_guard',
  KnowledgeInjection = 'knowledge_injection',
  SharedGraph = 'shared_graph',
  AutoRepair = 'auto_repair',
  StrictCache = 'strict_cache',
}

export interface FeatureSpec {
  readonly name: FeatureName;
  /** The switch this feature already shipped with. Still authoritative. */
  readonly env: string;
  /** The narrowest channel that may run it at all. */
  readonly availableIn: RolloutChannel;
  /** The narrowest channel that runs it WITHOUT being asked, or null for never. */
  readonly defaultEnabledIn: RolloutChannel | null;
  /**
   * Words this switch accepts as "on" beyond the usual affirmatives.
   *
   * A few of these variables carry a MODE as well as a state --
   * TOKEN_OPTIMIZER_PROXY_DROP_THINKING=all both turns the feature on and says how
   * far to go. Without this, the resolver would report `all` as an unusable value
   * and tell the user it was ignored, while the call site honoured it: the
   * inspector would be lying about the one thing it exists to report. The mode
   * itself stays at the call site, which is the only place that knows what it means.
   */
  readonly extraOnValues?: readonly string[];
  readonly description: string;
}

/**
 * Every entry's channel placement is a claim about evidence, not a preference:
 * `defaultEnabledIn: null` means request-only, and it is not the same as "not yet
 * rolled out". No channel ever turns one of these on by itself, however wide it is,
 * because each either changes what the model writes (the output shaper, dropping
 * thinking, substitution, the net-saving guard) or forces an answer the code would
 * otherwise work out for itself (the shared graph, the strict cache). A channel is
 * a risk tier a user opted into, and neither of those is a risk a tier can carry
 * on someone else's behalf -- the widest channel still only makes them askable.
 * * `defaultEnabledIn: Stable` means this was measured and kept, and anything else
 * means it was not. Two entries here are default-on because they already shipped
 * that way, and moving them would be a behaviour change disguised as a refactor.
 */
export const FEATURES: Readonly<Record<FeatureName, FeatureSpec>> = {
  [FeatureName.DeferTools]: {
    name: FeatureName.DeferTools,
    env: 'TOKEN_OPTIMIZER_PROXY_DEFER_TOOLS',
    availableIn: RolloutChannel.Stable,
    defaultEnabledIn: RolloutChannel.Stable,
    description:
      'Defer whole tool definitions until a tool is used. Measured better than ' +
      'compacting them on 3 of 4 rows, and already default-on.',
  },
  [FeatureName.KnowledgeInjection]: {
    name: FeatureName.KnowledgeInjection,
    env: 'TOKEN_OPTIMIZER_PROXY_KNOWLEDGE',
    availableIn: RolloutChannel.Stable,
    defaultEnabledIn: RolloutChannel.Stable,
    description:
      'Put established findings into the cached prefix. Default-on with the ' +
      'proxy; it never rewrites the prefix mid-conversation.',
  },
  [FeatureName.NetSavingGuard]: {
    name: FeatureName.NetSavingGuard,
    env: 'TOKEN_OPTIMIZER_PROXY_NET_SAVING',
    availableIn: RolloutChannel.Stable,
    defaultEnabledIn: null,
    description:
      'Refuse to send a body larger than the client wrote. Off by default so a ' +
      'measurement can see the growth instead of a silent fallback.',
  },
  [FeatureName.OutputShaper]: {
    name: FeatureName.OutputShaper,
    env: 'TOKEN_OPTIMIZER_OUTPUT_SHAPER',
    availableIn: RolloutChannel.Beta,
    defaultEnabledIn: null,
    description:
      'Shape the response side. Changes what the model writes, so it is never ' +
      'a default.',
  },
  [FeatureName.Substitution]: {
    name: FeatureName.Substitution,
    env: 'TOKEN_OPTIMIZER_PROXY_SUBSTITUTE',
    availableIn: RolloutChannel.Canary,
    defaultEnabledIn: null,
    description:
      'Substitute rather than elide history. Removes model reasoning, and ' +
      'whether that cost the model something no offline instrument can answer.',
  },
  [FeatureName.DropThinking]: {
    name: FeatureName.DropThinking,
    env: 'TOKEN_OPTIMIZER_PROXY_DROP_THINKING',
    availableIn: RolloutChannel.Canary,
    defaultEnabledIn: null,
    extraOnValues: ['all'],
    description:
      'Drop older thinking blocks. A real turn reduction on n=1 per task over ' +
      'four tasks: enough to stop, not enough to have proven a mechanism.',
  },
  [FeatureName.ToolCodeMode]: {
    name: FeatureName.ToolCodeMode,
    env: 'TOKEN_OPTIMIZER_PROXY_TOOL_CODE',
    availableIn: RolloutChannel.Canary,
    defaultEnabledIn: RolloutChannel.Canary,
    description: 'Present tools as code on the Responses path.',
  },
  [FeatureName.SharedGraph]: {
    name: FeatureName.SharedGraph,
    env: 'TOKEN_OPTIMIZER_GRAPH_SHARED',
    availableIn: RolloutChannel.Beta,
    defaultEnabledIn: null,
    description:
      'Treat the knowledge graph as shared across projects. Inferred from the ' +
      'directory when unset, so this only forces the answer.',
  },
  [FeatureName.AutoRepair]: {
    name: FeatureName.AutoRepair,
    env: 'TOKEN_OPTIMIZER_AUTO_REPAIR',
    availableIn: RolloutChannel.Beta,
    defaultEnabledIn: RolloutChannel.Beta,
    description: 'Repair a broken install in place instead of reporting it.',
  },

  [FeatureName.StrictCache]: {
    name: FeatureName.StrictCache,
    env: 'TOKEN_OPTIMIZER_CACHE_STRICT',
    availableIn: RolloutChannel.Beta,
    defaultEnabledIn: null,
    description:
      'Fail rather than fall back to an in-memory cache. For a test or a run ' +
      'that must not silently persist nothing.',
  },
};

export function allFeatures(): readonly FeatureSpec[] {
  return Object.values(FEATURES).sort((a, b) => a.name.localeCompare(b.name));
}

/** The feature a name refers to, or null. Accepts hyphens for underscores. */
export function featureFor(value: string): FeatureSpec | null {
  const wanted = normalise(value);
  for (const spec of allFeatures()) if (spec.name === wanted) return spec;
  return null;
}

export function featureNames(): readonly string[] {
  return allFeatures().map((spec) => spec.name);
}

let digest: string | null = null;

/**
 * A stable identity for every field of this registry that changes a decision.
 *
 * Memoised because the registry cannot change within a process, and because the
 * resolve path is called from single-flag helpers that run per request -- hashing
 * eleven entries on each of those would be a cost paid for nothing.
 *
 * The description is deliberately excluded: reworded prose would otherwise make
 * two runs of identical behaviour look like different configurations, which is
 * the one thing a digest exists to rule out.
 */
export function registryDigest(): string {
  if (digest !== null) return digest;
  const canonical = allFeatures().map((spec) => ({
    name: spec.name,
    env: spec.env,
    available_in: spec.availableIn,
    default_enabled_in: spec.defaultEnabledIn,
  }));
  digest =
    'sha256:' +
    createHash('sha256')
      .update(JSON.stringify(canonical), 'utf8')
      .digest('hex');
  return digest;
}
