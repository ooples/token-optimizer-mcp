// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/capabilities.mjs. Regenerate with `npm run sync:hooks`.
/**
 * The product's honest cross-client capability contract.
 *
 * A client is listed at the strongest surface its public lifecycle protocol can
 * actually support.  This registry is consumed by the adapter, certification
 * tooling, and evidence reports so a rules-only integration can never be
 * presented as equivalent to a native stop-continuation integration.
 */

export const CAPABILITY_TIERS = Object.freeze({
  CONTINUATION: 'lifecycle-continuation',
  OBSERVATION: 'native-observation',
  RULES: 'mcp-rules',
});

/**
 * MCP tools whose presence changes hook behaviour.
 *
 * A hook and an MCP server are separate processes. Installing both does not
 * prove that the current host registered the server's schemas: the server may
 * have failed to start, the host may have disabled it, or a bounded tool
 * profile may deliberately omit the file tools. The old hook treated install
 * intent as runtime fact and could deny Grep only to point at a `smart_grep`
 * schema the model did not have.
 *
 * Keep this list deliberately smaller than the full catalog. These are the
 * names a lifecycle hook may mention or substitute, so these are the names for
 * which it needs positive inventory evidence.
 */
export const HOOK_MCP_TOOLS = Object.freeze([
  'smart_read',
  'smart_write',
  'smart_edit',
  'smart_glob',
  'smart_grep',
  'optimize_session',
  'get_optimization_report',
  'wiki_write',
  // The read side of the graph. The session index tells the model to "call
  // wiki_query with a key for detail", so the hook needs positive evidence that
  // the name it is advertising is actually registered in this host.
  'wiki_query',
]);

const HOOK_MCP_TOOL_SET = new Set(HOOK_MCP_TOOLS);
const INVENTORY_KEYS = new Set([
  'availabletools',
  'mcptools',
  'registeredtools',
  'toolinventory',
  'toolnames',
]);
const INVENTORY_CONTAINERS = new Set([
  'capabilities',
  'context',
  'mcp',
  'session',
]);

/** Convert a host-qualified MCP name back to the schema name. */
function optimizerToolName(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  for (const name of HOOK_MCP_TOOLS) {
    if (
      normalized === name ||
      normalized.endsWith(`__${name}`) ||
      normalized.endsWith(`.${name}`) ||
      normalized.endsWith(`/${name}`) ||
      normalized.endsWith(`:${name}`)
    )
      return name;
  }
  return null;
}

function addInventoryValue(value, names) {
  if (Array.isArray(value)) {
    for (const item of value) addInventoryValue(item, names);
    return;
  }
  if (typeof value === 'string') {
    // Environment configuration commonly uses either CSV or JSON. A host
    // payload normally supplies one name per array item; accepting both shapes
    // keeps the explicit contract portable without guessing from prose.
    let parsed = null;
    if (/^\s*\[/.test(value)) {
      try {
        parsed = JSON.parse(value);
      } catch {
        parsed = null;
      }
    }
    if (Array.isArray(parsed)) {
      addInventoryValue(parsed, names);
      return;
    }
    for (const item of value.split(/[\s,]+/)) {
      const name = optimizerToolName(item);
      if (name) names.add(name);
    }
    return;
  }
  if (value && typeof value === 'object') {
    const name = optimizerToolName(
      value.name ?? value.tool_name ?? value.toolName
    );
    if (name) names.add(name);
  }
}

/**
 * Extract positive, tool-by-tool registration evidence supplied by the host.
 *
 * `proven: false` is intentionally different from an empty proven inventory.
 * Both fail open, but the distinction lets a SessionStart inventory be carried
 * into later hook processes only when the host actually supplied one. The
 * TOKEN_OPTIMIZER_MCP_CAPABILITIES environment variable is the portable escape
 * hatch for hosts whose hook payload has no inventory field; it must enumerate
 * exact registered names and is never inferred from TOOL_PROFILE.
 */
export function optimizerToolEvidence(raw = {}, env = process.env) {
  const hostNames = new Set();
  let hostProven = false;

  const visit = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 3) return;
    for (const [key, child] of Object.entries(value)) {
      const normalized = key.replace(/[_-]/g, '').toLowerCase();
      if (INVENTORY_KEYS.has(normalized)) {
        hostProven = true;
        addInventoryValue(child, hostNames);
      } else if (INVENTORY_CONTAINERS.has(normalized)) {
        visit(child, depth + 1);
      }
    }
  };
  visit(raw);

  // A current host inventory is stronger than a bundled/install-time default.
  // In particular, a proven empty inventory means the server failed or was
  // disabled for this session and must keep native tools available.
  if (hostProven) return { proven: true, names: hostNames };

  const names = new Set();
  const proven = Object.prototype.hasOwnProperty.call(
    env,
    'TOKEN_OPTIMIZER_MCP_CAPABILITIES'
  );
  if (proven)
    addInventoryValue(env.TOKEN_OPTIMIZER_MCP_CAPABILITIES, names);
  return { proven, names };
}

