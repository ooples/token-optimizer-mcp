#!/usr/bin/env node
/**
 * SWE-bench A/B harness for token-optimizer. See README.md.
 *
 *   node bench/swebench/run.mjs fetch  [--dataset verified|lite]
 *   node bench/swebench/run.mjs plan   --n 50 --seed 7 [--reps 1] [--model sonnet] [--budget-usd 3]
 *                                      [--learned --repo django/django]   one repository, learned state kept (see README)
 *                                      [--continue-learned]   a new learned sample in the same work dir, on unused instances
 *                                      [--mode assist|advise|enforce|off]   the plugin arm's posture (default: the product's)
 *   node bench/swebench/run.mjs run    [--limit K] [--dry-run] [--no-warm]   K counts runs, not pairs: N pairs is --limit 2N
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
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  agentArgs,
  ARMS,
  armEnv,
  BENCH_PORTS,
  costUnits,
  instancesOf,
  predictionsFile,
  PRODUCT_MODES,
  isShim,
  transcriptDirFor,
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
    if (['dry-run', 'confirm-spend', 'keep-worktrees', 'no-warm', 'learned', 'continue-learned'].includes(name)) {
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

/**
 * Stop the supervisor a previous campaign started in the bench's own home
 * (lib.mjs armEnv), so this campaign's routing starts one from the new
 * snapshot instead of reusing a proxy built from older code. The state file
 * is written only by that supervisor; the user's live one keeps its own.
 */
async function stopBenchSupervisor(work) {
  const state = join(work, 'home', 'proxy-supervisor.json');
  if (existsSync(state)) {
    try {
      const { pid } = JSON.parse(readFileSync(state, 'utf8'));
      if (Number.isInteger(pid) && pid > 0) process.kill(pid);
    } catch {
      // Already gone, or a file from a supervisor that never finished starting.
    }
    rmSync(state, { force: true });
  }
  // THE PORT IS SHARED BY EVERY WORK DIRECTORY. A supervisor started by another
  // one -- pilot 7's, built that morning -- kept answering on it, and every
  // later campaign routed through it: two learned pilots measured an older
  // proxy than the build under test, and its paragraph ledger lived in the
  // other work directory. Whatever answers on the bench's own control port is
  // a bench supervisor (the installed one uses 16999), so it goes too.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const pid = await benchSupervisorPid();
    if (pid === null) return;
    try {
      if (attempt === 0) process.kill(pid);
    } catch {
      // Exited between the health reply and the kill.
    }
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error(`a supervisor still answers on the bench control port ${BENCH_PORTS.control}; stop it before running`);
}

/** The pid of whatever supervisor answers on the bench control port, or null. */
async function benchSupervisorPid() {
  try {
    const response = await fetch(`http://127.0.0.1:${BENCH_PORTS.control}/__token-optimizer/health`, { signal: AbortSignal.timeout(2000) });
    const body = await response.json();
    return Number.isInteger(body?.pid) ? body.pid : null;
  } catch {
    return null;
  }
}

/**
 * Refuse to measure through a proxy that is not this campaign's: the
 * supervisor answering on the bench port must be the one this work
 * directory's home recorded, which runs the snapshot staged for this run.
 */
async function assertOwnSupervisor(work) {
  let live = null;
  let recorded = null;
  // The supervisor publishes its state file just after it starts serving.
  for (let attempt = 0; attempt < 25; attempt += 1) {
    live = await benchSupervisorPid();
    recorded = readJson(join(work, 'home', 'proxy-supervisor.json'))?.pid ?? null;
    if (live !== null && live === recorded) return;
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error(`the bench proxy is not this run's (answering pid ${live}, this work directory's ${recorded}); the plugin arm would not measure the build under test`);
}

/** A plugin copy whose MCP server is THIS checkout's build, not the published @latest. */
async function stagePlugin(work) {
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
  await stopBenchSupervisor(work);
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
  return stageCredentials(dir, env);
}

/** Only the credential, into a config directory that is kept (the learned mode's). */
function stageCredentials(dir, env) {
  if (env.ANTHROPIC_API_KEY) return 'api';
  const host = join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), '.credentials.json');
  const creds = readJson(host);
  if (!creds?.claudeAiOauth) throw new Error(`no ANTHROPIC_API_KEY and no claudeAiOauth entry in ${host}`);
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: creds.claudeAiOauth }));
  return 'subscription';
}

