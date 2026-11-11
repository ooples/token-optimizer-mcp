import { timingSafeEqual, createHash } from 'node:crypto';
import { canonicalJson, sha256 } from './protocol.mjs';

export const GUARD_MODES = Object.freeze([
  'shadow',
  'observe',
  'advise',
  'require-verification',
  'deny',
]);

const modes = new Set(GUARD_MODES);
const operators = new Set([
  'equals',
  'contains',
  'matches',
  'startsWith',
  'in',
]);
const interventions = new Set([
  'advise',
  'require-verification',
  'deny',
  'replace-parameters',
]);
const failureBehaviors = new Set(['allow', 'advise']);

export function validateGuard(guard) {
  const diagnostics = [];
  if (!guard?.id) diagnostics.push('guard.id is required');
  if (!Array.isArray(guard?.triggers) || !guard.triggers.length)
    diagnostics.push('guard.triggers are required');
  for (const trigger of guard?.triggers || []) {
    if (!trigger.field || !operators.has(trigger.operator))
      diagnostics.push('guard trigger is invalid');
    if (trigger.value === undefined)
      diagnostics.push('guard trigger value is required');
  }
  if (!interventions.has(guard?.intervention?.type))
    diagnostics.push('guard intervention type is invalid');
  if (!guard?.evidence?.length) diagnostics.push('guard evidence is required');
  if (!guard?.scope?.projectId)
    diagnostics.push('guard project scope is required');
  if (!guard?.replacementAction && guard?.intervention?.type !== 'advise') {
    diagnostics.push('guard replacementAction is required');
  }
  if (!guard?.rollback) diagnostics.push('guard rollback path is required');
  if (
    guard.timeoutMs !== undefined &&
    (!Number.isFinite(guard.timeoutMs) || guard.timeoutMs <= 0)
  )
    diagnostics.push('guard timeoutMs must be positive');
  if (
    guard.failureBehavior !== undefined &&
    !failureBehaviors.has(guard.failureBehavior)
  )
    diagnostics.push('guard failureBehavior must be allow or advise');
  const serialized = JSON.stringify(guard || {});
  if (/\b(?:eval|exec|spawn|shell|javascript|powershell)\b/i.test(serialized)) {
    diagnostics.push('guard content cannot grant arbitrary code execution');
  }
  return { valid: diagnostics.length === 0, diagnostics };
}

function conditionMatches(condition, action) {
  const actual = String(condition.field)
    .split('.')
    .reduce((value, key) => value?.[key], action);
  const expected = condition.value;
  if (condition.operator === 'equals') return actual === expected;
  if (condition.operator === 'contains')
    return String(actual || '').includes(String(expected));
  if (condition.operator === 'startsWith')
    return String(actual || '').startsWith(String(expected));
  if (condition.operator === 'in')
    return Array.isArray(expected) && expected.includes(actual);
  if (condition.operator === 'matches') {
    try {
      return new RegExp(String(expected), condition.flags || '').test(
        String(actual || '')
      );
    } catch {
      return false;
    }
  }
  return false;
}

export function guardMatches(guard, action, context = {}) {
  if (guard.state !== 'active') return false;
  if (guard.scope.projectId !== context.projectId) return false;
  if (
    guard.scope.workspaceId &&
    guard.scope.workspaceId !== context.workspaceId
  )
    return false;
  return guard.triggers.every((condition) =>
    conditionMatches(condition, action)
  );
}

export class GuardRuntime {
  constructor({ mode = 'shadow', policy = {}, disabled = false } = {}) {
    if (!modes.has(mode)) throw new Error(`unknown guard mode ${mode}`);
    this.mode = mode;
    this.policy = policy;
    this.disabled = disabled;
    this.guards = new Map();
    this.disabledGuards = new Map();
    this.audit = [];
  }

  register(guard) {
    const validation = validateGuard(guard);
    if (!validation.valid)
      return { registered: false, diagnostics: validation.diagnostics };
    this.guards.set(guard.id, { ...guard, digest: sha256(guard) });
    return {
      registered: true,
      diagnostics: [],
      guard: this.guards.get(guard.id),
    };
  }

