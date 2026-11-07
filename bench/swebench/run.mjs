#!/usr/bin/env node
/**
 * SWE-bench A/B harness for token-optimizer. See README.md.
 *
 *   node bench/swebench/run.mjs fetch  [--dataset verified|lite]
 *   node bench/swebench/run.mjs plan   --n 50 --seed 7 [--reps 1] [--model sonnet] [--budget-usd 3]
 *   node bench/swebench/run.mjs run    [--limit K] [--dry-run]
 *   node bench/swebench/run.mjs evaluate            prints the official evaluator commands
 *   node bench/swebench/run.mjs report [--eval control=<report.json> --eval token-optimizer=<report.json>]
 *
 * State lives in --work (default bench/swebench/.work, gitignored): the
 * instance cache, plan.json, results.jsonl and predictions-<arm>.jsonl.
 * `run` is resumable: a run already in results.jsonl for this plan is skipped.
 *
 * `run` SPENDS MONEY OR QUOTA. It refuses without --confirm-spend, and prints
 * the plan's worst-case cost (runs x --budget-usd) first.
 */

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ARMS,
  armEnv,
  costUnits,
  isShim,
  mcpConnected,
  DATASETS,
  mcnemar,
  pairedRatio,
  planId,
  promptFor,
  resultEvent,
  runKey,
  runOrder,
  sampleInstances,
  stripTestChanges,
} from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolvePath(HERE, '..', '..');

function parseArgs(argv) {
  const args = { _: [], eval: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const name = token.slice(2);
    if (['dry-run', 'confirm-spend', 'keep-worktrees'].includes(name)) {
      args[name] = true;
      continue;
    }
    const value = argv[++index];
    if (name === 'eval') args.eval.push(value);
    else args[name] = value;
  }
  return args;
}

const readJson = (path, fallback = null) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
};

const readJsonl = (path) => {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
};

function git(args, options = {}) {
  const out = spawnSync('git', args, { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024, ...options });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${(out.stderr || '').trim().slice(0, 400)}`);
  return out.stdout;
}

// ---------------------------------------------------------------------------
// fetch

async function fetchInstances(work, datasetKey) {
  const dataset = DATASETS[datasetKey];
  if (!dataset) throw new Error(`unknown dataset ${datasetKey}; one of ${Object.keys(DATASETS).join(', ')}`);
  const rows = [];
  for (let offset = 0; ; offset += 100) {
    const url = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(dataset)}&config=default&split=test&offset=${offset}&length=100`;
    // The datasets server answers 502 now and then under load; a page is retried
    // with backoff rather than failing a fetch of hundreds of rows.
    let response;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      response = await fetch(url);
      if (response.ok || response.status < 500) break;
      await new Promise((wait) => setTimeout(wait, 1000 * 2 ** attempt));
    }
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const body = await response.json();
    for (const { row } of body.rows || []) {
      rows.push({
        instance_id: row.instance_id,
        repo: row.repo,
        base_commit: row.base_commit,
        problem_statement: row.problem_statement,
        version: row.version,
      });
    }
    if (!body.rows?.length || rows.length >= (body.num_rows_total ?? Infinity)) break;
  }
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, `instances-${datasetKey}.json`), JSON.stringify(rows));
  return rows;
}

// ---------------------------------------------------------------------------
// run

/** A plugin copy whose MCP server is THIS checkout's build, not the published @latest. */
function stagePlugin(work) {
  const server = join(REPO, 'dist', 'server', 'index.js');
  if (!existsSync(server)) throw new Error(`no build at ${server}; run npm run build first`);
  const staged = join(work, 'plugin');
  rmSync(staged, { recursive: true, force: true });
  cpSync(join(REPO, 'plugin'), staged, { recursive: true });
  // A SNAPSHOT of the build, not the live dist/: a rebuild during a campaign
  // would otherwise change the arm under test half-way through. It stays inside
  // the checkout, so the server still resolves this checkout's node_modules.
  // The layout is kept: the server reads ../../package.json relative to itself
  // for its version, and that package.json's "type" is what makes dist/*.js ESM.
  const snapshot = join(work, 'build');
  rmSync(snapshot, { recursive: true, force: true });
  cpSync(join(REPO, 'dist'), join(snapshot, 'dist'), { recursive: true });
  cpSync(join(REPO, 'package.json'), join(snapshot, 'package.json'));
  writeFileSync(
    join(staged, '.mcp.json'),
    `${JSON.stringify({ mcpServers: { 'token-optimizer': { command: 'node', args: [join(snapshot, 'dist', 'server', 'index.js')], env: {} } } }, null, 2)}\n`
  );
  return staged;
}