/**
 * Put the plugin arm where an installed user is: routed through the proxy
 * before the first request, as the installer leaves them.
 *
 * WHY THE HARNESS DOES IT. A fresh config directory per run is a user on their
 * very first session, every time. The product deliberately does not switch a
 * running session onto the route -- Claude Code re-sends the context uncached
 * when its endpoint moves mid-session -- so a first session runs unrouted, and
 * without this the arm would measure hooks and MCP tools but never the proxy.
 * It calls the product's own routing code, from the same build snapshot the
 * arm runs, with the timing the installer uses.
 */
/** `run --capture <dir>`: the bench proxy writes request bodies there (diagnosis only). */
let proxyCapture = null;

async function installRoute(work, configDir, arm, mode = null) {
  const module = join(work, 'build', 'dist', 'proxy', 'default-routing.js');
  const { maintainDefaultRouting } = await import(pathToFileURL(module).href);
  const env = armEnv(process.env, { arm, configDir, productHome: join(work, 'home'), mode });
  if (proxyCapture) env.TOKEN_OPTIMIZER_PROXY_CAPTURE = proxyCapture;
  const result = await maintainDefaultRouting(env, { switchTiming: 'now' });
  if (result.status !== 'written' && result.status !== 'unchanged') {
    throw new Error(`could not route the ${arm} arm through the proxy (status ${result.status}); the arm would not be the product`);
  }
  return result.url;
}

/**
 * The learned mode's per-arm places: one repository directory and one config
 * directory, kept across every instance of the plan.
 *
 * WHY. Tool pruning learns per repository -- a store keyed on the project
 * root, and a deny list in that root's `.claude/settings.local.json` -- from
 * the transcripts in the config directory. The ordinary mode gives every run a
 * new worktree path and a new config, so every run is a first session in a new
 * repository: in pilots 3-7 pruning never had the five sessions it needs, and
 * no store was ever written. Here each arm keeps one checkout, reset to each
 * instance's base commit, and one config, so the plugin arm reaches the state
 * an installed user is in after a week in one repository. Control keeps the
 * same places, so the arms differ only in the product.
 */
function learnedPlace(work, arm) {
  const base = join(work, 'learned', arm);
  return { base, repoDir: join(base, 'repo'), configDir: join(base, 'config'), foldFile: join(base, 'fold.json') };
}

/**
 * The kept checkout, at `commit`, with nothing the last run left behind --
 * except `.claude/`, where the product's deny list lives.
 */
function resetLearnedRepo(mirror, repoDir, commit) {
  if (!existsSync(join(repoDir, '.git'))) {
    git(['--git-dir', mirror, 'worktree', 'add', '--detach', '--force', repoDir, commit]);
    return;
  }
  // A RUN KILLED MID-CHECKOUT LEAVES index.lock, and every later reset then
  // fails ("Unable to create ... index.lock: File exists") -- seen when the
  // machine ran out of memory and the pilot was killed. Runs are sequential and
  // this checkout is the plan's own, so a lock found here has no live owner.
  const gitDir = git(['rev-parse', '--absolute-git-dir'], { cwd: repoDir }).trim();
  rmSync(join(gitDir, 'index.lock'), { force: true });
  git(['checkout', '--force', '--detach', commit], { cwd: repoDir });
  git(['clean', '-ffdx', '-e', '.claude'], { cwd: repoDir });
}

