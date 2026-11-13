#!/usr/bin/env node
/**
 * Solo versus agents, with and without token-optimizer: the gate for #567.
 *
 * WHY. A user ran two sessions on similar work, one doing it alone and one with
 * five agents, and watched the agents' session burn about ten times the tokens.
 * Every per-tool saving we report was real and did not move that number,
 * because the cost of an agent is not in its tool output: it is the fixed
 * context every agent starts from and re-reads each turn, the cache it
 * re-writes after every gap past five minutes, and the report it hands back
 * into the parent's context. This measures exactly that, end to end, on one
 * reproducible task, in four arms:
 *
 *   solo-plain    the parent does the work itself; token-optimizer not loaded
 *   agents-plain  one general-purpose agent per file; token-optimizer not loaded
 *   solo-opt      solo, with this checkout's plugin loaded
 *   agents-opt    agents, with this checkout's plugin and an approved agent brief
 *
 * THE TASK. A fixture repository with four source files, one seeded bug in
 * each, a test that covers all four, and an instruction file of realistic size
 * (CLAUDE.md, generated deterministically). One CRITICAL rule in it -- a
 * `// fixed:` line above every function you fix -- is checked afterwards. A run
 * that is cheap because its agents never saw the user's rules FAILS here; it
 * does not win.
 *
 * THE BRIEF. agents-opt approves the unedited draft that
 * `token-optimizer-agent-brief draft` produces from the fixture's CLAUDE.md. A
 * user who reviews it can only make it smaller, so this is the conservative
 * case.
 *
 * WHAT IS COUNTED. Every request of the parent and of each agent, from the
 * session transcripts, once per message id (src/hooks-core/subagents.mjs):
 * uncached input, cache writes by tier and cache reads, and output. "weighted"
 * is in uncached-input-token equivalents: input + 1.25 x 5m writes + 2 x 1h
 * writes + 0.1 x reads + 5 x output. Claude Code's own total_cost_usd is
 * recorded beside it.
 *
 * FAIRNESS. Arms are interleaved rep by rep, so cache warmth and API drift fall
 * on every arm alike. Each run gets a fresh copy of the fixture. The installed
 * token-optimizer plugin is disabled in every arm through --settings, so the
 * plain arms carry none of it and the opt arms carry only this checkout.
 * Instruction files above the fixture (a CLAUDE.md in a parent directory) would
 * load in every arm; the harness lists any it finds, and --root should point
 * somewhere that has none.
 *
 * Usage:
 *   node bench/agents/ab.mjs --root C:/bench-agents [--reps 3] [--model claude-haiku-5-5]
 *        [--arms solo-plain,agents-plain,solo-opt,agents-opt[,agents-opt-nodigest]]
 *        [--fixture small|large] [--instructions-kb 30] [--gate]
 *
 * Spends real API usage: 4 arms x 3 reps = 12 sessions by default.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  draftBrief,
  instructionFiles,
  renderWorkerAgent,
  workerAgentPath,
} from '../../src/hooks-core/agent-brief.mjs';
import { tallyFile } from '../../src/hooks-core/subagents.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const pluginDir = join(repo, 'src', 'plugin');

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const ROOT = option('--root', join(tmpdir(), 'token-optimizer-agents-ab'));
const REPS = Number(option('--reps', '3'));
const MODEL = option('--model', 'claude-haiku-5-5');
const ARMS = option('--arms', 'solo-plain,agents-plain,solo-opt,agents-opt')
  .split(',')
  .map((s) => s.trim());
const INSTRUCTIONS_KB = Number(option('--instructions-kb', '30'));
const GATE = args.includes('--gate');
const OUT = option('--out', join(here, 'results'));
const TIMEOUT_MS = Number(option('--timeout-min', '15')) * 60_000;

const FIXTURE = option('--fixture', 'small');
if (!['small', 'large', 'slow'].includes(FIXTURE))
  throw new Error('--fixture must be small, large or slow');

// Variants of agents-opt, each switching one thing so its effect is measured
// rather than assumed:
//   -nodigest      the shared briefing off
//   -inherit       workers stay on the parent's model
//   -bg            agents start in the background, as Claude Code does unasked
//   -noroute       no routing to the brief's worker (so no Haiku either)
//   -nobudget      no report budget on the agent's prompt
//   -nonotice      no short-prompts line at session start
//   -ttl1h         subagents write the 1h cache tier, as the setting
//                  token-optimizer writes does (agents-opt runs at Claude
//                  Code's 5m default: the worker's own frontmatter 1h was
//                  measured as ignored, 0 1h writes in 3 runs)
//   -proxy         through this checkout's proxy, keep-warm on; its pings,
//                  which no transcript records, are read from the proxy's
//                  accounting ledger and added to the run
//   -proxynowarm   the same proxy with keep-warm off
// forks-* fork the parent instead of starting fresh agents; -enforce runs the
// plugin in enforce mode, the only mode in which the fork guard can change
// the batch it is asked about (in assist it advises for the next one).
const KNOWN_ARMS = new Set([
  'solo-plain',
  'agents-plain',
  'solo-opt',
  'agents-opt',
  'agents-opt-nodigest',
  'agents-opt-inherit',
  'agents-opt-bg',
  'agents-opt-noroute',
  'agents-opt-nobudget',
  'agents-opt-nonotice',
  'agents-opt-ttl1h',
  'agents-opt-proxy',
  'agents-opt-proxynowarm',
  'forks-plain',
  'forks-opt',
  'forks-opt-enforce',
]);
for (const arm of ARMS)
  if (!KNOWN_ARMS.has(arm)) throw new Error(`unknown arm ${arm}`);
if (!Number.isInteger(REPS) || REPS < 1)
  throw new Error('--reps must be a positive integer');

// ---------------------------------------------------------------- the fixture

const FILES = {
  'src/sum.js':
    '/** Sum of the numbers in a list. */\nexport function sum(list) {\n  let total = 0;\n  for (let i = 1; i < list.length; i++) total += list[i];\n  return total;\n}\n',
  'src/reverse.js':
    "/** The string, reversed. */\nexport function reverse(text) {\n  return text.split('').join('');\n}\n",
  'src/max.js':
    '/** The largest number in a non-empty list. */\nexport function max(list) {\n  let best = 0;\n  for (const n of list) if (n > best) best = n;\n  return best;\n}\n',
  'src/even.js':
    '/** Whether an integer is even. */\nexport function isEven(n) {\n  return n % 2 === 1;\n}\n',
  'test.js': [
    "import assert from 'node:assert/strict';",
    "import { sum } from './src/sum.js';",
    "import { reverse } from './src/reverse.js';",
    "import { max } from './src/max.js';",
    "import { isEven } from './src/even.js';",
    'assert.equal(sum([1, 2, 3]), 6);',
    "assert.equal(reverse('abc'), 'cba');",
    'assert.equal(max([-5, -2, -9]), -2);',
    'assert.equal(isEven(4), true);',
    'assert.equal(isEven(7), false);',
    "console.log('all tests pass');",
    '',
  ].join('\n'),
  'package.json':
    '{ "name": "agents-ab-fixture", "private": true, "type": "module" }\n',
};
const SMALL_SOURCES = ['src/sum.js', 'src/reverse.js', 'src/max.js', 'src/even.js'];

