/**
 * DOES THE INSTRUCTION ACTUALLY MOVE CALLS-PER-TURN?
 *
 * THE ONE QUANTITY NOTHING ELSE HERE CAN MEASURE. `batch-headroom.mjs` says how
 * much of the batching opportunity is reachable from real transcripts -- 37.6%
 * of adjacent pairs had every input in hand a turn early (arm B, the lower
 * bound), 57.8% shared no token with the earlier result (arm A, the upper) --
 * and `turn-lever.check.mjs` prices arm B at 2.05x against the competitor's
 * 1.69x, paying for the block's residency at 4.85% obedience.
 *
 * All of that assumes the model does what the block asks. There is no treatment
 * arm in the transcript history, because the block has never been injected, so
 * obedience cannot be measured from what already exists. It needs live calls.
 *
 * NEEDS A CREDENTIAL AND THE NETWORK, and spends subscription cap. Never in CI,
 * never on a push, and run only when asked. The credential comes from the same
 * place the subscription meter takes it and neither it nor any part of it is
 * written to a file, a log or the console.
 *
 * THREE ARMS, because two would not separate "the instruction works" from "any
 * extra text in the system prompt changes behaviour":
 *
 *   control        no block at all
 *   conservative   the shipped text -- batch only calls whose results are not
 *                  needed by each other. Targets arm B.
 *   aggressive     batch unless a dependence is known. Targets arm A, and is
 *                  the arm that could batch dependent calls, which is why its
 *                  correctness is reported separately rather than assumed.
 *
 * THE TASKS ARE BUILT SO BATCHING IS CORRECT, not merely possible. Each one
 * asks about several independent files, so a model that batches is right to and
 * a model that does not is paying for turns it did not need. A task where the
 * second call depends on the first would measure obedience against a case where
 * obedience is wrong.
 *
 * WHAT IS REPORTED: calls per assistant turn, turns to finish, and whether the
 * task was answered at all -- a model that batches by guessing finishes fast
 * and wrongly, and a turn count without a correctness column would call that a
 * win. Only counts and the arm label leave this file; no task text, no model
 * output, no credential.
 */

import { readOAuthToken, snapshot } from '../subscription/meter.mjs';

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-5-20250929';
const MAX_TURNS = 8;

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
};
const TASKS = Number(arg('tasks', 20));

/** The shipped text, kept in sync with src/compress/batch-guidance.ts. */
const CONSERVATIVE =
  'When several next steps do not need each other results, make them as ' +
  'multiple tool calls in one message instead of one call per turn. Each ' +
  'turn re-reads the whole conversation, so two independent calls made in ' +
  'two turns are paid for twice.';

/** The upper-bound bar: batch unless a dependence is known. */
const AGGRESSIVE =
  'Make your tool calls in parallel in a single message unless a call needs ' +
  'the result of an earlier one. Each turn re-reads the whole conversation, ' +
  'so calls split across turns are paid for repeatedly.';

const ARMS = [
  ['control', null],
  ['conservative', CONSERVATIVE],
  ['aggressive', AGGRESSIVE],
];

/**
 * A fixture repository, in memory.
 *
 * Deterministic and tiny, so a run costs what the turns cost and nothing else,
 * and so the answer is checkable: each file states one fact, and the task asks
 * for facts from several files at once.
 */
const FILES = {};
for (let i = 0; i < 40; i++) {
  FILES[`src/service-${i}.ts`] =
    `// service ${i}\nexport const PORT_${i} = ${4000 + i * 7};\n` +
    `export const RETRIES_${i} = ${1 + (i % 5)};\n`;
}

const TOOLS = [
  {
    name: 'read_file',
    description: 'Read one file from the repository.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'list_files',
    description: 'List every file path in the repository.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
];

function runTool(name, input) {
  if (name === 'list_files') return Object.keys(FILES).join('\n');
  if (name === 'read_file')
    return FILES[String(input?.path)] ?? `no such file: ${String(input?.path)}`;
  return `no such tool: ${name}`;
}

/** Task n: the ports of three unrelated services, which are three reads. */
function task(n) {
  const a = n % 40;
  const b = (n * 7 + 11) % 40;
  const c = (n * 13 + 23) % 40;
  const picks = [...new Set([a, b, c])];
  return {
    prompt:
      `In this repository, what are the PORT values of ` +
      picks.map((i) => `src/service-${i}.ts`).join(', ') +
      `? Answer with just the numbers, comma separated.`,
    expect: picks.map((i) => String(4000 + i * 7)),
  };
}

const { token } = readOAuthToken();
if (!token) {
  console.log(
    'no OAuth token available -- set CLAUDE_CODE_OAUTH_TOKEN or sign in; nothing measured'
  );
  process.exit(1);
}

async function call(body) {
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'oauth-2025-04-20',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (attempt >= 4) throw new Error(`transport failure: ${error.message}`);
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    if (response.status === 429 || response.status >= 500) {
      if (attempt >= 4) {
        // A 429 THAT SURVIVES BACKOFF IS USUALLY THE CAP, NOT CONGESTION, and
        // the difference decides whether re-running is worth anything. The
        // meter already knows, so the refusal says which and when it clears
        // rather than leaving a bare status to be guessed at. Measured once at
        // 95% of a weekly window with 2,404 minutes to run: no amount of
        // retrying was going to help, and the remaining 5% is the operator's
        // working budget, not this harness's to spend.
        let state = '';
        try {
          const usage = await snapshot({ token });
          state = JSON.stringify(usage?.windows ?? usage ?? null);
        } catch {
          state = 'the meter could not be read';
        }
        throw new Error(
          `api returned ${response.status} after ${attempt + 1} tries -- ${state}. ` +
            'If that is a cap rather than congestion, re-run after it resets; ' +
            'nothing is measured and nothing is written.'
        );
      }
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      continue;
    }
    if (!response.ok)
      // The status and nothing else: an error body can quote the request.
      throw new Error(`api returned ${response.status}`);
    return response.json();
  }
}

