/**
 * THE REFERENCE RATE, MEASURED BY DRIVING THE PROXY RATHER THAN INFERRED.
 *
 * The whole withholding case is linear in one number: how often a unit the
 * proxy withheld is wanted back. Every figure on this branch used 0.23, which
 * came from textual recurrence over a borrowed corpus -- a method that cannot
 * see a unit the model read and reasoned about without quoting, so biased in the
 * direction that flatters us, and with no second signal to check it against.
 *
 * The counters to answer it properly now exist: `spilled` at the spill sink,
 * `reinstatedUnits` matched on the way in against a digest of everything that
 * left, and `referenceRate` dividing them. What was missing was anything that
 * fills them. I wrote in the pull request that this "needs a real session",
 * which was wrong: `startProxy` takes `spill: true` and no test had ever started
 * a spilling proxy, so the counters could be filled by driving it.
 *
 * So this replays each corpus conversation through a real proxy as real
 * requests. A reinstatement here is a later turn whose body carries a unit an
 * earlier turn had spilled -- measured at the boundary the engine actually
 * spills on, which is the fidelity that textual recurrence lacked.
 *
 * WHAT IT STILL IS NOT. These are corpus conversations, not somebody working, so
 * the rate is a property of this corpus under this policy. A live session can
 * differ, and the counters are in the shipped ledger precisely so that one can
 * be read later.
 *
 * AND IT MEASURES NOTHING YET, FOR A REASON THAT IS PROBABLY MINE. Over 1,323
 * requests with `spill: true` and `spillWholeBlockBelow: 0.9`, nothing was
 * withheld. Called directly with the same sink and threshold, `v1Frontier`
 * returns zero spills AND ZERO ELISIONS -- it compresses nothing at all, which
 * is what strategy.ts:569 says it must do without a previous turn to work
 * from: the frontier compresses only the span after the breakpoint it saw LAST
 * turn, and respecting the marker on THIS request leaves nothing compressible.
 *
 * So the arm needs a conversation the proxy can recognise ACROSS turns, and
 * these synthetic requests may not give it one -- every turn may look like a
 * first turn, which has nothing to compress by design. That walks back what an
 * earlier commit floated: this is most likely a gap in the harness rather than
 * the withholding arm being unreachable through the proxy. Establishing what
 * the proxy keys a conversation on is the next step, and until then no claim
 * either way is supported.
 *
 * SETTLED: THE ARM IS REACHABLE AND THIS HARNESS CANNOT MEASURE THE RATE.
 * Through a real proxy with `spill: true` and `spillWholeBlockBelow: 0.9`, over
 * 1,323 requests: 648 elisions and 75 units withheld. So the withholding arm
 * works through the proxy and the earlier worry that it existed only in the
 * bench is retired.
 *
 * The rate reads 0.0% -- a REAL zero, 75 withheld and none returned, which the
 * guard reports as 0 rather than as absent. But it is an artifact of this
 * harness: the upstream is a stub that answers "ok", so no model is deciding
 * anything and no expand tool is ever called. A replay against a canned
 * upstream can never produce a retrieval, so 0.0% is the only answer it could
 * give.
 *
 * Which bounds what this file is for. It proves the arm withholds and the
 * counters move, and the rate itself needs a live model that can ask for
 * something back. The counters are in the shipped ledger so that a real session
 * answers it.
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startProxy } from '../../dist/proxy/server.js';
import { pendingCounts, resetRollup } from '../../dist/telemetry/rollup.js';
import { referenceRate } from '../../dist/proxy/reinstated.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(HERE, '..', '..', 'hr-corpus', 'natives-18.json');

function conversations() {
  if (!existsSync(CORPUS)) return [];
  const parsed = JSON.parse(readFileSync(CORPUS, 'utf-8'));
  const list = Array.isArray(parsed)
    ? parsed
    : Object.entries(parsed).map(([name, value]) => ({
        name,
        ...(typeof value === 'object' ? value : { text: value }),
      }));
  return list
    .map((entry) => ({
      name: entry.name,
      turns: Object.keys(entry)
        .filter((key) => /^[0-9]+$/.test(key))
        .map((key) => entry[key])
        .map((m, i) => ({
          role: m.role ?? (i % 2 === 0 ? 'user' : 'assistant'),
          text:
            typeof m.content === 'string'
              ? m.content
              : JSON.stringify(m.content ?? m),
        })),
    }))
    .filter((entry) => entry.turns.length >= 2);
}

/** A request shaped as the client sends it: the marker on the last message. */
const requestFor = (turns, upTo) => ({
  model: 'claude-sonnet-4-5',
  max_tokens: 1024,
  messages: turns.slice(0, upTo + 1).map((turn, i) => ({
    role: turn.role,
    content: [
      i === upTo
        ? {
            type: 'text',
            text: turn.text,
            cache_control: { type: 'ephemeral' },
          }
        : { type: 'text', text: turn.text },
    ],
  })),
});

