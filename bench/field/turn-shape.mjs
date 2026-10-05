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
 * THE 31% BELOW IS RETRACTED, and what replaced it is bigger. Reasoning does
 * not live in `text` blocks, it lives in `thinking` blocks, and the run-length
 * walk broke a run on any assistant turn without a tool call -- so it broke on
 * every thinking turn and the runs came out short by construction.
 *
 * Counted properly across 114,715 assistant entries: 37,543 carry thinking,
 * 52,800 carry a tool call and no prose, and exactly TWO carry thinking and a
 * tool call together. The model almost never thinks and acts in the same turn,
 * so a thinking turn and the tool turn that follows it are two requests, each
 * paying a full context re-read.
 *
 * That is the headroom on N: merging them would remove on the order of 37,500
 * requests from roughly 90,000, about 42% -- larger than batching consecutive
 * tool calls and cleaner, because it does not ask the model to decide more per
 * turn, only to say what it has decided in the same turn it acts on it.
 *
 * The numbers under the old heading are left for the record and are not a
 * ceiling on anything.
 *
 * WHAT THE MEASURED 33% IS WORTH, at the recorded 406,321 handed tokens against
 * their 2,746,640 at p=0 and 3,523,083 at p=1:
 *
 *   today, 56 turns              3,088,040   lose
 *   33% fewer turns, 37.5        2,337,158   WIN p=0 by 15%
 *   + the 8% eviction measured   2,150,186   WIN p=0 by 21.7%
 *
 * None of it defers anything, so the same figure stands at p=1 where theirs
 * rises to 3,523,083 -- a 39% win there. That makes it the first arrangement on
 * this branch to win both ends without withholding, resting on a measurement of
 * real transcripts rather than a projection from a borrowed corpus.
 *
 * TWO ASSUMPTIONS, STATED RATHER THAN BURIED. That N scales with request count,
 * which is the cost model's own structure since `readsPerWrittenToken` counts
 * the requests that carried a token. And that the model can be led to think and
 * act in one turn at all -- the proxy cannot force that, only ask through the
 * system prompt, and whether asking works is the next measurement.
 *
 * AND THERE IS A CAUTION FROM THE BATCHING PRECEDENT. Claude Code's own
 * instructions already ask for multi-call batching -- "make all of the
 * independent calls in the same response" -- and the measured result is 1.15
 * calls per turn with 92% of turns making exactly one. So asking for batching
 * demonstrably achieves very little, which is reason to doubt that asking for
 * anything about turn shape achieves much.
 *
 * It is a caution and not a refutation, because the think-then-act merge is a
 * different request. Batching asks the model to plan further ahead and commit to
 * several calls at once. Merging asks it not to split ONE decision across two
 * requests, which nothing currently asks for. Untested rather than disproven,
 * and the precedent says to test it before believing the 33%.
 *
 * A probe that grepped the transcripts for existing batching instructions is
 * not evidence either way: it matched the probe's own source, written into the
 * transcript as it ran. Searching a transcript for a phrase while writing that
 * phrase into it measures nothing.
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
 *
 * THE OTHER LEVER ON N IS MODEL ROUTING, AND IT IS ADVISORY BY DESIGN.
 * `src/server/routing-tool.ts` says so in its own header: "Advice only. Nothing
 * here switches a model." The proxy reads `model` for attribution at
 * server.ts:650 and never writes it, so nothing in the product routes anything.
 *
 * That is the lever that multiplies the whole bill rather than trimming one
 * term -- a subscription cap is model-weighted, so moving half the traffic to a
 * cheaper model is worth more than any compression result on this branch. It is
 * also the one change that alters which model answers a user's request, which
 * is a consent decision and not a technical one, so it is recorded here rather
 * than taken.
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

/**
 * How often the model thinks and acts in the same turn.
 *
 * THE LEVER ON N, AND THE ONE THE RUN-LENGTH WALK ABOVE MISSED. A thinking turn
 * and the tool turn that follows it are two requests, and each re-reads the
 * whole context -- so if the two could be one turn, the second re-read is
 * simply not paid. This does not ask the model to decide more per turn, only to
 * say what it has decided in the turn it acts on.
 *
 * Reasoning lives in `thinking` blocks, not `text`. Looking for prose finds one
 * tool turn in 52,800 and reads as "nothing to merge", which is how the earlier
 * ceiling came out wrong.
 */
export function thinkAndAct() {
  let entries = 0;
  let thinking = 0;
  let acting = 0;
  let both = 0;
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
        entries += 1;
        const blocks = Array.isArray(message.content) ? message.content : [];
        const thinks = blocks.some(
          (b) => b?.type === 'thinking' || b?.type === 'redacted_thinking'
        );
        const acts = blocks.some((b) => b?.type === 'tool_use');
        if (thinks) thinking += 1;
        if (acts) acting += 1;
        if (thinks && acts) both += 1;
      }
    }
  }
  return { entries, thinking, acting, both };
}

const split = thinkAndAct();
if (split.entries > 0) {
  console.log(
    `\n${split.entries} assistant entr(ies): ${split.thinking} think, ${split.acting} act, ${split.both} do both`
  );
  const separable = Math.min(split.thinking, split.acting) - split.both;
  const requests = split.thinking + split.acting - split.both;
  console.log(
    `  separable thinking turns: ${separable} of ${requests} request(s), ${((separable / requests) * 100).toFixed(0)}% fewer if each merged with the act it precedes`
  );
  // A CEILING AND NOT A TARGET. It assumes every thinking turn is followed by
  // an act it could have carried, which is the most favourable pairing
  // available; the real figure needs the pairs walked in order.
  // AND THE ADJACENCY, so this is a figure rather than a ceiling. Walked in
  // order, 32,591 of 37,544 thinking-only turns -- 86.8% -- are immediately
  // followed by a turn that acts, with only a tool result in between. Those are
  // the pairs a single turn could have been.
  const adjoining = adjacentThinkThenAct();
  if (adjoining.thinkingOnly > 0)
    console.log(
      `  measured: ${adjoining.followedByAct} of ${adjoining.thinkingOnly} thinking turns (${((adjoining.followedByAct / adjoining.thinkingOnly) * 100).toFixed(1)}%) are immediately followed by an act, so ${((adjoining.followedByAct / requests) * 100).toFixed(0)}% of requests are a pair that could be one`
    );
}

/**
 * Thinking turns immediately followed by a turn that acts.
 *
 * The pairing the ceiling above assumes, checked rather than assumed. A tool
 * result between the two does not break the pair -- it is the harness answering
 * the previous call -- but a real user message does, because the model stopped
 * and waited.
 */
export function adjacentThinkThenAct() {
  let thinkingOnly = 0;
  let followedByAct = 0;
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
      let pending = false;
      for (const line of text.split(String.fromCharCode(10))) {
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
          if (!blocks.some((b) => b?.type === 'tool_result')) pending = false;
          continue;
        }
        const thinks = blocks.some(
          (b) => b?.type === 'thinking' || b?.type === 'redacted_thinking'
        );
        const acts = blocks.some((b) => b?.type === 'tool_use');
        if (thinks && !acts) {
          thinkingOnly += 1;
          pending = true;
          continue;
        }
        if (acts) {
          if (pending) followedByAct += 1;
          pending = false;
        }
      }
    }
  }
  return { thinkingOnly, followedByAct };
}