/**
 * A throwaway config directory, so neither arm sees the host's plugins,
 * settings, memory or MCP servers. With no ANTHROPIC_API_KEY the run uses the
 * subscription: only the `claudeAiOauth` entry of the host credentials is
 * copied in, freshly for every run (a token refreshed inside a throwaway
 * directory would otherwise die with it).
 */
function stageConfig(dir, env) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'settings.json'), `${JSON.stringify({ includeCoAuthoredBy: false }, null, 2)}\n`);
  if (env.ANTHROPIC_API_KEY) return 'api';
  const host = join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), '.credentials.json');
  const creds = readJson(host);
  if (!creds?.claudeAiOauth) throw new Error(`no ANTHROPIC_API_KEY and no claudeAiOauth entry in ${host}`);
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: creds.claudeAiOauth }));
  return 'subscription';
}

function ensureMirror(work, repo) {
  const mirror = join(work, 'repos', `${repo.replace('/', '__')}.git`);
  if (!existsSync(mirror)) {
    mkdirSync(dirname(mirror), { recursive: true });
    git(['clone', '--bare', '--filter=blob:none', `https://github.com/${repo}.git`, mirror]);
  }
  return mirror;
}

/**
 * The real Claude Code binary: --claude, CLAUDE_BIN, or the first `claude`
 * executable on PATH that is not a launcher shim. On the machine this was
 * written on the first `claude` on PATH is this product's managed `claude.cmd`,
 * which would have run the CONTROL arm through token-optimizer.
 */
export function resolveClaude(explicit, env = process.env) {
  const candidate = explicit || env.CLAUDE_BIN;
  if (candidate) {
    if (isShim(candidate)) throw new Error(`${candidate} is a launcher shim, not the Claude Code binary`);
    return candidate;
  }
  const names = process.platform === 'win32' ? ['claude.exe'] : ['claude'];
  for (const dir of String(env.PATH || env.Path || '').split(delimiter)) {
    for (const name of names) {
      const path = join(dir, name);
      if (existsSync(path) && !isShim(path)) return path;
    }
  }
  throw new Error('no Claude Code binary found on PATH; pass --claude <path>');
}

function runAgent({ claude, cwd, prompt, model, budgetUsd, configDir, pluginDir, arm, timeoutMs, logPath }) {
  return new Promise((resolveRun) => {
    // The prompt goes on stdin: an issue body is multi-line and full of quotes,
    // which no argv quoting survives intact on every platform.
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', model, '--max-budget-usd', String(budgetUsd), '--permission-mode', 'bypassPermissions', '--no-session-persistence'];
    // The plugin arm logs MCP activity, so every row can say whether the
    // server under test was actually connected (it is still `pending` at the
    // init event, and nothing else in stream-json reports it).
    if (pluginDir) args.push('--plugin-dir', pluginDir, '--debug', 'mcp', '--debug-file', join(dirname(logPath), 'debug.log'));
    const child = spawn(claude, args, {
      cwd,
      env: armEnv(process.env, { arm, configDir }),
      windowsHide: true,
    });
    child.stdin.end(prompt);
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      appendFileSync(logPath, chunk);
    });
    child.stderr.on('data', (chunk) => appendFileSync(logPath, chunk));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveRun({ code, out });
    });
  });
}

