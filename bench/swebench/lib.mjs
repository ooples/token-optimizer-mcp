/**
 * SWE-bench A/B harness: the pure parts (sampling, ordering, accounting,
 * statistics), kept free of I/O so they are tested directly.
 *
 * See README.md for the method. In one line: the same instances, run once per
 * arm in a precommitted interleaved order, scored by the official SWE-bench
 * evaluator, compared PER INSTANCE -- cost as a paired ratio, resolution as a
 * paired (McNemar) comparison.
 */

import { createHash } from 'node:crypto';

/** The arms. A closed set: an arm is an installed configuration, not a label. */
export const ARMS = Object.freeze({
  // `experimentArm` is the product's own TOKEN_OPTIMIZER_EXPERIMENT_ARM, a
  // closed set the MCP server validates at startup (baseline | optimizer |
  // retrieval | full). The first pilot passed the harness arm name instead;
  // the server rejected it and exited, so those plugin-arm runs measured the
  // hooks alone. Setting it at all also stops the in-product injection holdout
  // from withholding context at random in the middle of a benchmark.
  control: Object.freeze({ id: 'control', plugin: false, experimentArm: 'baseline', description: 'Claude Code with nothing installed' }),
  'token-optimizer': Object.freeze({ id: 'token-optimizer', plugin: true, experimentArm: 'full', description: "this checkout's plugin: hooks + MCP server" }),
});

export const DATASETS = Object.freeze({
  verified: 'princeton-nlp/SWE-bench_Verified',
  lite: 'princeton-nlp/SWE-bench_Lite',
});

/**
 * The environment an arm runs in. Everything that could route the CONTROL arm
 * through this product, or make either arm believe it is a child of the
 * session that launched the harness, is removed: the proxy base URL, every
 * TOKEN_OPTIMIZER_* switch, and Claude Code's own session variables. Found on
 * the machine this was written on, where the parent shell carried
 * ANTHROPIC_BASE_URL (the token-optimizer proxy) and twelve CLAUDE_CODE_* and
 * TOKEN_OPTIMIZER_* variables. An API key, when present, is kept: it decides
 * the billing mode on purpose.
 */
export function armEnv(parent, { arm, configDir, productHome }) {
  const env = {};
  for (const [key, value] of Object.entries(parent)) {
    if (key === 'ANTHROPIC_BASE_URL' || key === 'ANTHROPIC_AUTH_TOKEN') continue;
    if (/^TOKEN_OPTIMIZER_/.test(key) || /^CLAUDE_CODE_/.test(key) || /^CLAUDE_(PID|EFFORT|CONFIG_DIR)$/.test(key)) continue;
    env[key] = value;
  }
  env.CLAUDE_CONFIG_DIR = configDir;
  const known = ARMS[arm];
  if (!known) throw new Error(`unknown arm ${arm}; one of ${Object.keys(ARMS).join(', ')}`);
  env.TOKEN_OPTIMIZER_EXPERIMENT_ARM = known.experimentArm;
  // The account's claude.ai connectors (Gmail, Docs, Slack, ...) loaded in the
  // plugin arm and not in the control arm when probed: 46 tool definitions
  // billed to one arm only. Off in both.
  env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
  // THE PLUGIN ARM'S PROXY IS THE BUILD UNDER TEST, NOT THE ONE INSTALLED ON
  // THE MACHINE. Routing reuses whatever supervisor answers on the control
  // port, and on the machine this was written on that was the installed 7.9.0
  // serving the user's own sessions: pilot 5 measured that proxy, not this
  // checkout's. Its own home and ports make the snapshot start its own
  // supervisor, and leave the user's live one alone.
  if (known.plugin && productHome) {
    env.TOKEN_OPTIMIZER_HOME = productHome;
    env.TOKEN_OPTIMIZER_PROXY_CONTROL_PORT = String(BENCH_PORTS.control);
    env.TOKEN_OPTIMIZER_PROXY_ROUTE_BASE = String(BENCH_PORTS.routeBase);
  }
  return env;
}

/** The bench's own supervisor ports: outside the installed defaults (16999, 17000-17999). */
export const BENCH_PORTS = Object.freeze({ control: 24999, routeBase: 25000 });

/** Whether a run's MCP debug log shows the token-optimizer server connecting. */
export function mcpConnected(debugLog) {
  return /token-optimizer[^\n]*(?:connected|connection established|successfully)/i.test(String(debugLog));
}

/** A launcher shim (this product's managed `claude.cmd`) is never the binary under test. */
export function isShim(path) {
  return /[\\/]\.token-optimizer[\\/]/i.test(String(path)) || /\.(cmd|bat|ps1)$/i.test(String(path));
}

/** Cache-aware cost units (input = 1); the same weights toolprune uses. */
export const UNIT_WEIGHTS = Object.freeze({ input: 1, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2, output: 5 });

/** Deterministic 32-bit PRNG (mulberry32) so a plan is reproducible from its seed. */
export function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(items, random) {
  const out = [...items];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const pick = Math.floor(random() * (index + 1));
    [out[index], out[pick]] = [out[pick], out[index]];
  }
  return out;
}

/**
 * N instances, stratified by repository so one large repository (django is 46%
 * of Verified) cannot be the whole sample: round-robin over repositories in a
 * seeded order, each repository's instances seeded-shuffled.
 */
export function sampleInstances(instances, { n, seed }) {
  const random = rng(seed);
  const byRepo = new Map();
  for (const item of [...instances].sort((a, b) => a.instance_id.localeCompare(b.instance_id))) {
    if (!byRepo.has(item.repo)) byRepo.set(item.repo, []);
    byRepo.get(item.repo).push(item);
  }
  const queues = shuffle([...byRepo.keys()].sort(), random).map((repo) => shuffle(byRepo.get(repo), random));
  const out = [];
  while (out.length < n && queues.some((queue) => queue.length)) {
    for (const queue of queues) {
      if (out.length >= n) break;
      const next = queue.shift();
      if (next) out.push(next);
    }
  }
  return out;
}

