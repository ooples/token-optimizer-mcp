/** Archive request-level evidence for every non-winning scheduled pair. */
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2]);
const read = async (name) =>
  JSON.parse(await readFile(join(root, name), 'utf8'));
const audit = await read('joint-audit.json');
const execution = await read('execution.json');
const cases = [];
for (const pair of audit.cases) {
  if (pair.classification === 'joint-win') continue;
  const state = execution.pairs.find((p) => p.id === pair.id);
  const rows = await read(`cases/${pair.id}/results.json`);
  const arms = {};
  for (const arm of ['proxy', 'headroom']) {
    const row = rows.find((r) => r.arm === arm);
    const directory = join(state.raw, `${row.task}-${row.rep}-${arm}`);
    const events = (await readFile(join(directory, 'agent.stdout'), 'utf8'))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const stderr = await readFile(join(directory, 'agent.stderr'), 'utf8');
    const commands = events
      .filter(
        (e) =>
          e.type === 'item.completed' && e.item?.type === 'command_execution'
      )
      .map(({ item }) => ({
        command: item.command,
        status: item.status,
        exitCode: item.exit_code,
        failureOutput:
          item.status === 'failed' ? item.aggregated_output : undefined,
      }));
    arms[arm] = {
      ...pair.arms[arm],
      clientExit: row.exit,
      clientAllocationFailure:
        row.exit !== 0 && /memory allocation .* failed/i.test(stderr),
      firstRequestInput: row.ledgerUsage?.find((r) => r.usage)?.usage
        .input_tokens,
      commands,
    };
  }
  const p = arms.proxy,
    h = arms.headroom;
  const knownCost = [p, h].every((a) => Number.isFinite(a.estimatedUsd));
  const costLoss = knownCost && p.estimatedUsd > h.estimatedUsd;
  const passingSpeedLoss =
    [p, h].every((a) => a.verdict === 'PASS') &&
    p.agentSeconds > h.agentSeconds;
  cases.push({
    id: pair.id,
    family: pair.family,
    classification: pair.classification,
    costLoss,
    passingSpeedLoss,
    unknownCost: !knownCost,
    smallerInputCostLoss: costLoss && p.usage.input < h.usage.input,
    costComponents: pair.costComponents,
    arms,
  });
}
const speedLosses = cases.filter((c) => c.passingSpeedLoss);
const report = {
  scope:
    'Post-run diagnosis of every non-winning scheduled pair. Original verdicts and unknown charges are preserved. Commands are observed agent actions, not proof that compression caused an action. Upstream time combines transport and provider work, plus the competitor proxy on that arm.',
  casesReviewed: cases.length,
  costLossesIncludingTies: cases.filter((c) => c.costLoss).length,
  smallerInputCostLosses: cases.filter((c) => c.smallerInputCostLoss).length,
  passingSpeedLosses: speedLosses.length,
  unknownCostAttempts: cases.reduce(
    (sum, c) =>
      sum +
      Object.values(c.arms).filter((a) => !Number.isFinite(a.estimatedUsd))
        .length,
    0
  ),
  clientAllocationFailures: cases.reduce(
    (sum, c) =>
      sum +
      Object.values(c.arms).filter((a) => a.clientAllocationFailure).length,
    0
  ),
  maxProxyTransformMsAmongSpeedLosses: Math.max(
    ...speedLosses.map((c) => c.arms.proxy.timing?.transformMs ?? 0)
  ),
  speedLossesWithHigherUpstreamTime: speedLosses.filter(
    (c) => c.arms.proxy.timing?.upstreamMs > c.arms.headroom.timing?.upstreamMs
  ).length,
  cases,
};
await writeFile(
  join(root, 'loss-review.json'),
  JSON.stringify(report, null, 2) + '\n',
  { flag: 'wx' }
);
console.log(JSON.stringify({ ...report, cases: undefined }, null, 2));
