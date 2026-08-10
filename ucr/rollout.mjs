import { sha256 } from './protocol.mjs';

export const ROLLOUT_STAGES = Object.freeze([
  'offline-replay',
  'shadow-selection',
  'observe-only',
  'advisory-canary',
  'verification-canary',
  'scoped-enforcement',
  'stable',
]);

export class RolloutController {
  constructor({ stage = 'offline-replay', thresholds = {} } = {}) {
    if (!ROLLOUT_STAGES.includes(stage))
      throw new Error(`unknown rollout stage ${stage}`);
    this.stage = stage;
    this.thresholds = {
      correctnessDelta: -0.02,
      severeHarm: 0,
      p95LatencyMs: 250,
      p95ContextOverhead: 0.05,
      availability: 0.995,
      unauthorizedAccess: 0,
      ...thresholds,
    };
    this.kills = new Map();
    this.incidents = [];
    this.readOnly = false;
    this.disconnected = false;
  }

  kill(level, id, reason) {
    const key = `${level}:${id || '*'}`;
    this.kills.set(key, { level, id: id || '*', reason, at: Date.now() });
    return this.kills.get(key);
  }

  enabled(context = {}) {
    const checks = [
      'global:*',
      `organization:${context.organizationId}`,
      `project:${context.projectId}`,
      `client:${context.client}`,
      `model:${context.model}`,
      `object:${context.objectId}`,
    ];
    return !checks.some((key) => this.kills.has(key));
  }

  observe(metrics, context = {}) {
    const regressions = [];
    if (metrics.correctnessDelta < this.thresholds.correctnessDelta)
      regressions.push('correctness');
    if (metrics.severeHarm > this.thresholds.severeHarm)
      regressions.push('severe-harm');
    if (metrics.p95LatencyMs > this.thresholds.p95LatencyMs)
      regressions.push('latency');
    if (metrics.p95ContextOverhead > this.thresholds.p95ContextOverhead)
      regressions.push('context');
    if (metrics.availability < this.thresholds.availability)
      regressions.push('availability');
    if (metrics.unauthorizedAccess > this.thresholds.unauthorizedAccess)
      regressions.push('data-policy');
    if (regressions.length) {
      const incident = {
        incidentId: `incident:${sha256({ regressions, context, n: this.incidents.length }).slice(0, 24)}`,
        regressions,
        context,
        stage: this.stage,
        at: Date.now(),
      };
      this.incidents.push(incident);
      this.kill(
        context.objectId ? 'object' : context.projectId ? 'project' : 'global',
        context.objectId || context.projectId,
        regressions.join(', ')
      );
      const index = Math.max(0, ROLLOUT_STAGES.indexOf(this.stage) - 1);
      this.stage = ROLLOUT_STAGES[index];
      return { rolledBack: true, incident, stage: this.stage };
    }
    return { rolledBack: false, stage: this.stage };
  }

  promote(verdict) {
    if (verdict?.status !== 'passed')
      return { promoted: false, reason: 'release verdict is not passed' };
    const index = ROLLOUT_STAGES.indexOf(this.stage);
    if (index === ROLLOUT_STAGES.length - 1)
      return { promoted: false, reason: 'already stable' };
    this.stage = ROLLOUT_STAGES[index + 1];
    return { promoted: true, stage: this.stage };
  }

  safeMode({ readOnly = true, disconnected = false } = {}) {
    this.readOnly = readOnly;
    this.disconnected = disconnected;
    return {
      readOnly: this.readOnly,
      disconnected: this.disconnected,
      guardsEnforced: false,
    };
  }
}

export class CircuitBreaker {
  constructor({ failures = 3, resetMs = 30_000 } = {}) {
    this.limit = failures;
    this.resetMs = resetMs;
    this.failureCount = 0;
    this.openedAt = null;
  }

  allow(now = Date.now()) {
    if (this.openedAt === null) return true;
    if (now - this.openedAt >= this.resetMs) {
      this.failureCount = 0;
      this.openedAt = null;
      return true;
    }
    return false;
  }

  record(success, now = Date.now()) {
    if (success) {
      this.failureCount = 0;
      this.openedAt = null;
      return;
    }
    this.failureCount += 1;
    if (this.failureCount >= this.limit) this.openedAt = now;
  }
}