/**
 * THE LARGE TASK. Solo's cost grows with the task -- every file it reads stays
 * in its context and is re-read on every later turn -- while each agent pays a
 * fixed start and reads one file. Four one-line bugs cannot show where that
 * crosses over; this can: twelve modules of twenty documented functions
 * (~8 KB each), one seeded bug in each module, and a test that lists every
 * failing function. Deterministic, and every bug is checked to be caught.
 */
const LARGE_MODULES = 12;
const LARGE_FUNCTIONS = 20;
const LARGE_INPUTS = [0, 1, 2, 5, 9];
const TEMPLATES = [
  // [correct body, the same body with the seeded bug]
  (a, b) => [
    `let total = 0;\n  for (let k = 0; k <= x; k++) total += k * ${a};\n  return total + ${b};`,
    `let total = 0;\n  for (let k = 0; k < x; k++) total += k * ${a};\n  return total + ${b};`,
  ],
  (a, b) => [
    `const parts = [];\n  for (let k = 0; k < ${a}; k++) parts.push((x + k) % ${b + 2});\n  return parts.reduce((sum, v) => sum + v, 0);`,
    `const parts = [];\n  for (let k = 1; k < ${a}; k++) parts.push((x + k) % ${b + 2});\n  return parts.reduce((sum, v) => sum + v, 0);`,
  ],
  (a, b) => [
    `if (x < ${a}) return x * ${b};\n  return x * ${b} - ${a};`,
    `if (x < ${a}) return x * ${b};\n  return x * ${b} + ${a};`,
  ],
];
const DOC_LINES = [
  'Kept separate from its neighbours because callers depend on its exact rounding.',
  'The constants come from the original specification and must not be tuned.',
  'Profiling showed no benefit from caching here, so it recomputes on every call.',
  'Inputs are small non-negative integers; larger values are never passed in practice.',
  'Changing the order of operations here changes results for some inputs.',
];

