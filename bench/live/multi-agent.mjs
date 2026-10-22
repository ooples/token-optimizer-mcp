#!/usr/bin/env node
/**
 * Multi-agent head-to-head: a lead Claude Code agent fixes four packages by
 * spawning one subagent per package, under each arm, and every API request of
 * every agent is measured on the same instrument.
 *
 * WHY THIS EXISTS. ab.sh measures one agent on a two-function repo, and every
 * arm in it runs with whatever plugin the user has installed -- so "control"
 * and an alternative's arm still had our hooks and MCP tools, and no run ever
 * compared the PRODUCT (hooks + MCP + proxy) with an alternative. A real
 * 10-agent campaign then spent 11.3M input tokens in 12 minutes, most of it on
 * context each agent re-reads every call, which a single-agent toy cannot show.
 *
 * SAME INSTRUMENT FOR EVERY ARM. Every arm's traffic passes through our proxy;
 * it compresses only in the arms that are ours, and in null mode it only
 * records. An alternative (`alt-a`) sits behind the recorder, so the usage
 * block of the provider's response -- what was actually billed for the request
 * it sent -- is what we count, not anyone's own savings report. The repository
 * does not name it: its launch command, launch environment and upstream
 * variable come from the operator's environment (ALT_A_CMD, ALT_A_ENV,
 * ALT_A_UPSTREAM_VAR), and the arm is skipped when they are unset.
 *
 * ISOLATION IS CHECKED, NOT ASSUMED. Each run's stream-json init event lists
 * the plugins and MCP servers that actually loaded; a run whose arm says
 * "plugin off" but which loaded token-optimizer is marked INVALID rather than
 * counted.
 *
 * CORRECTNESS FROM THE TESTS, NEVER FROM THE AGENT: after the run the visible
 * suites and hidden tests (kept outside the task directory) are run in a fresh
 * process.
 *
 * Usage (PowerShell):
 *   $env:ARMS='control,alt-a,ours'; $env:REPS='3'; node bench/live/multi-agent.mjs
 * Env: ARMS, REPS (multiple of the arm count balances position), MODEL
 * (default sonnet), OUT, ALT_A_CMD (the alternative's proxy command, `{port}`
 * marks its listen port), ALT_A_ENV (JSON: the environment its own launcher
 * gives the client), ALT_A_UPSTREAM_VAR (the variable it reads its upstream from),
 * PKG (our package root providing dist/proxy/cli.js; default this checkout),
 * NEXT_PLUGIN_DIR (plugin directory for the ours-next arm), RUN_TIMEOUT_S.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  cpSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(process.env.PKG ?? join(HERE, '..', '..'));
const ARMS = (process.env.ARMS ?? 'control,ours')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const REPS = Number(process.env.REPS ?? ARMS.length);
const MODEL = process.env.MODEL ?? 'sonnet';
/** The alternative's proxy command, split on spaces; `{port}` is replaced with its port. */
const ALT_A_CMD = (process.env.ALT_A_CMD ?? '')
  .trim()
  .split(/\s+/)
  .filter(Boolean);
const altCommand = (port) =>
  ALT_A_CMD.map((part) => part.replace('{port}', String(port)));
const RUN_TIMEOUT_S = Number(process.env.RUN_TIMEOUT_S ?? 1200);
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = resolve(
  process.env.OUT ??
    join(PKG, 'bench', 'live', 'results', `multi-agent-${STAMP}`)
);
const PLUGIN = 'token-optimizer@token-optimizer';
const CLAUDE_BIN =
  process.env.CLAUDE_BIN ??
  (() => {
    const r = spawnSync(
      process.platform === 'win32' ? 'where' : 'which',
      ['claude'],
      { encoding: 'utf8' }
    );
    const hit = (r.stdout ?? '')
      .split(/\r?\n/)
      .find((l) => /claude(\.exe)?$/i.test(l.trim()));
    // An npm-installed claude.cmd cannot be spawned without a shell, and a shell
    // would mangle the prompt: say so up front instead of failing every run.
    if (
      !hit &&
      process.platform === 'win32' &&
      !process.env.SELFCHECK &&
      !process.env.REGRADE
    )
      console.error(
        'claude.exe not found on PATH; set CLAUDE_BIN to the claude executable (not a .cmd shim)'
      );
    return hit ? hit.trim() : 'claude';
  })();
// TASK_VENV: a venv with pytest, put first on PATH for the agents too, so `python -m pytest` works for them.
const TASK_VENV = process.env.TASK_VENV ?? null;
const VENV_BIN = TASK_VENV
  ? join(TASK_VENV, process.platform === 'win32' ? 'Scripts' : 'bin')
  : null;
if (VENV_BIN)
  process.env.PATH = `${VENV_BIN}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`;
const PY =
  process.env.PYTHON ?? (VENV_BIN ? join(VENV_BIN, 'python') : 'python');

/**
 * The environment the alternative's own launcher gives the client (ALT_A_ENV,
 * a JSON object), so its arm is the product as its users run it and not a bare
 * proxy. Filled only where absent, like any launcher would.
 */
