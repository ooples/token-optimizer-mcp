/**
 * HOW MUCH OF THIS TRAFFIC COULD A CHEAPER MODEL HAVE ANSWERED.
 *
 * MEASURED AND NOT BUILT, deliberately. `routing-tool.ts` is advice only and
 * the proxy reads `model` at server.ts and never writes it. Changing which
 * model answers a user's request is a consent decision rather than a technical
 * one, so this reports the ceiling and stops there.
 *
 * WHY IT IS A LEVER AT ALL. A subscription cap is metered in effective input
 * tokens weighted by the model's rate, so a request answered by a cheaper
 * model spends less of the cap for the same context -- and 64.9% of this
 * user's measured bill is cache READS, which is the whole context charged
 * again on every request (BILL_SPLIT_CENSUS). Routing does not shrink the
 * context; it changes what re-reading it costs. That makes it independent of
 * every payload lever on this branch, and independent of the batching lever
 * too, which changes how MANY times the context is read.
 *
 * THE CRITERION, and why there are two of them. A turn is a candidate when it
 * emitted no reasoning: grouped by `requestId`, a turn whose only content is
 * `tool_use` carried no thinking block and no prose, so nothing was reasoned
 * out loud that a smaller model would have had to reproduce.
 *
 *   STRICT  tool_use alone -- no thinking, no text.
 *   LOOSE   one tool call and no prose, thinking allowed.
 *
 * NEITHER IS A PROOF THAT THE ANSWER WOULD HAVE BEEN THE SAME. An absent
 * thinking block means none was emitted, not that none was needed, and a
 * single mechanical-looking call can still be the one that required the most
 * judgement to choose. So these bound the opportunity; they do not establish
 * that taking it is safe. That is what a held-out accuracy arm would be for,
 * and there is not one.
 *
 * GROUPS BY `requestId` FIRST. Counting transcript entries instead split every
 * turn into its blocks and produced a 33% figure for a different lever that was
 * pure artefact -- see turn-shape.mjs. A turn is a request.
 *
 * READS LOCAL TRANSCRIPTS AND EMITS ONLY COUNTS: no path, no tool input, no
 * result text, no tool name. Not in CI: there are no transcripts there, and a
 * run that finds no turns exits non-zero rather than reporting a zero that
 * means the instrument was severed.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BILL_SPLIT_CENSUS } from '../compression/cost-model.mjs';

const ROOT = join(homedir(), '.claude', 'projects');

const stats = { turns: 0, strict: 0, loose: 0, acting: 0, prose: 0 };

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
    /** Per request: the block types seen, and how many calls it made. */
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
      if (!message || message.role !== 'assistant') continue;
      const blocks = Array.isArray(message.content) ? message.content : [];
      const key = entry.requestId ?? `unkeyed-${order.length}`;
      let turn = byRequest.get(key);
      if (!turn) {
        turn = { kinds: new Set(), calls: 0 };
        byRequest.set(key, turn);
        order.push(key);
      }
      for (const block of blocks) {
        if (block?.type) turn.kinds.add(block.type);
        if (block?.type === 'tool_use') turn.calls += 1;
      }
    }
    for (const key of order) {
      const turn = byRequest.get(key);
      stats.turns += 1;
      const thinks =
        turn.kinds.has('thinking') || turn.kinds.has('redacted_thinking');
      const prose = turn.kinds.has('text');
      if (turn.calls > 0) stats.acting += 1;
      if (prose) stats.prose += 1;
      if (turn.calls > 0 && !prose) {
        stats.loose += 1;
        if (!thinks) stats.strict += 1;
      }
    }
  }
}

if (stats.turns === 0) {
  console.log(
    `no assistant turns under ${ROOT} -- nothing measured, and a zero here is a severed instrument rather than a result`
  );
  process.exit(1);
}

const pct = (n) => `${((n / stats.turns) * 100).toFixed(1)}%`;
console.log(
  `${stats.turns} turn(s) grouped by requestId: ${stats.acting} act, ${stats.prose} carry prose`
);
console.log(
  `  STRICT  tool_use alone:            ${stats.strict} (${pct(stats.strict)})`
);
console.log(
  `  LOOSE   calls, no prose:           ${stats.loose} (${pct(stats.loose)})`
);

// WHAT IT WOULD BE WORTH, SWEPT RATHER THAN CLAIMED. The cross-model rate
// ratio is not something this harness has measured, so it is the x-axis
// instead of a constant: `r` is the cheaper model's input rate as a fraction
// of the current one. The saving applies to the read-and-input share of the
// bill for the downgraded requests -- 65.3% of it -- because routing changes
// what re-reading the context costs, not how much context there is.
const readShare =
  BILL_SPLIT_CENSUS.shares.read + BILL_SPLIT_CENSUS.shares.input;
console.log(
  `\nread+input share of the measured bill: ${(readShare * 100).toFixed(1)}% (${BILL_SPLIT_CENSUS.windowDays}d, ${BILL_SPLIT_CENSUS.requests} requests)`
);
console.log('\n  r     strict     loose   (share of the whole bill saved)');
for (const r of [0.2, 0.333, 0.5, 0.8]) {
  const line = (n) =>
    `${((n / stats.turns) * (1 - r) * readShare * 100).toFixed(1)}%`;
  console.log(
    `  ${r.toFixed(3)}  ${line(stats.strict).padStart(7)}  ${line(stats.loose).padStart(7)}`
  );
}
console.log(
  '\nNOT A RESULT: an absent thinking block means none was emitted, not that none was needed. These bound the opportunity; a held-out accuracy arm would be needed to show taking it is safe, and there is not one.'
);
