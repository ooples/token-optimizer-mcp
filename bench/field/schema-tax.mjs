/**
 * What advertising 19 MCP tools actually costs, from our own runs.
 *
 * The estimate this exists to check: 26,286 bytes of tool schema (~7,300 tokens)
 * sit in every request's cached prefix, which costs roughly $0.062 on a $0.43
 * run -- about 14%, or 2.3 turns' worth. That number is arithmetic from
 * published averages, not an observation, and the whole "drop the MCP server"
 * argument rests on it.
 *
 * The two arms are byte-identical manifests except that one has no `mcp` block,
 * so the difference between them is the advertising and nothing else. The
 * existing `token-optimizer-mcp-off` arm does NOT answer this: it turns
 * enforcement off and deliberately keeps the schemas on both sides.
 *
 * Read against the LOCAL results.sqlite the rig writes, not THOL's published one.
 */
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { writeSync } from 'node:fs';

const say = (line) => writeSync(1, `${line}\n`);

const DB = process.argv[2] || 'bench/thol/results.sqlite';
if (!existsSync(DB)) {
  say(`  no results at ${DB} -- pass the rig's sqlite path as the first argument`);
  process.exit(0);
}

const db = new Database(DB, { readonly: true });

const rows = db
  .prepare(
    `select competitor, task,
            avg(total_cost_usd) usd, avg(num_turns) turns,
            avg(cache_read_tokens) cache_read,
            avg(cache_creation_tokens) cache_create,
            avg(input_tokens) input, avg(output_tokens) output,
            avg(success) success, count(*) n
       from runs
      where status = 'ok'
      group by competitor, task`
  )
  .all();

const by = new Map();
for (const r of rows) {
  if (!by.has(r.competitor)) by.set(r.competitor, new Map());
  by.get(r.competitor).set(r.task, r);
}

const MCP = 'token-optimizer-mcp';
const HOOKS = 'token-optimizer-hooks-only';

if (!by.has(MCP) || !by.has(HOOKS)) {
  say(`  need both arms; have: ${[...by.keys()].join(', ')}`);
  process.exit(0);
}

const tasks = [...by.get(MCP).keys()].filter((t) => by.get(HOOKS).has(t));
const geo = (xs) => Math.exp(xs.reduce((s, x) => s + Math.log(x), 0) / xs.length);

say('');
say('THE SCHEMA TAX, measured -- same build, same hooks, MCP advertised or not');
say('');
say('task'.padEnd(30) + 'MCP $'.padStart(10) + 'hooks $'.padStart(10) + 'ratio'.padStart(8) + 'turns'.padStart(14));
say('-'.repeat(72));

const ratios = [];
for (const task of tasks) {
  const m = by.get(MCP).get(task);
  const h = by.get(HOOKS).get(task);
  if (!m.usd || !h.usd) continue;
  ratios.push(h.usd / m.usd);
  say(
    task.slice(0, 29).padEnd(30) +
      m.usd.toFixed(4).padStart(10) +
      h.usd.toFixed(4).padStart(10) +
      (h.usd / m.usd).toFixed(3).padStart(8) +
      `${m.turns.toFixed(0)} -> ${h.turns.toFixed(0)}`.padStart(14)
  );
}

say('');
say(`  hooks-only / MCP  = ${geo(ratios).toFixed(3)} (geometric mean over ${ratios.length} tasks)`);
say(`  so advertising the tools costs ${((1 / geo(ratios) - 1) * 100).toFixed(1)}% of a run.`);
say(`  the arithmetic estimate this checks was ~14%.`);

/* Against control, which is the number that decides whether we ship either. */
if (by.has('control')) {
  say('');
  say('AND AGAINST CONTROL');
  say('');
  for (const arm of [MCP, HOOKS, 'token-optimizer-mcp-off']) {
    if (!by.has(arm)) continue;
    const rs = [];
    const ts = [];
    for (const task of tasks) {
      const a = by.get(arm).get(task);
      const c = by.get('control').get(task);
      if (!a?.usd || !c?.usd) continue;
      rs.push(a.usd / c.usd);
      if (c.turns && a.turns) ts.push(a.turns / c.turns);
    }
    if (!rs.length) continue;
    say(
      '  ' +
        arm.padEnd(30) +
        `USD ${geo(rs).toFixed(3)}`.padStart(12) +
        `  turns ${geo(ts).toFixed(3)}`
    );
  }
  say('');
  say('  tokenade measures 0.772 on the published field. That is the bar.');
}

/* Where the difference actually sits, which says whether it is the schemas. */
say('');
say('WHICH BUCKET MOVED');
say('');
const sum = (arm, key) => tasks.reduce((s, t) => s + (by.get(arm).get(t)?.[key] || 0), 0) / tasks.length;
for (const [label, key] of [
  ['cache_creation', 'cache_create'],
  ['cache_read', 'cache_read'],
  ['input', 'input'],
  ['output', 'output'],
  ['turns', 'turns'],
]) {
  const m = sum(MCP, key);
  const h = sum(HOOKS, key);
  say(
    '  ' +
      label.padEnd(16) +
      `MCP ${Math.round(m).toLocaleString()}`.padStart(18) +
      `   hooks ${Math.round(h).toLocaleString()}`.padStart(20) +
      `   ${(h / m).toFixed(3)}`
  );
}
say('');
say('  If the tax is real it lands in cache_creation and cache_read, not turns:');
say('  the schemas are sent once and re-read every turn, and removing them');
say('  should not change how many turns the task takes.');
