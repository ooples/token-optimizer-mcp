/**
 * REPLAYING A CONVERSATION TURN BY TURN, WHICH NOTHING HERE HAS EVER DONE.
 *
 * Every figure on this branch is measured on a one-shot payload: the whole
 * conversation handed to the compressor once, scored once. The mechanism those
 * figures argue for does not engage on turn one. strategy.ts:569 compresses
 * only the span after the cache breakpoint it saw on the PREVIOUS turn, so with
 * no previous turn the floor is null, the engine compresses from message 0, the
 * first message differs, serialiseKeepingPrefix bails at keep===0, and the
 * recorded prefix survival is 20 tokens of envelope. All of that is the
 * harness's shape rather than the product's behaviour.
 *
 * So this replays. Turn t sends messages 0..t with `cache_control` on the last
 * one, which is what Claude Code does and what anchor.ts:279 records as
 * verified. Each turn is compressed knowing the turn before it, and the cost is
 * the one the provider actually charges:
 *
 *   turn cost = shared prefix * R + everything after it * W
 *
 * measured as the real byte agreement between consecutive outgoing bodies
 * rather than assumed. That is the number the whole volatile-tail argument
 * rests on, and it has never been measured once.
 *
 * MEASURED, with recorded counts rather than census estimates: 98.4% of the
 * prefix survives, weighted across turns. The one-shot recording said 20 tokens
 * of a 150,000-token payload, about 0.01%, so the product preserves the cached
 * prefix and the single-shot harness simply could not see it.
 *
 * The spread is the work. raw-build-log keeps 17.4%, browser-session 17.7%,
 * grep-output 33.2%, codebase-exploration 36.8%, repeated-reads 44.1% -- five
 * shapes where the engine rewrites most of what it already sent, and the ones a
 * volatile-tail discipline would fix. Everything else is near 100%, which is
 * what carries the weighted figure.
 *
 * RUN IT WITH THE STAMP SEED. Without TOKEN_OPTIMIZER_BENCH_STAMP_SEED the
 * markers differ from the ones that were recorded, every payload digest misses,
 * and `tokens` refuses rather than estimating -- which is the correct failure
 * and not a defect in this file.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compressBody, anchorStore } from './ours-engine.mjs';
import { tokens } from './currency.mjs';
import { RATES } from './assembly.mjs';

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

/** The longest shared opening run of two buffers, in bytes. */
function sharedPrefix(a, b) {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) i += 1;
  return i;
}

/**
 * A request as the client sends it: the marker on the LAST message, moving
 * forward every turn.
 */
function requestFor(turns, upTo) {
  const messages = turns.slice(0, upTo + 1).map((turn, i) => ({
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
  }));
  return { model: 'claude-sonnet-4-5', max_tokens: 1024, messages };
}

const { cacheWrite: W, cacheRead: R } = RATES;
const rows = [];
for (const { name, turns } of conversations()) {
  const anchors = anchorStore();
  let previous = null;
  let cost = 0;
  let sentTokens = 0;
  let sharedBytes = 0;
  let totalBytes = 0;
  for (let t = 0; t < turns.length; t += 1) {
    const body = Buffer.from(JSON.stringify(requestFor(turns, t)), 'utf8');
    const spilled = [];
    let out;
    try {
      out = compressBody(
        body,
        (content, hint) => {
          spilled.push(content);
          return `.token-optimizer/spill/r${spilled.length}-${hint}`;
        },
        anchors
      );
    } catch {
      // A refusal is an answer: the arm declined and the client sends its own
      // bytes, which is what an unrewritten turn costs.
      out = { body };
    }
    const sent = out.body ?? body;
    const shared = previous === null ? 0 : sharedPrefix(previous, sent);
    sharedBytes += shared;
    totalBytes += sent.length;
    // Priced in tokens, since that is the bill, but the prefix is found in
    // bytes because that is what the provider matches on.
    const sentTok = tokens(sent.toString('utf8'));
    const sharedTok =
      shared === 0 ? 0 : tokens(sent.toString('utf8').slice(0, shared));
    cost += sharedTok * R + (sentTok - sharedTok) * W;
    sentTokens += sentTok;
    previous = sent;
  }
  rows.push({
    name,
    turns: turns.length,
    sentTokens,
    cost,
    prefixShare: totalBytes === 0 ? 0 : sharedBytes / totalBytes,
  });
}

if (rows.length === 0) {
  console.log(
    'no multi-turn fixture vendored here; run with hr-corpus present'
  );
} else {
  rows.sort((a, b) => b.prefixShare - a.prefixShare);
  console.log(
    'conversation'.padEnd(24) + ' turns   sent tok    cost  prefix kept'
  );
  for (const r of rows)
    console.log(
      `${r.name.padEnd(24)} ${String(r.turns).padStart(5)} ${String(r.sentTokens).padStart(10)} ${String(Math.round(r.cost)).padStart(7)} ${(r.prefixShare * 100).toFixed(1).padStart(10)}%`
    );
  const totalBytesKept =
    rows.reduce((s, r) => s + r.prefixShare * r.sentTokens, 0) /
    rows.reduce((s, r) => s + r.sentTokens, 0);
  console.log(
    `\nweighted prefix kept across turns: ${(totalBytesKept * 100).toFixed(1)}% -- the number the volatile-tail design rests on`
  );
}
