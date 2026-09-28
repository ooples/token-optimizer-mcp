/**
 * IS THE MACHINE FREE ENOUGH TO MEASURE THE OTHER SIDE ON?
 *
 * WHY THE WITNESS WE ALREADY HAD CANNOT ANSWER THIS. `load-witness.mjs` times a
 * fixed single-threaded integer loop. On a 32-core box nothing contends for its
 * core until the machine is saturated, so it reports a quiet machine almost
 * whatever else is running. Measured: hr30 (clean) 45.49ms, hr31 (sixteen
 * Kompress time-budget warnings) 45.77ms, and a box running forty MSBuild
 * nodes, two `dotnet test` runs and two mutation sweeps read 44.19ms -- the
 * FASTEST of the three. It is a good drift detector and a blind load detector,
 * and it is left exactly as it is because every recorded capture is comparable
 * through it.
 *
 * WHAT THIS MEASURES INSTEAD. The fraction of all logical cores' time that was
 * not idle, from two `os.cpus()` snapshots. That is the quantity that actually
 * decides whether their engine finishes: their ML transform is wall-clock
 * budgeted (20s to acquire) and multi-threaded, so it starves when the cores
 * are busy, gives up, and passes the content through UNCOMPRESSED -- changing
 * their OUTPUT, not just their speed. The same box above reads 0.28 and 0.24
 * busy where the spin loop saw nothing.
 *
 * IT IS A GUARD, NOT A PROOF. A threshold on ambient load cannot show that a
 * capture was clean; only `competitorWarnings.degraded` can, and that is
 * already a hard refusal in both `run-theirs.py` and `head-to-head.mjs`. This
 * exists so the operator finds out before a four-hour sweep rather than during
 * it.
 */

/** @typedef {{user:number,nice:number,sys:number,idle:number,irq:number}} CpuTimes */

const total = (t) => t.user + t.nice + t.sys + t.idle + t.irq;

/**
 * The busy fraction between two `os.cpus()` readings.
 *
 * REFUSES RATHER THAN RETURNING NaN. Two snapshots taken too close together, or
 * a platform that does not move these counters, divide by zero -- and a NaN
 * compared against a threshold is false, which would read as a quiet machine.
 * That is the exact failure this file exists to prevent, so it is named.
 *
 * @param {readonly CpuTimes[]} before
 * @param {readonly CpuTimes[]} after
 * @returns {{cores:number,busyFraction:number,freeCores:number}|{error:string}}
 */
export function busySample(before, after) {
  if (!Array.isArray(before) || !Array.isArray(after))
    return { error: 'two arrays of cpu times are required' };
  if (before.length === 0 || before.length !== after.length)
    return { error: `core count changed or is zero: ${before.length} then ${after.length}` };
  let busy = 0;
  let all = 0;
  for (let i = 0; i < before.length; i += 1) {
    const span = total(after[i]) - total(before[i]);
    const idle = after[i].idle - before[i].idle;
    if (!Number.isFinite(span) || !Number.isFinite(idle) || span < 0 || idle < 0)
      return { error: `core ${i} reported counters that went backwards or are not numbers` };
    all += span;
    busy += span - idle;
  }
  if (all <= 0) return { error: 'no cpu time elapsed between the two readings' };
  const busyFraction = busy / all;
  return {
    cores: before.length,
    busyFraction,
    freeCores: (1 - busyFraction) * before.length,
  };
}

/**
 * The default ceiling, as a fraction of all cores' time.
 *
 * WHERE IT COMES FROM. It is a guard set from measurement, not a derived
 * constant. A box running forty MSBuild nodes, two `dotnet test` runs and two
 * mutation sweeps measured 0.28 and 0.24 busy twice in a row; that is the
 * regime that produced the sixteen Kompress time-budget warnings in hr31. An
 * idle Windows box sits in the low hundredths. 0.10 sits between the two with
 * room on both sides, and leaves roughly 29 of 32 cores for their inference.
 * Override with --max-busy when a box has a different core count or a
 * permanent background service.
 */
export const DEFAULT_MAX_BUSY = 0.1;

/**
 * @param {ReturnType<typeof busySample>} sample
 * @param {number} maxBusyFraction
 * @returns {string|null} why the machine is unfit, or null when it is fit
 */
export function loadRefusal(sample, maxBusyFraction = DEFAULT_MAX_BUSY) {
  if ('error' in sample) return `could not read machine load: ${sample.error}`;
  if (!Number.isFinite(maxBusyFraction) || maxBusyFraction <= 0 || maxBusyFraction > 1)
    return `--max-busy must be a fraction in (0, 1], not ${maxBusyFraction}`;
  if (sample.busyFraction <= maxBusyFraction) return null;
  return (
    `the machine is ${(sample.busyFraction * 100).toFixed(1)}% busy across ` +
    `${sample.cores} core(s) (ceiling ${(maxBusyFraction * 100).toFixed(1)}%, ` +
    `${sample.freeCores.toFixed(1)} core(s) free). Their ML transform is wall-clock ` +
    'budgeted, so on a busy box it gives up and passes content through uncompressed, ' +
    'and their column becomes a floor on their engine rather than a measurement of it.'
  );
}

/**
 * Two `os.cpus()` readings `ms` apart.
 *
 * @param {number} ms
 * @returns {Promise<ReturnType<typeof busySample>>}
 */
export async function sampleBusy(ms = 2000) {
  const { cpus } = await import('node:os');
  const before = cpus().map((c) => ({ ...c.times }));
  await new Promise((r) => setTimeout(r, ms));
  const after = cpus().map((c) => ({ ...c.times }));
  return busySample(before, after);
}