function largeFixture(modules = LARGE_MODULES) {
  const files = {};
  const sources = [];
  const expected = {};
  for (let i = 0; i < modules; i++) {
    const path = `src/m${i}.js`;
    sources.push(path);
    const buggy = (i * 5) % LARGE_FUNCTIONS;
    const parts = [`/** Module ${i}: numeric helpers used by the reporting pipeline. */`, ''];
    expected[`m${i}`] = {};
    for (let j = 0; j < LARGE_FUNCTIONS; j++) {
      const a = 2 + ((i * 7 + j * 3) % 5);
      const b = 1 + ((i * 5 + j * 11) % 7);
      const [good, bad] = TEMPLATES[(i + j) % TEMPLATES.length](a, b);
      const fn = (body) => new Function('x', body);
      const want = LARGE_INPUTS.map((x) => fn(good)(x));
      if (j === buggy && LARGE_INPUTS.every((x, n) => fn(bad)(x) === want[n]))
        throw new Error(`seeded bug in m${i}_f${j} is not caught by the test`);
      expected[`m${i}`][`f${j}`] = want;
      parts.push('/**', ` * Helper ${j} of module ${i}.`);
      for (let d = 0; d < 3; d++) parts.push(` * ${DOC_LINES[(i + j + d) % DOC_LINES.length]}`);
      parts.push(' */', `export function m${i}_f${j}(x) {`, `  ${j === buggy ? bad : good}`, '}', '');
    }
    files[path] = parts.join('\n');
  }
  files['test.js'] = [
    ...sources.map((p, i) => `import * as m${i} from './${p}';`),
    `const modules = { ${sources.map((_, i) => `m${i}`).join(', ')} };`,
    `const inputs = ${JSON.stringify(LARGE_INPUTS)};`,
    ...Object.entries(expected).map(([m, fns]) => `const expected_${m} = ${JSON.stringify(fns)};`),
    `const expected = { ${sources.map((_, i) => `m${i}: expected_m${i}`).join(', ')} };`,
    'let failures = 0;',
    'for (const [m, fns] of Object.entries(expected)) {',
    '  for (const [f, want] of Object.entries(fns)) {',
    '    const got = inputs.map((x) => modules[m][`${m}_${f}`](x));',
    '    if (JSON.stringify(got) !== JSON.stringify(want)) {',
    '      failures++;',
    '      console.log(`FAIL src/${m}.js ${m}_${f}: inputs ${JSON.stringify(inputs)} expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`);',
    '    }',
    '  }',
    '}',
    "console.log(failures ? `${failures} failing function(s)` : 'all tests pass');",
    'process.exitCode = failures ? 1 : 0;',
    '',
  ].join('\n');
  files['package.json'] = FILES['package.json'];
  return { files, sources };
}

/**
 * THE SLOW TASK, for keep-warm. Three of the large modules, and a check that
 * takes ~6 minutes -- longer than the 5-minute cache tier every agent writes
 * at -- so an agent that waits on it returns to an expired cache unless
 * something held it warm. The check then runs the same test.
 */
const SLOW_CHECK_SECONDS = 330;
function slowFixture() {
  const { files, sources } = largeFixture(3);
  files['check.js'] = [
    '// The slow verification step: waits, then runs the test.',
    `setTimeout(() => import('./test.js'), ${SLOW_CHECK_SECONDS * 1000});`,
    '',
  ].join('\n');
  return { files, sources };
}

const { files: FIXTURE_FILES, sources: SOURCES } =
  FIXTURE === 'large' ? largeFixture() : FIXTURE === 'slow' ? slowFixture() : { files: FILES, sources: SMALL_SOURCES };

/**
 * A realistic instruction file: rules a delegated agent needs, buried in the
 * rationale, history and examples real instruction files carry. Deterministic.
 */
