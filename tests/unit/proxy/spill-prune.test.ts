/**
 * A proxy that spills prunes the spill directories of proxies that died
 * without shutting down -- and only directories a proxy marked as its own.
 *
 * TOKEN_OPTIMIZER_SPILL_ROOT can point at a shared directory, where a
 * numbered entry that merely looks like a dead proxy's pid is somebody else's
 * data. The unit tests pin the predicate; this pins the wiring: the proxy
 * really asks for the marker before it deletes anything.
 */
import { describe, expect, it } from '@jest/globals';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProxy } from '../../../src/proxy/server.js';
import { SPILL_OWNER_MARKER } from '../../../src/compress/spill-path.js';

// No process can have this pid, so the OS reports its owner gone.
const DEAD = String(2 ** 31 - 2);

describe('spill directory pruning at startup', () => {
  it('removes a dead proxy directory it marked and keeps one it did not', async () => {
    const base = mkdtempSync(join(tmpdir(), 'spill-prune-'));
    const marked = join(base, DEAD);
    const foreign = join(base, `${DEAD}-1`);
    mkdirSync(marked);
    mkdirSync(foreign);
    writeFileSync(join(marked, SPILL_OWNER_MARKER), '');
    writeFileSync(join(foreign, 'somebody-elses.txt'), 'keep me');
    const previous = process.env.TOKEN_OPTIMIZER_SPILL_ROOT;
    process.env.TOKEN_OPTIMIZER_SPILL_ROOT = base;
    try {
      const proxy = await startProxy({
        upstream: 'http://127.0.0.1:9',
        projectRoot: mkdtempSync(join(tmpdir(), 'spill-prune-project-')),
        spill: true,
      });
      await new Promise<void>((resolve) => proxy.server.close(() => resolve()));
      expect(existsSync(marked)).toBe(false);
      expect(existsSync(join(foreign, 'somebody-elses.txt'))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.TOKEN_OPTIMIZER_SPILL_ROOT;
      else process.env.TOKEN_OPTIMIZER_SPILL_ROOT = previous;
      rmSync(base, { recursive: true, force: true });
    }
  }, 30000);
});