export function recoveryExercise({
  acceptedEvents,
  restoredEvents,
  startedAt,
  recoveredAt,
}) {
  const lost = acceptedEvents.filter((id) => !new Set(restoredEvents).has(id));
  return {
    passed: lost.length === 0,
    lost,
    recoveryPointEvents: lost.length,
    recoveryTimeMs: recoveredAt - startedAt,
  };
}

function percentile(values, quantile) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * quantile) - 1)
  );
  return sorted[index];
}

/** Aggregate request-level telemetry into the release SLO contract. */
export function sloReport(samples, thresholds = {}) {
  const targets = {
    availability: 0.995,
    p95LatencyMs: 250,
    p95ContextOverhead: 0.05,
    correctnessDelta: -0.02,
    severeHarm: 0,
    unauthorizedAccess: 0,
    ...thresholds,
  };
  const total = samples.length;
  const metrics = {
    samples: total,
    availability: total
      ? samples.filter((sample) => sample.available !== false).length / total
      : null,
    p95LatencyMs: percentile(
      samples.map((sample) => sample.latencyMs),
      0.95
    ),
    p95ContextOverhead: percentile(
      samples.map((sample) => sample.contextOverhead),
      0.95
    ),
    correctnessDelta: total
      ? samples.reduce(
          (sum, sample) => sum + Number(sample.correctnessDelta || 0),
          0
        ) / total
      : null,
    severeHarm: samples.reduce(
      (sum, sample) => sum + Number(sample.severeHarm || 0),
      0
    ),
    unauthorizedAccess: samples.reduce(
      (sum, sample) => sum + Number(sample.unauthorizedAccess || 0),
      0
    ),
  };
  const gates = {
    availability:
      metrics.availability !== null &&
      metrics.availability >= targets.availability,
    latency:
      metrics.p95LatencyMs !== null &&
      metrics.p95LatencyMs <= targets.p95LatencyMs,
    context:
      metrics.p95ContextOverhead !== null &&
      metrics.p95ContextOverhead <= targets.p95ContextOverhead,
    correctness:
      metrics.correctnessDelta !== null &&
      metrics.correctnessDelta >= targets.correctnessDelta,
    severeHarm: metrics.severeHarm <= targets.severeHarm,
    dataPolicy: metrics.unauthorizedAccess <= targets.unauthorizedAccess,
  };
  return {
    targets,
    metrics,
    gates,
    passed: total > 0 && Object.values(gates).every(Boolean),
  };
}

export const REQUIRED_FAULTS = Object.freeze([
  'dependency-timeout',
  'malformed-event',
  'storage-unavailable',
  'canary-regression',
  'process-restart',
  'network-partition',
]);

/** Grade executable fault receipts without confusing them with production traffic. */
export function faultInjectionStudy(
  receipts,
  { maximumRecoveryMs = 300_000 } = {}
) {
  const byFault = new Map(receipts.map((receipt) => [receipt.fault, receipt]));
  const missing = REQUIRED_FAULTS.filter((fault) => !byFault.has(fault));
  const failed = REQUIRED_FAULTS.filter((fault) => {
    const receipt = byFault.get(fault);
    return (
      receipt &&
      (!receipt.contained ||
        receipt.dataLoss > 0 ||
        receipt.recoveryTimeMs > maximumRecoveryMs)
    );
  });
  return {
    required: REQUIRED_FAULTS,
    exercised: REQUIRED_FAULTS.length - missing.length,
    missing,
    failed,
    maximumRecoveryMs,
    receiptHash: sha256(receipts),
    passed: missing.length === 0 && failed.length === 0,
  };
}

/** A fail-closed gate: exercises alone cannot authorize a stable rollout. */
export function productionReadiness({
  release,
  evidenceClasses = [],
  slos,
  faults,
  recovery,
  rolloutStage,
}) {
  const missing = [];
  if (release?.status !== 'passed') missing.push('powered release verdict');
  if (!evidenceClasses.includes('effectiveness'))
    missing.push('effectiveness evidence');
  if (!evidenceClasses.includes('production'))
    missing.push('production traffic evidence');
  if (!slos?.passed) missing.push('production SLO window');
  if (!faults?.passed) missing.push('complete fault-injection study');
  if (!recovery?.passed || recovery?.recoveryPointEvents !== 0)
    missing.push('zero-loss recovery exercise');
  if (rolloutStage !== 'stable') missing.push('stable rollout stage');
  return {
    status: missing.length ? 'insufficient' : 'passed',
    ready: missing.length === 0,
    missing,
  };
}
