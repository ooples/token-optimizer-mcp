export const CORE_TOOL_NAMES = [
  'smart_read',
  'smart_write',
  'smart_edit',
  'smart_glob',
  'smart_grep',
  'optimize_text',
  'get_cached',
  'optimize_session',
  'get_optimization_report',
  'wiki_write',
  'wiki_read',
  'expand',
  'waste_audit',
  'cache_audit',
  'model_routing',
  'token_audit',
  'install_doctor',
  'fleet_audit',
] as const;

export const COGNITIVE_TOOL_NAMES = [
  'context_page',
  'context_receipt_verify',
  'cognition_record',
  'checkpoint_handoff',
  'outcome_report',
] as const;

export const CONTINUITY_TOOL_NAMES = [
  'context_page',
  'cognition_record',
] as const;

export const ATTESTATION_TOOL_NAMES = ['context_receipt_verify'] as const;

export type ToolProfile =
  | 'attestation'
  | 'continuity'
  | 'cognitive'
  | 'core'
  | 'full';
export type ExperimentArm = 'baseline' | 'optimizer' | 'retrieval' | 'full';

export function resolveExperimentArm(
  value = process.env.TOKEN_OPTIMIZER_EXPERIMENT_ARM
): ExperimentArm {
  const arm = String(value || 'full')
    .trim()
    .toLowerCase();
  if (['baseline', 'optimizer', 'retrieval', 'full'].includes(arm))
    return arm as ExperimentArm;
  throw new Error(
    `Invalid TOKEN_OPTIMIZER_EXPERIMENT_ARM=${JSON.stringify(value)}. ` +
      'Expected baseline, optimizer, retrieval, or full.'
  );
}

export function resolveToolProfile(
  value = process.env.TOKEN_OPTIMIZER_TOOL_PROFILE
): ToolProfile {
  const profile = String(value || 'core')
    .trim()
    .toLowerCase();
  if (
    profile === 'attestation' ||
    profile === 'continuity' ||
    profile === 'cognitive' ||
    profile === 'core' ||
    profile === 'full'
  )
    return profile;

  throw new Error(
    `Invalid TOKEN_OPTIMIZER_TOOL_PROFILE=${JSON.stringify(value)}. ` +
      'Expected "attestation", "continuity", "cognitive", "core" (the default), or "full".'
  );
}

/**
 * Select the definitions a client is allowed to see and call.
 *
 * The profile is enforced server-side rather than left only to a client config:
 * every MCP host gets the bounded default, and an unadvertised specialist tool
 * cannot still be invoked by name. A missing core definition is a startup error
 * because silently dropping wiki_write or expand would break the policy while
 * leaving tools/list looking superficially healthy.
 */
export function selectToolDefinitions<T extends { name: string }>(
  tools: readonly T[],
  profile = resolveToolProfile(),
  arm = resolveExperimentArm()
): T[] {
  const core = new Set<string>(CORE_TOOL_NAMES);
  const cognitive = new Set<string>(COGNITIVE_TOOL_NAMES);
  const continuity = new Set<string>(CONTINUITY_TOOL_NAMES);
  const attestation = new Set<string>(ATTESTATION_TOOL_NAMES);
  const selected =
    profile === 'full'
      ? [...tools]
      : tools.filter((tool) =>
          profile === 'attestation'
            ? attestation.has(tool.name)
            : profile === 'continuity'
              ? continuity.has(tool.name)
              : profile === 'cognitive'
                ? cognitive.has(tool.name)
                : core.has(tool.name)
        );
  const selectedNames = new Set(selected.map((tool) => tool.name));
  const missing =
    profile === 'attestation'
      ? ATTESTATION_TOOL_NAMES.filter((name) => !selectedNames.has(name))
      : profile === 'continuity'
        ? CONTINUITY_TOOL_NAMES.filter((name) => !selectedNames.has(name))
        : profile === 'core'
          ? CORE_TOOL_NAMES.filter((name) => !selectedNames.has(name))
          : profile === 'cognitive'
            ? COGNITIVE_TOOL_NAMES.filter((name) => !selectedNames.has(name))
            : [];

  if (missing.length) {
    throw new Error(
      `${profile} MCP tool profile is missing required tools: ${missing.join(', ')}`
    );
  }

  if (arm === 'baseline') return [];
  if (profile === 'attestation') return selected;
  if (profile === 'continuity' || profile === 'cognitive') {
    if (arm === 'optimizer') return [];
    if (arm === 'retrieval')
      return selected.filter((tool) => tool.name !== 'cognition_record');
    return selected;
  }
  if (arm === 'optimizer')
    return selected.filter(
      (tool) => !['wiki_read', 'wiki_write'].includes(tool.name)
    );
  if (arm === 'retrieval')
    return selected.filter((tool) => tool.name !== 'wiki_write');
  return selected;
}