function instructions(targetBytes) {
  const topics = [
    [
      'CRITICAL: Change Tracking',
      [
        'Every function you fix MUST get a comment line `// fixed: <one sentence on what was wrong>` directly above it.',
        'Never remove an existing doc comment.',
      ],
    ],
    [
      'CRITICAL: Repository Safety',
      [
        'Never commit, push or create branches.',
        'Never delete files you did not create.',
      ],
    ],
    [
      'Code Style',
      [
        'Use two-space indentation and single quotes.',
        'Prefer early returns over nested conditionals.',
      ],
    ],
    [
      'Testing',
      [
        'Always run `node test.js` after a change.',
        'Never weaken an assertion to make a test pass.',
      ],
    ],
    [
      'Dependencies',
      ['Do not add dependencies.', 'Prefer the standard library.'],
    ],
    [
      'Error Handling',
      [
        'Never swallow an error silently.',
        'Use typed errors where a caller must branch on them.',
      ],
    ],
    [
      'Performance',
      ['Avoid allocation inside hot loops.', 'Measure before optimising.'],
    ],
    [
      'Documentation',
      [
        'Keep comments about why, not what.',
        'Update the README when behaviour changes.',
      ],
    ],
    [
      'Release Process',
      [
        'Only the maintainer tags releases.',
        'Never edit the changelog by hand.',
      ],
    ],
    ['Security', ['Never log secrets.', 'Never read credential files.']],
    [
      'Naming',
      [
        'Use descriptive names; avoid abbreviations.',
        'Name booleans as questions.',
      ],
    ],
    [
      'Reviews',
      [
        'Address every review comment before asking again.',
        'Never resolve a thread you did not fix.',
      ],
    ],
  ];
  const filler = [
    'This rule exists because of an incident in which the opposite was done and the cost was only discovered much later, after several other changes had been layered on top of it.',
    'Over time we found that the shortcut always looked cheaper at the moment it was taken and was always more expensive in total, once the follow-up work was counted honestly.',
    'Several contributors have asked why this is so strict; the short answer is that every exception we made became the precedent for the next one.',
    'When in doubt, follow the conventions already present in the surrounding code, and ask before introducing a new pattern that the rest of the codebase does not use.',
    'An example of the failure mode: a change that passed every check locally but broke a consumer that relied on behaviour nobody had written down.',
  ];
  const parts = ['# Engineering Guidelines', ''];
  let i = 0;
  while (parts.join('\n').length < targetBytes) {
    const [heading, rules] = topics[i % topics.length];
    const round = Math.floor(i / topics.length);
    parts.push(`## ${heading}${round ? ` (part ${round + 1})` : ''}`, '');
    for (const rule of rules) parts.push(`- ${rule}`);
    parts.push('', '### Why', '');
    for (let k = 0; k < 4; k++) parts.push(filler[(i + k) % filler.length]);
    parts.push('');
    i++;
  }
  return `${parts.join('\n')}\n`;
}

function makeFixture(dir) {
  mkdirSync(join(dir, 'src'), { recursive: true });
  for (const [path, text] of Object.entries(FIXTURE_FILES))
    writeFileSync(join(dir, path), text);
  writeFileSync(join(dir, 'CLAUDE.md'), instructions(INSTRUCTIONS_KB * 1024));
  spawnSync('git', ['init', '-q'], { cwd: dir });
}

function verify(dir) {
  const test = spawnSync(process.execPath, ['test.js'], {
    cwd: dir,
    encoding: 'utf8',
  });
  const ruleKept = SOURCES.filter((f) =>
    /\/\/ fixed:/.test(readFileSync(join(dir, f), 'utf8'))
  );
  const testUnchanged =
    readFileSync(join(dir, 'test.js'), 'utf8') === FIXTURE_FILES['test.js'];
  return {
    testsPass: test.status === 0,
    ruleKept: ruleKept.length,
    testUnchanged,
    correct:
      test.status === 0 && ruleKept.length === SOURCES.length && testUnchanged,
  };
}

// ---------------------------------------------------------------- one run

const TASK =
  'Fix the bug in each of src/sum.js, src/reverse.js, src/max.js and src/even.js so that `node test.js` passes. Do not edit test.js.';
const LARGE_TASK =
  'Some functions under src/ have bugs. `node test.js` lists every failing function. Fix each bug so that `node test.js` passes. Do not edit test.js.';
const SLOW_STEP =
  ' After fixing its file, each agent must run `node check.js` with a Bash timeout of 600000 ms -- it takes about six minutes -- and confirm its function no longer fails.';
