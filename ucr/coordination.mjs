import { sha256 } from './protocol.mjs';

function nowMs(now) {
  return Number.isFinite(now) ? now : Date.now();
}

export class CoordinationRuntime {
  constructor({ leaseMs = 30_000 } = {}) {
    this.leaseMs = leaseMs;
    this.agents = new Map();
    this.tasks = new Map();
    this.leases = new Map();
    this.conflicts = [];
    this.events = [];
  }

  registerAgent(agent) {
    if (!agent?.id || !Array.isArray(agent.capabilities))
      throw new Error('agent id and capabilities required');
    const record = {
      ...agent,
      available: agent.available !== false,
      heartbeatAt: Date.now(),
    };
    this.agents.set(agent.id, record);
    return record;
  }

  heartbeat(agentId, now = Date.now()) {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    this.agents.set(agentId, {
      ...agent,
      heartbeatAt: nowMs(now),
      available: true,
    });
    return true;
  }

  defineTask(task) {
    if (!task?.id) throw new Error('task id required');
    const record = {
      dependencies: [],
      artifacts: [],
      plannedActions: [],
      state: 'pending',
      version: 0,
      ...task,
    };
    const duplicate = [...this.tasks.values()].find(
      (candidate) =>
        candidate.id !== record.id &&
        candidate.state !== 'completed' &&
        sha256({
          goal: candidate.goal,
          artifacts: candidate.artifacts,
          plannedActions: candidate.plannedActions,
        }) ===
          sha256({
            goal: record.goal,
            artifacts: record.artifacts,
            plannedActions: record.plannedActions,
          })
    );
    if (duplicate) return { defined: false, duplicateOf: duplicate.id };
    this.tasks.set(record.id, record);
    return { defined: true, task: record };
  }

  dependenciesReady(taskId) {
    const task = this.tasks.get(taskId);
    return (
      Boolean(task) &&
      task.dependencies.every((id) => this.tasks.get(id)?.state === 'completed')
    );
  }

  claim(taskId, agentId, { expectedVersion = null, now = Date.now() } = {}) {
    const task = this.tasks.get(taskId);
    const agent = this.agents.get(agentId);
    if (!task || !agent || !agent.available)
      return { claimed: false, reason: 'task or available agent not found' };
    if (!this.dependenciesReady(taskId))
      return { claimed: false, reason: 'dependencies incomplete' };
    if (expectedVersion !== null && task.version !== expectedVersion) {
      return this.conflict(taskId, agentId, 'optimistic version mismatch');
    }
    const prior = this.leases.get(taskId);
    const nowValue = nowMs(now);
    if (prior && prior.expiresAt > nowValue && prior.agentId !== agentId) {
      return this.conflict(taskId, agentId, `leased by ${prior.agentId}`);
    }
    const lease = {
      leaseId: `lease:${sha256({ taskId, agentId, now: nowValue }).slice(0, 24)}`,
      taskId,
      agentId,
      claimedAt: nowValue,
      expiresAt: nowValue + this.leaseMs,
    };
    this.leases.set(taskId, lease);
    this.tasks.set(taskId, {
      ...task,
      state: 'active',
      owner: agentId,
      version: task.version + 1,
    });
    this.events.push({ type: 'coordination.claimed', ...lease });
    return { claimed: true, lease, task: this.tasks.get(taskId) };
  }

  renew(leaseId, agentId, now = Date.now()) {
    const lease = [...this.leases.values()].find(
      (candidate) => candidate.leaseId === leaseId
    );
    const nowValue = nowMs(now);
    if (!lease || lease.agentId !== agentId || lease.expiresAt <= nowValue)
      return { renewed: false };
    const renewed = { ...lease, expiresAt: nowValue + this.leaseMs };
    this.leases.set(lease.taskId, renewed);
    this.events.push({ type: 'coordination.renewed', ...renewed });
    return { renewed: true, lease: renewed };
  }

  release(leaseId, agentId, { completed = false, receipt = null } = {}) {
    const lease = [...this.leases.values()].find(
      (candidate) => candidate.leaseId === leaseId
    );
    if (!lease || lease.agentId !== agentId) return { released: false };
    const task = this.tasks.get(lease.taskId);
    this.tasks.set(lease.taskId, {
      ...task,
      state: completed ? 'completed' : 'pending',
      owner: null,
      version: task.version + 1,
      completionReceipt: completed ? receipt : null,
    });
    this.leases.delete(lease.taskId);
    this.events.push({
      type: 'coordination.released',
      ...lease,
      completed,
      receipt,
    });
    return { released: true, task: this.tasks.get(lease.taskId) };
  }

  handoff(leaseId, fromAgent, toAgent, receipt) {
    const released = this.release(leaseId, fromAgent, {
      completed: false,
      receipt,
    });
    if (!released.released) return { handedOff: false };
    const claimed = this.claim(released.task.id, toAgent, {
      expectedVersion: released.task.version,
    });
    return { handedOff: claimed.claimed, released, claimed, receipt };
  }

  conflict(taskId, agentId, reason) {
    const conflict = {
      conflictId: `conflict:${sha256({ taskId, agentId, reason, n: this.conflicts.length }).slice(0, 24)}`,
      taskId,
      agentId,
      reason,
      at: Date.now(),
      state: 'open',
    };
    this.conflicts.push(conflict);
    this.events.push({ type: 'coordination.conflict', ...conflict });
    return { claimed: false, conflict };
  }

  recover(now = Date.now()) {
    const nowValue = nowMs(now);
    const expired = [...this.leases.values()].filter(
      (lease) => lease.expiresAt <= nowValue
    );
    for (const lease of expired) {
      const task = this.tasks.get(lease.taskId);
      this.tasks.set(lease.taskId, {
        ...task,
        owner: null,
        state: 'pending',
        version: task.version + 1,
      });
      this.leases.delete(lease.taskId);
    }
    return {
      expired: expired.map((lease) => lease.leaseId),
      recoverableTasks: expired.map((lease) => lease.taskId),
    };
  }

  snapshot() {
    return {
      agents: [...this.agents.values()].sort((a, b) =>
        a.id.localeCompare(b.id)
      ),
      tasks: [...this.tasks.values()].sort((a, b) => a.id.localeCompare(b.id)),
      leases: [...this.leases.values()].sort((a, b) =>
        a.taskId.localeCompare(b.taskId)
      ),
      conflicts: [...this.conflicts].sort((a, b) =>
        a.conflictId.localeCompare(b.conflictId)
      ),
    };
  }
}
