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

export type ToolProfile = 'core' | 'full';

export function resolveToolProfile(
  value = process.env.TOKEN_OPTIMIZER_TOOL_PROFILE
): ToolProfile {
  const profile = String(value || 'core')
    .trim()
    .toLowerCase();
  if (profile === 'core' || profile === 'full') return profile;

  throw new Error(
    `Invalid TOKEN_OPTIMIZER_TOOL_PROFILE=${JSON.stringify(value)}. ` +
      'Expected "core" (the default) or "full".'
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
  profile = resolveToolProfile()
): T[] {
  if (profile === 'full') return [...tools];

  const core = new Set<string>(CORE_TOOL_NAMES);
  const selected = tools.filter((tool) => core.has(tool.name));
  const selectedNames = new Set(selected.map((tool) => tool.name));
  const missing = CORE_TOOL_NAMES.filter((name) => !selectedNames.has(name));

  if (missing.length) {
    throw new Error(`Core MCP tool profile is missing: ${missing.join(', ')}`);
  }

  return selected;
}
