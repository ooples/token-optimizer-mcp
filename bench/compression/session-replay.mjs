/**
 * What a strategy costs over a WHOLE SESSION, priced with the cache model.
 *
 * THE INSTRUMENT THAT WAS MISSING, and its absence is why a losing idea reached
 * a live campaign. `proof.mjs` prices ONE request, plus a two-turn steady check.
 * That is the wrong unit for anything touching history, because the entire cost
 * of a history rewrite is paid across turns: a transform can shrink every single
 * request it is shown and still lose money, if what it removes was already
 * sitting in the provider's cache at 0.1x and removing it forces the rest to be
 * rewritten at 1.25x.
 *
 * That is why the thinking-drop probe was hard to judge: it cut turns hard --
 * 0.31, 0.67, 0.75, 0.94 against control at score 1.0 -- while per-request size
 * said it was winning and the invoice was ambiguous. This replays the same
 * arithmetic offline, for free.
 *
 * WHAT IT AGREED WITH, ONCE ASKED AT THE RIGHT LENGTH. The replay and the live
 * campaign appeared to contradict each other -- 0.659 here against 0.885 there
 * -- and the contradiction was an artefact of regime. Reasoning ACCUMULATES, so
 * the share of history it occupies grows with conversation length, and the two
 * instruments were being run at lengths two orders of magnitude apart. Capped at
 * the benchmark's own 8-26 turns, this file reports 0.886 at ten turns against
 * the campaign's measured 0.885 effective input. The curve is monotone: 0.886 at
 * 10 turns, 0.810 at 20, 0.757 at 40, 0.731 at 100, 0.700 at 721.
 *
 * Read the agreement as direction and magnitude, not as three decimal places --
 * the modelling gaps listed below are larger than that. The conclusion that
 * survives is structural: THIS TRANSFORM'S VALUE IS A FUNCTION OF CONVERSATION
 * LENGTH, and a benchmark whose tasks end at 26 turns measures it in the regime
 * where it is worth least.
 *
 * HOW THE CACHE IS PRICED. Anthropic's cache key is the literal prefix: a
 * request hits the cache for exactly as long as its leading bytes match what was
 * sent before, and everything from the first difference onward is written fresh.
 * So each turn is priced by finding the longest run of leading messages that are
 * byte-identical to the previous turn's SENT request -- not the client's request,
 * the one the proxy actually put on the wire -- charging those at 0.1x and
 * everything after at 1.25x.
 *
 * This is the whole reason a transform must be a pure function of each message.
 * One that reconsiders an earlier message -- because the conversation grew, or a
 * floor moved, or the newest turn is exempt -- breaks the prefix at that message
 * and pays a full write for the entire tail, every turn, forever.
 *
 * WHAT THIS DOES NOT MEASURE, stated plainly because the numbers look more
 * authoritative than they are:
 *
 *   1. QUALITY. A transform that saves money by deleting something the model
 *      needed shows up here as a win and on a benchmark as a score regression.
 *      This answers "can it pay", not "does it still work".
 *   2. BEHAVIOUR. The replay holds the conversation FIXED and varies only how
 *      it is transmitted. Live, a different context produces different turns and
 *      a different session length -- the drop arm finished the same tasks in 8
 *      turns where control took 26. So a win here is a claim about transmission
 *      alone. What the run database settles is that this is not where the money
 *      went: output tokens FELL (0.827) and tool calls per turn were unchanged
 *      (0.88-0.96 against control's 0.93-0.96), so the arm was neither thinking
 *      harder nor redoing work.
 *   3. CACHE BREAKPOINTS. A session log does not record `cache_control`, so the
 *      reconstructed requests carry none. Anything whose behaviour depends on
 *      where the client put its breakpoint -- the anchor machinery most of all
 *      -- is therefore exercised in a degenerate configuration here. The
 *      anchored arms below are a smoke test that anchoring does not ADD churn,
 *      not evidence that it behaves identically in production.
 *
 * COST OF RUNNING IT. Each turn re-transforms the whole conversation so far, so
 * the work is quadratic in turns. Measured: a 2,319-turn session completes the
 * pure arms in a few minutes, while the anchored arms -- which run the full V1
 * compression per turn -- exceed ten. That is a property of the question, not a
 * defect: pricing turn N genuinely requires knowing what turn N-1 sent. Give
 * long sessions their own run, or compare the pure arms first and reach for the
 * anchored ones only when something looks like churn.
 *
 * Usage:
 *   node bench/compression/session-replay.mjs <transcript.jsonl> [more...]
 *
 * Run `npm run build` first: this reads dist/.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { STRATEGIES } from '../../dist/compress/strategy.js';
import { anchorStore } from '../../dist/compress/anchor.js';
import { substituteHistory } from '../../dist/compress/history.js';

const CACHE_WRITE = 1.25;
const CACHE_READ = 0.1;

/** Tokens, approximated the same way proof.mjs does so figures compose. */
const tokens = (text) => Math.ceil(text.length / 4);