const ALT_A_ENV = (() => {
  try {
    const parsed = JSON.parse(process.env.ALT_A_ENV ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw new Error('ALT_A_ENV must be a JSON object of environment variables');
  }
})();

/**
 * Each arm: whether our plugin loads, how our proxy treats traffic, and
 * whether the alternative is behind it. `ours` is the product as a user
 * installs it: the installed plugin plus the compression proxy. `ours-next`
 * swaps in a plugin directory built from a branch.
 */
const ARM = {
  control: { plugin: false, proxyNull: true, alt: false },
  'alt-a': { plugin: false, proxyNull: true, alt: true, env: ALT_A_ENV },
  ours: { plugin: true, proxyNull: false, alt: false },
  'ours-hooks': { plugin: true, proxyNull: true, alt: false },
  'ours-next': { plugin: 'next', proxyNull: false, alt: false },
  // A frozen earlier build (PREV_PKG + PREV_PLUGIN_DIR), for before/after A/Bs of one change.
  'ours-prev': { plugin: 'prev', proxyNull: false, alt: false },
  // The A/B run before the reorder became the default: marker only, no task move.
  'ours-next-marker': {
    plugin: 'next',
    proxyNull: false,
    alt: false,
    proxyEnv: { TOKEN_OPTIMIZER_PROXY_SHARE_PREFIX: 'marker' },
  },
  // The repository pack's A/B: everything ours-next does, without the pack.
  'ours-next-nopack': {
    plugin: 'next',
    proxyNull: false,
    alt: false,
    proxyEnv: { TOKEN_OPTIMIZER_PROXY_REPO_PACK: '0' },
  },
  // One feature off each, for attribution against `ours-next`.
  // Prefetch is opt-in (prefetch.ts): this arm turns it on.
  'ours-next-prefetch': {
    plugin: 'next',
    proxyNull: false,
    alt: false,
    proxyEnv: { TOKEN_OPTIMIZER_PROXY_PREFETCH: '1' },
  },
  'ours-next-noterse': {
    plugin: 'next',
    proxyNull: false,
    alt: false,
    proxyEnv: { TOKEN_OPTIMIZER_PROXY_WORKER_TERSE: '0' },
  },
  // Hook-side features, switched off in the CLIENT's environment (the hooks run there).
  'ours-next-norepeats': {
    plugin: 'next',
    proxyNull: false,
    alt: false,
    env: { TOKEN_OPTIMIZER_REPEATS: '0' },
  },
  'ours-next-noboard': {
    plugin: 'next',
    proxyNull: false,
    alt: false,
    env: { TOKEN_OPTIMIZER_BLACKBOARD: '0' },
  },
  'ours-next-nohandoff': {
    plugin: 'next',
    proxyNull: false,
    alt: false,
    env: { TOKEN_OPTIMIZER_LEAN_HANDOFF: '0' },
  },
  // repo_ask is opt-in (quiet-env.mjs): this arm turns it on.
  'ours-next-ask': {
    plugin: 'next',
    proxyNull: false,
    alt: false,
    env: { TOKEN_OPTIMIZER_REPO_ASK: '1' },
  },
  // Server-side compaction (opt-in) at its minimum trigger, for the long task.
  'ours-next-compact': {
    plugin: 'next',
    proxyNull: false,
    alt: false,
    proxyEnv: {
      TOKEN_OPTIMIZER_PROXY_COMPACT: '1',
      TOKEN_OPTIMIZER_PROXY_COMPACT_TRIGGER: '50000',
    },
  },
  // Turn coalescing: the batching instruction in every request's system prompt.
  'ours-next-batch': {
    plugin: 'next',
    proxyNull: false,
    alt: false,
    proxyEnv: { TOKEN_OPTIMIZER_BATCH_GUIDANCE: '1' },
  },
  // Server-side clearing of old tool results (context-edit.ts, opt-in) on, for its A/B.
  'ours-next-clear': {
    plugin: 'next',
    proxyNull: false,
    alt: false,
    proxyEnv: { TOKEN_OPTIMIZER_PROXY_CLEAR_TOOL_USES: '1' },
  },
  // The pack's size: every call re-reads it, so it has to remove more than it adds.
  'ours-next-pack8k': {
    plugin: 'next',
    proxyNull: false,
    alt: false,
    proxyEnv: { TOKEN_OPTIMIZER_PROXY_REPO_PACK_CHARS: '8000' },
  },
};

const PACKAGES = ['pricing', 'inventory', 'schedule', 'ledger'];

// ---------------------------------------------------------------- the task --

/** Deterministic filler, so every arm reads the same bytes. */
function filler(name, count, seed) {
  const verbs = [
    'normalize',
    'validate',
    'merge',
    'split',
    'score',
    'rank',
    'clamp',
    'project',
    'bucket',
    'scale',
  ];
  const nouns = [
    'record',
    'window',
    'batch',
    'entry',
    'series',
    'quote',
    'slot',
    'line',
    'tier',
    'span',
  ];
  let out = '';
  for (let i = 0; i < count; i++) {
    const v = verbs[(i * 7 + seed) % verbs.length];
    const n = nouns[(i * 3 + seed) % nouns.length];
    out += `
def ${v}_${n}_${i}(values, factor=${(i % 5) + 1}, limit=${100 + i}):
    """${v[0].toUpperCase() + v.slice(1)} each ${n} in \`values\` for the ${name} pipeline.

    Kept for the batch importer (see docs/${name}/${n}.md). Values above
    \`limit\` are clamped before scaling so one outlier cannot dominate.
    """
    result = []
    for index, value in enumerate(values):
        if value is None:
            continue
        clamped = min(value, limit)
        adjusted = clamped * factor
        if index % ${(i % 3) + 2} == 0:
            adjusted = adjusted - (index % ${(i % 4) + 1})
        result.append(round(adjusted, 4))
    return result
`;
  }
  return out;
}

const BUGS = {
  pricing: {
    code: `
def apply_discount(price, percent):
    """Price after a percentage discount, rounded to cents."""
    factor = 1 - percent / 100
    discounted = price * factor
    discounted = discounted * factor  # applied once in checkout, once here
    return round(discounted, 2)
`,
    tests: `from pricing.core import apply_discount

def test_ten_percent():
    assert apply_discount(200.0, 10) == 180.0

def test_zero():
    assert apply_discount(50.0, 0) == 50.0
`,
    hidden: `from pricing.core import apply_discount

def test_hidden_quarter():
    assert apply_discount(80.0, 25) == 60.0

def test_hidden_full():
    assert apply_discount(19.99, 100) == 0.0
`,
    failing: 'tests/test_core.py::test_ten_percent',
    assertion: 'assert 162.0 == 180.0',
  },
  inventory: {
    code: `
def reorder_point(daily_demand, lead_days, safety_stock):
    """Units on hand at which to reorder: demand over the lead time plus safety stock."""
    return daily_demand * (lead_days - 1) + safety_stock
`,
    tests: `from inventory.core import reorder_point

def test_basic():
    assert reorder_point(10, 5, 20) == 70

def test_no_safety():
    assert reorder_point(3, 1, 0) == 3
`,
    hidden: `from inventory.core import reorder_point

def test_hidden_large():
    assert reorder_point(120, 14, 300) == 1980

def test_hidden_zero_lead():
    assert reorder_point(5, 0, 7) == 7
`,
    failing: 'tests/test_core.py::test_basic',
    assertion: 'assert 60 == 70',
  },
  schedule: {
    code: `
def utc_offset_minutes(offset):
    """Minutes east of UTC for an offset such as '+05:30' or '-08:00'."""
    sign = -1 if offset[0] == '+' else 1
    hours, minutes = offset[1:].split(':')
    return sign * (int(hours) * 60 + int(minutes))
`,
    tests: `from schedule.core import utc_offset_minutes

def test_india():
    assert utc_offset_minutes('+05:30') == 330

def test_pacific():
    assert utc_offset_minutes('-08:00') == -480
`,
    hidden: `from schedule.core import utc_offset_minutes

def test_hidden_zero():
    assert utc_offset_minutes('+00:00') == 0

def test_hidden_newfoundland():
    assert utc_offset_minutes('-03:30') == -210
`,
    failing: 'tests/test_core.py::test_india',
    assertion: 'assert -330 == 330',
  },
  ledger: {
    code: `
def settle(amount):
    """Amount rounded to cents, half to even, as the bank settles it."""
    return int(amount * 100) / 100
`,
    tests: `from ledger.core import settle

def test_round_up():
    assert settle(10.239) == 10.24

def test_exact():
    assert settle(5.5) == 5.5
`,
    hidden: `from ledger.core import settle

def test_hidden_half_even_down():
    assert settle(2.125) == 2.12

# Exact binary halves only: 2.135 is stored as 2.13499..., so Python's own
# half-even round() and a Decimal(str(x)) fix disagree on it, and the test
# failed correct fixes in every arm (4 of 4 failures in the first 8 runs).
def test_hidden_half_even_up():
    assert settle(0.375) == 0.38

def test_hidden_half_even_eighth():
    assert settle(0.125) == 0.12

def test_hidden_negative():
    assert settle(-1.006) == -1.01
`,
    failing: 'tests/test_core.py::test_round_up',
    assertion: 'assert 10.23 == 10.24',
  },
};

/** A CI log the size a real one is: mostly passing noise, one failure in the middle. */
function ciLog(name, seed) {
  const lines = [
    `============================= test session starts =============================`,
    `platform linux -- Python 3.12.4, pytest-8.3.2, pluggy-1.5.0`,
    `rootdir: /builds/acme/monorepo`,
    `collected 2412 items`,
    '',
  ];
  for (let i = 0; i < 2400; i++) {
    const mod = ['batch', 'window', 'series', 'quote', 'tier'][(i + seed) % 5];
    lines.push(
      `pkgs/${name}/tests/test_${mod}_${i % 60}.py::test_case_${i} PASSED${' '.repeat(8)}[${String(Math.floor((i / 2412) * 100)).padStart(3)}%]`
    );
    if (i % 97 === 0)
      lines.push(
        `  /builds/acme/monorepo/pkgs/${name}/${name}/util.py:${40 + (i % 50)}: DeprecationWarning: datetime.utcnow() is deprecated`
      );
    if (i === 1300) {
      const b = BUGS[name];
      lines.push(
        `pkgs/${name}/${b.failing} FAILED`,
        '',
        '=================================== FAILURES ===================================',
        `_____________________ ${b.failing.split('::')[1]} _____________________`,
        '',
        `    def ${b.failing.split('::')[1]}():`,
        `>       ${b.assertion}`,
        `E       ${b.assertion}`,
        '',
        `pkgs/${name}/tests/test_core.py:4: AssertionError`,
        ''
      );
    }
  }
  lines.push(
    `=========================== short test summary info ============================`,
    `FAILED pkgs/${name}/${BUGS[name].failing} - ${BUGS[name].assertion}`,
    `================ 1 failed, 2411 passed, 24 warnings in 312.44s ================`
  );
  return lines.join('\n') + '\n';
}

function git(cwd, ...args) {
  const r = spawnSync(
    'git',
    [
      '-c',
      'user.name=bench',
      '-c',
      'user.email=bench@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8' }
  );
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}

function seed(work, hidden, rep) {
  mkdirSync(join(work, 'ci-logs'), { recursive: true });
  writeFileSync(
    join(work, 'pytest.ini'),
    `[pytest]\npythonpath = ${PACKAGES.map((p) => `pkgs/${p}`).join(' ')}\naddopts = -p no:cacheprovider --import-mode=importlib\n`
  );
  writeFileSync(
    join(work, 'README.md'),
    `# acme monorepo\n\nFour packages under pkgs/. CI logs for the last failing pipeline are in ci-logs/.\n`
  );
  git(work, 'init', '-q', '-b', 'main');
  for (const [k, p] of PACKAGES.entries()) {
    const dir = join(work, 'pkgs', p);
    mkdirSync(join(dir, p), { recursive: true });
    mkdirSync(join(dir, 'tests'), { recursive: true });
    writeFileSync(join(dir, p, '__init__.py'), '');
    writeFileSync(
      join(dir, p, 'util.py'),
      `"""Shared helpers for ${p}."""\n` + filler(p, 30, k + 11)
    );
    writeFileSync(
      join(dir, p, 'core.py'),
      `"""Core ${p} rules."""\n` +
        filler(p, 25, k) +
        BUGS[p].code +
        filler(p + '_tail', 15, k + 3)
    );
    writeFileSync(join(dir, 'tests', 'test_core.py'), BUGS[p].tests);
    writeFileSync(join(hidden, `test_hidden_${p}.py`), BUGS[p].hidden);
    writeFileSync(join(work, 'ci-logs', `${p}.log`), ciLog(p, k + rep));
  }
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'import monorepo');
  for (let i = 0; i < 6; i++) {
    writeFileSync(join(work, 'CHANGES.md'), `release ${i}\n`.repeat(i + 1));
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', `chore: release notes ${i}`);
  }
}

