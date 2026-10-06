/**
 * HOW MUCH OF THE BATCHING CEILING IS ACTUALLY REACHABLE.
 *
 * `turn-shape.mjs` measures the ceiling: 52,955 turns sit in 36,399 runs of
 * consecutive tool-only turns, so collapsing every run would be 31% fewer
 * turns, and at N=56 that is worth more than every payload saving on this
 * branch put together. It is also unreachable as stated, because a run
 * collapses only where the later call did not need the earlier result.
 *
 * TWO ARMS, BECAUSE ONE OF THEM IS NOT A PROOF AND SAYING SO IS THE POINT.
 *
 * ARM A -- NO TEXTUAL DEPENDENCE. The later call's input shares no distinctive
 * token with the earlier call's result. This is the obvious test and it is an
 * UPPER bound, not a proof: a model can read a result, decide something from
 * it, and issue a call that quotes none of it. Reported because it brackets
 * the answer from above, and labelled so it is not read as the answer.
 *
 * ARM B -- EVERY INPUT ALREADY IN HAND. Every distinctive token in the later
 * call's input already appeared in the conversation STRICTLY BEFORE the
 * earlier call was issued, so the model demonstrably held the text it needed
 * to write that call one turn earlier. A lower bound, because a call can be
 * independent without every token being pre-present.
 *
 * NEITHER ARM MEASURES LOGICAL DEPENDENCE, and the first draft of this called
 * arm B "provably independent", which it is not. Both arms measure whether the
 * INFORMATION was available, not whether the DECISION needed the result: a
 * model can hold every token of a call in hand and still, correctly, wait to
 * see what the previous call returned before deciding to make it. So the two
 * arms bracket the textual dependence and the real reachable figure sits
 * somewhere at or below arm B -- which is still a bracket rather than the
 * single number the merge instruction was priced on, and that single number
 * turned out to be an artefact of counting transcript entries instead of
 * grouping them by `requestId`. Everything here groups by `requestId` first.
 *
 * WHY THE CEILING HERE IS NOT THE 31% IN `turn-shape.mjs`. That instrument
 * breaks a run on any turn carrying prose, so a turn holding [text, thinking,
 * tool_use] ends it; 14,489 turns do. This one does not, because prose does
 * not make a turn unmergeable -- a turn that explains itself and calls a tool
 * is one request like any other. The two therefore measure different things
 * and 96.4% is the more permissive of the two, which is exactly why it is
 * useless on its own and why arm B is the figure.
 *
 * READS LOCAL TRANSCRIPTS AND EMITS NO CONTENT. Only counts leave this file:
 * no path, no tool input, no result text, not a token it matched on. CI never
 * runs it -- there are no transcripts there, and a check that silently
 * measures an empty corpus is the vacuity failure this harness has hit five
 * times, so a run that finds no runs says so and exits non-zero.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(homedir(), '.claude', 'projects');

/**
 * Distinctive tokens of a string: the ones a dependence would show up in.
 *
 * Length 8 is the floor `conservation` settled on for the same job -- short
 * tokens match everywhere and would report dependence between unrelated
 * calls, which biases toward "not batchable" and would understate the lever
 * we are trying to find. Lowercased, because a path quoted back can change
 * case and a false independence is the expensive direction.
 */
function distinctive(text, out = new Set()) {
  if (typeof text !== 'string') return out;
  for (const match of text.toLowerCase().matchAll(/[a-z0-9_./\-]{8,}/g))
    out.add(match[0]);
  return out;
}

/** Every string anywhere in a value, which is where a tool input hides them. */
function strings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === 'object')
    for (const v of Object.values(value)) strings(v, out);
  return out;
}

/**
 * One transcript, walked into turns keyed by `requestId`.
 *
 * A turn carries the tool calls it made, the results that came back for them,
 * and whether a real user message preceded it -- which is what breaks a run,
 * because the model stopped and waited rather than continuing on its own.
 */
function turnsOf(text) {
  const byRequest = new Map();
  const order = [];
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
      // A tool result continues the run; anything else from the user ends it.
      const results = blocks.filter((b) => b?.type === 'tool_result');
      if (results.length === 0) {
        order.push({ kind: 'user', text: strings(blocks).join('\n') });
        continue;
      }
      order.push({ kind: 'results', results });
      continue;
    }
    const key = entry.requestId ?? `unkeyed-${order.length}`;
    let turn = byRequest.get(key);
    if (!turn) {
      turn = { kind: 'turn', key, calls: [], text: [] };
      byRequest.set(key, turn);
      order.push(turn);
    }
    for (const block of blocks) {
      if (block?.type === 'tool_use') turn.calls.push(block);
      else if (block?.type === 'text' && typeof block.text === 'string')
        turn.text.push(block.text);
    }
  }
  return order;
}

