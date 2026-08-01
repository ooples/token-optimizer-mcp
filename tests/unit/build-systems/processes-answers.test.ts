import { describe, it, expect, afterEach, beforeAll } from '@jest/globals';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { TokenCounter } from '../../../src/core/token-counter.js';
import { MetricsCollector } from '../../../src/core/metrics.js';
import {
  SmartProcesses,
  type SmartProcessesOutput,
} from '../../../src/tools/build-systems/smart-processes.js';

/**
 * A listing tool has to list something, and an empty answer is not a saving.
 *
 * smart_processes defaulted `cpuThreshold` to 10 and `memoryThreshold` to 100,
 * so on any machine that is not on fire every process was filtered out. Run
 * live on a 64-core box it counted 514 processes and returned NONE of them --
 * then reported a 100% token reduction, having "saved" 25,825 tokens by
 * omitting the answer.
 *
 * The baseline was invented too: `processes.length * 200`, an assumed 200
 * characters per process. Measuring the real snapshot put it at 39,344 tokens,
 * so the invented figure was understating by a third -- wrong in both
 * directions is the signature of a number nobody checked.
 *
 * These tests run against this machine's real process table, because that is
 * the only thing that can tell.
 */

const dirs: string[] = [];
const caches: CacheEngine[] = [];

afterEach(() => {
  while (caches.length) {
    try {
      caches.pop()?.close();
    } catch {
      /* already closed */
    }
  }
  while (dirs.length) {
    const d = dirs.pop();
    if (d) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* windows */
      }
    }
  }
});

function tool(): SmartProcesses {
  const dir = mkdtempSync(join(tmpdir(), 'proc-'));
  dirs.push(dir);
  const cache = new CacheEngine(join(dir, 'c.db'));
  caches.push(cache);
  return new SmartProcesses(cache, new TokenCounter(), new MetricsCollector());
}

/**
 * Enumerating the process table shells out to the OS and takes seconds on a
 * machine with 500+ processes. Taking one snapshot per CONFIGURATION rather
 * than one per assertion keeps the suite honest about what it is measuring --
 * every test below reasons about the same numbers -- and keeps seven OS calls
 * from becoming a timeout under parallel load.
 *
 * SIZED FROM MEASUREMENT, NOT GUESSED. These three snapshots take 6.5s on an
 * idle 64-core box. Saturating every core (64 spinners against jest's own ~63
 * workers) pushed the same three past 60s and failed all seven tests in this
 * file -- `wmic` degrades sharply when there is no spare core to schedule it
 * on, and a developer running this suite alongside a build is the ordinary
 * case, not a contrived one.
 *
 * 180s is ~28x the idle cost and ~3x the worst measured. It is deliberately
 * not a tight bound: nothing here is asserting speed, so the only thing a
 * tighter timeout can do is fail for reasons that have nothing to do with the
 * code under test.
 */
const TIMEOUT = 180_000;

let normal: SmartProcessesOutput;
let highFloor: SmartProcessesOutput;
let impossibleFloor: SmartProcessesOutput;

beforeAll(async () => {
  normal = await tool().run({ useCache: false });
  highFloor = await tool().run({ useCache: false, cpuThreshold: 99 });
  impossibleFloor = await tool().run({ useCache: false, cpuThreshold: 100000 });
}, TIMEOUT);

describe('smart_processes answers by default', () => {
  it('returns processes rather than filtering them all away', () => {
    // The machine running this test has processes. Reporting none of them is
    // the defect, whatever the thresholds happen to be set to.
    expect(normal.summary.totalProcesses).toBeGreaterThan(0);
    expect(normal.summary.filteredCount).toBeGreaterThan(0);
  });

  it('includes the process table in its top lists', () => {
    const listed =
      normal.topProcesses.byCpu.length + normal.topProcesses.byMemory.length;
    expect(listed).toBeGreaterThan(0);
  });

  it('still honours an explicit threshold', () => {
    // The thresholds remain useful for hunting a runaway process; only the
    // DEFAULT changed. A 99% CPU floor should exclude almost everything.
    expect(highFloor.summary.filteredCount).toBeLessThan(
      highFloor.summary.totalProcesses
    );
  });
});

describe('smart_processes reports an honest saving', () => {
  it('measures the baseline from the real snapshot', () => {
    const r = normal;
    // Assumed 200 chars/process gave `total * 200 / 4` tokens = total * 50.
    // A measured baseline will not land on that number.
    expect(r.metrics.originalTokens).not.toBe(r.summary.totalProcesses * 50);
    expect(r.metrics.originalTokens).toBeGreaterThan(0);
  });

  it('never reports a compacted size larger than the baseline', () => {
    const r = normal;
    expect(r.metrics.compactedTokens).toBeLessThanOrEqual(
      r.metrics.originalTokens
    );
  });

  it('the percentage agrees with the two numbers beside it', () => {
    const r = normal;
    const derived =
      r.metrics.originalTokens > 0
        ? Math.round(
            (1 - r.metrics.compactedTokens / r.metrics.originalTokens) * 100
          )
        : 0;
    expect(
      Math.abs(r.metrics.reductionPercentage - derived)
    ).toBeLessThanOrEqual(1);
  });

  it('claims NO saving when a filter removed every process', () => {
    // Omitting the answer is not compression. This reported 100%.
    const r = impossibleFloor;
    expect(r.summary.filteredCount).toBe(0);
    expect(r.metrics.reductionPercentage).toBe(0);
  });
});
