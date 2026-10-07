/**
 * DOES THE BATCHING INSTRUCTION CHANGE THE MODEL'S BEHAVIOUR?
 *
 * The question the whole N lever rests on, and the only one nothing else here
 * can answer. `batch-headroom.mjs` says 37.6% of adjacent pairs had every input
 * in hand a turn early; `turn-lever.check.mjs` prices that at 2.05x against the
 * competitor's 1.69x and says the block repays its own residency at 4.85%
 * obedience. All of it assumes the model does what the block asks.
 *
 * WHY THIS DRIVES THE REAL CLIENT AND NOT THE RAW API. The first version of
 * this called /v1/messages directly with the OAuth credential and was refused
 * 429 for every request, including a sixteen-token one. That survived a weekly
 * cap reset -- 7d back to 1% and still 429, while count_tokens returned 200 --
 * so it is an entitlement boundary on that endpoint rather than a budget, and
 * no amount of waiting or shrinking the run was going to clear it. The agent
 * CLI has the entitlement, so the measurement goes through the CLI.
 *
 * AND IT SPLITS THE QUESTION IN TWO, WHICH IS BETTER THAN THE ORIGINAL DESIGN:
 *
 *   can we DELIVER the block?        already proven, by a test that reads the
 *                                    body a stub upstream received
 *                                    (tests/unit/proxy/batch-guidance-wiring)
 *   does the block CHANGE anything?  this file, via --append-system-prompt
 *
 * Routing the CLI through our proxy would answer both at once and confound
 * them: a null result could be the instruction not working or the injection not
 * arriving. Delivery is settled, so this holds it fixed.
 *
 * THREE ARMS, because two would not separate "the instruction works" from "any
 * extra sentence in the system prompt changes behaviour": control, the shipped
 * conservative text, and an aggressive text.
 *
 * THE TASKS ARE BUILT SO BATCHING IS CORRECT, not merely possible -- each asks
 * for facts from several unrelated files, so a model that batches is right to
 * and one that does not is paying for turns it did not need. Correctness is a
 * reported column, not an assumption: the aggressive arm is the one that can
 * buy turns by guessing, and a turn count without correctness beside it would
 * score that as a win.
 *
 * Reads the CLI's stream-json and emits only counts. Spends subscription cap,
 * so never in CI and never on a push.
 */

import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
};
const TASKS = Number(arg('tasks', 8));
const MODEL = arg('model', 'sonnet');

/** The shipped text, kept in sync with src/compress/batch-guidance.ts. */
const CONSERVATIVE =
  'When several next steps do not need each other results, make them as ' +
  'multiple tool calls in one message instead of one call per turn. Each ' +
  'turn re-reads the whole conversation, so two independent calls made in ' +
  'two turns are paid for twice.';

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
 * A fixture repository whose answers CANNOT BE INFERRED, which the first
 * version's could.
 *
 * It wrote `PORT = 4000 + i * 7`. The agent read ONE file, inferred the
 * formula, and answered all three correctly without reading the other two --
 * one tool call for a three-file question, while the correctness column said
 * 2/2, so the fixture was certifying a guess. Every arm then measured 0.0%
 * because there was nothing left to batch.
 *
 * The ports are now a scramble with no relation to the index, so the only way
 * to the answer is to read each file.
 */
const root = mkdtempSync(join(tmpdir(), 'obedience-'));
mkdirSync(join(root, 'src'), { recursive: true });
const PORTS = [];
for (let i = 0; i < 40; i++) {
  // Deterministic, so a re-run is comparable, and arbitrary, so one file says
  // nothing about the next.
  let h = 2166136261 ^ (i * 2654435761);
  h = (h ^ (h >>> 13)) * 1274126177;
  PORTS.push(10000 + (Math.abs(h) % 55000));
}
for (let i = 0; i < 40; i++)
  writeFileSync(
    join(root, 'src', `service-${i}.ts`),
    `// service ${i}\nexport const PORT = ${PORTS[i]};\nexport const RETRIES = ${1 + (i % 5)};\n`,
    'utf8'
  );

/** Task n: three unrelated files, so three reads with no dependence. */
function task(n) {
  const picks = [...new Set([n % 40, (n * 7 + 11) % 40, (n * 13 + 23) % 40])];
  return {
    prompt:
      'What are the PORT values in ' +
      picks.map((i) => `src/service-${i}.ts`).join(', ') +
      '? Answer with just the numbers, comma separated. Do not change any files.',
    expect: picks.map((i) => String(PORTS[i])),
    files: picks.length,
  };
}