/**
 * The run order, fixed before anything runs. Each instance's arms run back to
 * back (so both see the same API conditions), and which arm goes first
 * alternates by a seeded coin, so neither arm systematically inherits a warm
 * provider cache or a later time of day.
 */
export function runOrder(instanceIds, arms, { reps = 1, seed }) {
  const random = rng(seed ^ 0x9e3779b9);
  const order = [];
  for (let rep = 0; rep < reps; rep += 1) {
    for (const id of instanceIds) {
      const pair = random() < 0.5 ? [...arms] : [...arms].reverse();
      for (const arm of pair) order.push({ instanceId: id, arm, rep });
    }
  }
  return order;
}

export function runKey({ instanceId, arm, rep }) {
  return `${instanceId}::${arm}::${rep}`;
}

/** A fingerprint of the plan, recorded with every result so two plans never mix. */
export function planId(plan) {
  return createHash('sha256')
    .update(JSON.stringify({ dataset: plan.dataset, seed: plan.seed, model: plan.model, order: plan.order }))
    .digest('hex')
    .slice(0, 12);
}

/** What the agent is told: the issue, and the one rule SWE-bench scores on. */
export function promptFor(instance) {
  return [
    'You are working in a checkout of a Python repository at the current directory.',
    'Resolve the following GitHub issue by editing the repository source.',
    'Do not modify or add test files; the change is evaluated by hidden tests.',
    'When the change is complete, stop.',
    '',
    '<issue>',
    String(instance.problem_statement || '').trim(),
    '</issue>',
  ].join('\n');
}

/** Cache-aware units from a stream-json `result` event's `usage`. */
export function costUnits(usage = {}) {
  const creation = usage.cache_creation || {};
  const write1h = Number(creation.ephemeral_1h_input_tokens) || 0;
  const write5m =
    Number(creation.ephemeral_5m_input_tokens) || Math.max(0, (Number(usage.cache_creation_input_tokens) || 0) - write1h);
  return (
    (Number(usage.input_tokens) || 0) * UNIT_WEIGHTS.input +
    (Number(usage.cache_read_input_tokens) || 0) * UNIT_WEIGHTS.cacheRead +
    write5m * UNIT_WEIGHTS.cacheWrite5m +
    write1h * UNIT_WEIGHTS.cacheWrite1h +
    (Number(usage.output_tokens) || 0) * UNIT_WEIGHTS.output
  );
}

/** The last `result` event of a stream-json transcript, or null. */
export function resultEvent(streamText) {
  let last = null;
  for (const line of String(streamText).split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const event = JSON.parse(line);
      if (event?.type === 'result') last = event;
    } catch {
      // A partial line from a killed process.
    }
  }
  return last;
}

/** Drop test-file hunks: SWE-bench applies its own tests over the patch. */
export function stripTestChanges(diff) {
  const files = String(diff).split(/(?=^diff --git )/m);
  return files
    .filter((chunk) => {
      const match = chunk.match(/^diff --git a\/(\S+)/);
      if (!match) return chunk.trim() !== '';
      return !/(^|\/)(tests?|testing)\/|(^|\/)test_[^/]*\.py$|_tests?\.py$|(^|\/)conftest\.py$/.test(match[1]);
    })
    .join('');
}

// ---------------------------------------------------------------------------
// Statistics.

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

/**
 * Paired cost comparison: per-instance log(treatment / control), so a 2x saving
 * on a cheap task counts as much as on an expensive one. Returns the geometric
 * mean ratio and a percentile-bootstrap 95% interval.
 */
export function pairedRatio(pairs, { seed = 1, resamples = 10_000 } = {}) {
  const logs = pairs.filter(([a, b]) => a > 0 && b > 0).map(([control, treatment]) => Math.log(treatment / control));
  if (logs.length < 2) return { n: logs.length, ratio: logs.length ? Math.exp(logs[0]) : null, low: null, high: null };
  const random = rng(seed);
  const draws = [];
  for (let index = 0; index < resamples; index += 1) {
    let sum = 0;
    for (let k = 0; k < logs.length; k += 1) sum += logs[Math.floor(random() * logs.length)];
    draws.push(sum / logs.length);
  }
  draws.sort((a, b) => a - b);
  return {
    n: logs.length,
    ratio: Math.exp(mean(logs)),
    low: Math.exp(quantile(draws, 0.025)),
    high: Math.exp(quantile(draws, 0.975)),
  };
}

function binomialTail(k, n) {
  // P(X <= k) for X ~ Binomial(n, 1/2).
  let total = 0;
  let coefficient = 1;
  for (let i = 0; i <= k; i += 1) {
    if (i > 0) coefficient = (coefficient * (n - i + 1)) / i;
    total += coefficient;
  }
  return total / 2 ** n;
}

/**
 * Exact McNemar test on paired resolution: only the discordant instances
 * (resolved by one arm, not the other) carry information.
 */
export function mcnemar(pairs) {
  let onlyControl = 0;
  let onlyTreatment = 0;
  for (const [control, treatment] of pairs) {
    if (control && !treatment) onlyControl += 1;
    if (treatment && !control) onlyTreatment += 1;
  }
  const n = onlyControl + onlyTreatment;
  const p = n ? Math.min(1, 2 * binomialTail(Math.min(onlyControl, onlyTreatment), n)) : 1;
  return { onlyControl, onlyTreatment, p };
}
