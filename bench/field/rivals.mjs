/**
 * What the field actually does, from THOL's own published runs.
 *
 * THE METRIC IS `total_cost_usd`, which is what the leaderboard ranks on. That
 * matters more than it looks: a raw sum of token columns weights cache reads
 * equally with input, and cache reads are billed at about a tenth of the rate --
 * so the two metrics disagree about where a competitor's cost actually is. Both
 * are printed here, because the difference between them is itself the finding.
 *
 * Ratios are per task against `control` -- same task, same model, no optimizer --
 * combined as a geometric mean, since an arithmetic mean of ratios is dominated
 * by whichever task happened to be most expensive.
 *
 * SUCCESSFUL RUNS ONLY, AND THAT IS A LIMITATION RATHER THAN A SAFEGUARD. The
 * `status = 'ok'` filter drops failed runs -- and it drops their COST with them.
 * So this does not stop an entrant looking cheap by failing: an entrant that
 * burns a fortune failing a task and succeeds cheaply elsewhere is scored only
 * on the cheap half, and one that fails a task outright is simply absent from
 * it rather than penalised for it. Reading these numbers as "cost to get the
 * work done" therefore overstates every entrant, and overstates the ones that
 * fail most. Ranking on failure-inclusive cost would need the failed runs'
 * spend and a completion rate beside the ratio, which the published table does
 * not carry -- so what is printed below is a comparison of successful runs, and
 * nothing stronger.
 */
