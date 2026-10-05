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
  console.log(
    `\nbatched eviction of unreferenced messages: ${Math.round(base)} -> ${Math.round(evicted)} (${(evicted / base).toFixed(3)}x), measured turn by turn with the prefix found in bytes`
  );
}