const rows = conversations();
if (rows.length === 0) {
  console.log(
    'no multi-turn fixture vendored here; run with hr-corpus present'
  );
  process.exit(0);
}

// An upstream that answers, so the proxy completes a request and books a row.
const upstream = createServer((req, res) => {
  req.resume();
  res.setHeader('content-type', 'application/json');
  res.end(
    JSON.stringify({
      id: 'msg_bench',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    })
  );
});
await new Promise((done) => upstream.listen(0, '127.0.0.1', done));
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

resetRollup();
let total = {};
let last = {};
// `spill: true` GIVES A SINK AND NOT A POLICY, which is why the first run of
// this reported nothing withheld over 1,323 requests. `spillWholeBlockBelow`
// defaults to 0 -- never move a block out -- so a spilling proxy still spills
// nothing until a threshold is set. 0.9 is the preset the bench's winning arm
// uses: move a block only where the engine could not take 90% off it in place.
const proxy = await startProxy({
  upstream: upstreamUrl,
  spill: true,
  compression: { spillWholeBlockBelow: 0.9 },
});
let sent = 0;
try {
  for (const { turns } of rows) {
    for (let t = 0; t < turns.length; t += 1) {
      await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(requestFor(turns, t)),
        signal: AbortSignal.timeout(30000),
      }).then((r) => r.arrayBuffer());
      sent += 1;
      // ACCUMULATE ACROSS FLUSHES. ROLLUP_EVERY is a hardcoded 200, so a run of
      // 1,323 requests empties the pending counters six times and a single read
      // at the end sees only the remainder. That is how the first reading came
      // out with `reinstated` ABOVE `spilled`: the two counters were spanning
      // different windows, units having been withheld in a flushed batch and
      // wanted back in the surviving one. referenceRate refused to divide them,
      // which is the guard working -- a rate above one means the numerator and
      // denominator are measuring different populations.
      const now = pendingCounts();
      if ((now.requests ?? 0) < (last.requests ?? 0))
        for (const [k, v] of Object.entries(last))
          total[k] = (total[k] ?? 0) + v;
      last = { ...now };
    }
  }
} finally {
  // READ THE COUNTERS BEFORE SETTLING. `pendingCounts()` is what has not been
  // rolled up yet, and `ledgerSettled` flushes -- so reading after it returns
  // an empty ledger by definition. The first version of this read afterwards
  // and reported every counter as zero, including bytes_in, which looked like
  // a proxy that never compressed anything and was a harness reading an
  // already-emptied counter.
  for (const [k, v] of Object.entries(pendingCounts()))
    total[k] = (total[k] ?? 0) + v;
  await proxy.ledgerSettled?.();
  await new Promise((done) => proxy.server.close(done));
  await new Promise((done) => upstream.close(done));
}

const counts = total;
// DID THE PROXY COMPRESS ANYTHING AT ALL? Without this the harness cannot tell
// "the arm withheld nothing" from "the arm never ran", and those have opposite
// meanings: the first is a measurement and the second is a broken harness. The
// first version of this file could not tell them apart and I published a
// product claim off the ambiguity.
// EVERY COUNTER, NAMED, rather than two I guessed at. The first version of this
// line printed `counts.compressed` and `counts.requests` and reported 0 for
// both -- which could as easily have meant the keys do not exist as that
// nothing happened, which is the exact ambiguity it was added to remove.
console.log(
  `ledger: ${
    Object.entries(counts)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ') || '(empty)'
  }`
);
const rate = referenceRate(counts);
console.log(
  `${sent} request(s) over ${rows.length} conversation(s): spilled ${counts.spilled ?? 0}, reinstated ${counts.reinstated ?? 0}`
);
if (rate === null)
  console.log(
    'no reference rate: nothing was withheld, so there is no denominator -- which is reported as absent rather than as zero, because zero is the most flattering reading available'
  );
else
  console.log(
    `reference rate ${(rate * 100).toFixed(1)}%, against the 23% this branch has been assuming from textual recurrence`
  );
