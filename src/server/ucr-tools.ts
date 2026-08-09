import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));

async function runtime(): Promise<any> {
  return import(
    pathToFileURL(path.join(here, '..', '..', 'ucr', 'index.mjs')).href
  );
}

function runtimeRoot(): string {
  return process.env.TOKEN_OPTIMIZER_UCR_DIR
    ? path.resolve(process.env.TOKEN_OPTIMIZER_UCR_DIR)
    : path.join(process.cwd(), '.token-optimizer', 'ucr');
}

function identity() {
  const client = process.env.TOKEN_OPTIMIZER_CLIENT || 'mcp';
  const tiers: Record<string, string> = {
    'claude-code': 'continuable',
    codex: 'continuable',
    copilot: 'continuable',
    gemini: 'continuable',
    qwen: 'continuable',
    cursor: 'continuable',
    cline: 'interceptable',
    opencode: 'interceptable',
    kilo: 'interceptable',
    windsurf: 'interceptable',
    roo: 'connected',
    zed: 'connected',
    amp: 'connected',
    continue: 'connected',
    crush: 'connected',
    droid: 'connected',
    mcp: 'connected',
  };
  return {
    agentId: process.env.TOKEN_OPTIMIZER_AGENT_ID || 'mcp-agent',
    client,
    clientVersion: process.env.TOKEN_OPTIMIZER_CLIENT_VERSION || null,
    model: process.env.TOKEN_OPTIMIZER_MODEL || null,
    modelVersion: process.env.TOKEN_OPTIMIZER_MODEL_VERSION || null,
    capabilityTier:
      process.env.TOKEN_OPTIMIZER_CAPABILITY_TIER ||
      tiers[client] ||
      'connected',
  };
}

function scope(args: any) {
  return {
    taskId: args.taskId || null,
    sessionId:
      args.sessionId || process.env.TOKEN_OPTIMIZER_SESSION_ID || 'mcp-session',
    projectId:
      process.env.TOKEN_OPTIMIZER_PROJECT_ID || path.basename(process.cwd()),
    workspaceId: process.env.TOKEN_OPTIMIZER_WORKSPACE_ID || process.cwd(),
    branch: process.env.TOKEN_OPTIMIZER_BRANCH || null,
  };
}

export const UCR_TOOL_DEFINITIONS = [
  {
    name: 'context_page',
    description:
      'Obtain bounded decision-specific cognition. Returns an explicit empty result when nothing safe applies.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The current decision or question.',
        },
        taskId: { type: 'string' },
        sessionId: { type: 'string' },
        trigger: {
          type: 'string',
          enum: [
            'task',
            'plan',
            'file',
            'symbol',
            'tool',
            'command',
            'validation',
          ],
        },
        budget: { type: 'number', minimum: 0, maximum: 2048 },
      },
      required: ['query'],
    },
  },
  {
    name: 'cognition_record',
    description:
      'Propose, verify, and activate evidence-backed cognition authored by the active model.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: [
            'claim',
            'failure',
            'decision',
            'procedure',
            'goal',
            'hypothesis',
            'guard',
          ],
        },
        semanticObject: { type: 'object' },
        evidenceReceipts: { type: 'array', items: { type: 'object' } },
        taskId: { type: 'string' },
        sessionId: { type: 'string' },
      },
      required: ['kind', 'semanticObject', 'evidenceReceipts'],
    },
  },
  {
    name: 'checkpoint_handoff',
    description:
      'Create or restore a resumable checkpoint and return a takeover receipt.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['create', 'restore'] },
        checkpoint: { type: 'object' },
        currentState: { type: 'object' },
        boundary: { type: 'string' },
        consumer: { type: 'string' },
      },
      required: ['operation', 'checkpoint'],
    },
  },
  {
    name: 'outcome_report',
    description:
      'Record correctness-first task outcome and deterministic grader evidence.',
    inputSchema: {
      type: 'object',
      properties: {
        episodeId: { type: 'string' },
        outcome: { type: 'object' },
        graderReceipt: { type: 'object' },
        taskId: { type: 'string' },
        sessionId: { type: 'string' },
      },
      required: ['episodeId', 'outcome', 'graderReceipt'],
    },
  },
] as const;

function writer(runtimeModule: any, args: any, sequence: number) {
  const actor = identity();
  const writerId = `${actor.client}:${actor.agentId}`;
  const clock = new runtimeModule.HybridLogicalClock(writerId);
  const traceId = runtimeModule.uuidv7();
  return (type: string, payload: any) =>
    runtimeModule.createEvent({
      type,
      payload,
      traceId,
      writer: { id: writerId, sequence: sequence++ },
      actor,
      scope: scope(args),
      clock,
      sensitivity: 'internal',
    });
}

