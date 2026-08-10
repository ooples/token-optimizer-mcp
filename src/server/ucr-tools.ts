import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { mkdirSync, renameSync, writeFileSync } from 'fs';

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

function writeActiveGuardIndex(ucr: any, events: any[]): void {
  const graph = ucr.rebuildGraph(events);
  const guards = [...graph.objects.values()]
    .filter((object: any) => object.state === 'active' && object.guard)
    .map((object: any) => ({
      id: `guard:${object.id}`,
      state: 'active',
      triggers: object.guard.triggers,
      intervention: object.guard.intervention,
      replacementAction: object.guard.replacementAction,
      rollback: object.guard.rollback || 'disable this guard',
      timeoutMs: object.guard.timeoutMs,
      failureBehavior: object.guard.failureBehavior || 'advise',
      evidence: object.verificationReceiptIds || [],
      scope: object.scope,
      sourceObjectId: object.id,
    }))
    .filter((guard: any) => ucr.validateGuard(guard).valid)
    .sort((left: any, right: any) => left.id.localeCompare(right.id));
  const body = {
    schemaVersion: 'ucr.active-guards/1',
    guards,
    eventDigest: ucr.sha256(events),
  };
  const output = { ...body, indexHash: ucr.sha256(body) };
  const root = runtimeRoot();
  mkdirSync(root, { recursive: true });
  const target = path.join(root, 'active-guards.json');
  const temporary = `${target}.${process.pid}.next`;
  writeFileSync(temporary, `${ucr.canonicalJson(output)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  renameSync(temporary, target);
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
    name: 'context_receipt_verify',
    description:
      'Verify that one adapter-delivered context receipt and its correction trace to authenticated external grader evidence.',
    inputSchema: {
      type: 'object',
      properties: {
        deliveryEventId: {
          type: 'string',
          description: 'The delivery receipt ID supplied by the host adapter.',
        },
      },
      required: ['deliveryEventId'],
      additionalProperties: false,
    },
  },
  {
    name: 'cognition_record',
    description:
      'Verify external grader evidence, then propose and activate evidence-backed cognition authored by the active model. Use operation=verify-evidence before recording unfamiliar evidence.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['verify-evidence', 'record'],
          default: 'record',
          description:
            'verify-evidence is read-only and returns authenticated observations; record compiles and persists model-authored cognition.',
        },
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
        semanticObject: {
          type: 'object',
          description:
            'Compact model-authored delta. Always include trigger, applicability, nonApplicability, invalidators, scope, confidence, confidenceLabel, and expectedOutcome. A failure/guard also includes attemptedAction, observedFailure, rootCause, correction, and verificationEvidence. Other kinds include their kind-specific evidence fields. The server validates the complete contract and rejects omissions.',
          additionalProperties: true,
        },
        evidenceReceipts: {
          type: 'array',
          minItems: 1,
          description:
            'Receipts signed by the configured external deterministic grader. Models must pass them unchanged.',
          items: {
            type: 'object',
            properties: {
              graderId: { type: 'string', minLength: 1 },
              passed: { type: 'boolean', const: true },
              artifactHash: { type: 'string', minLength: 1 },
              signature: { type: 'string', minLength: 1 },
              taskId: { type: 'string' },
              issuedAt: { type: 'string' },
              observations: {
                type: 'object',
                description:
                  'Externally observed task facts covered by the signature.',
              },
            },
            required: ['graderId', 'passed', 'artifactHash', 'signature'],
          },
        },
        taskId: { type: 'string' },
        sessionId: { type: 'string' },
      },
      required: ['evidenceReceipts'],
      anyOf: [
        {
          properties: { operation: { const: 'verify-evidence' } },
          required: ['operation'],
        },
        { required: ['kind', 'semanticObject'] },
      ],
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
        workspaceId: requestedScope.workspaceId,
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

  if (name === 'context_receipt_verify') {
    const graderSecret = process.env.TOKEN_OPTIMIZER_GRADER_SECRET;
    const delivery = current.find(
      (event: any) =>
        event.eventId === args.deliveryEventId &&
        event.type === 'context.delivered'
    );
    const graph = ucr.rebuildGraph(current);
    const objectIds = delivery?.payload?.objectIds || [];
    const objects = objectIds
      .map((objectId: string) => graph.objects.get(objectId))
      .filter(Boolean);
    const attestations = objects.map((object: any) => {
      const receiptEvents = (object.verificationReceiptIds || [])
        .map((eventId: string) =>
          current.find((event: any) => event.eventId === eventId)
        )
        .filter(Boolean);
      const computedReceiptHash = ucr.sha256(
        receiptEvents
          .map((event: any) => ({
            eventId: event.eventId,
            type: event.type,
            payloadHash: event.payloadHash || ucr.sha256(event.payload || {}),
          }))
          .sort((a: any, b: any) => a.eventId.localeCompare(b.eventId))
      );
      const valid =
        object.state === 'active' &&
        receiptEvents.length > 0 &&
        computedReceiptHash === object.verificationReceiptHash &&
        receiptEvents.every(
          (event: any) =>
            event.type === 'verification.passed' &&
            ucr.verifyGraderReceipt(event.payload, graderSecret)
        );
      return {
        objectId: object.id,
        semanticKind: object.type,
        recordMeaning:
          object.type === 'failure'
            ? 'verified correction to a prior failed attempt'
            : 'verified semantic record',
        rejectedAction: object.attemptedAction || null,
        verifiedCorrection: object.correction || null,
        verificationEvidence: object.verificationEvidence || null,
        valid,
        receiptIds: receiptEvents.map((event: any) => event.eventId).sort(),
        receiptHash: computedReceiptHash,
      };
    });
    const valid =
      Boolean(delivery) &&
      objects.length > 0 &&
      objects.length === objectIds.length &&
      attestations.every((attestation: any) => attestation.valid);
    const attestation = create(
      valid ? 'verification.passed' : 'verification.failed',
      {
        passed: valid,
        operation: 'context-receipt-attestation',
        deliveryEventId: args.deliveryEventId,
        objectIds,
        attestationHash: ucr.sha256(attestations),
      }
    );
    store.append(attestation);
    return {
      valid,
      deliveryEventId: args.deliveryEventId,
      objectIds,
      attestations,
      verifier: 'external-deterministic-grader-receipt-chain',
      attestationEventId: attestation.eventId,
    };
  }

  if (name === 'cognition_record') {
    const graderSecret = process.env.TOKEN_OPTIMIZER_GRADER_SECRET;
    if (!graderSecret) {
      throw new Error(
        'cognition_record requires TOKEN_OPTIMIZER_GRADER_SECRET for external receipt verification'
      );
    }
    const verifiedReceipts = (args.evidenceReceipts || []).map(
      (receipt: any) => {
        if (!ucr.verifyGraderReceipt(receipt, graderSecret)) {
          throw new Error(
            'every evidence receipt must carry a valid external deterministic-grader signature'
          );
        }
        return receipt;
      }
    );
    if (args.operation === 'verify-evidence') {
      return {
        valid: true,
        receipts: verifiedReceipts.map((receipt: any) => {
          const { signature: _signature, ...authenticated } = receipt;
          return authenticated;
        }),
        verifier: 'external-deterministic-grader-hmac-sha256',
        persisted: false,
      };
    }
    if (!args.kind || !args.semanticObject) {
      throw new Error(
        'cognition_record operation=record requires kind and semanticObject'
      );
    }
    const receipts = verifiedReceipts.map((receipt: any) =>
      create('verification.passed', { ...receipt, passed: true })
    );
    const existingGraph = ucr.rebuildGraph(current);
    const compiler = new ucr.SemanticCompiler({
      eventFactory: create,
      existingObjects: [...existingGraph.objects.values()],
    });
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
    if (!proposed.accepted) {
      if (proposed.duplicate && proposed.duplicateOf) {
        writeActiveGuardIndex(ucr, current);
        return {
          accepted: true,
          duplicate: true,
          object: existingGraph.objects.get(proposed.duplicateOf) || null,
          eventIds: [],
          diagnostics: proposed.diagnostics,
        };
      }
      return proposed;
    }
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
    writeActiveGuardIndex(ucr, [...current, ...appended]);
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