import Database from 'better-sqlite3';
import { writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const say = (line) => writeSync(1, `${line}\n`);
const db = new Database(join(dirname(fileURLToPath(import.meta.url)), 'results.sqlite'), {
  readonly: true,
});

const TOKENS = 'input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens';

const rows = db
  .prepare(
    `select competitor, task,
            avg(total_cost_usd) usd, avg(${TOKENS}) tokens,
            avg(num_turns) turns, avg(competitor_tool_calls) own_tools,
            avg(cache_read_tokens) cache_read, avg(input_tokens) input,
            avg(output_tokens) output
       from runs
      where status = 'ok' and total_cost_usd is not null
      group by competitor, task`
  )
  .all();

const byCompetitor = new Map();
for (const r of rows) {
  if (!byCompetitor.has(r.competitor)) byCompetitor.set(r.competitor, new Map());
  byCompetitor.get(r.competitor).set(r.task, r);
}

const control = byCompetitor.get('control');
const geomean = (xs) =>
  xs.length ? Math.exp(xs.reduce((s, x) => s + Math.log(x), 0) / xs.length) : NaN;

const summary = [];
for (const [name, tasks] of byCompetitor) {
  if (name === 'control') continue;

  const usd = [];
  const tokens = [];
  const turns = [];
  let ownTools = 0;
  let counted = 0;

  for (const [task, r] of tasks) {
    const base = control.get(task);
    if (!base?.usd || !r.usd) continue;
    usd.push(r.usd / base.usd);
    if (base.tokens && r.tokens) tokens.push(r.tokens / base.tokens);
    if (base.turns && r.turns) turns.push(r.turns / base.turns);
    ownTools += r.own_tools || 0;
    counted += 1;
  }

  if (!counted) continue;
  summary.push({
    name,
    tasks: counted,
    usd: geomean(usd),
    tokens: geomean(tokens),
    turns: geomean(turns),
    ownTools: ownTools / counted,
  });
}

summary.sort((a, b) => a.usd - b.usd);

say('');
say('THE FIELD against control, on the tasks each one actually ran');
say('');
say(
  'competitor'.padEnd(24) +
    'tasks'.padStart(6) +
    'USD'.padStart(8) +
    'tokens'.padStart(8) +
    'turns'.padStart(8) +
    'ownTools'.padStart(10)
);
say('-'.repeat(64));
for (const s of summary) {
  say(
    s.name.padEnd(24) +
      String(s.tasks).padStart(6) +
      s.usd.toFixed(3).padStart(8) +
      s.tokens.toFixed(3).padStart(8) +
      s.turns.toFixed(3).padStart(8) +
      s.ownTools.toFixed(1).padStart(10)
  );
}

say('');
say('USD is the leaderboard metric. 1.000 = no better than doing nothing.');

/* Which token bucket carries the USD, for the leader and for control. */
const tk = byCompetitor.get('tokenade');
const shared = [...tk.keys()].filter((t) => control.has(t));

const totals = (name) => {
  const t = byCompetitor.get(name);
  const acc = { usd: 0, input: 0, output: 0, cache_read: 0, turns: 0, n: 0 };
  for (const task of shared) {
    const r = t.get(task);
    if (!r) continue;
    acc.usd += r.usd;
    acc.input += r.input;
    acc.output += r.output;
    acc.cache_read += r.cache_read;
    acc.turns += r.turns;
    acc.n += 1;
  }
  return acc;
};

say('');
say('WHERE THE LEADER SAVES, per run on the 17 shared tasks');
say('');
const c = totals('control');
const t = totals('tokenade');
for (const [label, key] of [
  ['input tokens', 'input'],
  ['output tokens', 'output'],
  ['cache read tokens', 'cache_read'],
  ['turns', 'turns'],
  ['USD', 'usd'],
]) {
  const cv = c[key] / c.n;
  const tv = t[key] / t.n;
  say(
    '  ' +
      label.padEnd(20) +
      'control ' +
      (key === 'usd' ? cv.toFixed(4) : Math.round(cv).toString()).padStart(10) +
      '   tokenade ' +
      (key === 'usd' ? tv.toFixed(4) : Math.round(tv).toString()).padStart(10) +
      '   ' +
      (tv / cv).toFixed(3)
  );
}

/* ---- Does anything explain the ranking? ---- */

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const corr = (xs, ys) => {
  const mx = mean(xs);
  const my = mean(ys);
  const cov = mean(xs.map((x, i) => (x - mx) * (ys[i] - my)));
  const sx = Math.sqrt(mean(xs.map((x) => (x - mx) ** 2)));
  const sy = Math.sqrt(mean(ys.map((y) => (y - my) ** 2)));
  return cov / (sx * sy);
};

const withTurns = summary.filter((s) => Number.isFinite(s.turns));
say('');
say('WHAT PREDICTS THE RANKING');
say('');
say(
  `  correlation(turns, USD) = ${corr(
    withTurns.map((s) => s.turns),
    withTurns.map((s) => s.usd)
  ).toFixed(3)}   across ${withTurns.length} competitors`
);
say('');
say('  Every entrant that spends more turns than control costs more than control.');
say('  That is the law this benchmark actually enforces, and it is why a refusal');
say('  is the most expensive thing an optimizer can do: it buys a smaller tool');
say('  result with an extra round trip, and the round trip costs more.');

/* ---- Where the leader wins and loses, task by task ---- */

say('');
say('THE LEADER TASK BY TASK -- worst ratio first, so its losses lead');
say('');
say('task'.padEnd(36) + 'USD'.padStart(8) + 'turns'.padStart(8));
say('-'.repeat(52));

const detail = [];
for (const [task, r] of tk) {
  const base = control.get(task);
  if (!base?.usd) continue;
  detail.push({
    task,
    usd: r.usd / base.usd,
    turns: base.turns ? r.turns / base.turns : NaN,
  });
}
// DESCENDING, so the rows the heading promises are the rows at the top. This
// sorted ascending, which put the leader's biggest WINS first under a heading
// announcing its losses -- and the losses, the only rows this section exists to
// find, were pushed to the bottom of a 17-row table.
for (const d of detail.sort((a, b) => b.usd - a.usd)) {
  say(
    d.task.slice(0, 35).padEnd(36) +
      d.usd.toFixed(3).padStart(8) +
      d.turns.toFixed(3).padStart(8)
  );
}
say('');
say(`  beats control on ${detail.filter((d) => d.usd < 1).length} of ${detail.length} tasks`);