const stats = {
  files: 0,
  turns: 0,
  runs: 0,
  turnsInRuns: 0,
  /** Adjacent pairs inside a run: the unit a batch would collapse. */
  pairs: 0,
  noTextualDependence: 0,
  provablyIndependent: 0,
  /** Pairs refused for a reason worth separating out. */
  noResult: 0,
  noTokens: 0,
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
    stats.files += 1;
    const walk = turnsOf(text);
    /** Everything the conversation has said, as distinctive tokens. */
    const seen = new Set();
    /** The run in progress: acting turns with no user message between them. */
    let run = [];
    /** Tokens present before each turn in the run was issued. */
    const before = [];
    /** Results that came back for the previous turn's calls. */
    let pendingResults = null;

    const closeRun = () => {
      if (run.length > 1) {
        stats.runs += 1;
        stats.turnsInRuns += run.length;
      } else if (run.length === 1) {
        stats.runs += 1;
        stats.turnsInRuns += 1;
      }
      run = [];
      before.length = 0;
    };

    for (const step of walk) {
      if (step.kind === 'user') {
        closeRun();
        distinctive(step.text, seen);
        pendingResults = null;
        continue;
      }
      if (step.kind === 'results') {
        pendingResults = step.results;
        continue;
      }
      if (step.calls.length === 0) {
        // A turn that only wrote prose ends the run: the model handed back.
        closeRun();
        for (const t of step.text) distinctive(t, seen);
        pendingResults = null;
        continue;
      }
      stats.turns += 1;

      // THE PAIR. This turn against the one before it, inside the same run.
      if (run.length > 0) {
        stats.pairs += 1;
        const earlierResults = pendingResults;
        const laterInput = distinctive(
          strings(step.calls.map((c) => c.input)).join('\n')
        );
        if (!earlierResults || earlierResults.length === 0) {
          stats.noResult += 1;
        } else if (laterInput.size === 0) {
          // A call with no distinctive token in its input -- nothing to test
          // either arm on, so it is counted apart rather than scored as a win.
          stats.noTokens += 1;
        } else {
          const resultTokens = distinctive(
            strings(earlierResults.map((r) => r.content)).join('\n')
          );
          let shares = false;
          for (const token of laterInput)
            if (resultTokens.has(token)) {
              shares = true;
              break;
            }
          if (!shares) stats.noTextualDependence += 1;
          // ARM B: everything this call needed was already said before the
          // PREVIOUS call went out. `before[run.length - 1]` is the token set
          // as it stood then, so a token the earlier result introduced is not
          // in it and the pair fails -- which is the whole point.
          const priorSeen = before[run.length - 1];
          let allPrePresent = priorSeen !== undefined;
          if (allPrePresent)
            for (const token of laterInput)
              if (!priorSeen.has(token)) {
                allPrePresent = false;
                break;
              }
          if (allPrePresent) stats.provablyIndependent += 1;
        }
      }

      before.push(new Set(seen));
      run.push(step);
      for (const t of step.text) distinctive(t, seen);
      for (const s of strings(step.calls.map((c) => c.input)))
        distinctive(s, seen);
      if (pendingResults)
        for (const s of strings(pendingResults.map((r) => r.content)))
          distinctive(s, seen);
      pendingResults = null;
    }
    closeRun();
  }
}

if (stats.turns === 0) {
  console.log(
    `no assistant tool turns under ${ROOT} -- nothing measured, and a zero here is a severed instrument rather than a result`
  );
  process.exit(1);
}

const pct = (n, d) => (d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`);
const scored = stats.pairs - stats.noResult - stats.noTokens;

console.log(
  `${stats.files} transcript(s), ${stats.turns} acting turn(s) grouped by requestId`
);
console.log(
  `${stats.turnsInRuns} turn(s) in ${stats.runs} run(s): collapsing every run is ${pct(stats.turnsInRuns - stats.runs, stats.turnsInRuns)} fewer turns -- the CEILING`
);
console.log(
  `\n${stats.pairs} adjacent pair(s) inside runs, the unit a batch collapses:`
);
console.log(
  `  ${stats.noResult} with no result in between (not scored), ${stats.noTokens} whose later input has no distinctive token (not scored)`
);
console.log(`  ${scored} scored:`);
console.log(
  `  ARM A  no textual dependence: ${stats.noTextualDependence} (${pct(stats.noTextualDependence, scored)}) -- UPPER bound; a model can use a result without quoting it`
);
console.log(
  `  ARM B  every input in hand:   ${stats.provablyIndependent} (${pct(stats.provablyIndependent, scored)}) -- LOWER bound; the tokens were in context before the PREVIOUS call went out`
);

// TURNS REMOVED, COUNTED DIRECTLY. Each collapsible pair removes one turn, so
// the figure is pairs over turns -- not the ceiling multiplied by a rate,
// which equals it only by construction and invites a bound to be read as a
// result.
const removedB = stats.provablyIndependent / stats.turns;
const removedA = stats.noTextualDependence / stats.turns;
console.log(
  `
turns removed if every collapsible pair collapses: ${(removedB * 100).toFixed(1)}% on arm B, ${(removedA * 100).toFixed(1)}% on arm A`
);
console.log(
  `  N 56 -> ${(56 * (1 - removedB)).toFixed(1)} (arm B) or ${(56 * (1 - removedA)).toFixed(1)} (arm A) -- and NEITHER says the model would do it`
);
console.log(
  `\nprice it with: node bench/compression/turn-lever.check.mjs (N moves, nothing is injected)`
);
