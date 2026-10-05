/**
 * HOW MANY TOOL CALLS A TURN CARRIES, FROM REAL SESSIONS.
 *
 * The session bill is `handed * (W + R*N)` and every attempt on this branch
 * attacked `handed` -- compression, templating, eviction, marker encoding, a
 * per-unit policy. `handed` is the term a tokenizer has already compressed, and
 * N carries 5.6 of the 7.6. N is where the headroom is and nothing had looked
 * at it.
 *
 * N is not a guess: cost-model.mjs records `readsPerWrittenToken` of 56.02,
 * 56.97 and 70.34 over 7, 14 and 30 days of real transcript usage, and the
 * default takes the lowest. Every re-read is a request that carried the token
 * again, so fewer requests is directly fewer re-reads.
 *
 * This measures the shape of those requests across the local transcripts.
 *
 * GROUPED BY `requestId`, WHICH IS THE WHOLE TRICK. The transcript writes one
 * entry per `tool_use` block, so counting entries gives exactly 1.00 calls per
 * turn on 60,742 of them -- a suspiciously perfect number that is an artifact
 * of the grain, not a property of the model. 1,680 consecutive entry pairs
 * share a `requestId` and none share a `parentUuid`, which is what gives the
 * split away. Grouped properly the figure is 1.15.
 *
 * AND THE BATCHABLE HEADROOM IS BOUNDED, measured the same way. Of 36,301 runs
 * of consecutive tool-only turns holding 52,785 turns between them, 69.5% are a
 * run of ONE -- a single tool call sitting between two pieces of reasoning,
 * with no neighbour to batch it with. 20.8% are runs of two, 6.4% of three, and
 * the tail past five is half a percent.
 *
 * Collapsing every run into a single turn would take 52,785 turns to 36,301, so
 * 31% fewer tool turns is the CEILING on batching, not a target. And because
 * most runs are length one, most calls are genuinely interleaved with thinking:
 * batching those would change what the model does rather than how its requests
 * are packaged, which is the aggressive bar and needs an accuracy arm before
 * any cost claim.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(homedir(), '.claude', 'projects');

/** Tool calls per logical assistant turn, keyed by the request that made it. */
function callsPerTurn() {
  const perRequest = new Map();
  let projects = 0;
  for (const name of readdirSync(ROOT)) {
    const dir = join(ROOT, name);
    let files = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    if (files.length > 0) projects += 1;
    for (const file of files) {
      let text;
      try {
        text = readFileSync(join(dir, file), 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        const message = entry.message;
        if (!message || message.role !== 'assistant') continue;
        const uses = (
          Array.isArray(message.content) ? message.content : []
        ).filter((block) => block?.type === 'tool_use');
        if (uses.length === 0) continue;
        const key = entry.requestId ?? entry.uuid;
        perRequest.set(key, (perRequest.get(key) ?? 0) + uses.length);
      }
    }
  }
  return { perRequest, projects };
}

const { perRequest, projects } = callsPerTurn();
if (perRequest.size === 0) {
  console.log('no local transcripts with tool calls; nothing to measure');
  process.exit(0);
}

const histogram = new Map();
let calls = 0;
for (const n of perRequest.values()) {
  calls += n;
  const bucket = Math.min(n, 5);
  histogram.set(bucket, (histogram.get(bucket) ?? 0) + 1);
}
const turns = perRequest.size;
const mean = calls / turns;
console.log(
  `${turns} tool-using turn(s) over ${projects} project(s), ${calls} call(s), ${mean.toFixed(2)} per turn`
);
for (const bucket of [1, 2, 3, 4, 5])
  console.log(
    `  ${bucket === 5 ? '5+' : bucket} call(s): ${histogram.get(bucket) ?? 0} (${(((histogram.get(bucket) ?? 0) / turns) * 100).toFixed(1)}%)`
  );

// WHAT IT WOULD BE WORTH. A turn is a request and a request re-reads the whole
// context, so halving the turns halves the dominant term. These are the turn
// counts a given mean would need, not a claim that the mean can be moved.
for (const target of [1.5, 2, 3]) {
  const needed = Math.ceil(calls / target);
  console.log(
    `  at ${target} calls per turn: ${needed} turn(s), ${(((turns - needed) / turns) * 100).toFixed(0)}% fewer`
  );
}

/**
 * Runs of consecutive tool-only turns: the batchable population.
 *
 * A run is a stretch of turns that each carry tool calls and no prose, broken
 * by any turn that reasons or by a real user message. Collapsing a run into one
 * turn is the most batching could ever do, so the distribution of run lengths
 * is the ceiling -- and a run of one has no neighbour, so it is headroom only
 * if the model can be made to think and call in the same breath.
 */
export function runLengths() {
  const histogram = new Map();
  let turnsInRuns = 0;
  const close = (run) => {
    if (run <= 0) return;
    const bucket = Math.min(run, 6);
    histogram.set(bucket, (histogram.get(bucket) ?? 0) + 1);
    turnsInRuns += run;
  };
  for (const name of readdirSync(ROOT)) {
    const dir = join(ROOT, name);
    let files = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const file of files) {
      let text;
      try {
        text = readFileSync(join(dir, file), 'utf8');
      } catch {
        continue;
      }
      let run = 0;
      let lastRequest = null;
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        const message = entry.message;
        if (!message) continue;
        const blocks = Array.isArray(message.content) ? message.content : [];
        if (message.role !== 'assistant') {
          // A tool RESULT continues the run; a real user message ends it.
          const isResult = blocks.some((b) => b?.type === 'tool_result');
          if (!isResult) {
            close(run);
            run = 0;
          }
          continue;
        }
        const uses = blocks.filter((b) => b?.type === 'tool_use');
        const prose = blocks.filter(
          (b) => b?.type === 'text' && String(b.text ?? '').trim()
        );
        if (uses.length === 0) {
          close(run);
          run = 0;
          continue;
        }
        // One logical turn per request, however many entries it was split into.
        if (entry.requestId === lastRequest) continue;
        lastRequest = entry.requestId;
        if (prose.length === 0) run += 1;
        else {
          close(run);
          run = 1;
        }
      }
      close(run);
      run = 0;
    }
  }
  return { histogram, turnsInRuns };
}

const { histogram: runs, turnsInRuns } = runLengths();
const runCount = [...runs.values()].reduce((sum, n) => sum + n, 0);
if (runCount > 0) {
  console.log(
    `\n${runCount} run(s) of consecutive tool-only turns holding ${turnsInRuns} turn(s)`
  );
  for (const bucket of [1, 2, 3, 4, 5, 6])
    console.log(
      `  ${bucket === 6 ? '6+' : bucket}: ${runs.get(bucket) ?? 0} (${(((runs.get(bucket) ?? 0) / runCount) * 100).toFixed(1)}%)`
    );
  console.log(
    `  collapsing every run: ${turnsInRuns} -> ${runCount} turn(s), ${(((turnsInRuns - runCount) / turnsInRuns) * 100).toFixed(0)}% fewer -- the CEILING on batching`
  );
}