/**
 * Rebuild a WIRE-shaped conversation from a session log.
 *
 * THE LOG IS NOT THE WIRE, and conflating them produced a wrong answer on the
 * first run of this file. A session log writes one row per content block, so a
 * single assistant message that reasoned and then called a tool appears as two
 * consecutive assistant rows -- which is why reading a transcript directly
 * suggests "thinking blocks appear in their own messages, never mixed with
 * tool_use". On the wire they are one message: the Messages API requires
 * user and assistant to alternate, so consecutive same-role rows cannot be
 * separate messages.
 *
 * That artefact is load-bearing rather than cosmetic. A transform that digests
 * a message using its own tool calls finds none, does nothing, and scores
 * exactly 1.000 -- looking like a transform that cannot pay when it is really a
 * transform that never ran. Coalescing is what makes the replay a replay.
 */
function messagesFrom(path) {
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const m = row?.message;
    if (!m || (m.role !== 'assistant' && m.role !== 'user')) continue;
    if (!Array.isArray(m.content) || !m.content.length) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content.push(...m.content);
    else out.push({ role: m.role, content: [...m.content] });
  }
  return out;
}

/**
 * The turn boundaries: every index at which the client would send a request.
 *
 * A request is sent when it is the model's move, which is after a user message.
 * Slicing anywhere else would price a request no client ever makes.
 */
function turnBoundaries(messages) {
  const cuts = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i].role === 'user') cuts.push(i + 1);
  }
  return cuts;
}

/**
 * Cost of one session under one transform.
 *
 * `transform` takes the client's messages and returns what goes on the wire.
 * Charged per turn against the previous turn's sent body, which is what the
 * provider is holding.
 */
function priceSession(messages, cuts, transform) {
  // One store for the whole session, as the proxy keeps one per conversation.
  const anchors = anchorStore();
  let previous = [];
  let read = 0;
  let write = 0;
  let sentChars = 0;

  // MEASURED PER MESSAGE, KEPT AS A DIGEST. The naive form held every turn's
  // full serialisation in order to compare it with the next turn's, which is
  // O(turns x messages) live strings: on a 2,319-turn session of 4,639 messages
  // that is ~10.7M multi-kilobyte strings and the run was killed by the host for
  // memory before it finished. Only two facts about each message are ever
  // needed -- its hash, to find where the prefix stops matching, and its token
  // count -- so only those are carried forward.
  //
  // The WeakMap is the other half: a transform that returns the SAME object for
  // an unchanged message (control does; a substituting arm does not) then
  // serialises it once for the whole session instead of once per turn.
  const memo = new WeakMap();
  const describe = (message) => {
    const hit = memo.get(message);
    if (hit) return hit;
    const json = JSON.stringify(message);
    const entry = {
      hash: createHash('sha1').update(json).digest('base64'),
      tokens: tokens(json),
      chars: json.length,
    };
    memo.set(message, entry);
    return entry;
  };

  // The fixed prefix is charged exactly as the provider charges it: written on
  // the first turn, re-read on every turn after. It is identical in every arm,
  // so it cancels in a difference and dilutes in a ratio -- which is precisely
  // why it has to be present for the ratio to mean anything.
  let firstTurn = true;

  for (const cut of cuts) {
    const sent = transform(messages.slice(0, cut), anchors);
    const described = sent.map(describe);

    if (FIXED_PREFIX_TOKENS > 0) {
      if (firstTurn) write += FIXED_PREFIX_TOKENS;
      else read += FIXED_PREFIX_TOKENS;
      firstTurn = false;
    }

    // The longest leading run that is byte-identical to what the provider
    // already has. The first mismatch ends the cached prefix -- everything
    // after it is new content whether or not it was ever sent before.
    let shared = 0;
    while (
      shared < described.length &&
      shared < previous.length &&
      described[shared].hash === previous[shared]
    ) {
      shared += 1;
    }

    for (let i = 0; i < described.length; i += 1) {
      if (i < shared) read += described[i].tokens;
      else write += described[i].tokens;
      sentChars += described[i].chars;
    }
    previous = described.map((d) => d.hash);
  }

  return {
    read,
    write,
    effective: read * CACHE_READ + write * CACHE_WRITE,
    sentChars,
  };
}