/**
 * One task under one arm, measured from the CLI's own stream.
 *
 * `--output-format stream-json` emits one JSON object per line; an assistant
 * message carries its content blocks, so tool calls per TURN is the count of
 * `tool_use` blocks in one message rather than the number of lines -- which is
 * the distinction that made the earlier transcript walk report 33% headroom
 * from an artefact.
 */
function runTask(block, t) {
  const args = [
    '-p',
    t.prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    MODEL,
    // READ ONLY, AND --allowedTools DOES NOT ACHIEVE THAT. Allowing only Read
    // still let the agent run `grep -n PORT a.ts b.ts c.ts` through Bash and
    // answer a three-file question in ONE call -- measured, and it made every
    // arm read 0.0% because there was nothing left to batch. Disallowing the
    // tools that can answer several files at once is what leaves three
    // independent reads, which is the thing the instruction is about.
    //
    // With these denied the control arm makes 3 Reads across 3 separate turns,
    // so the headroom this harness is measuring is real and visible.
    '--disallowedTools',
    'Bash',
    'Grep',
    'Glob',
    'Task',
    'WebFetch',
  ];
  if (block !== null) args.push('--append-system-prompt', block);
  const run = spawnSync('claude', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  let turns = 0;
  let calls = 0;
  let text = '';
  for (const line of (run.stdout ?? '').split('\n')) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const message = event?.message;
    if (event?.type !== 'assistant' || !message) continue;
    const blocks = Array.isArray(message.content) ? message.content : [];
    turns += 1;
    calls += blocks.filter((b) => b?.type === 'tool_use').length;
    for (const b of blocks)
      if (b?.type === 'text' && typeof b.text === 'string') text += b.text;
  }
  const correct = t.expect.every((want) => text.includes(want));
  return { turns, calls, correct, status: run.status };
}

const results = new Map();
for (const [label] of ARMS) results.set(label, []);

console.log(`${TASKS} task(s) x ${ARMS.length} arm(s), model ${MODEL}`);
let failures = 0;
for (let n = 0; n < TASKS; n++) {
  for (const [label, block] of ARMS) {
    const r = runTask(block, task(n));
    if (r.status !== 0) failures += 1;
    results.get(label).push(r);
  }
  process.stdout.write(`  task ${n + 1}/${TASKS}\r`);
}
console.log(' '.repeat(24));

// A RUN THAT COULD NOT INVOKE THE CLI IS NOT A NULL RESULT. Without this the
// harness prints 0 turns for every arm and the comparison reads as "no
// difference", which is the vacuity failure this corpus has hit repeatedly.
const attempted = TASKS * ARMS.length;
if (failures === attempted) {
  console.log(
    `every one of ${attempted} invocation(s) failed -- nothing measured, and a zero here is a severed instrument rather than a result`
  );
  rmSync(root, { recursive: true, force: true });
  process.exit(1);
}
if (failures > 0)
  console.log(
    `WARNING: ${failures}/${attempted} invocation(s) exited non-zero`
  );

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const rows = ARMS.map(([label]) => {
  const rs = results.get(label);
  return {
    label,
    turns: mean(rs.map((r) => r.turns)),
    calls: mean(rs.map((r) => r.calls)),
    perTurn: mean(rs.map((r) => r.calls / Math.max(1, r.turns))),
    correct: rs.filter((r) => r.correct).length,
    n: rs.length,
  };
});

console.log('arm            turns  calls  calls/turn  correct');
for (const r of rows)
  console.log(
    `${r.label.padEnd(14)} ${r.turns.toFixed(2).padStart(5)}  ${r.calls.toFixed(2).padStart(5)}  ${r.perTurn.toFixed(2).padStart(10)}  ${r.correct}/${r.n}`
  );

const control = rows.find((r) => r.label === 'control');
console.log('');
for (const r of rows) {
  if (r.label === 'control') continue;
  const saved = (control.turns - r.turns) / Math.max(1, control.turns);
  console.log(
    `${r.label}: ${(saved * 100).toFixed(1)}% fewer turn(s) than control, calls/turn ${control.perTurn.toFixed(2)} -> ${r.perTurn.toFixed(2)}`
  );
  if (r.correct < control.correct)
    console.log(
      `  WARNING: correctness fell ${control.correct}/${control.n} -> ${r.correct}/${r.n}; this arm's turn saving is not free`
    );
}
console.log(
  `\n${TASKS} task(s) is a small arm: it can show a large effect or no effect, not a small one. Break-even for the block's own residency is 4.85% of the measured 36.1% headroom.`
);
rmSync(root, { recursive: true, force: true });