const PROMPT = [
  'This repository has four Python packages under pkgs/ (pricing, inventory, schedule, ledger). Each has a failing test;',
  'the CI log of the failing pipeline for each package is in ci-logs/<package>.log.',
  'Work as a team: use the Agent tool to start one subagent per package, all four in parallel. Each subagent must find',
  'the root cause from its CI log and the package source, fix the source (never the tests), and confirm with',
  '`python -m pytest pkgs/<package> -q`. When all four are done, run `python -m pytest -q` for the whole repository',
  'and report the result in at most two lines.',
].join(' ');

// ---------------------------------------------- TASK=loop: an edit/test loop --
//
// The fix task's four broken packages, worked by ONE agent that runs the whole
// suite after every fix: the same command again and again with output that
// changes, and files re-read after editing. Diff-only repeats target exactly
// this, and no fan-out worker ever does it. Graded like the fix task.
const LOOP_PROMPT = [
  'This repository has four Python packages under pkgs/ (pricing, inventory, schedule, ledger). Each has a failing test;',
  'the CI log of the failing pipeline for each package is in ci-logs/<package>.log. Do the work yourself: do not use the Agent',
  'tool or start subagents. Fix the packages one at a time, root cause from the CI log and the source, fixing the source and',
  'never the tests. After EACH fix, run `python -m pytest -q` for the whole repository and read its output before moving on,',
  'and re-read the file you changed to confirm the edit. When all four pass, report the result in at most two lines.',
].join(' ');

// ------------------------------------------------- TASK=explore: a real repo --
//
// The fix task is small enough that agents grep the logs and never produce big
// output. The campaign that burned 11.3M tokens was exploration of a large repo
// -- git show, git grep, ls, cat -- so this task asks four subagents factual
// questions about a 4,779-file snapshot whose answers are known at a pinned
// commit, and grades the answers exactly.
// This checkout by default: EXPLORE_COMMIT pins the snapshot whatever is checked out.
const EXPLORE_REPO = resolve(process.env.EXPLORE_REPO ?? PKG);
const EXPLORE_COMMIT = 'f0531cecceb3ccc925269ae0a2c9f254904808a2';
const EXPLORE_ANSWERS = {
  proxy: {
    keepConstant: 'DEFAULT_KEEP_RELEVANT',
    keepValue: 5,
    routingFn: 'defaultRoutingAllowed',
  },
  bound: {
    bytes: 30000,
    envVar: 'TOKEN_OPTIMIZER_BOUND_BYTES',
    tailShare: 0.5,
  },
  expand: { ttlDays: 30, regenMs: 3000 },
  grep: { maxGlobs: 2000, hintFn: 'gitignoredHint' },
};
const EXPLORE_PROMPT = [
  'This is the token-optimizer-mcp repository. Answer the questions below from the code, working as a team: use the Agent tool',
  'to start one subagent per section (proxy, bound, expand, grep), all four in parallel. Each subagent finds its answers in the code',
  'and cites file:line in its reply. Then write answers.json at the repository root with exactly this shape and nothing else:',
  '{"proxy":{"keepConstant":"","keepValue":0,"routingFn":""},"bound":{"bytes":0,"envVar":"","tailShare":0},"expand":{"ttlDays":0,"regenMs":0},"grep":{"maxGlobs":0,"hintFn":""}}.',
  'Do not modify any other file. Questions --',
  'proxy: when the compression proxy defers tool definitions, how many non-core tools does it keep loaded by default (the constant name and its value),',
  'and which exported function decides whether default routing into Claude Code settings is allowed?',
  'bound: what is the default byte bound applied to output-heavy shell commands by the hooks, which environment variable overrides it,',
  "and what share of the byte budget does the hooks' compact() function reserve for the ending of an output?",
  'expand: how many days are captured artifacts kept, and below how many milliseconds of regeneration cost is a stale artifact regenerated instead of served?',
  'grep: what is the maximum number of gitignored globs smart_grep passes to its search, and what is the name of the function that builds the hint',
  'naming the ignored directory when only gitignored files match?',
].join(' ');