/** The product's between-session fold, in the arm's environment (fold.mjs). */
function foldLearned({ claude, pluginDir, repoDir, configDir, arm, productHome, mode = null }) {
  const run = spawnSync(
    process.execPath,
    [join(HERE, 'fold.mjs'), join(pluginDir, 'hooks', 'lib'), repoDir, transcriptDirFor(configDir, repoDir), claude],
    { env: armEnv(process.env, { arm, configDir, productHome, mode }), encoding: 'utf8', windowsHide: true, timeout: 120_000 }
  );
  try {
    return JSON.parse(run.stdout.trim().split('\n').pop());
  } catch {
    return { error: (run.stderr || run.stdout || `exit ${run.status}`).slice(0, 400) };
  }
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

function runAgent({ claude, cwd, prompt, model, budgetUsd, configDir, pluginDir, arm, timeoutMs, logPath, productHome, mode = null, persist = false }) {
  return new Promise((resolveRun) => {
    // The prompt goes on stdin: an issue body is multi-line and full of quotes,
    // which no argv quoting survives intact on every platform.
    const args = agentArgs({ model, budgetUsd, persist });
    // The plugin arm logs MCP activity, so every row can say whether the
    // server under test was actually connected (it is still `pending` at the
    // init event, and nothing else in stream-json reports it).
    if (pluginDir) args.push('--plugin-dir', pluginDir, '--debug', 'mcp', '--debug-file', join(dirname(logPath), 'debug.log'));
    const child = spawn(claude, args, {
      cwd,
      env: armEnv(process.env, { arm, configDir, productHome, mode }),
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

/**
 * One unscored session per arm before the batch, so neither arm starts cold.
 *
 * WHY. The first request of every session reads the prefix both arms share
 * across sessions -- tools and the opening system blocks -- from the prompt
 * cache, if any recent session wrote it. Control's prefix is the stock
 * `claude -p` one, which other traffic on the account keeps warm; the plugin
 * arm's (tools shaped by the proxy) exists only in this benchmark. In pilot 4
 * that alone made the plugin arm's first run write 14,810 cache tokens against
 * control's 6,015 -- 9,556 of the arm's 17,156 extra cache-write tokens over
 * ten pairs -- a cost of the benchmark's ordering, not of the product: an
 * installed user's own sessions keep their prefix warm the same way. Warming
 * both arms makes the batch measure steady state for both. The warm-up rows go
 * to warmup.jsonl, never results.jsonl; `--no-warm` skips them.
 */
async function warmArm(work, { arm, claude, plan, pluginDir }) {
  const dir = join(work, 'runs', `_warm__${arm}`);
  rmSync(dir, { recursive: true, force: true });
  const cwd = join(dir, 'cwd');
  mkdirSync(cwd, { recursive: true });
  const configDir = join(dir, 'config');
  stageConfig(configDir, process.env);
  try {
    // `off` turns the proxy off too, so the product routes nothing: measured as such.
    const routedVia = ARMS[arm].plugin && plan.mode !== 'off' ? await installRoute(work, configDir, arm, plan.mode ?? null) : null;
    if (routedVia) await assertOwnSupervisor(work);
    const { code, out } = await runAgent({
      claude,
      cwd,
      prompt: 'Reply with the single word ok.',
      model: plan.model,
      budgetUsd: Math.min(plan.budgetUsd, 0.25),
      configDir,
      pluginDir: ARMS[arm].plugin ? pluginDir : null,
      arm,
      timeoutMs: 5 * 60_000,
      logPath: join(dir, 'stream.jsonl'),
      productHome: join(work, 'home'),
      mode: plan.mode ?? null,
    });
    const result = resultEvent(out);
    const row = { planId: plan.id, arm, warmup: true, routedVia, exit: code, costUsd: result?.total_cost_usd ?? null, usage: result?.usage ?? null, at: new Date().toISOString() };
    appendFileSync(join(work, 'warmup.jsonl'), `${JSON.stringify(row)}\n`);
    console.log(`warm-up ${arm.padEnd(16)} $${row.costUsd ?? '?'} (unscored)`);
  } finally {
    rmSync(configDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}

async function runPlan(work, args) {
  proxyCapture = args.capture ? resolvePath(args.capture) : null;
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
  if (plan.learned) {
    // The learned config directories are kept, so a run that throws must not
    // leave a credential copy in one: dropped on any exit, error included.
    process.on('exit', () => {
      for (const arm of plan.arms) rmSync(join(learnedPlace(work, arm).configDir, '.credentials.json'), { force: true });
    });
  }
  const pluginDir = plan.arms.some((arm) => ARMS[arm]?.plugin) ? await stagePlugin(work) : null;
  const claude = resolveClaude(args.claude);
  console.log(`binary under test: ${claude}`);
  if (!args['dry-run'] && !args['no-warm']) {
    for (const arm of [...new Set(batch.map((item) => item.arm))]) {
      await warmArm(work, { arm, claude, plan, pluginDir });
    }
  }
  for (const item of batch) {
    const instance = instances.get(item.instanceId);
    if (!instance) throw new Error(`instance ${item.instanceId} not in the cache`);
    const runDir = join(work, 'runs', `${item.instanceId}__${item.arm}__${item.rep}`);
    const place = plan.learned ? learnedPlace(work, item.arm) : null;
    const repoDir = place ? place.repoDir : join(runDir, 'repo');
    const configDir = place ? place.configDir : join(runDir, 'config');
    if (args['dry-run']) {
      console.log(`[dry-run] ${item.arm.padEnd(16)} ${item.instanceId} @ ${instance.base_commit.slice(0, 10)}  ${ARMS[item.arm].plugin ? `--plugin-dir ${pluginDir}` : '(no plugin)'}${place ? `  in ${repoDir}` : ''}`);
      continue;
    }
    const mirror = ensureMirror(work, instance.repo);
    rmSync(runDir, { recursive: true, force: true });
    mkdirSync(runDir, { recursive: true });
    let billing;
    if (place) {
      resetLearnedRepo(mirror, repoDir, instance.base_commit);
      billing = existsSync(join(configDir, 'settings.json')) ? stageCredentials(configDir, process.env) : stageConfig(configDir, process.env);
    } else {
      git(['--git-dir', mirror, 'worktree', 'add', '--detach', '--force', repoDir, instance.base_commit]);
      billing = stageConfig(configDir, process.env);
    }
    const routedVia = ARMS[item.arm].plugin && plan.mode !== 'off' ? await installRoute(work, configDir, item.arm, plan.mode ?? null) : null;
    if (routedVia) await assertOwnSupervisor(work);
    // What the product had learned when this run started: the last fold's
    // applied list (none before the first fold).
    const prunedAtStart = place && ARMS[item.arm].plugin ? readJson(place.foldFile, {})?.applied || [] : null;
    const started = Date.now();
    const { code, out } = await runAgent({
      claude,
      cwd: repoDir,
      prompt: promptFor(instance),
      model: plan.model,
      budgetUsd: plan.budgetUsd,
      configDir,
      pluginDir: ARMS[item.arm].plugin ? pluginDir : null,
      arm: item.arm,
      timeoutMs: plan.timeoutMinutes * 60_000,
      logPath: join(runDir, 'stream.jsonl'),
      productHome: join(work, 'home'),
      mode: plan.mode ?? null,
      persist: Boolean(place),
    });
    const result = resultEvent(out);
    const patch = stripTestChanges(git(['diff', instance.base_commit], { cwd: repoDir }));
    const row = {
      planId: plan.id,
      instanceId: item.instanceId,
      arm: item.arm,
      rep: item.rep,
      billing,
      routedVia,
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
      ...(place ? { learned: true, prunedAtStart } : {}),
      at: new Date().toISOString(),
    };
    if (place && ARMS[item.arm].plugin) {
      const fold = foldLearned({ claude, pluginDir, repoDir, configDir, arm: item.arm, productHome: join(work, 'home'), mode: plan.mode ?? null });
      writeFileSync(place.foldFile, JSON.stringify(fold, null, 2));
      row.foldAfter = { applied: fold.applied ?? null, pending: fold.pending ?? null, restored: fold.restored ?? null, blocked: fold.blocked ?? null, error: fold.error ?? null };
    }
    appendFileSync(join(work, 'results.jsonl'), `${JSON.stringify(row)}\n`);
    appendFileSync(
      join(work, predictionsFile(plan, item.arm)),
      `${JSON.stringify({ instance_id: item.instanceId, model_name_or_path: `${item.arm}-${plan.id}`, model_patch: patch })}\n`
    );
    console.log(`${item.arm.padEnd(16)} ${item.instanceId}: $${row.costUsd ?? '?'} ${row.turns ?? '?'} turns, patch ${patch.length} B`);
    // The credential copy goes whatever else is kept.
    if (place) {
      rmSync(join(configDir, '.credentials.json'), { force: true, maxRetries: 5, retryDelay: 500 });
      continue;
    }
    rmSync(configDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
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
  const lines = [`plan ${plan.id} (${plan.dataset}, ${plan.model}, seed ${plan.seed}, mode ${plan.mode ?? "default"}${plan.continues ? `, continues ${plan.continues}` : ""}): ${complete.length} complete pairs of ${plan.order.length / plan.arms.length}`];
  const fmt = (r) => (r.ratio == null ? 'n/a' : `${r.ratio.toFixed(3)}x${r.low != null ? ` [95% CI ${r.low.toFixed(3)}-${r.high.toFixed(3)}]` : ''}`);
  const unconnected = complete.filter(([, arms]) => arms['token-optimizer'].mcpConnected === false).length;
  if (unconnected) lines.push(`WARNING: the token-optimizer MCP server never connected in ${unconnected} plugin-arm run(s); those runs measured hooks only`);
  lines.push(`cost (USD, API-equivalent), token-optimizer / control: ${fmt(dollars)}`);
  lines.push(`cost (cache-aware units),   token-optimizer / control: ${fmt(units)}`);
  if (plan.learned) {
    // Before and after the product had learned something to act on: the
    // comparison the learned mode exists for.
    for (const [label, learnedYet] of [['nothing pruned yet', false], ['with a learned prune', true]]) {
      const subset = complete.filter(([, arms]) => (arms['token-optimizer'].prunedAtStart || []).length > 0 === learnedYet);
      const ratio = pairedRatio(subset.map(([, arms]) => [arms.control.costUsd, arms['token-optimizer'].costUsd]));
      lines.push(`  ${label.padEnd(22)} ${String(subset.length).padStart(2)} pairs: ${fmt(ratio)}`);
    }
    const last = rows.filter((row) => row.foldAfter).at(-1)?.foldAfter;
    if (last) lines.push(`  pruned after the last run: ${(last.applied || []).join(', ') || 'nothing'}${last.error ? ` (fold error: ${last.error})` : ''}`);
  }
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
    if (args.learned && !args.repo) throw new Error('--learned needs --repo owner/name: what is learned is per repository');
    if (args.mode && !PRODUCT_MODES.includes(args.mode)) throw new Error(`--mode is one of ${PRODUCT_MODES.join(', ')}`);
    const existing = readJson(join(work, 'plan.json'));
    // CONTINUE A LEARNED PLAN: a new sample in the SAME work directory, so the
    // product's learned state (keyed by the kept checkout's path) carries over,
    // on instances no earlier plan here has run -- every pair is measured after
    // the learning, not partly during it.
    let continues = null;
    let used = new Set();
    if (args['continue-learned']) {
      if (!args.learned) throw new Error('--continue-learned needs --learned');
      if (!existing?.learned || existing.repo !== args.repo) {
        throw new Error(`--continue-learned needs an existing learned plan for ${args.repo} in this work directory`);
      }
      continues = existing.id;
      used = new Set(readJsonl(join(work, 'results.jsonl')).map((row) => row.instanceId));
    }
    const pool = (args.learned ? instancesOf(instances, args.repo) : instances).filter((item) => !used.has(item.instance_id));
    if (!pool.length) throw new Error(`no instances of ${args.repo} in ${dataset}`);
    const sample = sampleInstances(pool, { n, seed });
    const plan = {
      ...(args.learned ? { learned: true, repo: args.repo } : {}),
      ...(args.mode ? { mode: args.mode } : {}),
      ...(continues ? { continues } : {}),
      dataset,
      seed,
      model: args.model || 'sonnet',
      budgetUsd: Number(args['budget-usd']) || 3,
      timeoutMinutes: Number(args['timeout-minutes']) || 30,
      arms,
      order: runOrder(sample.map((item) => item.instance_id), arms, { reps: Number(args.reps) || 1, seed }),
    };
    plan.id = planId(plan);
    if (!continues && existing && existing.id !== plan.id && readJsonl(join(work, 'results.jsonl')).some((row) => row.planId === existing.id)) {
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
        `python -m swebench.harness.run_evaluation --dataset_name ${DATASETS[plan.dataset]} --predictions_path ${join(work, predictionsFile(plan, arm))} --run_id ${arm}-${plan.id} --max_workers 4`
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