/** The arms. Each is a transform from client messages to wire messages. */
const ARMS = {
  // No proxy at all: the client's own bytes. The only honest baseline, because
  // every saving has to be a saving against what would otherwise be sent.
  control: (messages) => messages,

  // Today's shipping behaviour, as a strategy over the same messages.
  'v1-frontier': (messages) => {
    const out = STRATEGIES['v1-frontier']({ messages }, {});
    return out.request.messages ?? messages;
  },

  // The probe that lost. Reproduced here to check the instrument can SEE the
  // failure it missed -- an instrument that scores a known loser as a winner is
  // not evidence about anything else it scores.
  'drop-thinking-keep-newest': (messages) => {
    let lastAssistant = -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'assistant') {
        lastAssistant = i;
        break;
      }
    }
    return messages
      .map((m, i) => {
        if (m.role !== 'assistant' || i === lastAssistant) return m;
        if (!Array.isArray(m.content)) return m;
        const next = m.content.filter(
          (b) => b?.type !== 'thinking' && b?.type !== 'redacted_thinking'
        );
        return next.length === m.content.length ? m : { ...m, content: next };
      })
      .filter((m) => !Array.isArray(m.content) || m.content.length > 0);
  },

  'drop-thinking-all': (messages) =>
    messages
      .map((m) => {
        if (m.role !== 'assistant' || !Array.isArray(m.content)) return m;
        const next = m.content.filter(
          (b) => b?.type !== 'thinking' && b?.type !== 'redacted_thinking'
        );
        return next.length === m.content.length ? m : { ...m, content: next };
      })
      .filter((m) => !Array.isArray(m.content) || m.content.length > 0),

  // THE REGISTERED STRATEGY, not a hand-rolled copy of it. This arm called
  // `substituteHistory` directly at first, which meant it silently did not
  // exercise the tool-result compression the strategy passes in -- so the
  // measurement would have reported the feature as nearly worthless while
  // never running half of it. A benchmark arm must call the shipped entry
  // point, or it is measuring the benchmark.
  // THE COMPETITOR, ON THE SAME BYTES. `ccrStyle` is this repo's faithful
  // reimplementation of HeadRoom's design -- opaque hash markers, history
  // compressed, a retrieval tool and system message injected. Without it in
  // this harness "we win" only ever meant "we beat doing nothing", which is a
  // much weaker claim than the one the project is actually trying to make.
  //
  // Its injected tool and system text are NOT counted here: this instrument
  // prices `messages` only, so the competitor is measured without the overhead
  // its own design adds elsewhere. That is deliberate and it flatters them.
  ccr: (messages) => {
    const out = STRATEGIES.ccr({ messages }, {});
    return out.request.messages ?? messages;
  },

  'v4-substitute': (messages) => {
    const out = STRATEGIES['v4-substitute']({ messages }, {});
    return out.request.messages ?? messages;
  },

  // Substitution WITHOUT the tool-result half, so the two regions it attacks
  // -- reasoning and tool results -- can be told apart rather than bundled.
  'v4-reasoning-only': (messages) => substituteHistory(messages).messages,
};

/**
 * The same arms, but through the anchor machinery the proxy actually uses.
 *
 * WHY THESE EXIST SEPARATELY. The bare strategies above are pure functions; the
 * deployed proxy is not. It carries an `AnchorStore` across the session and
 * lets `anchorDecision` choose, per turn, whether to re-anchor -- deliberately
 * rewriting a cached prefix when it judges the rewrite will repay. That is a
 * conversation-level decision, so it is exactly the kind of thing that can
 * break the append-only property the pure transforms guarantee.
 *
 * It also matters because the bare arms DISAGREE WITH THE CAMPAIGN. Replayed
 * here, dropping all thinking is ~30% cheaper than control; measured live it
 * lost on three of four tasks. Two candidate explanations -- the live loss came
 * from the model behaving differently, or it came from something in the proxy
 * path these arms do not model. Anchoring is the obvious suspect, and running
 * it is how the suspicion gets tested instead of argued.
 *
 * A store per session, and the decision committed only after the body is
 * "sent", which is the order the proxy uses.
 */
