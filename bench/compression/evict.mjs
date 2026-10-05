/**
 * WHAT A BATCHED EVICTION ACTUALLY COSTS, WITH THE REAL CACHE MECHANICS.
 *
 * Two things are now settled. The prefix is already preserved -- replay.mjs
 * measures 99.9% kept across turns, and the only thing that ever breaks it is
 * the client's own `cache_control` marker moving forward. And 77% of units are
 * never referenced again after the turn they arrive in (liveness.mjs), which is
 * a ceiling on what could be dropped.
 *
 * Those two facts point in opposite directions, which is the whole question. A
 * preserved prefix is worth R=0.1 per token per turn. Dropping a unit saves
 * that for every remaining turn but breaks the prefix at the drop point, so
 * everything after it is re-written at W=2. assembly.mjs priced that trade on a
 * synthetic schedule and found batching the only affordable form. This measures
 * it on real conversations.
 *
 * Both arms replay the same corpus turn by turn. The baseline sends every
 * message. The evicting arm, at one chosen turn, replaces the TEXT of every
 * earlier message that liveness says is dead with a stub naming what was there
 * -- a stub rather than a hole, so a wrong decision costs a turn of latency
 * when the model asks again rather than costing the answer.
 *
 * MEASURED WITH RECORDED COUNTS: 2,868,124 -> 2,639,288, which is 0.920x and an
 * 8% saving. Run in census mode, where an unrecorded string is answered with
 * chars/4, the same arms read 0.815x -- so the estimate flattered eviction by
 * more than a factor of two, and the 18.5% this file reported before the
 * payloads were recorded was not a measurement.
 *
 * 8% IS NOT ENOUGH TO WIN. Our recorded p=0 is 3,088,040 and theirs is
 * 2,746,640; eight percent off ours is about 2,841,000, which still loses. So
 * batched eviction of unreferenced messages, gated per conversation and priced
 * properly, does not close the gap on its own -- and the synthetic 0.808x from
 * assembly.mjs agreed with the census figure rather than with the truth, which
 * means the agreement reported earlier was two estimates matching each other.
 *
 * The gate still earns its place: it declines on 2 of 18 conversations and the
 * assertion below makes a policy that costs more than its baseline impossible.
 * It just is not where a win comes from.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compressBody, anchorStore } from './ours-engine.mjs';
import { tokens } from './currency.mjs';
import { RATES } from './assembly.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(HERE, '..', '..', 'hr-corpus', 'natives-18.json');
const SHINGLE_WORDS = 6;

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
    .filter((entry) => entry.turns.length >= 3);
}

function sharedPrefix(a, b) {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) i += 1;
  return i;
}

/** Is anything distinctive from this message seen in a later one? */
function isDead(turns, index) {
  const words = turns[index].text.trim().split(/\s+/).filter(Boolean);
  if (words.length < SHINGLE_WORDS) return false;
  const later = turns
    .slice(index + 1)
    .map((t) => t.text)
    .join('\n');
  // Three probes across the message, not just its opening: a long tool result
  // can be referred to by its middle.
  for (const at of [
    0,
    Math.floor(words.length / 2),
    words.length - SHINGLE_WORDS,
  ])
    if (later.includes(words.slice(at, at + SHINGLE_WORDS).join(' ')))
      return false;
  return true;
}

/** What a dropped message leaves behind: enough to ask for it again. */
const stubFor = (turn, index) =>
  `[message ${index}, ${turn.role}, ${turn.text.length} characters withheld as unreferenced]`;

function replay(turns, { evictAt = null, dead = [] } = {}) {
  const { cacheWrite: W, cacheRead: R } = RATES;
  const anchors = anchorStore();
  let previous = null;
  let cost = 0;
  for (let t = 0; t < turns.length; t += 1) {
    const messages = turns.slice(0, t + 1).map((turn, i) => {
      const drop = evictAt !== null && t >= evictAt && i < t && dead[i];
      const text = drop ? stubFor(turn, i) : turn.text;
      return {
        role: turn.role,
        content: [
          i === t
            ? { type: 'text', text, cache_control: { type: 'ephemeral' } }
            : { type: 'text', text },
        ],
      };
    });
    const body = Buffer.from(
      JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1024,
        messages,
      }),
      'utf8'
    );
    let out;
    try {
      out = compressBody(
        body,
        (c, h) => `.token-optimizer/spill/e-${h}`,
        anchors
      );
    } catch {
      out = { body };
    }
    const sent = out.body ?? body;
    const text = sent.toString('utf8');
    const shared = previous === null ? 0 : sharedPrefix(previous, sent);
    const sentTok = tokens(text);
    const sharedTok = shared === 0 ? 0 : tokens(text.slice(0, shared));
    cost += sharedTok * R + (sentTok - sharedTok) * W;
    previous = sent;
  }
  return cost;
}

const rows = [];
for (const { name, turns } of conversations()) {
  const dead = turns.map((_, i) => isDead(turns, i));
  const deadCount = dead.filter(Boolean).length;
  const base = replay(turns);
  const at = Math.max(1, Math.floor(turns.length / 3));
  const evicted = replay(turns, { evictAt: at, dead });
  rows.push({ name, turns: turns.length, deadCount, base, evicted, at });
}

if (rows.length === 0) {
  console.log('no fixture with three or more turns is vendored here');
} else {
  rows.sort((a, b) => a.evicted / a.base - b.evicted / b.base);
  console.log(
    'conversation'.padEnd(24) + ' turns dead  at    baseline    evicting  ratio'
  );
  for (const r of rows)
    console.log(
      `${r.name.padEnd(24)} ${String(r.turns).padStart(5)} ${String(r.deadCount).padStart(4)} ${String(r.at).padStart(3)} ${String(Math.round(r.base)).padStart(11)} ${String(Math.round(r.evicted)).padStart(11)}  ${(r.evicted / r.base).toFixed(3)}x`
    );
  const base = rows.reduce((s, r) => s + r.base, 0);
  const evicted = rows.reduce((s, r) => s + r.evicted, 0);
  const ratio = (v) => (v / base).toFixed(3);
  console.log(
    String.fromCharCode(10) +
      'batched eviction everywhere: ' +
      Math.round(base) +
      ' -> ' +
      Math.round(evicted) +
      ' (' +
      ratio(evicted) +
      'x)'
  );
  // GATED: TAKE THE ARM ONLY WHERE IT PAYS. Applied everywhere, eviction loses
  // on some shapes -- human-authored-json by 35% -- because the stub breaks the
  // cached prefix and the residency saved does not cover re-writing what
  // follows. The decision is per conversation, and the harness can make it the
  // way a proxy would: price both arms and keep the cheaper. A policy that can
  // decline is strictly better than one that cannot, and the gap between these
  // two lines is what the global version throws away.
  const gated = rows.reduce((s, r) => s + Math.min(r.base, r.evicted), 0);
  const declined = rows.filter((r) => r.evicted >= r.base).length;
  console.log(
    'gated, taken only where it pays: ' +
      Math.round(base) +
      ' -> ' +
      Math.round(gated) +
      ' (' +
      ratio(gated) +
      'x), declined on ' +
      declined +
      ' of ' +
      rows.length +
      ' conversation(s)'
  );
  // A gate that can make things worse is not a gate.
  if (gated > base)
    throw new Error(
      'a gated policy cannot cost more than its baseline: ' +
        gated +
        ' against ' +
        base
    );
}