async function runPlan(work, args) {
  const plan = readJson(join(work, 'plan.json'));
  if (!plan) throw new Error('no plan.json; run `plan` first');
  const instances = new Map((readJson(join(work, `instances-${plan.dataset}.json`), []) || []).map((item) => [item.instance_id, item]));
  const done = new Set(readJsonl(join(work, 'results.jsonl')).filter((row) => row.planId === plan.id).map(runKey));
  const pending = plan.order.filter((item) => !done.has(runKey(item)));
  const limit = Number(args.limit) || pending.length;
  const batch = pending.slice(0, limit);
  console.log(`plan ${plan.id}: ${plan.order.length} runs, ${done.size} done, running ${batch.length}; worst case $${(batch.length * plan.budgetUsd).toFixed(2)} at --max-budget-usd ${plan.budgetUsd}`);
  if (!args['dry-run'] && !args['confirm-spend']) {
    console.log('refusing to spend without --confirm-spend');
    return 2;
  }
  const pluginDir = plan.arms.some((arm) => ARMS[arm]?.plugin) ? stagePlugin(work) : null;
  const claude = resolveClaude(args.claude);
  console.log(`binary under test: ${claude}`);
  for (const item of batch) {
    const instance = instances.get(item.instanceId);
    if (!instance) throw new Error(`instance ${item.instanceId} not in the cache`);
    const runDir = join(work, 'runs', `${item.instanceId}__${item.arm}__${item.rep}`);
    const repoDir = join(runDir, 'repo');
    if (args['dry-run']) {
      console.log(`[dry-run] ${item.arm.padEnd(16)} ${item.instanceId} @ ${instance.base_commit.slice(0, 10)}  ${ARMS[item.arm].plugin ? `--plugin-dir ${pluginDir}` : '(no plugin)'}`);
      continue;
    }
    const mirror = ensureMirror(work, instance.repo);
    rmSync(runDir, { recursive: true, force: true });
    mkdirSync(runDir, { recursive: true });
    git(['--git-dir', mirror, 'worktree', 'add', '--detach', '--force', repoDir, instance.base_commit]);
    const billing = stageConfig(join(runDir, 'config'), process.env);
    const started = Date.now();
    const { code, out } = await runAgent({
      claude,
      cwd: repoDir,
      prompt: promptFor(instance),
      model: plan.model,
      budgetUsd: plan.budgetUsd,
      configDir: join(runDir, 'config'),
      pluginDir: ARMS[item.arm].plugin ? pluginDir : null,
      arm: item.arm,
      timeoutMs: plan.timeoutMinutes * 60_000,
      logPath: join(runDir, 'stream.jsonl'),
    });
    const result = resultEvent(out);
    const patch = stripTestChanges(git(['diff', instance.base_commit], { cwd: repoDir }));
    const row = {
      planId: plan.id,
      instanceId: item.instanceId,
      arm: item.arm,
      rep: item.rep,
      billing,
      exit: code,
      subtype: result?.subtype ?? null,
      costUsd: result?.total_cost_usd ?? null,
      costUnits: result?.usage ? costUnits(result.usage) : null,
      usage: result?.usage ?? null,
      turns: result?.num_turns ?? null,
      durationMs: Date.now() - started,
      patchBytes: patch.length,
      mcpConnected: ARMS[item.arm].plugin
        ? mcpConnected(existsSync(join(runDir, 'debug.log')) ? readFileSync(join(runDir, 'debug.log'), 'utf8') : '')
        : null,
      at: new Date().toISOString(),
    };
    appendFileSync(join(work, 'results.jsonl'), `${JSON.stringify(row)}\n`);
    appendFileSync(
      join(work, `predictions-${item.arm}.jsonl`),
      `${JSON.stringify({ instance_id: item.instanceId, model_name_or_path: `${item.arm}-${plan.id}`, model_patch: patch })}\n`
    );
    console.log(`${item.arm.padEnd(16)} ${item.instanceId}: $${row.costUsd ?? '?'} ${row.turns ?? '?'} turns, patch ${patch.length} B`);
    // The credential copy goes whatever else is kept.
    rmSync(join(runDir, 'config'), { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    if (!args['keep-worktrees']) {
      try {
        git(['--git-dir', mirror, 'worktree', 'remove', '--force', repoDir]);
      } catch {
        // A child the agent started (a test server, the MCP server on Windows)
        // can still hold the directory. A leftover worktree costs disk, not
        // correctness: the next run of this key re-creates it with --force.
        try {
          rmSync(repoDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
        } catch {
          console.log(`  (worktree ${repoDir} still locked; left for cleanup)`);
        }
      }
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// report

function report(work, args) {
  const plan = readJson(join(work, 'plan.json'));
  if (!plan) throw new Error('no plan.json');
  const rows = readJsonl(join(work, 'results.jsonl')).filter((row) => row.planId === plan.id);
  const resolved = new Map();
  for (const spec of args.eval) {
    const [arm, path] = spec.split('=');
    const body = readJson(path, {});
    resolved.set(arm, new Set(body.resolved_ids || []));
  }
  const byInstance = new Map();
  for (const row of rows) {
    const key = `${row.instanceId}::${row.rep}`;
    if (!byInstance.has(key)) byInstance.set(key, {});
    byInstance.get(key)[row.arm] = row;
  }
  const complete = [...byInstance.entries()].filter(([, arms]) => arms.control && arms['token-optimizer']);
  const dollars = pairedRatio(complete.map(([, arms]) => [arms.control.costUsd, arms['token-optimizer'].costUsd]));
  const units = pairedRatio(complete.map(([, arms]) => [arms.control.costUnits, arms['token-optimizer'].costUnits]));
  const lines = [`plan ${plan.id} (${plan.dataset}, ${plan.model}, seed ${plan.seed}): ${complete.length} complete pairs of ${plan.order.length / plan.arms.length}`];
  const fmt = (r) => (r.ratio == null ? 'n/a' : `${r.ratio.toFixed(3)}x${r.low != null ? ` [95% CI ${r.low.toFixed(3)}-${r.high.toFixed(3)}]` : ''}`);
  const unconnected = complete.filter(([, arms]) => arms['token-optimizer'].mcpConnected === false).length;
  if (unconnected) lines.push(`WARNING: the token-optimizer MCP server never connected in ${unconnected} plugin-arm run(s); those runs measured hooks only`);
  lines.push(`cost (USD, API-equivalent), token-optimizer / control: ${fmt(dollars)}`);
  lines.push(`cost (cache-aware units),   token-optimizer / control: ${fmt(units)}`);
  if (resolved.size === 2) {
    const ids = complete.map(([key]) => key.split('::')[0]);
    const control = resolved.get('control');
    const treatment = resolved.get('token-optimizer');
    const test = mcnemar(ids.map((id) => [control.has(id), treatment.has(id)]));
    const rate = (set) => ids.filter((id) => set.has(id)).length;
    lines.push(`resolved: control ${rate(control)}/${ids.length}, token-optimizer ${rate(treatment)}/${ids.length}; discordant ${test.onlyControl} vs ${test.onlyTreatment}, McNemar p=${test.p.toFixed(3)}`);
    const spend = (arm) => complete.reduce((sum, [, arms]) => sum + (arms[arm].costUsd || 0), 0);
    lines.push(`USD per resolved: control ${(spend('control') / Math.max(1, rate(control))).toFixed(2)}, token-optimizer ${(spend('token-optimizer') / Math.max(1, rate(treatment))).toFixed(2)}`);
  } else {
    lines.push('resolution: pass --eval control=<report.json> --eval token-optimizer=<report.json> from the official evaluator');
  }
  console.log(lines.join('\n'));
  return 0;
}

// ---------------------------------------------------------------------------

async function main(argv) {
  const args = parseArgs(argv);
  const [command] = args._;
  const work = resolvePath(args.work || join(HERE, '.work'));
  if (command === 'fetch') {
    const rows = await fetchInstances(work, args.dataset || 'verified');
    console.log(`${rows.length} instances cached`);
    return 0;
  }
  if (command === 'plan') {
    const dataset = args.dataset || 'verified';
    const instances = readJson(join(work, `instances-${dataset}.json`));
    if (!instances) throw new Error(`run fetch --dataset ${dataset} first`);
    const n = Number(args.n) || 50;
    const seed = Number(args.seed) || 1;
    const arms = Object.keys(ARMS);
    const sample = sampleInstances(instances, { n, seed });
    const plan = {
      dataset,
      seed,
      model: args.model || 'sonnet',
      budgetUsd: Number(args['budget-usd']) || 3,
      timeoutMinutes: Number(args['timeout-minutes']) || 30,
      arms,
      order: runOrder(sample.map((item) => item.instance_id), arms, { reps: Number(args.reps) || 1, seed }),
    };
    plan.id = planId(plan);
    const existing = readJson(join(work, 'plan.json'));
    if (existing && existing.id !== plan.id && readJsonl(join(work, 'results.jsonl')).some((row) => row.planId === existing.id)) {
      throw new Error(`plan ${existing.id} already has results; use a new --work directory`);
    }
    writeFileSync(join(work, 'plan.json'), JSON.stringify(plan, null, 2));
    console.log(`plan ${plan.id}: ${sample.length} instances x ${arms.length} arms x ${Number(args.reps) || 1} reps = ${plan.order.length} runs; worst case $${(plan.order.length * plan.budgetUsd).toFixed(2)}`);
    return 0;
  }
  if (command === 'run') return runPlan(work, args);
  if (command === 'evaluate') {
    const plan = readJson(join(work, 'plan.json'));
    for (const arm of plan?.arms || []) {
      console.log(
        `python -m swebench.harness.run_evaluation --dataset_name ${DATASETS[plan.dataset]} --predictions_path ${join(work, `predictions-${arm}.jsonl`)} --run_id ${arm}-${plan.id} --max_workers 4`
      );
    }
    return 0;
  }
  if (command === 'report') return report(work, args);
  console.error('usage: run.mjs fetch|plan|run|evaluate|report');
  return 2;
}

if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code ?? 0),
    (error) => {
      console.error(error?.message || error);
      process.exit(1);
    }
  );
}
