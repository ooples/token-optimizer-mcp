/** Fixed fresh cases, balanced orders, no outcome-selected retries. */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { adversarialFixture, adversarialTasks } from './adversarial-cases.mjs';
import { heldoutWorkflow } from './heldout-cases.mjs';
import { standardScenario } from './codex-cost.mjs';

const study = resolve(process.argv[2]);
await mkdir(study, { recursive: true });
const families = [
  'logs',
  'json',
  'code',
  'bugfix',
  'refactor',
  'refresh',
  'mixed',
  'outer',
  ...adversarialTasks,
];
const pairsPerFamily = 10;
let state = randomBytes(4).readUInt32LE() || 1;
const scheduleSeed = state;
const random = () => {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return (state >>> 0) / 4294967296;
};
const schedule = [];
for (const family of families)
  for (let i = 0; i < pairsPerFamily; i++) {
    const seed = 2000000000 + Math.floor(random() * 1000000000);
    const task = ['mixed', 'outer'].includes(family) ? 'refresh' : family;
    const fixture = ['bugfix', 'refactor', 'refresh'].includes(task)
      ? heldoutWorkflow(task, seed)
      : adversarialFixture(task, seed);
    schedule.push({
      id: `${family}-${i + 1}`,
      family,
      task,
      seed,
      arms: i % 2 ? ['headroom', 'proxy'] : ['proxy', 'headroom'],
      readMode:
        family === 'mixed'
          ? 'mixed'
          : family === 'outer'
            ? 'outer-truncated'
            : 'natural',
      caseSha256: createHash('sha256')
        .update(JSON.stringify(fixture))
        .digest('hex'),
    });
  }
for (let i = schedule.length - 1; i > 0; i--) {
  const j = Math.floor(random() * (i + 1));
  [schedule[i], schedule[j]] = [schedule[j], schedule[i]];
}
if (new Set(schedule.map((r) => r.seed)).size !== schedule.length)
  throw Error('Duplicate seed');
const plan = {
  version: 2,
  created: new Date().toISOString(),
  scheduleSeed,
  productCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim(),
  caseSuite: 'adversarial-v1',
  model: 'gpt-6-astra',
  families,
  pairsPerFamily,
  pairs: schedule.length,
  runs: schedule.length * 2,
  scenario: standardScenario,
  bootstrap: { resamples: 20000, seed: scheduleSeed },
  success: { minimumOneSided95SuccessBound: 0.95, bothCostUpper95Below: 0.95 },
  joint: {
    alpha: 0.05,
    comparisonsPerFamily: 3,
    strictObservedAllWins: true,
    minimumFamilyJointWinProbability: 0.5,
    method:
      'Bonferroni simultaneous one-sided paired log-ratio t bounds for cost and agent time; exact binomial lower bounds for joint wins. Parametric mean inference assumes independent approximately normal log ratios; probability bounds assume independent case pairs.',
  },
  sizing: {
    pairsPerFamily,
    note: 'A fixed diagnostic confirmation budget, not powered to certify a 95% per-task joint-win probability. At 10/10 wins the simultaneous binomial lower bound remains far below 95%. No sample extension based on results.',
  },
  schedule,
};
await writeFile(
  join(study, 'plan.json'),
  JSON.stringify(plan, null, 2) + '\n',
  { flag: 'wx' }
);
await writeFile(
  join(study, 'PROTOCOL.md'),
  `# Joint cost and speed confirmation\n\nFrozen product, client, competitor, generator, auditors and plan before provider calls. ${schedule.length} fresh pairs across ${families.length} families, ten distinct seeds per family, five orders each. No retries or replacement of failed attempts. Existing runner stops after three consecutive infrastructure failures and retains all partial evidence.\n\nPrimary unit: independently validated task completion. A joint win requires both audited PASS, complete reconciled provider usage, strictly lower estimated cost under the recorded scenario, and strictly lower agent wall time. Startup-inclusive time is secondary. Ties and unknown charges are not wins. All scheduled cases remain in denominators.\n\nJoint analysis applies simultaneous bounds across three endpoints per family, reports every individual loss, and fails the all-observed-tasks claim if any pair fails. Bounds on family mean costs and times do not establish every future execution wins. Binomial lower bounds quantify this gap explicitly. Shared cache/provider state may violate independence. Fresh sessions do not imply cold caches. First-request-uncached and fully-uncached sensitivities hold observed model behavior fixed.\n\nAdversarial families: tiny, incompressible digests, numeric extrema, null versus absent, outer-truncated envelopes, plus the seven earlier workflow families. Local concurrent/repeated/append-only traffic is separate from live provider evidence. Controlled initial-read families are labeled; repository workflows remain natural except mixed/outer exposure.\n`,
  { flag: 'wx' }
);
console.log(JSON.stringify({ study, pairs: schedule.length, scheduleSeed }));