/** Rehydrate the most recently proven inventory for this exact hook session. */
export function optimizerToolsForHook(raw, state = {}, env = process.env) {
  const current = optimizerToolEvidence(raw, env);
  if (current.proven) return current;
  if (
    Number.isFinite(state.optimizerToolsObservedAt) &&
    state.optimizerToolsObservedAt > 0 &&
    Array.isArray(state.optimizerTools)
  ) {
    return {
      proven: true,
      names: new Set(
        state.optimizerTools.filter((name) => HOOK_MCP_TOOL_SET.has(name))
      ),
    };
  }
  return { proven: false, names: new Set() };
}

/** Persist a proven inventory on the state object used by later hook events. */
export function rememberOptimizerTools(
  state,
  evidence,
  observedAt = Date.now()
) {
  if (!state || !evidence?.proven) return state;
  state.optimizerTools = [...evidence.names]
    .filter((name) => HOOK_MCP_TOOL_SET.has(name))
    .sort();
  state.optimizerToolsObservedAt = observedAt;
  return state;
}

const native = (profile) => ({
  structuralCapture: 'native',
  findingDelivery: 'native',
  routing: 'native-veto',
  ...profile,
});

export const CLIENT_CAPABILITIES = Object.freeze({
  'claude-code': native({
    name: 'Claude Code',
    tier: CAPABILITY_TIERS.CONTINUATION,
    semanticHarvest: 'stop-continuation',
    canDeny: true,
    denyStyle: 'permission',
    stopDecision: 'block',
  }),
  codex: native({
    name: 'Codex',
    tier: CAPABILITY_TIERS.CONTINUATION,
    semanticHarvest: 'stop-continuation',
    canDeny: true,
    denyStyle: 'permission',
    stopDecision: 'block',
  }),
  copilot: native({
    name: 'GitHub Copilot CLI',
    tier: CAPABILITY_TIERS.CONTINUATION,
    semanticHarvest: 'agent-stop-continuation',
    canDeny: true,
    contextStyle: 'top-level',
    denyStyle: 'top-level-permission',
    stopDecision: 'block',
  }),
  gemini: native({
    name: 'Gemini CLI',
    tier: CAPABILITY_TIERS.CONTINUATION,
    semanticHarvest: 'after-agent-retry',
    canDeny: true,
    denyStyle: 'top-level',
    stopDecision: 'deny',
  }),
  qwen: native({
    name: 'Qwen Code',
    tier: CAPABILITY_TIERS.CONTINUATION,
    semanticHarvest: 'stop-continuation',
    canDeny: true,
    denyStyle: 'permission',
    stopDecision: 'block',
  }),
  cursor: native({
    name: 'Cursor',
    tier: CAPABILITY_TIERS.CONTINUATION,
    semanticHarvest: 'stop-followup',
    canDeny: true,
    contextStyle: 'cursor',
    denyStyle: 'cursor',
    stopStyle: 'followup',
    stopDecision: 'block',
  }),
  cline: native({
    name: 'Cline',
    tier: CAPABILITY_TIERS.OBSERVATION,
    semanticHarvest: 'active-model-rule',
    canDeny: true,
    contextStyle: 'cline',
    denyStyle: 'cline',
    stopDecision: 'block',
  }),
  opencode: native({
    name: 'OpenCode',
    tier: CAPABILITY_TIERS.OBSERVATION,
    semanticHarvest: 'active-model-rule',
    canDeny: true,
    denyStyle: 'permission',
    stopDecision: 'block',
  }),
  kilo: native({
    name: 'Kilo',
    tier: CAPABILITY_TIERS.OBSERVATION,
    semanticHarvest: 'active-model-rule',
    canDeny: true,
    denyStyle: 'permission',
    stopDecision: 'block',
  }),
  windsurf: native({
    name: 'Windsurf',
    tier: CAPABILITY_TIERS.OBSERVATION,
    semanticHarvest: 'active-model-rule',
    canDeny: true,
    contextStyle: 'silent',
    denyStyle: 'exit-2',
    stopDecision: 'block',
  }),
  roo: {
    name: 'Roo Code',
    tier: CAPABILITY_TIERS.RULES,
    routing: 'rules',
    structuralCapture: 'mcp-visible-only',
    findingDelivery: 'explicit-mcp',
    semanticHarvest: 'active-model-rule',
    canDeny: false,
  },
  zed: {
    name: 'Zed',
    tier: CAPABILITY_TIERS.RULES,
    routing: 'rules',
    structuralCapture: 'mcp-visible-only',
    findingDelivery: 'explicit-mcp',
    semanticHarvest: 'active-model-rule',
    canDeny: false,
  },
  amp: {
    name: 'Amp',
    tier: CAPABILITY_TIERS.RULES,
    routing: 'rules',
    structuralCapture: 'mcp-visible-only',
    findingDelivery: 'explicit-mcp',
    semanticHarvest: 'active-model-rule',
    canDeny: false,
  },
  continue: {
    name: 'Continue',
    tier: CAPABILITY_TIERS.RULES,
    routing: 'rules',
    structuralCapture: 'mcp-visible-only',
    findingDelivery: 'explicit-mcp',
    semanticHarvest: 'active-model-rule',
    canDeny: false,
  },
  crush: {
    name: 'Crush',
    tier: CAPABILITY_TIERS.RULES,
    routing: 'rules',
    structuralCapture: 'mcp-visible-only',
    findingDelivery: 'explicit-mcp',
    semanticHarvest: 'active-model-rule',
    canDeny: false,
  },
  droid: {
    name: 'Droid (Factory)',
    tier: CAPABILITY_TIERS.RULES,
    routing: 'rules',
    structuralCapture: 'mcp-visible-only',
    findingDelivery: 'explicit-mcp',
    semanticHarvest: 'active-model-rule',
    canDeny: false,
  },
});

export function capabilityFor(client) {
  return CLIENT_CAPABILITIES[String(client || '').toLowerCase()] || null;
}

export function nativeClientProfiles() {
  return Object.fromEntries(
    Object.entries(CLIENT_CAPABILITIES)
      .filter(([, profile]) => profile.structuralCapture === 'native')
      .map(([key, profile]) => [key, { ...profile }])
  );
}

export function capabilitySummary() {
  return Object.entries(CLIENT_CAPABILITIES).map(([client, profile]) => ({
    client,
    name: profile.name,
    tier: profile.tier,
    routing: profile.routing,
    structuralCapture: profile.structuralCapture,
    findingDelivery: profile.findingDelivery,
    semanticHarvest: profile.semanticHarvest,
  }));
}