const PROMPTS =
  FIXTURE === 'large'
    ? {
        solo: `${LARGE_TASK} Do all of the work yourself; do not start any agents.`,
        // The parent looks first, as a real one does before delegating; that
        // exploration is what the shared briefing passes on.
        agents: `${LARGE_TASK} First run \`node test.js\` and look at the repository yourself. Then start one general-purpose agent per failing source file, all in a single message so they run in parallel, each fixing only its own file. When they finish, run \`node test.js\` yourself and report the result.`,
        // The parent reads every module before delegating, so its context is
        // what a fork copies -- the case the fork guard exists for.
        forks: `${LARGE_TASK} First run \`node test.js\` and read every source file under src/ yourself. Then fork yourself once per failing source file (Agent tool, subagent_type "fork"), all in a single message so they run in parallel, each fixing only its own file. When they finish, run \`node test.js\` yourself and report the result.`,
      }
    : FIXTURE === 'slow'
    ? {
        solo: `${LARGE_TASK} Do all of the work yourself; do not start any agents. When every file is fixed, run \`node check.js\` once with a Bash timeout of 600000 ms -- it takes about six minutes.`,
        agents: `${LARGE_TASK} First run \`node test.js\` yourself. Then start one general-purpose agent per failing source file, all in a single message so they run in parallel, each fixing only its own file.${SLOW_STEP} When they finish, run \`node test.js\` yourself and report the result.`,
      }
    : {
        solo: `${TASK} Do all of the work yourself; do not start any agents.`,
        agents: `${TASK} Start one general-purpose agent per source file, all four in a single message so they run in parallel, each fixing only its own file. When they finish, run \`node test.js\` yourself and report the result.`,
      };

function settingsFile(dir) {
  // The installed token-optimizer plugin is off in every arm; the opt arms load
  // this checkout's plugin with --plugin-dir instead.
  const path = join(dir, '..', `${dir.split(/[\\/]/).pop()}.settings.json`);
  writeFileSync(
    path,
    JSON.stringify(
      { enabledPlugins: { 'token-optimizer@token-optimizer': false } },
      null,
      2
    )
  );
  return path;
}

function sessionFiles(sessionId) {
  const projects = join(
    process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
    'projects'
  );
  for (const name of readdirSync(projects)) {
    const main = join(projects, name, `${sessionId}.jsonl`);
    if (!existsSync(main)) continue;
    const agents = [];
    const walk = (d, depth) => {
      if (depth > 4 || !existsSync(d)) return;
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (/^agent-.*\.jsonl$/.test(e.name)) agents.push(p);
      }
    };
    walk(join(projects, name, sessionId, 'subagents'), 0);
    return { main, agents };
  }
  return null;
}

function agentTypes(agentFiles) {
  return agentFiles.map((f) => {
    try {
      return (
        JSON.parse(readFileSync(f.replace(/\.jsonl$/, '.meta.json'), 'utf8'))
          .agentType ?? null
      );
    } catch {
      return null;
    }
  });
}

/** The model an agent ran on: the first real assistant message's. */
function firstModel(path) {
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.includes('"assistant"')) continue;
      const model = JSON.parse(line)?.message?.model;
      if (typeof model === 'string' && !model.startsWith('<')) return model;
    }
  } catch {
    /* an unreadable transcript has no model to report */
  }
  return null;
}

const weightOf = (t) =>
  t.input + 1.25 * t.write5m + 2 * t.write1h + 0.1 * t.cacheRead + 5 * t.output;

/**
 * This checkout's proxy, for the -proxy arms: started per run, so each run's
 * keep-warm state and accounting ledger are its own. Resolves to its URL (the
 * one line it prints on stdout) and a stop function.
 */
function startProxy({ ledger, keepWarm }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(repo, 'dist', 'proxy', 'cli.js'), '--port', '0', '--quiet'], {
      env: {
        ...process.env,
        TOKEN_OPTIMIZER_PROXY_ACCOUNTING: ledger,
        TOKEN_OPTIMIZER_PROXY_KEEPWARM: keepWarm ? '1' : 'off',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => reject(new Error('proxy did not print its URL in 30 s')), 30_000);
    child.on('error', reject);
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const line = out.split('\n')[0].trim();
      if (out.includes('\n') && /^https?:\/\//.test(line)) {
        clearTimeout(timer);
        resolve({ url: line, stop: () => child.kill() });
      }
    });
  });
}

