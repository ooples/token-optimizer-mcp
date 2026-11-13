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
 *        [--arms solo-plain,agents-plain,solo-opt,agents-opt] [--instructions-kb 30] [--gate]
 *
 * Spends real API usage: 4 arms x 3 reps = 12 sessions by default.
 */
import { spawnSync } from 'node:child_process';
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

const KNOWN_ARMS = new Set([
  'solo-plain',
  'agents-plain',
  'solo-opt',
  'agents-opt',
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
const SOURCES = ['src/sum.js', 'src/reverse.js', 'src/max.js', 'src/even.js'];

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
  for (const [path, text] of Object.entries(FILES))
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
    readFileSync(join(dir, 'test.js'), 'utf8') === FILES['test.js'];
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
const PROMPTS = {
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

const weightOf = (t) =>
  t.input + 1.25 * t.write5m + 2 * t.write1h + 0.1 * t.cacheRead + 5 * t.output;

function runArm(arm, rep, stamp) {
  const [shape, flavour] = arm.split('-');
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
    'Read,Edit,Write,Glob,Grep,Agent,Task,Bash(node test.js)',
    ...(shape === 'solo' ? ['--disallowedTools', 'Agent,Task'] : []),
    ...(flavour === 'opt' ? ['--plugin-dir', pluginDir] : []),
  ];
  const started = Date.now();
  const result = spawnSync('claude', cli, {
    cwd: dir,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    env: {
      ...process.env,
      TOKEN_OPTIMIZER_HOME: home,
      // The bench never writes the user's settings; the worker's 1h tier comes
      // from its own frontmatter.
      TOKEN_OPTIMIZER_SUBAGENT_CACHE_TTL: 'off',
    },
  });
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
  const totals = Object.fromEntries(
    ['turns', 'input', 'write5m', 'write1h', 'cacheRead', 'output'].map((k) => [
      k,
      sum(k),
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
    agentStartContext: agents.map((a) => a.baseContext),
    parentWeighted: Math.round(weightOf(parent)),
    agentsWeighted: Math.round(agents.reduce((n, a) => n + weightOf(a), 0)),
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

function main() {
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
    reps: REPS,
    arms: ARMS,
    instructionsBytes: instructions(INSTRUCTIONS_KB * 1024).length,
    instructionFilesAboveFixture: contamination,
    commit: spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo,
      encoding: 'utf8',
    }).stdout.trim(),
    fixtureHash: createHash('sha256')
      .update(JSON.stringify(FILES))
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
      const row = runArm(arm, rep, stamp);
      rows.push(row);
      appendFileSync(out, `${JSON.stringify({ kind: 'run', ...row })}\n`);
      console.log(
        `${arm.padEnd(13)} rep ${rep}: ${row.correct ? 'correct' : 'WRONG  '} weighted ${String(row.weighted).padStart(8)}` +
          ` (parent ${row.parentWeighted}, ${row.agents} agent(s) ${row.agentsWeighted})` +
          ` $${row.costUsd ?? '?'} ${row.seconds}s${row.agentTypes.length ? ` [${[...new Set(row.agentTypes)].join(', ')}]` : ''}`
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
  const verdict = {
    kind: 'summary',
    summary,
    agentsPlainOverSoloPlain: ratio('agents-plain', 'solo-plain'),
    agentsOptOverAgentsPlain: ratio('agents-opt', 'agents-plain'),
    agentsOptOverSoloOpt: ratio('agents-opt', 'solo-opt'),
  };
  appendFileSync(out, `${JSON.stringify(verdict)}\n`);
  console.log('');
  for (const [arm, s] of Object.entries(summary)) {
    console.log(
      `${arm.padEnd(13)} ${s.correct}/${s.runs} correct, median weighted ${s.medianWeighted}, median $${s.medianCostUsd}, median agent start ${s.medianAgentStart ?? '-'}`
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

main();