// --------------------------------------- TASK=long: one agent, a long session --
//
// Clearing old tool results (context-edit.ts) only pays once a conversation is
// long, and no fan-out worker gets there. This is the explore questions worked
// by ONE agent, section by section, reading every file it relies on in full and
// keeping notes -- a session that grows the way a long main session does --
// graded by the same exact answers.
const LONG_PROMPT = [
  'This is the token-optimizer-mcp repository. Answer the questions below from the code yourself: do not use the Agent tool or start subagents.',
  'Work through the sections strictly one at a time, in this order: proxy, bound, expand, grep. For each section, read every file you rely on in full with Read',
  "(no line ranges), cite file:line, and append that section's answers to notes.md before you start the next section.",
  'When all four are done, write answers.json at the repository root with exactly this shape and nothing else:',
  '{"proxy":{"keepConstant":"","keepValue":0,"routingFn":""},"bound":{"bytes":0,"envVar":"","tailShare":0},"expand":{"ttlDays":0,"regenMs":0},"grep":{"maxGlobs":0,"hintFn":""}}.',
  'Do not modify any other file. Questions --',
  ...EXPLORE_PROMPT.slice(EXPLORE_PROMPT.indexOf('Questions --') + 'Questions --'.length).trim().split(/(?<=\?) (?=[a-z]+: )/),
].join(' ');

// ------------------------------- TASK=overlap: siblings repeating each other --
//
// The explore fan-out, but every subagent must first establish the same three
// facts about the repository before its own section -- the duplicated sibling
// work the blackboard and duplicate detection are for. Graded by the same
// exact answers.
const OVERLAP_PROMPT = EXPLORE_PROMPT.replace(
  'Each subagent finds its answers in the code',
  'Each subagent first establishes, from the repository itself, (1) the exact npm script that runs the unit tests,' +
    ' (2) the directory that holds the hook sources shared by every client integration, and (3) the file that defines' +
    " the compression proxy's HTTP server -- and states them at the top of its reply -- then finds its answers in the code"
);

function seedExplore(work) {
  // A plain path, which git clones on every platform (a hand-built file:// URL
  // came out as file://// for absolute POSIX paths). No --depth: a shallow clone
  // of a local path is not honoured, and the pinned commit must be reachable.
  const known = spawnSync(
    'git',
    ['-C', EXPLORE_REPO, 'cat-file', '-e', `${EXPLORE_COMMIT}^{commit}`],
    { encoding: 'utf8' }
  );
  if (known.status !== 0)
    throw new Error(
      `TASK=explore needs a token-optimizer-mcp clone containing ${EXPLORE_COMMIT}: set EXPLORE_REPO (now ${EXPLORE_REPO})`
    );
  const r = spawnSync(
    'git',
    ['clone', '--quiet', '--no-checkout', EXPLORE_REPO, work],
    { encoding: 'utf8' }
  );
  if (r.status !== 0)
    throw new Error(`clone of ${EXPLORE_REPO} failed: ${r.stderr}`);
  git(work, 'checkout', '-q', EXPLORE_COMMIT);
}

function verdictExplore(work, allowed = /answers\.json$/) {
  let got = null;
  try {
    got = JSON.parse(readFileSync(join(work, 'answers.json'), 'utf8'));
  } catch {
    /* missing or malformed */
  }
  // Numbers may be written with separators (30_000, "30,000"); names must match exactly.
  const num = (v) => Number(String(v ?? '').replace(/[_,\s]/g, ''));
  const fields = [];
  for (const [section, answers] of Object.entries(EXPLORE_ANSWERS))
    for (const [key, want] of Object.entries(answers)) {
      const have = got?.[section]?.[key];
      const ok =
        typeof want === 'number'
          ? num(have) === want
          : String(have ?? '').trim() === want;
      fields.push({ field: `${section}.${key}`, ok, have: have ?? null });
    }
  const correct = fields.filter((f) => f.ok).length;
  const dirty = spawnSync('git', ['status', '--porcelain'], {
    cwd: work,
    encoding: 'utf8',
  })
    .stdout.split('\n')
    .filter((l) => l.trim() && !allowed.test(l));
  return {
    visible: correct === fields.length,
    hidden: true,
    testsUntouched: dirty.length === 0,
    pass: correct === fields.length && dirty.length === 0,
    correct,
    of: fields.length,
    wrong: fields.filter((f) => !f.ok),
  };
}

const TASK = process.env.TASK ?? 'fix';

/**
 * TASK=campaign: a real multi-agent workload, replayed. CAMPAIGN_SCRIPT is a
 * Workflow script (generated from a real run's agent tasks, read-only), and the
 * lead runs it through the Workflow tool -- the agent type whose requests carry
 * the client's full injected context. Run it with ISOLATE=0 so every arm sees
 * the operator's real environment, as the original run did.
 */
const CAMPAIGN_SCRIPT = process.env.CAMPAIGN_SCRIPT
  ? resolve(process.env.CAMPAIGN_SCRIPT)
  : null;
const CAMPAIGN_AGENTS = Number(process.env.CAMPAIGN_AGENTS ?? 10);
/** A replay counts when every one of its agents ran and the lead finished. */
function verdictCampaign(agents, result) {
  // agentBreakdown keeps the last two path segments; a worker's file is agent-<id>.jsonl.
  const workers = (agents ?? []).filter((a) =>
    /(^|\/)agent-[^/]+\.jsonl$/.test(a.file)
  ).length;
  const finished = /\bDONE\b/.test(String(result?.result ?? ''));
  const pass = workers >= CAMPAIGN_AGENTS && finished;
  return {
    visible: pass,
    hidden: true,
    testsUntouched: true,
    pass,
    workers,
    finished,
  };
}
const campaignPrompt = () =>
  `Use a workflow: call the Workflow tool once with scriptPath "${CAMPAIGN_SCRIPT}" and no other arguments, ` +
  'exactly as given. Wait until the workflow has finished, then reply with the single word DONE.';

// --------------------------------------------------------------- the arms --