export async function runUcrTool(name: string, args: any): Promise<any> {
  const ucr = await runtime();
  const store = new ucr.EventStore(runtimeRoot());
  const current = store.read().events;
  const create = writer(ucr, args, current.length);

  if (name === 'context_page') {
    const graph = ucr.rebuildGraph(current);
    const requestedScope = scope(args);
    const planner = new ucr.RetrievalPlanner({
      graph,
      // Cross-project paging is denied here. Federated transfer must first
      // create an explicitly authorized project-scoped cognition object.
      compatibility: (object: any) => {
        const sourceProject = object.scope?.projectId;
        const reasons = [];
        if (sourceProject && sourceProject !== requestedScope.projectId)
          reasons.push('project scope mismatch');
        if (
          object.scope?.workspaceId &&
          object.scope.workspaceId !== requestedScope.workspaceId
        )
          reasons.push('workspace scope mismatch');
        if (
          object.scope?.taskId &&
          object.scope.taskId !== requestedScope.taskId
        )
          reasons.push('task scope mismatch');
        return reasons.length
          ? { compatible: false, reasons }
          : { compatible: true, reasons: [] };
      },
    });
    const vm = new ucr.ContextVM({ planner, hardMaximumTokens: 2048 });
    const result = vm.page(
      args.query,
      {
        taskId: args.taskId,
        trigger: args.trigger || 'task',
        projectId: requestedScope.projectId,
      },
      { budget: args.budget ?? 512 }
    );
    const delivery = create('context.delivered', {
      queryHash: ucr.sha256(args.query),
      taskId: args.taskId || null,
      action: result.action,
      objectIds: result.capsules.flatMap((capsule: any) => capsule.objectIds),
      capsuleIds: result.capsules.map((capsule: any) => capsule.capsuleId),
      tokens: result.tokens,
      trigger: args.trigger || 'task',
    });
    store.append(delivery);
    return { ...result, deliveryEventId: delivery.eventId };
  }

  if (name === 'cognition_record') {
    const graderSecret = process.env.TOKEN_OPTIMIZER_GRADER_SECRET;
    if (!graderSecret) {
      throw new Error(
        'cognition_record requires TOKEN_OPTIMIZER_GRADER_SECRET for external receipt verification'
      );
    }
    const receipts = (args.evidenceReceipts || []).map((receipt: any) => {
      if (!ucr.verifyGraderReceipt(receipt, graderSecret)) {
        throw new Error(
          'every evidence receipt must carry a valid external deterministic-grader signature'
        );
      }
      return create('verification.passed', { ...receipt, passed: true });
    });
    const compiler = new ucr.SemanticCompiler({ eventFactory: create });
    const proposed = compiler.propose(
      args.kind,
      {
        ...args.semanticObject,
        evidenceReceipts: receipts.map((receipt: any) => receipt.eventId),
      },
      {
        producer: `${identity().client}/${identity().model || 'unknown-model'}`,
      }
    );
    if (!proposed.accepted) return proposed;
    const verified = compiler.verify(proposed.proposal.id, receipts);
    if (!verified.verified) return verified;
    const activated = compiler.activate(proposed.proposal.id);
    const appended = [
      ...receipts,
      proposed.event,
      verified.event,
      activated.event,
    ];
    for (const event of appended) store.append(event);
    return {
      accepted: true,
      object: activated.object,
      eventIds: appended.map((event: any) => event.eventId),
    };
  }

  if (name === 'checkpoint_handoff') {
    if (args.operation === 'create') {
      const checkpoint = ucr.createCheckpoint(args.checkpoint, {
        boundary: args.boundary || 'handoff',
        producer: `${identity().client}/${identity().model || 'unknown-model'}`,
      });
      const checkpointStore = new ucr.CheckpointStore(
        path.join(runtimeRoot(), 'checkpoints')
      );
      checkpointStore.write(checkpoint);
      store.append(
        create('checkpoint.created', {
          object: {
            ...checkpoint,
            id: checkpoint.checkpointId,
            type: 'checkpoint',
          },
        })
      );
      return { created: true, checkpoint };
    }
    return ucr.restoreCheckpoint(args.checkpoint, args.currentState || {}, {
      consumer: args.consumer || identity().agentId,
    });
  }

  if (name === 'outcome_report') {
    const graderSecret = process.env.TOKEN_OPTIMIZER_GRADER_SECRET;
    if (!ucr.verifyGraderReceipt(args.graderReceipt, graderSecret)) {
      throw new Error(
        'outcome_report requires a valid external deterministic-grader signature'
      );
    }
    const event = create('outcome.recorded', {
      object: {
        id: `outcome:${args.episodeId}`,
        type: 'outcome',
        episodeId: args.episodeId,
        ...args.outcome,
        graderReceipt: args.graderReceipt,
      },
    });
    const result = store.append(event);
    return {
      recorded: result.accepted || result.duplicate,
      eventId: event.eventId,
      outcome: args.outcome,
    };
  }

  throw new Error(`unknown UCR operation ${name}`);
}