/** The keep-warm pings a proxy ledger recorded, as transcript-style totals. */
function pingTotals(ledger) {
  const totals = { pings: 0, input: 0, write5m: 0, write1h: 0, cacheRead: 0, output: 0 };
  let text = '';
  try {
    text = readFileSync(ledger, 'utf8');
  } catch {
    return totals;
  }
  for (const line of text.split('\n')) {
    if (!line.includes('"keepwarm"')) continue;
    try {
      const row = JSON.parse(line);
      if (row.path !== 'keepwarm') continue;
      const u = row.usage || {};
      totals.pings += 1;
      totals.input += Number(u.input_tokens) || 0;
      totals.cacheRead += Number(u.cache_read_input_tokens) || 0;
      // A ping that had to write found the entry gone; priced at the agents' 5m tier.
      totals.write5m += Number(u.cache_creation_input_tokens) || 0;
      totals.output += Number(u.output_tokens) || 0;
    } catch {
      /* a torn last line */
    }
  }
  return totals;
}

async function runArm(arm, rep, stamp) {
  const [shape, flavour, variant] = arm.split('-');
  const dir = join(ROOT, stamp, `${arm}-${rep}`);
  makeFixture(dir);
  const home = join(dir, '..', `${arm}-${rep}.home`);
  mkdirSync(home, { recursive: true });
  if (flavour === 'opt') {
    const files = instructionFiles({ cwd: dir }).project.map((path) => ({
      path,
      text: readFileSync(path, 'utf8'),
    }));
    writeFileSync(join(home, 'agent-brief.md'), draftBrief(files));
    // What `approve --project` generates: the worker with the always-sent rules
    // in its system prompt. In the fixture, so the user's own ~/.claude/agents
    // is never touched; written before the session starts, so the hook uses it.
    const agent = workerAgentPath('project', { cwd: dir });
    mkdirSync(dirname(agent), { recursive: true });
    writeFileSync(
      agent,
      renderWorkerAgent('project', {
        cwd: dir,
        env: { ...process.env, TOKEN_OPTIMIZER_HOME: home },
      })
    );
  }
  const cli = [
    '-p',
    PROMPTS[shape],
    '--model',
    MODEL,
    '--output-format',
    'json',
    '--settings',
    settingsFile(dir),
    '--allowedTools',
    'Read,Edit,Write,Glob,Grep,Agent,Task,Bash(node test.js),Bash(node check.js)',
    ...(shape === 'solo' ? ['--disallowedTools', 'Agent,Task'] : []),
    ...(flavour === 'opt' ? ['--plugin-dir', pluginDir] : []),
  ];
  const proxied = variant === 'proxy' || variant === 'proxynowarm';
  const ledger = join(dir, '..', `${arm}-${rep}.proxy.jsonl`);
  const proxy = proxied ? await startProxy({ ledger, keepWarm: variant === 'proxy' }) : null;
  const started = Date.now();
  const result = spawnSync('claude', cli, {
    cwd: dir,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    env: {
      ...process.env,
      TOKEN_OPTIMIZER_HOME: home,
      // The bench never writes the user's settings.
      TOKEN_OPTIMIZER_SUBAGENT_CACHE_TTL: 'off',
      TOKEN_OPTIMIZER_MAIN_CACHE_TTL: 'off',
      ...(variant === 'nodigest' ? { TOKEN_OPTIMIZER_AGENT_DIGEST: 'off' } : {}),
      // agents-opt-inherit keeps every worker on the parent's model.
      ...(variant === 'inherit' ? { TOKEN_OPTIMIZER_WORKER_MODEL: 'inherit' } : {}),
      // agents-opt-bg leaves agents in the background (agent-spawn.mjs inForeground is on by default).
      ...(variant === 'bg' ? { TOKEN_OPTIMIZER_AGENT_FOREGROUND: 'off' } : {}),
      ...(variant === 'noroute' ? { TOKEN_OPTIMIZER_AGENT_ROUTE: 'off' } : {}),
      ...(variant === 'nobudget' ? { TOKEN_OPTIMIZER_AGENT_REPORT_BUDGET: 'off' } : {}),
      ...(variant === 'nonotice' ? { TOKEN_OPTIMIZER_AGENT_BRIEF_NOTICE: 'off' } : {}),
      // The env form of subagentPromptCacheTtl; the user's settings are never touched.
      ...(variant === 'ttl1h' ? { CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '1h' } : {}),
      ...(variant === 'enforce' ? { TOKEN_OPTIMIZER_MODE: 'enforce' } : {}),
      ...(proxy ? { ANTHROPIC_BASE_URL: proxy.url } : {}),
    },
  });
  // Pings outlive the run by design; whatever fired before the stop is counted.
  proxy?.stop();
  const seconds = Math.round((Date.now() - started) / 1000);
  let json = null;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    /* recorded as a failed run below */
  }
  const files = json?.session_id ? sessionFiles(json.session_id) : null;
  const zero = {
    turns: 0,
    input: 0,
    write5m: 0,
    write1h: 0,
    cacheRead: 0,
    output: 0,
    baseContext: 0,
  };
  const tally = (path) => ({ ...zero, ...(tallyFile(path) || {}) });
  const parent = files ? tally(files.main) : zero;
  const agents = files ? files.agents.map(tally) : [];
  const sum = (key) => parent[key] + agents.reduce((n, a) => n + a[key], 0);
  const pings = proxied ? pingTotals(ledger) : null;
  const totals = Object.fromEntries(
    ['turns', 'input', 'write5m', 'write1h', 'cacheRead', 'output'].map((k) => [
      k,
      sum(k) + (pings && k !== 'turns' ? pings[k] : 0),
    ])
  );
  const check = verify(dir);
  return {
    arm,
    rep,
    model: MODEL,
    seconds,
    exit: result.status,
    sessionId: json?.session_id ?? null,
    costUsd: json?.total_cost_usd ?? null,
    agents: agents.length,
    agentTypes: files ? agentTypes(files.agents) : [],
    agentModels: files ? files.agents.map(firstModel) : [],
    agentStartContext: agents.map((a) => a.baseContext),
    parentWeighted: Math.round(weightOf(parent)),
    agentsWeighted: Math.round(agents.reduce((n, a) => n + weightOf(a), 0)),
    ...(pings ? { pings: pings.pings, pingsWeighted: Math.round(weightOf(pings)) } : {}),
    weighted: Math.round(weightOf(totals)),
    totals,
    ...check,
  };
}

