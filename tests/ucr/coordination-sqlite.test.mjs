import { afterEach, describe, expect, test } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  SqliteCoordinationStore,
  reconcileCoordinationPartitions,
} from '../../ucr/index.mjs';

const roots = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe('transactional coordination store', () => {
  test('serializes competing leases as an explicit conflict and recovers expiry', () => {
    const root = mkdtempSync(join(tmpdir(), 'ucr-sqlite-coordination-'));
    roots.push(root);
    const path = join(root, 'coordination.sqlite');
    const first = new SqliteCoordinationStore(path, { leaseMs: 10 });
    const second = new SqliteCoordinationStore(path, { leaseMs: 10 });
    try {
      first.defineTask({ id: 'task', goal: 'fix', artifacts: ['a.ts'] });
      expect(first.claim('task', 'agent-a', { expectedVersion: 0, now: 100 })).toMatchObject({
        claimed: true,
      });
      expect(second.claim('task', 'agent-b', { now: 101 })).toMatchObject({
        claimed: false,
        conflict: { taskId: 'task', agentId: 'agent-b' },
      });
      expect(second.recover(111)).toMatchObject({ recoverableTasks: ['task'] });
      expect(second.claim('task', 'agent-b', { now: 112 }).claimed).toBe(true);
      expect(second.snapshot()).toMatchObject({
        tasks: [expect.objectContaining({ id: 'task', owner: 'agent-b' })],
        conflicts: [expect.objectContaining({ task_id: 'task' })],
      });
    } finally {
      first.close();
      second.close();
    }
  });

  test('reconciles partition duplicates and exposes split ownership', () => {
    const eventA = {
      eventId: 'a',
      type: 'coordination.claimed',
      taskId: 'task',
      agentId: 'agent-a',
      at: 100,
    };
    const eventB = { ...eventA, eventId: 'b', agentId: 'agent-b', at: 101 };
    expect(
      reconcileCoordinationPartitions([
        { events: [eventA, eventB] },
        { events: [eventA] },
      ])
    ).toMatchObject({
      duplicateEvents: 1,
      conflicts: [{ taskId: 'task', owners: ['agent-a', 'agent-b'] }],
    });
  });
});
