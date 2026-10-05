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