// ---------------------------------------------------------------- the campaign

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

async function main() {
  mkdirSync(ROOT, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const version = spawnSync('claude', ['--version'], {
    encoding: 'utf8',
  }).stdout.trim();
  const probe = join(ROOT, stamp, 'probe');
  mkdirSync(probe, { recursive: true });
  const above = instructionFiles({ cwd: probe });
  const contamination = [...above.global, ...above.project];
  const out = join(OUT, `ab-${stamp}.jsonl`);
  const header = {
    kind: 'header',
    stamp,
    claudeVersion: version,
    model: MODEL,
    fixture: FIXTURE,
    reps: REPS,
    arms: ARMS,
    instructionsBytes: instructions(INSTRUCTIONS_KB * 1024).length,
    instructionFilesAboveFixture: contamination,
    commit: spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo,
      encoding: 'utf8',
    }).stdout.trim(),
    fixtureHash: createHash('sha256')
      .update(JSON.stringify(FIXTURE_FILES))
      .digest('hex')
      .slice(0, 16),
  };
  appendFileSync(out, `${JSON.stringify(header)}\n`);
  console.log(
    `claude ${version}, model ${MODEL}, ${REPS} rep(s) of ${ARMS.join(', ')}; results -> ${out}`
  );
  if (contamination.length)
    console.log(
      `WARNING: instruction files above --root load in every arm: ${contamination.join(', ')}`
    );

  const rows = [];
  for (let rep = 1; rep <= REPS; rep++) {
    // Rotate the order each rep, so no arm always runs first or last.
    const order = ARMS.map((_, i) => ARMS[(i + rep - 1) % ARMS.length]);
    for (const arm of order) {
      const row = await runArm(arm, rep, stamp);
      rows.push(row);
      appendFileSync(out, `${JSON.stringify({ kind: 'run', ...row })}\n`);
      console.log(
        `${arm.padEnd(20)} rep ${rep}: ${row.correct ? 'correct' : 'WRONG  '} weighted ${String(row.weighted).padStart(8)}` +
          ` (parent ${row.parentWeighted}, ${row.agents} agent(s) ${row.agentsWeighted})` +
          ` $${row.costUsd ?? '?'} ${row.seconds}s${row.agentTypes.length ? ` [${[...new Set(row.agentTypes)].join(', ')} on ${[...new Set(row.agentModels)].join(', ')}]` : ''}`
      );
    }
  }

  const summary = {};
  for (const arm of ARMS) {
    const mine = rows.filter((r) => r.arm === arm);
    summary[arm] = {
      runs: mine.length,
      correct: mine.filter((r) => r.correct).length,
      medianWeighted: median(mine.map((r) => r.weighted)),
      medianCostUsd: median(
        mine.map((r) => r.costUsd).filter((c) => typeof c === 'number')
      ),
      medianAgentStart: median(mine.flatMap((r) => r.agentStartContext)),
    };
  }
  const ratio = (a, b) =>
    summary[a]?.medianWeighted && summary[b]?.medianWeighted
      ? summary[a].medianWeighted / summary[b].medianWeighted
      : null;
  const usdRatio = (a, b) =>
    summary[a]?.medianCostUsd && summary[b]?.medianCostUsd
      ? summary[a].medianCostUsd / summary[b].medianCostUsd
      : null;
  const verdict = {
    kind: 'summary',
    summary,
    agentsPlainOverSoloPlain: ratio('agents-plain', 'solo-plain'),
    agentsOptOverAgentsPlain: ratio('agents-opt', 'agents-plain'),
    agentsOptOverSoloOpt: ratio('agents-opt', 'solo-opt'),
    agentsOptOverNoDigest: ratio('agents-opt', 'agents-opt-nodigest'),
    // Weighted tokens do not compare across models; once workers run on a
    // cheaper model than the parent (agent-spawn.mjs workerModel), dollars do.
    agentsOptOverSoloOptUsd: usdRatio('agents-opt', 'solo-opt'),
    agentsOptOverInheritUsd: usdRatio('agents-opt', 'agents-opt-inherit'),
    agentsOptOverBackgroundUsd: usdRatio('agents-opt', 'agents-opt-bg'),
    agentsBackgroundOverSoloOptUsd: usdRatio('agents-opt-bg', 'solo-opt'),
  };
  appendFileSync(out, `${JSON.stringify(verdict)}\n`);
  console.log('');
  for (const [arm, s] of Object.entries(summary)) {
    console.log(
      `${arm.padEnd(20)} ${s.correct}/${s.runs} correct, median weighted ${s.medianWeighted}, median $${s.medianCostUsd}, median agent start ${s.medianAgentStart ?? '-'}`
    );
  }
  const fmt = (x) => (x === null ? 'n/a' : x.toFixed(3));
  console.log(
    `agents-plain / solo-plain ${fmt(verdict.agentsPlainOverSoloPlain)}`
  );
  console.log(
    `agents-opt / agents-plain ${fmt(verdict.agentsOptOverAgentsPlain)}  (gate: < 1, every run correct)`
  );
  console.log(
    `agents-opt / solo-opt     ${fmt(verdict.agentsOptOverSoloOpt)}  (target: <= 1)`
  );
  if (verdict.agentsOptOverNoDigest !== null)
    console.log(
      `agents-opt / no digest    ${fmt(verdict.agentsOptOverNoDigest)}  (the shared briefing stays only if < 1)`
    );
  console.log(
    `agents-opt / solo-opt $   ${fmt(verdict.agentsOptOverSoloOptUsd)}  (target: <= 1, in dollars)`
  );
  if (verdict.agentsOptOverInheritUsd !== null)
    console.log(
      `agents-opt / inherit $    ${fmt(verdict.agentsOptOverInheritUsd)}  (workers on a cheaper model, against the parent's)`
    );
  if (verdict.agentsOptOverBackgroundUsd !== null)
    console.log(
      `agents-opt / background $  ${fmt(verdict.agentsOptOverBackgroundUsd)}  (foreground agents stay only if < 1)`
    );
  if (verdict.agentsBackgroundOverSoloOptUsd !== null)
    console.log(
      `agents-opt-bg / solo-opt $   ${fmt(verdict.agentsBackgroundOverSoloOptUsd)}  (agents in the background, in dollars)`
    );
  if (GATE) {
    const allCorrect = rows.every((r) => r.correct);
    const pass =
      allCorrect &&
      verdict.agentsOptOverAgentsPlain !== null &&
      verdict.agentsOptOverAgentsPlain < 1;
    console.log(
      `GATE ${pass ? 'PASS' : 'FAIL'}${allCorrect ? '' : ' (a run was not correct)'}`
    );
    process.exitCode = pass ? 0 : 1;
  }
}

// --fixture-only <dir>: write the fixture and report what verify() says of it,
// without starting a session -- the check that a fixture is sound before any
// usage is spent on it.
const fixtureOnly = option('--fixture-only', null);
if (fixtureOnly) {
  makeFixture(fixtureOnly);
  console.log(JSON.stringify({ fixture: FIXTURE, dir: fixtureOnly, ...verify(fixtureOnly) }));
} else {
  main();
}
