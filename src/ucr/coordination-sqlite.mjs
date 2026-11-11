import Database from 'better-sqlite3';
import { canonicalJson, sha256 } from './protocol.mjs';

export class SqliteCoordinationStore {
  constructor(path, { leaseMs = 30_000 } = {}) {
    this.path = path;
    this.leaseMs = leaseMs;
    this.database = new Database(path, { timeout: 30_000 });
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('busy_timeout = 30000');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS ucr_tasks (
        id TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        dependencies TEXT NOT NULL,
        artifacts TEXT NOT NULL,
        planned_actions TEXT NOT NULL,
        state TEXT NOT NULL,
        owner TEXT,
        version INTEGER NOT NULL,
        receipt TEXT
      );
      CREATE TABLE IF NOT EXISTS ucr_leases (
        task_id TEXT PRIMARY KEY,
        lease_id TEXT NOT NULL UNIQUE,
        agent_id TEXT NOT NULL,
        claimed_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ucr_coordination_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        task_id TEXT NOT NULL,
        agent_id TEXT,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ucr_coordination_conflicts (
        conflict_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  close() {
    this.database.close();
  }

  defineTask(task) {
    if (!task?.id || !task.goal) throw new Error('task id and goal required');
    const duplicate = this.database
      .prepare(
        `SELECT id FROM ucr_tasks
         WHERE state != 'completed' AND goal = ? AND artifacts = ? AND planned_actions = ?
         LIMIT 1`
      )
      .get(
        task.goal,
        canonicalJson(task.artifacts || []),
        canonicalJson(task.plannedActions || [])
      );
    if (duplicate && duplicate.id !== task.id)
      return { defined: false, duplicateOf: duplicate.id };
    this.database
      .prepare(
        `INSERT OR IGNORE INTO ucr_tasks
         (id, goal, dependencies, artifacts, planned_actions, state, owner, version, receipt)
         VALUES (?, ?, ?, ?, ?, 'pending', NULL, 0, NULL)`
      )
      .run(
        task.id,
        task.goal,
        canonicalJson(task.dependencies || []),
        canonicalJson(task.artifacts || []),
        canonicalJson(task.plannedActions || [])
      );
    return { defined: true, taskId: task.id };
  }

  claim(taskId, agentId, { expectedVersion = null, now = Date.now() } = {}) {
    const transaction = this.database.transaction(() => {
      const task = this.database
        .prepare('SELECT * FROM ucr_tasks WHERE id = ?')
        .get(taskId);
      if (!task) return { claimed: false, reason: 'task not found' };
      const dependencies = JSON.parse(task.dependencies);
      if (dependencies.length) {
        const complete = this.database
          .prepare(
            `SELECT COUNT(*) count FROM ucr_tasks
             WHERE id IN (${dependencies.map(() => '?').join(',')}) AND state = 'completed'`
          )
          .get(...dependencies).count;
        if (complete !== dependencies.length)
          return { claimed: false, reason: 'dependencies incomplete' };
      }
      const lease = this.database
        .prepare('SELECT * FROM ucr_leases WHERE task_id = ?')
        .get(taskId);
      const mismatch = expectedVersion !== null && task.version !== expectedVersion;
      const occupied = lease && lease.expires_at > now && lease.agent_id !== agentId;
      if (mismatch || occupied) {
        const reason = mismatch
          ? 'optimistic version mismatch'
          : `leased by ${lease.agent_id}`;
        const conflictId = `conflict:${sha256({ taskId, agentId, reason, now }).slice(0, 24)}`;
        this.database
          .prepare(
            `INSERT OR IGNORE INTO ucr_coordination_conflicts
             (conflict_id, task_id, agent_id, reason, created_at) VALUES (?, ?, ?, ?, ?)`
          )
          .run(conflictId, taskId, agentId, reason, now);
        return { claimed: false, conflict: { conflictId, taskId, agentId, reason } };
      }
      const leaseId = `lease:${sha256({ taskId, agentId, now }).slice(0, 24)}`;
      this.database
        .prepare(
          `INSERT INTO ucr_leases (task_id, lease_id, agent_id, claimed_at, expires_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(task_id) DO UPDATE SET lease_id=excluded.lease_id,
             agent_id=excluded.agent_id, claimed_at=excluded.claimed_at,
             expires_at=excluded.expires_at`
        )
        .run(taskId, leaseId, agentId, now, now + this.leaseMs);
      this.database
        .prepare(
          `UPDATE ucr_tasks SET state='active', owner=?, version=version+1 WHERE id=?`
        )
        .run(agentId, taskId);
      const event = {
        eventId: `coordination:${sha256({ taskId, agentId, leaseId }).slice(0, 24)}`,
        type: 'coordination.claimed',
        taskId,
        agentId,
        leaseId,
        at: now,
      };
      this.database
        .prepare(
          `INSERT OR IGNORE INTO ucr_coordination_events
           (event_id, type, task_id, agent_id, payload) VALUES (?, ?, ?, ?, ?)`
        )
        .run(event.eventId, event.type, taskId, agentId, canonicalJson(event));
      return { claimed: true, lease: { leaseId, taskId, agentId, expiresAt: now + this.leaseMs } };
    });
    return transaction.immediate();
  }

  recover(now = Date.now()) {
    const transaction = this.database.transaction(() => {
      const expired = this.database
        .prepare('SELECT * FROM ucr_leases WHERE expires_at <= ? ORDER BY task_id')
        .all(now);
      for (const lease of expired) {
        this.database
          .prepare(
            `UPDATE ucr_tasks SET state='pending', owner=NULL, version=version+1 WHERE id=?`
          )
          .run(lease.task_id);
        this.database.prepare('DELETE FROM ucr_leases WHERE task_id=?').run(lease.task_id);
      }
      return {
        expired: expired.map((lease) => lease.lease_id),
        recoverableTasks: expired.map((lease) => lease.task_id),
      };
    });
    return transaction.immediate();
  }

  snapshot() {
    const tasks = this.database.prepare('SELECT * FROM ucr_tasks ORDER BY id').all();
    const leases = this.database
      .prepare('SELECT * FROM ucr_leases ORDER BY task_id')
      .all();
    const conflicts = this.database
      .prepare('SELECT * FROM ucr_coordination_conflicts ORDER BY conflict_id')
      .all();
    const events = this.database
      .prepare('SELECT payload FROM ucr_coordination_events ORDER BY sequence')
      .all()
      .map((row) => JSON.parse(row.payload));
    const canonical = { tasks, leases, conflicts, events };
    return { ...canonical, digest: sha256(canonical) };
  }
}

export function reconcileCoordinationPartitions(partitions) {
  const events = partitions.flatMap((partition) => partition.events || []);
  const unique = new Map();
  for (const event of events) {
    const id = event.eventId || sha256(event);
    if (!unique.has(id)) unique.set(id, event);
  }
  const ordered = [...unique.values()].sort(
    (a, b) =>
      Number(a.at || 0) - Number(b.at || 0) ||
      String(a.eventId || '').localeCompare(String(b.eventId || ''))
  );
  const owners = new Map();
  const conflicts = [];
  for (const event of ordered.filter((item) => item.type === 'coordination.claimed')) {
    const prior = owners.get(event.taskId);
    if (prior && prior.agentId !== event.agentId) {
      conflicts.push({
        taskId: event.taskId,
        owners: [prior.agentId, event.agentId].sort(),
        eventIds: [prior.eventId, event.eventId].sort(),
      });
    } else owners.set(event.taskId, event);
  }
  return {
    events: ordered,
    conflicts,
    duplicateEvents: events.length - ordered.length,
    digest: sha256({ ordered, conflicts }),
  };
}