function anchoredArm(pre) {
  return (messages, anchors) => {
    const input = pre ? pre(messages) : messages;
    const out = STRATEGIES['v1-frontier']({ messages: input }, { anchors });
    if (out.anchor) anchors.remember(out.anchor.key, out.anchor.record);
    return out.request.messages ?? input;
  };
}

const ANCHORED = {
  'v1-frontier +anchors': anchoredArm(null),
  'v4-substitute +anchors': anchoredArm(
    (messages) => STRATEGIES['v4-substitute']({ messages }, {}).request.messages
  ),
};

// TURNS=n caps each session at its first n turns.
//
// NOT A CONVENIENCE. The live benchmark's tasks run 8 to 26 turns while a real
// development session runs hundreds, and reasoning ACCUMULATES: the share of
// history it occupies grows with conversation length. A transform measured on a
// 2,319-turn session is therefore being measured in a regime the benchmark
// never enters, and comparing the two without saying so compares two different
// questions. This makes the regime a dial so the comparison can be made at the
// benchmark's own length.
const TURN_CAP = Number(process.env.TURNS) > 0 ? Number(process.env.TURNS) : 0;

/**
 * The system prompt and tool definitions, which sit in front of every message.
 *
 * WITHOUT THIS THE DENOMINATOR IS WRONG AND FLATTERS US. A transcript records
 * only `messages`, so a replay over one prices history against history -- while
 * the real bill also carries a system prompt and a full tool schema that this
 * transform never touches. Including an unchanged region can only move every
 * ratio toward 1.0, so omitting it overstates the saving by however large that
 * region is.
 *
 * MEASURED, NOT ASSUMED. On a first turn the conversation is a single short
 * prompt, so a first-turn request is essentially system + tools. Across the 20
 * first-turn requests in the deferral campaign's ledger the median was 115,476
 * bytes -- about 28,869 tokens -- and that is the default here. It is a fixed
 * cost: written once, re-read at 0.1x on every later turn, identical in every
 * arm.
 *
 * FIXED_PREFIX_TOKENS=0 turns it off to recover the messages-only view, which
 * is the right number when the question is about the history region alone.
 */
const FIXED_PREFIX_TOKENS =
  process.env.FIXED_PREFIX_TOKENS !== undefined
    ? Number(process.env.FIXED_PREFIX_TOKENS)
    : 28869;

const paths = process.argv.slice(2);
if (!paths.length) {
  console.error('usage: node bench/compression/session-replay.mjs <transcript.jsonl> [...]');
  process.exit(2);
}

const totals = new Map();

for (const path of paths) {
  const messages = messagesFrom(path);
  const allCuts = turnBoundaries(messages);
  const cuts = TURN_CAP ? allCuts.slice(0, TURN_CAP) : allCuts;
  if (cuts.length < 2) {
    console.log(`\n${path}\n  skipped: fewer than two turns to price`);
    continue;
  }

  console.log(`\n${'='.repeat(78)}`);
  console.log(`${path.split(/[\\/]/).pop()}  --  ${messages.length} messages, ${cuts.length} turns`);
  console.log(
    '  arm                          cache read     cache write     effective    vs control'
  );

  const base = priceSession(messages, cuts, ARMS.control);
  for (const [name, transform] of Object.entries({ ...ARMS, ...ANCHORED })) {
    const priced = priceSession(messages, cuts, transform);
    const ratio = priced.effective / base.effective;
    const prior = totals.get(name) ?? { effective: 0, base: 0, wins: 0, n: 0 };
    totals.set(name, {
      effective: prior.effective + priced.effective,
      base: prior.base + base.effective,
      wins: prior.wins + (ratio < 1 ? 1 : 0),
      n: prior.n + 1,
    });
    console.log(
      `  ${name.padEnd(28)} ${String(Math.round(priced.read)).padStart(10)} ` +
        `${String(Math.round(priced.write)).padStart(15)} ` +
        `${String(Math.round(priced.effective)).padStart(13)} ` +
        `${ratio.toFixed(3).padStart(13)}`
    );
  }
}

console.log(`\n${'='.repeat(78)}`);
console.log('across every session replayed');
console.log('  arm                          effective    vs control    cheaper on');
for (const [name, t] of totals) {
  if (!t.n) continue;
  console.log(
    `  ${name.padEnd(28)} ${String(Math.round(t.effective)).padStart(10)} ` +
      `${(t.effective / t.base).toFixed(3).padStart(13)} ` +
      `${String(t.wins).padStart(8)}/${t.n}`
  );
}
console.log('');