  evaluate(action, context = {}) {
    if (this.disabled || context.emergencyDisable === true) {
      return {
        decision: 'allow',
        matches: [],
        disabled: true,
        interventions: [],
      };
    }
    const matches = [...this.guards.values()].filter((guard) =>
      !this.disabledGuards.has(guard.id) && guardMatches(guard, action, context)
    );
    const canIntercept = [
      'interceptable',
      'continuable',
      'transactional',
    ].includes(context.capabilityTier);
    const interventions = matches.map((guard) => {
      let effective = this.mode;
      if (
        effective === 'deny' &&
        (!canIntercept || this.policy.allowDeny !== true)
      )
        effective = 'advise';
      if (effective === 'require-verification' && !canIntercept)
        effective = 'advise';
      return {
        guardId: guard.id,
        mode: effective,
        evidence: guard.evidence,
        replacementAction: guard.replacementAction || null,
        rollback: guard.rollback,
        scope: guard.scope,
      };
    });
    const decision = interventions.some((item) => item.mode === 'deny')
      ? 'deny'
      : interventions.some((item) => item.mode === 'require-verification')
        ? 'require-verification'
        : 'allow';
    const result = {
      decision,
      matches: matches.map((guard) => guard.id),
      interventions,
      disabled: false,
    };
    this.audit.push({
      at: Date.now(),
      actionHash: sha256(action),
      context,
      ...result,
    });
    return result;
  }

  setMode(mode) {
    if (!modes.has(mode)) throw new Error(`unknown guard mode ${mode}`);
    const prior = this.mode;
    this.mode = mode;
    this.audit.push({ at: Date.now(), kind: 'mode-change', prior, mode });
    return { prior, mode };
  }

  disableGuard(guardId, reason) {
    if (!this.guards.has(guardId)) return { disabled: false };
    const record = { guardId, reason, at: Date.now() };
    this.disabledGuards.set(guardId, record);
    this.audit.push({ kind: 'guard-disabled', ...record });
    return { disabled: true, record };
  }

  enableGuard(guardId) {
    const prior = this.disabledGuards.get(guardId) || null;
    this.disabledGuards.delete(guardId);
    this.audit.push({ kind: 'guard-enabled', guardId, at: Date.now() });
    return { enabled: this.guards.has(guardId), prior };
  }

  simulate(guardId, traces) {
    const guard = this.guards.get(guardId);
    if (!guard) throw new Error(`guard not found: ${guardId}`);
    const cases = traces.map((trace) => ({
      expected: Boolean(trace.expected),
      matched: guardMatches(guard, trace.action, trace.context),
    }));
    const falsePositive = cases.filter(
      (item) => !item.expected && item.matched
    ).length;
    const falseNegative = cases.filter(
      (item) => item.expected && !item.matched
    ).length;
    const negativeCases = cases.filter((item) => !item.expected).length;
    const positiveCases = cases.filter((item) => item.expected).length;
    return {
      cases: cases.length,
      truePositive: cases.filter((item) => item.expected && item.matched)
        .length,
      falsePositive,
      falseNegative,
      falsePositiveRate: negativeCases ? falsePositive / negativeCases : null,
      falseNegativeRate: positiveCases ? falseNegative / positiveCases : null,
      safeToActivate:
        cases.length > 0 && falsePositive === 0 && falseNegative === 0,
    };
  }
}

export function mistakeImmunityTemplate(kind, values) {
  const templates = {
    'generated-source': {
      triggers: [
        { field: 'path', operator: 'matches', value: values.generatedPattern },
      ],
      intervention: { type: 'replace-parameters' },
      replacementAction: {
        path: values.sourcePath,
        then: values.regenerateCommand,
      },
    },
    'destructive-command': {
      triggers: [
        { field: 'command', operator: 'matches', value: values.commandPattern },
      ],
      intervention: { type: 'require-verification' },
      replacementAction: { verifyTarget: true },
    },
    'weak-validation': {
      triggers: [
        { field: 'command', operator: 'contains', value: values.weakCommand },
      ],
      intervention: { type: 'advise' },
      replacementAction: { command: values.verifiedCommand },
    },
  };
  const template = templates[kind];
  if (!template) throw new Error(`unknown mistake-immunity template ${kind}`);
  return {
    id: values.id || `guard:${kind}:${sha256(values).slice(0, 12)}`,
    state: 'active',
    scope: values.scope,
    evidence: values.evidence,
    rollback: values.rollback || 'disable this guard',
    ...template,
  };
}

export function guardReceipt(guard, secret) {
  return createHash('sha256')
    .update(`${secret}:${canonicalJson(guard)}`)
    .digest('hex');
}

export function verifyGuardReceipt(guard, secret, receipt) {
  const expected = Buffer.from(guardReceipt(guard, secret));
  const actual = Buffer.from(String(receipt || ''));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
