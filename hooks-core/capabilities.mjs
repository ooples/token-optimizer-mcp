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

const native = (profile) => ({
  structuralCapture: 'native',
  findingDelivery: 'native',
  routing: 'native-veto',
  ...profile,
});

export const CLIENT_CAPABILITIES = Object.freeze({
  'claude-code': native({
    name: 'Claude Code', tier: CAPABILITY_TIERS.CONTINUATION,
    semanticHarvest: 'stop-continuation', canDeny: true,
    denyStyle: 'permission', stopDecision: 'block',
  }),
  codex: native({
    name: 'Codex', tier: CAPABILITY_TIERS.CONTINUATION,
    semanticHarvest: 'stop-continuation', canDeny: true,
    denyStyle: 'permission', stopDecision: 'block',
  }),
  copilot: native({
    name: 'GitHub Copilot CLI', tier: CAPABILITY_TIERS.CONTINUATION,
    semanticHarvest: 'agent-stop-continuation', canDeny: true,
    contextStyle: 'top-level', denyStyle: 'top-level-permission', stopDecision: 'block',
  }),
  gemini: native({
    name: 'Gemini CLI', tier: CAPABILITY_TIERS.CONTINUATION,
    semanticHarvest: 'after-agent-retry', canDeny: true,
    denyStyle: 'top-level', stopDecision: 'deny',
  }),
  qwen: native({
    name: 'Qwen Code', tier: CAPABILITY_TIERS.CONTINUATION,
    semanticHarvest: 'stop-continuation', canDeny: true,
    denyStyle: 'permission', stopDecision: 'block',
  }),
  cursor: native({
    name: 'Cursor', tier: CAPABILITY_TIERS.CONTINUATION,
    semanticHarvest: 'stop-followup', canDeny: true,
    contextStyle: 'cursor', denyStyle: 'cursor', stopStyle: 'followup', stopDecision: 'block',
  }),
  cline: native({
    name: 'Cline', tier: CAPABILITY_TIERS.OBSERVATION,
    semanticHarvest: 'active-model-rule', canDeny: true,
    contextStyle: 'cline', denyStyle: 'cline', stopDecision: 'block',
  }),
  opencode: native({
    name: 'OpenCode', tier: CAPABILITY_TIERS.OBSERVATION,
    semanticHarvest: 'active-model-rule', canDeny: true,
    denyStyle: 'permission', stopDecision: 'block',
  }),
  kilo: native({
    name: 'Kilo', tier: CAPABILITY_TIERS.OBSERVATION,
    semanticHarvest: 'active-model-rule', canDeny: true,
    denyStyle: 'permission', stopDecision: 'block',
  }),
  windsurf: native({
    name: 'Windsurf', tier: CAPABILITY_TIERS.OBSERVATION,
    semanticHarvest: 'active-model-rule', canDeny: true,
    contextStyle: 'silent', denyStyle: 'exit-2', stopDecision: 'block',
  }),
  roo: {
    name: 'Roo Code', tier: CAPABILITY_TIERS.RULES, routing: 'rules',
    structuralCapture: 'mcp-visible-only', findingDelivery: 'explicit-mcp',
    semanticHarvest: 'active-model-rule', canDeny: false,
  },
  zed: {
    name: 'Zed', tier: CAPABILITY_TIERS.RULES, routing: 'rules',
    structuralCapture: 'mcp-visible-only', findingDelivery: 'explicit-mcp',
    semanticHarvest: 'active-model-rule', canDeny: false,
  },
  amp: {
    name: 'Amp', tier: CAPABILITY_TIERS.RULES, routing: 'rules',
    structuralCapture: 'mcp-visible-only', findingDelivery: 'explicit-mcp',
    semanticHarvest: 'active-model-rule', canDeny: false,
  },
  continue: {
    name: 'Continue', tier: CAPABILITY_TIERS.RULES, routing: 'rules',
    structuralCapture: 'mcp-visible-only', findingDelivery: 'explicit-mcp',
    semanticHarvest: 'active-model-rule', canDeny: false,
  },
  crush: {
    name: 'Crush', tier: CAPABILITY_TIERS.RULES, routing: 'rules',
    structuralCapture: 'mcp-visible-only', findingDelivery: 'explicit-mcp',
    semanticHarvest: 'active-model-rule', canDeny: false,
  },
  droid: {
    name: 'Droid (Factory)', tier: CAPABILITY_TIERS.RULES, routing: 'rules',
    structuralCapture: 'mcp-visible-only', findingDelivery: 'explicit-mcp',
    semanticHarvest: 'active-model-rule', canDeny: false,
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
