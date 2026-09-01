/**
 * Turning a report into something a sceptic can read.
 *
 * ADVERSARIAL FAMILIES ARE PRINTED FIRST, before any headline. That ordering is
 * the one editorial decision in this file and it is deliberate: a benchmark
 * written by the authors of a tool it measures is worth nothing unless the
 * places their tool cannot help are the first thing a reader sees. Putting them
 * last, or in an appendix, is how a vendor benchmark becomes marketing.
 *
 * A WITHHELD HEADLINE IS PRINTED AS WITHHELD, never as a number with a caveat
 * attached. Anything printed as a number gets quoted as a number.
 */

const pct = (r) => (Number.isFinite(r) ? `${((r - 1) * 100).toFixed(1)}%` : '--');
const fixed = (n, d = 3) => (Number.isFinite(n) ? n.toFixed(d) : '--');

/** One arm on one track. */
function renderArm(name, result, { adversarialTasks }) {
  const lines = [];
  const adversarial = result.perTask.filter((t) => adversarialTasks.has(t.task));
  const reuse = result.perTask.filter((t) => !adversarialTasks.has(t.task));

  lines.push(`  ${name}`);

  if (adversarial.length) {
    lines.push('    where our approach cannot help (reported first, by design)');
    for (const t of adversarial) lines.push(taskLine(t));
  } else {
    // Loud, because an empty adversarial set silently removes the benchmark's
    // only structural defence against author bias.
    lines.push('    !! NO ADVERSARIAL TASKS RESOLVED -- this comparison has no bias control');
  }

  if (reuse.length) {
    lines.push('    where reuse can help');
    for (const t of reuse) lines.push(taskLine(t));
  }

  if (result.unresolved.length) {
    lines.push(
      `    unresolved (excluded from the headline): ${result.unresolved.join(', ')}`
    );
  }

  lines.push('');
  if (!result.trustworthy) {
    lines.push(
      `    HEADLINE WITHHELD -- ${(result.unresolvedShare * 100).toFixed(0)}% of the ` +
        `battery did not converge (${result.tasksCounted} task(s) usable)`
    );
  } else {
    lines.push(
      `    cost per unit delivered: ${fixed(result.costRatio)} of control ` +
        `(${pct(result.costRatio)}) over ${result.tasksCounted} task(s)`
    );
  }
  return lines;
}

function taskLine(t) {
  const sig = t.significant ? '' : '  (interval spans parity)';
  const ci =
    Number.isFinite(t.ci?.low) && Number.isFinite(t.ci?.high)
      ? `[${fixed(t.ci.low)}, ${fixed(t.ci.high)}]`
      : '[--, --]';
  const completion = `${(t.arm.completion * 100).toFixed(0)}%`;
  return (
    `      ${t.task.padEnd(26)} ${fixed(t.ratio).padStart(7)} ${ci.padStart(18)}` +
    `  completed ${completion.padStart(4)}  n=${t.arm.n}${sig}`
  );
}

/**
 * The whole report.
 *
 * Tracks are rendered separately and never combined, so a tool that wins warm
 * and loses cold is described rather than averaged.
 */
export function renderReport(report, { adversarialTasks = new Set() } = {}) {
  const lines = [];
  lines.push('LEDGER -- cost per unit of work delivered, failures included');
  lines.push('');

  for (const [track, data] of Object.entries(report.tracks)) {
    lines.push(`TRACK: ${track}`);
    if (!data.control) {
      lines.push('  no control arm on this track; nothing can be compared');
      lines.push('');
      continue;
    }
    const arms = Object.entries(data.arms);
    if (!arms.length) lines.push('  no arms besides control');
    for (const [name, result] of arms) {
      lines.push(...renderArm(name, result, { adversarialTasks }));
    }
    lines.push('');
  }

  if (report.rejected?.length) {
    // Surfaced, because a run that happened but could not be stored is a hole
    // in the ledger and the totals will not match what was spent.
    lines.push(`REJECTED ROWS: ${report.rejected.length}`);
    for (const { problem } of report.rejected.slice(0, 5)) lines.push(`  ${problem}`);
  }

  return lines.join('\n');
}

/**
 * A one-line verdict, for a commit message or a PR body.
 *
 * Returns null when nothing may be claimed. A caller that wants a sentence and
 * gets null is being told there is no result, which is the correct outcome far
 * more often than a benchmark usually admits.
 */
export function headline(report, { track = 'cold', arm } = {}) {
  const data = report.tracks?.[track];
  const result = arm ? data?.arms?.[arm] : Object.values(data?.arms || {})[0];
  if (!result || !result.trustworthy) return null;
  return (
    `${arm || 'arm'} on ${track}: ${fixed(result.costRatio)} of control's cost per unit ` +
    `delivered (${pct(result.costRatio)}) across ${result.tasksCounted} task(s)`
  );
}