const alive = async (port) => {
  try {
    await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    return true;
  } catch {
    return false;
  }
};
const waitAlive = async (port, tries) => {
  for (let i = 0; i < tries; i++) {
    if (await alive(port)) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
};

function startProcess(cmd, args, env, errFile) {
  const p = spawn(cmd, args, {
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  const chunks = [];
  p.stderr.on('data', (d) => chunks.push(d));
  // A missing binary must not crash the campaign: the run's readiness check
  // then reports it as a SKIP.
  p.on('error', (e) =>
    chunks.push(Buffer.from(`spawn failed: ${e.message}\n`))
  );
  p.on('exit', () => {
    try {
      writeFileSync(errFile, Buffer.concat(chunks));
    } catch {
      /* out dir gone */
    }
  });
  return p;
}

function kill(p) {
  if (!p || p.exitCode !== null) return;
  // By PID only, and only processes this runner started (tree, on Windows).
  if (process.platform === 'win32')
    spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], {
      stdio: 'ignore',
    });
  else p.kill('SIGTERM');
}

/**
 * Transcript totals plus the keep-warm pings the recorder saw: a ping is real
 * spend that no agent transcript holds, so an arm's cost must include it.
 */
function withPings(totals, recorded) {
  if (!totals || !recorded?.pingUsage) return totals;
  const p = recorded.pingUsage;
  const t = {
    ...totals,
    requests: totals.requests + recorded.pings,
    pings: recorded.pings,
    input: totals.input + p.input,
    cacheWrite: totals.cacheWrite + p.cacheWrite,
    cacheRead: totals.cacheRead + p.cacheRead,
    output: totals.output + p.output,
  };
  t.weightedInput = Math.round(
    t.input + t.cacheWrite * 1.25 + t.cacheRead * 0.1
  );
  t.allInput = t.input + t.cacheWrite + t.cacheRead;
  return t;
}

function ledgerTotals(file) {
  const t = {
    requests: 0,
    input: 0,
    cacheWrite: 0,
    cacheRead: 0,
    output: 0,
    beforeBytes: 0,
    afterBytes: 0,
    compressed: 0,
  };
  if (!existsSync(file)) return null;
  for (const l of readFileSync(file, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    let j;
    try {
      j = JSON.parse(l);
    } catch {
      continue;
    }
    const u = j.usage ?? {};
    if (
      !u.input_tokens &&
      !u.output_tokens &&
      !u.cache_read_input_tokens &&
      !u.cache_creation_input_tokens
    )
      continue;
    t.requests++;
    t.input += u.input_tokens ?? 0;
    t.output += u.output_tokens ?? 0;
    t.cacheWrite += u.cache_creation_input_tokens ?? 0;
    t.cacheRead += u.cache_read_input_tokens ?? 0;
    // Keep-warm pings are spent by the proxy itself and appear in no transcript.
    if (j.path === 'keepwarm') {
      t.pings = (t.pings ?? 0) + 1;
      t.pingUsage ??= { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
      t.pingUsage.input += u.input_tokens ?? 0;
      t.pingUsage.output += u.output_tokens ?? 0;
      t.pingUsage.cacheWrite += u.cache_creation_input_tokens ?? 0;
      t.pingUsage.cacheRead += u.cache_read_input_tokens ?? 0;
    }
    t.beforeBytes += j.beforeBytes ?? 0;
    t.afterBytes += j.afterBytes ?? 0;
    t.compressed += j.compressed ? 1 : 0;
  }
  // Weighted the way the provider bills input: cache write 1.25x, cache read 0.1x.
  t.weightedInput = Math.round(
    t.input + t.cacheWrite * 1.25 + t.cacheRead * 0.1
  );
  t.allInput = t.input + t.cacheWrite + t.cacheRead;
  return t;
}

/** Provider usage classes summed over one transcript's distinct API calls. */
function usageOf(file) {
  const seen = new Set();
  const u = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  for (const l of readFileSync(file, 'utf8').split('\n')) {
    let e;
    try {
      e = JSON.parse(l);
    } catch {
      continue;
    }
    const x = e.type === 'assistant' && e.message?.usage;
    if (!x || seen.has(e.message.id)) continue;
    seen.add(e.message.id);
    u.input += x.input_tokens ?? 0;
    u.cacheWrite += x.cache_creation_input_tokens ?? 0;
    u.cacheRead += x.cache_read_input_tokens ?? 0;
    u.output += x.output_tokens ?? 0;
  }
  return u;
}

/**
 * Totals across every agent of the run, from the transcripts: the usage block the provider returned
 * for each call, whichever proxy the call went through. The recorder ledger is the cross-check.
 */
function transcriptTotals(agents) {
  if (!agents?.length) return null;
  const t = agents.reduce(
    (s, a) => ({
      requests: s.requests + a.calls,
      input: s.input + a.input,
      cacheWrite: s.cacheWrite + a.cacheWrite,
      cacheRead: s.cacheRead + a.cacheRead,
      output: s.output + a.output,
    }),
    { requests: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }
  );
  t.weightedInput = Math.round(
    t.input + t.cacheWrite * 1.25 + t.cacheRead * 0.1
  );
  t.allInput = t.input + t.cacheWrite + t.cacheRead;
  return t;
}

/** Per-agent breakdown from the session transcripts Claude Code wrote for this run. */
function agentBreakdown(sessionId) {
  if (!sessionId) return null;
  const root = join(homedir(), '.claude', 'projects');
  const files = [];
  const walk = (d, depth) => {
    if (depth > 4 || !existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith('.jsonl') && p.includes(sessionId))
        files.push(p);
    }
  };
  for (const proj of readdirSync(root)) walk(join(root, proj), 0);
  const agents = [];
  for (const f of files) {
    const seen = new Set();
    let calls = 0,
      firstCtx = null,
      lastCtx = 0,
      read = 0;
    for (const l of readFileSync(f, 'utf8').split('\n')) {
      let e;
      try {
        e = JSON.parse(l);
      } catch {
        continue;
      }
      const u = e.type === 'assistant' && e.message?.usage;
      if (!u || seen.has(e.message.id)) continue;
      seen.add(e.message.id);
      const ctx =
        (u.input_tokens ?? 0) +
        (u.cache_read_input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0);
      calls++;
      read += ctx;
      firstCtx ??= ctx;
      lastCtx = ctx;
    }
    agents.push({
      file: f.split(/[\\/]/).slice(-2).join('/'),
      calls,
      firstCtx,
      lastCtx,
      allInput: read,
      ...usageOf(f),
    });
  }
  return agents;
}

function verdict(work, hidden) {
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
  const visible = spawnSync(PY, ['-m', 'pytest', '-q'], {
    cwd: work,
    env,
    encoding: 'utf8',
    timeout: 180_000,
  });
  // Hidden tests run from the outside, against the fixed sources, after the agent has exited.
  const paths = PACKAGES.map((p) => join(work, 'pkgs', p)).join(
    process.platform === 'win32' ? ';' : ':'
  );
  const hid = spawnSync(
    PY,
    ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', hidden],
    { env: { ...env, PYTHONPATH: paths }, encoding: 'utf8', timeout: 180_000 }
  );
  const testsUntouched = PACKAGES.every(
    (p) =>
      readFileSync(join(work, 'pkgs', p, 'tests', 'test_core.py'), 'utf8') ===
      BUGS[p].tests
  );
  return {
    visible: visible.status === 0,
    hidden: hid.status === 0,
    testsUntouched,
    pass: visible.status === 0 && hid.status === 0 && testsUntouched,
  };
}

async function runArm(arm, rep, position) {
  const cfg = ARM[arm];
  if (!cfg) throw new Error(`unknown arm ${arm}`);
  const tag = `${arm}-${rep}`;
  const work = join(OUT, tag, 'work');
  const hidden = join(OUT, tag, 'hidden');
  const state = join(OUT, tag, 'optimizer-state');
  mkdirSync(work, { recursive: true });
  mkdirSync(hidden, { recursive: true });
  mkdirSync(state, { recursive: true });
  if (TASK === 'campaign') {
    if (!CAMPAIGN_SCRIPT || !existsSync(CAMPAIGN_SCRIPT))
      throw new Error('TASK=campaign needs CAMPAIGN_SCRIPT, a Workflow script');
  } else if (TASK === 'explore' || TASK === 'long' || TASK === 'overlap')
    seedExplore(work);
  else seed(work, hidden, rep);
  const ledger = join(OUT, `${tag}.ledger.jsonl`);
  const base =
    Number(process.env.PORT_BASE ?? 18_900) +
    Object.keys(ARM).indexOf(arm) * 10;
  const procs = [];
  try {
    if (cfg.alt && ALT_A_CMD.length === 0)
      return { arm, rep, position, verdict: 'SKIP', note: 'ALT_A_CMD not set' };
    // ALT_BEHIND=1 puts the recorder BEHIND the alternative (claude -> alternative -> recorder ->
    // provider), so a capture shows the bytes it actually forwarded; the default keeps it in front.
    // Needs ALT_A_UPSTREAM_VAR, the variable the alternative reads its upstream from.
    const behind = cfg.alt && process.env.ALT_BEHIND === '1';
    let upstream = null;
    if (cfg.alt && !behind) {
      const hp = base + 1;
      const [cmd, ...cmdArgs] = altCommand(hp);
      procs.push(
        startProcess(
          cmd,
          cmdArgs,
          { ...process.env },
          join(OUT, `${tag}.alt.err`)
        )
      );
      if (!(await waitAlive(hp, 45)))
        return {
          arm,
          rep,
          position,
          verdict: 'SKIP',
          note: 'alternative proxy never came up',
        };
      upstream = `http://127.0.0.1:${hp}`;
    }
    // CAPTURE_FORWARDED=1 on a compressing arm: a second, null-mode recorder BEHIND our proxy
    // captures the bytes our compressor actually forwarded (claude -> ours -> capture -> provider).
    if (!cfg.proxyNull && process.env.CAPTURE_FORWARDED === '1' && !upstream) {
      const cp = base + 3;
      procs.push(
        startProcess(
          process.execPath,
          [
            join(PKG, 'dist', 'proxy', 'cli.js'),
            '--port',
            String(cp),
            '--quiet',
          ],
          {
            ...process.env,
            TOKEN_OPTIMIZER_PROXY: '1',
            TOKEN_OPTIMIZER_PROXY_NULL: '1',
            TOKEN_OPTIMIZER_PROXY_CAPTURE: join(OUT, `${tag}.forwarded`),
          },
          join(OUT, `${tag}.forwarded.err`)
        )
      );
      if (!(await waitAlive(cp, 20)))
        return {
          arm,
          rep,
          position,
          verdict: 'SKIP',
          note: 'forwarded-capture recorder never came up',
        };
      upstream = `http://127.0.0.1:${cp}`;
    }
    const proxyEnv = {
      ...process.env,
      TOKEN_OPTIMIZER_PROXY: '1',
      TOKEN_OPTIMIZER_PROXY_ACCOUNTING: ledger,
      // Run-local state (repository packs and their pins) for the proxy too.
      TOKEN_OPTIMIZER_HOME: join(state, 'home'),
    };
    if (cfg.proxyNull) proxyEnv.TOKEN_OPTIMIZER_PROXY_NULL = '1';
    Object.assign(proxyEnv, cfg.proxyEnv ?? {});
    // CAPTURE=1: request bodies as the recorder received them (bench only; conversation content on disk).
    if (process.env.CAPTURE === '1')
      proxyEnv.TOKEN_OPTIMIZER_PROXY_CAPTURE = join(OUT, `${tag}.capture`);
    // ours-next runs the branch's proxy build (NEXT_PKG), every other arm this checkout's.
    const proxyPkg =
      cfg.plugin === 'next' && process.env.NEXT_PKG
        ? resolve(process.env.NEXT_PKG)
        : cfg.plugin === 'prev' && process.env.PREV_PKG
          ? resolve(process.env.PREV_PKG)
          : PKG;
    procs.push(
      startProcess(
        process.execPath,
        [
          join(proxyPkg, 'dist', 'proxy', 'cli.js'),
          '--port',
          String(base),
          '--quiet',
          ...(upstream ? ['--upstream', upstream] : []),
        ],
        proxyEnv,
        join(OUT, `${tag}.proxy.err`)
      )
    );
    if (!(await waitAlive(base, 20)))
      return {
        arm,
        rep,
        position,
        verdict: 'SKIP',
        note: 'recorder proxy never came up',
      };
    let clientBase = base;
    if (behind) {
      const upstreamVar = process.env.ALT_A_UPSTREAM_VAR;
      if (!upstreamVar)
        return {
          arm,
          rep,
          position,
          verdict: 'SKIP',
          note: 'ALT_BEHIND=1 needs ALT_A_UPSTREAM_VAR',
        };
      const hp = base + 1;
      const [cmd, ...cmdArgs] = altCommand(hp);
      procs.push(
        startProcess(
          cmd,
          cmdArgs,
          { ...process.env, [upstreamVar]: `http://127.0.0.1:${base}` },
          join(OUT, `${tag}.alt.err`)
        )
      );
      if (!(await waitAlive(hp, 45)))
        return {
          arm,
          rep,
          position,
          verdict: 'SKIP',
          note: 'alternative proxy never came up',
        };
      clientBase = hp;
    }

    // USER SETTINGS ARE NOT PART OF ANY ARM. The operator's ~/.claude/settings.json hooks ran inside every
    // run: a PreToolUse guard that blocks any command containing "quantiz" (so `Decimal.quantize`, the
    // natural ledger fix, was refused and agents fell back to round()), UserPromptSubmit hooks that inject
    // research context into the prompt, and Stop hooks. Skipping the user source and passing only what an
    // arm needs keeps the arms about the product. ISOLATE=0 restores the user's settings.
    const isolate = process.env.ISOLATE !== '0';
    const settings = {
      ...(isolate
        ? { env: { TOKEN_OPTIMIZER_MODE: process.env.ARM_MODE ?? 'assist' } }
        : {}),
      enabledPlugins: { [PLUGIN]: cfg.plugin === true },
    };
    const args = [
      '-p',
      TASK === 'campaign'
        ? campaignPrompt()
        : TASK === 'explore'
          ? EXPLORE_PROMPT
          : TASK === 'long'
            ? LONG_PROMPT
            : TASK === 'overlap'
              ? OVERLAP_PROMPT
              : TASK === 'loop'
                ? LOOP_PROMPT
                : PROMPT,
      '--model',
      MODEL,
      '--permission-mode',
      'bypassPermissions',
      '--output-format',
      'stream-json',
      '--verbose',
      '--settings',
      JSON.stringify(settings),
      ...(isolate ? ['--setting-sources', 'project,local'] : []),
    ];
    if (cfg.plugin === 'next') {
      if (!process.env.NEXT_PLUGIN_DIR)
        return {
          arm,
          rep,
          position,
          verdict: 'SKIP',
          note: 'NEXT_PLUGIN_DIR not set',
        };
      args.push('--plugin-dir', process.env.NEXT_PLUGIN_DIR);
    }
    if (cfg.plugin === 'prev') {
      if (!process.env.PREV_PLUGIN_DIR || !process.env.PREV_PKG)
        return {
          arm,
          rep,
          position,
          verdict: 'SKIP',
          note: 'PREV_PKG / PREV_PLUGIN_DIR not set',
        };
      args.push('--plugin-dir', process.env.PREV_PLUGIN_DIR);
    }
    const env = {
      ...process.env,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${clientBase}`,
      TOKEN_OPTIMIZER_STATE_DIR: join(state, 'state'),
      TOKEN_OPTIMIZER_WIKI_DIR: join(state, 'wiki'),
      TOKEN_OPTIMIZER_SHARED_DIR: join(state, 'shared'),
      TOKEN_OPTIMIZER_UCR_DIR: join(state, 'ucr'),
      // THE PLUGIN'S DEFAULT ROUTING WRITES ~/.claude/settings.json. Unredirected, the first arm run
      // with the plugin rewrote the user's real settings, Claude Code reloaded them mid-run, and every
      // later request left the recorder (1 of ~30 recorded). Run-local paths keep it off the user's
      // file and keep each run's traffic on this run's proxy; the proxy itself compresses for `ours`.
      TOKEN_OPTIMIZER_SETTINGS: join(state, 'claude-settings.json'),
      TOKEN_OPTIMIZER_HOME: join(state, 'home'),
    };
    for (const [k, val] of Object.entries(cfg.env ?? {}))
      if (!(k in env)) env[k] = String(val);
    // A nested run must not believe it is the parent session.
    for (const k of Object.keys(env))
      if (
        /^CLAUDE_?CODE(_|$)|^CLAUDECODE$/.test(k) &&
        k !== 'CLAUDE_CODE_GIT_BASH_PATH'
      )
        delete env[k];

    // In print mode the client stops a background workflow 10 minutes after its
    // last turn; three of twelve campaign runs were cut off that way, which made
    // them cheaper and invalid. The run's own RUN_TIMEOUT_S is the bound instead.
    env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS = '0';
    const started = Date.now();
    const stream = join(OUT, `${tag}.stream.jsonl`);
    // The binary itself, never through a shell: on Windows `shell: true` joins the
    // arguments unescaped and the multi-word prompt never reaches the client intact.
    // CAMPAIGN_CWD: where the replayed session ran. Claude Code keys auto-memory
    // (and project settings) by working directory, so a replay from a fresh
    // folder has no memory index while the original run carried 18k characters.
    const runCwd = TASK === 'campaign' && process.env.CAMPAIGN_CWD ? resolve(process.env.CAMPAIGN_CWD) : work;
    const child = spawn(CLAUDE_BIN, args, {
      cwd: runCwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const outChunks = [],
      errChunks = [];
    child.stdout.on('data', (d) => outChunks.push(d));
    child.stderr.on('data', (d) => errChunks.push(d));
    const timer = setTimeout(() => kill(child), RUN_TIMEOUT_S * 1000);
    // 'error' as well as 'exit': a spawn that fails (ENOENT) may never exit, and
    // an unhandled 'error' would end the campaign and orphan the proxies. The
    // run then has no requests and becomes an ERROR row below.
    let spawnError = null;
    await new Promise((r) => {
      child.on('exit', r);
      child.on('error', (e) => {
        spawnError = e;
        r();
      });
    });
    clearTimeout(timer);
    if (spawnError)
      errChunks.push(Buffer.from(`spawn failed: ${spawnError.message}\n`));
    const seconds = Math.round((Date.now() - started) / 1000);
    writeFileSync(stream, Buffer.concat(outChunks));
    writeFileSync(join(OUT, `${tag}.claude.err`), Buffer.concat(errChunks));

    const events = Buffer.concat(outChunks)
      .toString('utf8')
      .split('\n')
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const init =
      events.find((e) => e.type === 'system' && e.subtype === 'init') ?? {};
    const result = [...events].reverse().find((e) => e.type === 'result') ?? {};
    const loaded = JSON.stringify([init.plugins ?? [], init.mcp_servers ?? []]);
    const oursLoaded = /token-optimizer/.test(loaded);
    const isolationOk = cfg.plugin ? oursLoaded : !oursLoaded;
    const v =
      TASK === 'campaign'
        ? verdictCampaign(agentBreakdown(init.session_id), result)
        : TASK === 'explore'
          ? verdictExplore(work)
          : TASK === 'long'
            ? verdictExplore(work, /(answers\.json|notes\.md)$/)
            : TASK === 'overlap'
              ? verdictExplore(work)
              : verdict(work, hidden);
    const recorded = ledgerTotals(ledger);
    const agents = agentBreakdown(init.session_id);
    const totals = withPings(transcriptTotals(agents), recorded);
    // No measured request means the client never ran (auth, spawn, limit) -- an error, not a cheap FAIL.
    const ran = (totals?.requests ?? 0) > 0;
    // Every call should have crossed this run's proxy; a shortfall means traffic
    // escaped the instrument, so the arm's savings cannot be attributed to it.
    // Keep-warm pings are recorded but are not in transcripts, so they are left
    // out of the comparison.
    const recordedCalls = recorded
      ? recorded.requests - (recorded.pings ?? 0)
      : 0;
    const transcriptCalls = totals ? totals.requests - (totals.pings ?? 0) : 0;
    const ledgerCoverage = transcriptCalls
      ? recordedCalls / transcriptCalls
      : 0;
    return {
      arm,
      rep,
      position,
      seconds,
      task: TASK,
      verdict: !ran
        ? 'ERROR'
        : !isolationOk || ledgerCoverage < 1
          ? 'INVALID'
          : v.pass
            ? 'PASS'
            : 'FAIL',
      correctness: v,
      isolation: {
        ok: isolationOk,
        plugins: init.plugins,
        mcpServers: (init.mcp_servers ?? []).map(
          (s) => `${s.name}:${s.status}`
        ),
      },
      ledger: totals,
      recorder: recorded,
      ledgerCoverage,
      resultUsage: result.usage,
      costUsd: result.total_cost_usd,
      numTurns: result.num_turns,
      agents,
      sessionId: init.session_id,
    };
  } finally {
    for (const p of procs.reverse()) kill(p);
  }
}

// ----------------------------------------------------------------- driver --

/** The reference fix for each bug, used only by SELFCHECK to prove the verdict can pass. */
const FIXES = {
  pricing: [
    '    discounted = discounted * factor  # applied once in checkout, once here\n',
    '',
  ],
  inventory: [
    'daily_demand * (lead_days - 1) + safety_stock',
    'daily_demand * lead_days + safety_stock',
  ],
  schedule: [
    "sign = -1 if offset[0] == '+' else 1",
    "sign = 1 if offset[0] == '+' else -1",
  ],
  ledger: [
    '    return int(amount * 100) / 100',
    "    from decimal import Decimal, ROUND_HALF_EVEN\n    return float(Decimal(str(amount)).quantize(Decimal('0.01'), rounding=ROUND_HALF_EVEN))",
  ],
};

/** SELFCHECK=1: seeded repo must FAIL, the reference fixes must PASS, and the logs must name each failure. */
function selfCheck() {
  if (TASK === 'explore') {
    const work = join(OUT, 'selfcheck-explore');
    seedExplore(work);
    writeFileSync(
      join(work, 'answers.json'),
      JSON.stringify({
        ...EXPLORE_ANSWERS,
        bound: { ...EXPLORE_ANSWERS.bound, bytes: '30_000' },
      })
    );
    const right = verdictExplore(work);
    writeFileSync(
      join(work, 'answers.json'),
      JSON.stringify({
        ...EXPLORE_ANSWERS,
        expand: { ttlDays: 7, regenMs: 3000 },
      })
    );
    const wrong = verdictExplore(work);
    writeFileSync(join(work, 'README.md'), 'tampered');
    writeFileSync(join(work, 'answers.json'), JSON.stringify(EXPLORE_ANSWERS));
    const dirty = verdictExplore(work);
    console.log(
      JSON.stringify({
        right: right.pass,
        wrong: wrong.pass,
        wrongFields: wrong.wrong,
        dirty: dirty.pass,
      })
    );
    if (!right.pass || wrong.pass || dirty.pass) {
      console.error('SELFCHECK FAILED');
      process.exit(1);
    }
    console.log('SELFCHECK OK');
    return;
  }
  const dir = join(OUT, 'selfcheck');
  const work = join(dir, 'work'),
    hidden = join(dir, 'hidden');
  mkdirSync(work, { recursive: true });
  mkdirSync(hidden, { recursive: true });
  seed(work, hidden, 1);
  const before = verdict(work, hidden);
  for (const p of PACKAGES) {
    const f = join(work, 'pkgs', p, p, 'core.py');
    const src = readFileSync(f, 'utf8');
    if (!src.includes(FIXES[p][0]))
      throw new Error(`fix anchor missing for ${p}`);
    writeFileSync(f, src.replace(FIXES[p][0], FIXES[p][1]));
  }
  const after = verdict(work, hidden);
  const logs = PACKAGES.every((p) =>
    readFileSync(join(work, 'ci-logs', `${p}.log`), 'utf8').includes(
      BUGS[p].assertion
    )
  );
  const sizes = PACKAGES.map(
    (p) =>
      `${p}: core ${readFileSync(join(work, 'pkgs', p, p, 'core.py')).length}B log ${readFileSync(join(work, 'ci-logs', `${p}.log`)).length}B`
  );
  console.log(
    JSON.stringify({ before, after, logsNameFailures: logs, sizes }, null, 1)
  );
  if (before.pass || before.visible || !after.pass || !logs) {
    console.error('SELFCHECK FAILED');
    process.exit(1);
  }
  console.log('SELFCHECK OK');
}

async function main() {
  if (
    spawnSync(PY, ['-m', 'pytest', '--version'], { encoding: 'utf8' })
      .status !== 0
  )
    throw new Error(`pytest not available via ${PY}`);
  if (process.env.SELFCHECK === '1') return selfCheck();
  if (process.env.REGRADE) return regrade(resolve(process.env.REGRADE));
  if (!existsSync(join(PKG, 'dist', 'proxy', 'cli.js')))
    throw new Error(
      `build first: ${join(PKG, 'dist', 'proxy', 'cli.js')} missing`
    );
  mkdirSync(OUT, { recursive: true });
  const rows = [];
  console.log(`out ${OUT}\narms ${ARMS.join(',')} reps ${REPS} model ${MODEL}`);
  for (let rep = 1; rep <= REPS; rep++) {
    // ROTATED, as in ab.sh: an arm that runs later reads prefix cache an earlier arm paid for.
    const order = ARMS.map((_, k) => ARMS[(k + rep - 1) % ARMS.length]);
    console.log(`[rep ${rep} order: ${order.join(' ')}]`);
    for (const [i, arm] of order.entries()) {
      const r = await runArm(arm, rep, i + 1);
      rows.push(r);
      writeFileSync(join(OUT, 'results.json'), JSON.stringify(rows, null, 1));
      const l = r.ledger;
      console.log(
        `${arm.padEnd(10)} rep${rep} pos${i + 1} ${String(r.verdict).padEnd(7)} ${String(r.seconds ?? 0).padStart(4)}s  req=${l?.requests ?? 'n/a'} allInput=${l?.allInput ?? 'n/a'} weighted=${l?.weightedInput ?? 'n/a'} out=${l?.output ?? 'n/a'} agents=${r.agents?.length ?? 'n/a'} recorded=${r.recorder?.requests ?? 'n/a'}/${l?.requests ?? 'n/a'} ${r.note ?? ''}`
      );
    }
  }
  summarize(rows);
  writeFileSync(join(OUT, 'results.json'), JSON.stringify(rows, null, 1));
}

/**
 * REGRADE=<out dir>: re-run the CURRENT hidden tests against every finished run's work tree, for when a
 * grading defect is fixed after runs were spent (the 2.135 float case). Usage is untouched.
 */
function regrade(dir) {
  const rows = JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8'));
  for (const r of rows) {
    if (
      !r.ledger ||
      r.verdict === 'INVALID' ||
      r.verdict === 'SKIP' ||
      r.verdict === 'ERROR'
    )
      continue;
    // Only fix-task rows have hidden pytest suites; an explore row graded as one
    // would crash on a missing test file or overwrite its exact-answer verdict.
    // Rows written before `task` was recorded are treated as fix rows only when
    // their work tree actually holds the seeded packages.
    if (r.task && r.task !== 'fix') continue;
    const base = join(dir, `${r.arm}-${r.rep}`);
    if (!existsSync(join(base, 'hidden'))) continue;
    if (
      !existsSync(
        join(base, 'work', 'pkgs', PACKAGES[0], 'tests', 'test_core.py')
      )
    )
      continue;
    for (const p of PACKAGES)
      writeFileSync(
        join(base, 'hidden', `test_hidden_${p}.py`),
        BUGS[p].hidden
      );
    const v = verdict(join(base, 'work'), join(base, 'hidden'));
    if (v.pass !== r.correctness?.pass)
      console.log(
        `${r.arm}-${r.rep}: ${r.verdict} -> ${v.pass ? 'PASS' : 'FAIL'}`
      );
    r.correctness = v;
    r.verdict = v.pass ? 'PASS' : 'FAIL';
  }
  writeFileSync(join(dir, 'results.json'), JSON.stringify(rows, null, 1));
  summarize(rows);
}

function summarize(rows) {
  const by = {};
  for (const r of rows.filter(
    // ERROR rows have no usage; counted, they would lower an arm's mean cost.
    (x) =>
      x.ledger &&
      x.verdict !== 'INVALID' &&
      x.verdict !== 'SKIP' &&
      x.verdict !== 'ERROR'
  ))
    (by[r.arm] ??= []).push(r);
  const mean = (xs) =>
    xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
  const control = by.control
    ? mean(by.control.map((r) => r.ledger.weightedInput))
    : null;
  console.log(
    '\n=== summary from agent transcripts: weighted input = input + 1.25 x cache write + 0.1 x cache read (all agents, all calls) ==='
  );
  // COST counts output too, at the 5x price output carries relative to input (Anthropic rate cards),
  // because a reviewer found it was ~17% of worker cost and the input-only metric hid it.
  const cost = (r) => r.ledger.weightedInput + 5 * r.ledger.output;
  const controlCost = by.control ? mean(by.control.map(cost)) : null;
  for (const [arm, rs] of Object.entries(by)) {
    const w = mean(rs.map((r) => r.ledger.weightedInput));
    const c = mean(rs.map(cost));
    console.log(
      `${arm.padEnd(10)} n=${rs.length} pass=${rs.filter((r) => r.verdict === 'PASS').length}/${rs.length} weighted=${w} cost=${c} write=${mean(rs.map((r) => r.ledger.cacheWrite))} read=${mean(rs.map((r) => r.ledger.cacheRead))} output=${mean(rs.map((r) => r.ledger.output))} calls=${mean(rs.map((r) => r.ledger.requests))}${control ? `  vs control: weighted ${((w / control) * 100).toFixed(1)}% cost ${((c / controlCost) * 100).toFixed(1)}%` : ''}`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