/** One task under one arm. Returns counts only. */
async function runTask(block, t) {
  const system = ['You are a coding assistant working in a repository.']
    .concat(block === null ? [] : [block])
    .join('\n\n');
  const messages = [
    { role: 'user', content: [{ type: 'text', text: t.prompt }] },
  ];
  let turns = 0;
  let calls = 0;
  let answered = false;
  let text = '';
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const reply = await call({
      model: MODEL,
      max_tokens: 1024,
      system,
      tools: TOOLS,
      messages,
    });
    const blocks = Array.isArray(reply.content) ? reply.content : [];
    turns += 1;
    const uses = blocks.filter((b) => b?.type === 'tool_use');
    calls += uses.length;
    for (const b of blocks)
      if (b?.type === 'text' && typeof b.text === 'string') text += b.text;
    if (uses.length === 0) {
      answered = true;
      break;
    }
    messages.push({ role: 'assistant', content: blocks });
    messages.push({
      role: 'user',
      content: uses.map((u) => ({
        type: 'tool_result',
        tool_use_id: u.id,
        content: runTool(u.name, u.input),
      })),
    });
  }
  // CORRECTNESS, so a model that batches by guessing cannot read as a win.
  const correct = answered && t.expect.every((want) => text.includes(want));
  return { turns, calls, correct };
}

const results = new Map();
for (const [label] of ARMS) results.set(label, []);

console.log(`${TASKS} task(s) x ${ARMS.length} arm(s), model ${MODEL}\n`);
for (let n = 0; n < TASKS; n++) {
  const t = task(n);
  for (const [label, block] of ARMS) {
    const r = await runTask(block, t);
    results.get(label).push(r);
  }
  process.stdout.write(`  task ${n + 1}/${TASKS} done\r`);
}
console.log(' '.repeat(30));

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const rows = [];
for (const [label] of ARMS) {
  const rs = results.get(label);
  const perTurn = mean(rs.map((r) => r.calls / Math.max(1, r.turns)));
  rows.push({
    label,
    turns: mean(rs.map((r) => r.turns)),
    calls: mean(rs.map((r) => r.calls)),
    perTurn,
    correct: rs.filter((r) => r.correct).length,
    n: rs.length,
  });
}

console.log('arm            turns  calls  calls/turn  correct');
for (const r of rows)
  console.log(
    `${r.label.padEnd(14)} ${r.turns.toFixed(2).padStart(5)}  ${r.calls.toFixed(2).padStart(5)}  ${r.perTurn.toFixed(2).padStart(10)}  ${r.correct}/${r.n}`
  );

const control = rows.find((r) => r.label === 'control');
console.log('');
for (const r of rows) {
  if (r.label === 'control') continue;
  const saved = (control.turns - r.turns) / control.turns;
  console.log(
    `${r.label}: ${(saved * 100).toFixed(1)}% fewer turn(s) than control, calls/turn ${control.perTurn.toFixed(2)} -> ${r.perTurn.toFixed(2)}`
  );
  // A TURN SAVING WITH A CORRECTNESS LOSS IS NOT A SAVING, and the aggressive
  // arm is the one that can buy turns by guessing.
  if (r.correct < control.correct)
    console.log(
      `  WARNING: correctness fell ${control.correct}/${control.n} -> ${r.correct}/${r.n}; this arm's turn saving is not free`
    );
}
console.log(
  `\nPrice it: the break-even obedience for the block's own residency is 4.85% of the measured 36.1% headroom (bench/compression/turn-lever.check.mjs). ${TASKS} task(s) is a small arm -- it can show a large effect or no effect, not a small one.`
);
