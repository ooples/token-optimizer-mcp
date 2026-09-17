import { describe, it, expect } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { monitorHostMemory } from '../../bench/live/host-memory.mjs';

describe('pre-attempt memory freshness', () => {
  it.each([true, false])('uses fresh capacity even when the old sample says %s', async (oldReady) => {
    const dir = await mkdtemp(join(tmpdir(), 'memory-freshness-'));
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => child.emit('close', 0);
    const emit = ready => child.stdout.write(JSON.stringify({
      at: new Date().toISOString(),
      committedBytes: ready ? 1024 ** 3 : 4 * 1024 ** 3,
      commitLimitBytes: 5 * 1024 ** 3,
      availablePhysicalBytes: 1024 ** 3,
    }) + '\n');
    let monitor;
    try {
      monitor = await monitorHostMemory(dir, {
        platform: 'win32',
        spawnProcess: () => { setTimeout(() => emit(oldReady), 10); return child; },
      });
      const check = monitor.assertReady({ task: 'fixture', arm: 'full', rep: 1 });
      setTimeout(() => emit(!oldReady), 50);
      if (oldReady) await expect(check).rejects.toThrow('preflight failed');
      else await expect(check).resolves.toBeUndefined();
    } finally {
      await monitor?.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
