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
