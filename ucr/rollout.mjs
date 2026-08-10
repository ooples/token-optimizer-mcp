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

/** Remove stable production identifiers before any durable evidence is sealed. */
export function pseudonymizeProductionSamples(samples, { secret, keyId } = {}) {
  if (!secret || !keyId)
    throw new Error('production pseudonymization requires secret and keyId');
  return (samples || []).map((sample) => ({
    ...sample,
    client: sha256([secret, keyId, 'client', sample.client]),
    projectId: sha256([secret, keyId, 'project', sample.projectId]),
  }));
}

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

export const REQUIRED_TRAFFIC_STAGES = Object.freeze([
  'shadow-selection',
  'observe-only',
  'advisory-canary',
  'verification-canary',
  'scoped-enforcement',
]);

function rawContentPath(value, path = '') {
  if (!value || typeof value !== 'object') return null;
  for (const [key, item] of Object.entries(value)) {
    const next = path ? `${path}.${key}` : key;
    if (['prompt', 'transcript', 'rawOutput'].includes(key)) return next;
    const nested = rawContentPath(item, next);
    if (nested) return nested;
  }
  return null;
}

/** Validate one privacy-safe production observation before it can be signed. */
export function validateProductionSample(sample) {
  const diagnostics = [];
  if (sample?.realTraffic !== true) diagnostics.push('not real traffic');
  if (sample?.optIn !== true) diagnostics.push('missing explicit opt-in');
  if (!Number.isFinite(sample?.timestamp))
    diagnostics.push('invalid timestamp');
  if (!REQUIRED_TRAFFIC_STAGES.includes(sample?.rolloutStage))
    diagnostics.push('invalid rollout stage');
  if (!sample?.client) diagnostics.push('missing client');
  if (!sample?.projectId) diagnostics.push('missing project');
  if (typeof sample?.available !== 'boolean')
    diagnostics.push('missing availability observation');
  for (const key of [
    'latencyMs',
    'contextOverhead',
    'correctnessDelta',
    'severeHarm',
    'unauthorizedAccess',
    'privacyViolation',
  ]) {
    if (!Number.isFinite(sample?.[key])) diagnostics.push(`invalid ${key}`);
  }
  if (Number(sample?.latencyMs) < 0 || Number(sample?.contextOverhead) < 0)
    diagnostics.push('negative latency or context telemetry');
  const prohibited = rawContentPath(sample);
  if (prohibited) diagnostics.push(`raw model content at ${prohibited}`);
  return { valid: diagnostics.length === 0, diagnostics };
}

/** Grade real, opt-in traffic separately from local fault and SLO exercises. */
export function productionTrafficReport(
  samples,
  {
    minimumSamples = 1000,
    minimumDurationMs = 7 * 24 * 60 * 60 * 1000,
    minimumClients = 3,
    minimumProjects = 3,
  } = {}
) {
  const validations = (samples || []).map(validateProductionSample);
  const safe = (samples || []).filter((_, index) => validations[index].valid);
  const stages = new Set(safe.map((sample) => sample.rolloutStage));
  const clients = new Set(safe.map((sample) => sample.client).filter(Boolean));
  const projects = new Set(
    safe.map((sample) => sample.projectId).filter(Boolean)
  );
  const timestamps = safe.map((sample) => sample.timestamp);
  const durationMs = timestamps.length
    ? Math.max(...timestamps) - Math.min(...timestamps)
    : 0;
  const privacyViolations = safe.reduce(
    (sum, sample) => sum + Number(sample.privacyViolation || 0),
    0
  );
  const severeHarm = safe.reduce(
    (sum, sample) => sum + Number(sample.severeHarm || 0),
    0
  );
  const checks = {
    samples: safe.length >= minimumSamples,
    duration: durationMs >= minimumDurationMs,
    stages: REQUIRED_TRAFFIC_STAGES.every((stage) => stages.has(stage)),
    clients: clients.size >= minimumClients,
    projects: projects.size >= minimumProjects,
    privacy: privacyViolations === 0,
    severeHarm: severeHarm === 0,
    completeTelemetry: safe.length === (samples || []).length,
    noRawContent: (samples || []).every((sample) => !rawContentPath(sample)),
  };
  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    metrics: {
      samples: safe.length,
      durationMs,
      stages: stages.size,
      clients: clients.size,
      projects: projects.size,
      privacyViolations,
      severeHarm,
      rejectedSamples: (samples || []).length - safe.length,
    },
    thresholds: {
      minimumSamples,
      minimumDurationMs,
      minimumClients,
      minimumProjects,
      requiredStages: REQUIRED_TRAFFIC_STAGES,
    },
    sampleHash: sha256(safe),
  };
}

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
  traffic,
  rolloutStage,
}) {
  const missing = [];
  if (release?.status !== 'passed') missing.push('powered release verdict');
  if (!evidenceClasses.includes('effectiveness'))
    missing.push('effectiveness evidence');
  if (!evidenceClasses.includes('production'))
    missing.push('production traffic evidence');
  if (!traffic?.passed) missing.push('qualified staged traffic window');
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
