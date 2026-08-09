import { HybridLogicalClock, createEvent, validateEvent } from './protocol.mjs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const UCR_CLIENT_REGISTRY = Object.freeze({
  'claude-code': { family: 'process-hook', tier: 'continuable' },
  codex: { family: 'process-hook', tier: 'continuable' },
  copilot: { family: 'process-hook', tier: 'continuable' },
  gemini: { family: 'process-hook', tier: 'continuable' },
  qwen: { family: 'process-hook', tier: 'continuable' },
  cursor: { family: 'process-hook', tier: 'continuable' },
  cline: { family: 'in-process-plugin', tier: 'interceptable' },
  opencode: { family: 'in-process-plugin', tier: 'interceptable' },
  kilo: { family: 'in-process-plugin', tier: 'interceptable' },
  windsurf: { family: 'in-process-plugin', tier: 'interceptable' },
  roo: { family: 'rules-only', tier: 'connected' },
  zed: { family: 'mcp-only', tier: 'connected' },
  amp: { family: 'mcp-only', tier: 'connected' },
  continue: { family: 'rules-only', tier: 'connected' },
  crush: { family: 'rules-only', tier: 'connected' },
  droid: { family: 'rules-only', tier: 'connected' },
});

const eventMapping = Object.freeze({
  session_start: 'task.created',
  user_prompt: 'observation.recorded',
  pre_tool: 'action.proposed',
  tool_call: 'tool.called',
  tool_result: 'tool.result',
  post_tool: 'tool.result',
  stop: 'checkpoint.created',
  handoff: 'handoff.requested',
  feedback: 'feedback.recorded',
  outcome: 'outcome.recorded',
});

export class UCRAdapter {
  constructor({
    client,
    agentId,
    scope,
    writerId = null,
    clientVersion = null,
    model = null,
    modelVersion = null,
  } = {}) {
    const profile = UCR_CLIENT_REGISTRY[client];
    if (!profile) throw new Error(`unknown UCR client ${client}`);
    this.client = client;
    this.profile = profile;
    this.agentId = agentId;
    this.scope = scope;
    this.writerId = writerId || `${client}:${agentId}`;
    this.clientVersion = clientVersion;
    this.model = model;
    this.modelVersion = modelVersion;
    this.clock = new HybridLogicalClock(this.writerId);
    this.sequence = 0;
  }

  translate(input) {
    const type = eventMapping[input.kind];
    if (!type)
      return {
        accepted: false,
        diagnostic: `unknown optional adapter event ${input.kind}`,
      };
    const event = createEvent({
      type,
      payload: input.payload || {},
      traceId: input.traceId,
      causalParents: input.causalParents || [],
      writer: { id: this.writerId, sequence: this.sequence++ },
      actor: {
        agentId: this.agentId,
        client: this.client,
        clientVersion: this.clientVersion,
        model: this.model,
        modelVersion: this.modelVersion,
        capabilityTier: this.profile.tier,
      },
      scope: this.scope,
      clock: this.clock,
      wallMs: input.wallMs,
      idempotencyKey: input.idempotencyKey,
      sensitivity: input.sensitivity || 'internal',
      extensions: input.extensions || {},
    });
    return { accepted: true, event };
  }
}

export function certifyAdapter(client, fixture) {
  const profile = UCR_CLIENT_REGISTRY[client];
  if (!profile)
    return { client, certified: false, diagnostics: ['client not registered'] };
  const adapter = new UCRAdapter({
    client,
    agentId: 'certification-agent',
    scope: {
      sessionId: 'cert-session',
      projectId: 'cert-project',
      workspaceId: 'cert-workspace',
    },
  });
  const diagnostics = [];
  const events = [];
  for (const input of fixture) {
    const translated = adapter.translate(input);
    if (!translated.accepted) {
      if (input.required) diagnostics.push(translated.diagnostic);
      continue;
    }
    const validation = validateEvent(translated.event);
    if (!validation.valid) diagnostics.push(...validation.diagnostics);
    events.push(translated.event);
  }
  const requiredKinds = fixture
    .filter((item) => item.required)
    .map((item) => eventMapping[item.kind]);
  const emittedKinds = new Set(events.map((event) => event.type));
  for (const kind of requiredKinds)
    if (!emittedKinds.has(kind)) diagnostics.push(`missing required ${kind}`);
  return {
    client,
    family: profile.family,
    tier: profile.tier,
    certified: diagnostics.length === 0,
    diagnostics,
    events,
    executableSmoke: 'unexercised',
  };
}

export function certifyAdapterProcess(
  client,
  fixture,
  {
    executable = process.execPath,
    script = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      'scripts',
      'ucr-adapter-process.mjs'
    ),
    timeoutMs = 30_000,
  } = {}
) {
  const result = spawnSync(executable, [script], {
    input: JSON.stringify({ client, fixture }),
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (result.status !== 0) {
    return {
      client,
      certified: false,
      executableSmoke: 'failed',
      diagnostics: [String(result.stderr || result.error?.message || '').trim()],
    };
  }
  try {
    const report = JSON.parse(result.stdout);
    return {
      ...report,
      executableSmoke: report.certified ? 'passed' : 'failed',
      subprocess: true,
    };
  } catch (error) {
    return {
      client,
      certified: false,
      executableSmoke: 'failed',
      diagnostics: [`invalid adapter subprocess output: ${error.message}`],
    };
  }
}
