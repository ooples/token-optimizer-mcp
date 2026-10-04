/**
 * WHEN A UNIT ACTUALLY STOPS BEING REFERENCED, FROM REAL CONVERSATIONS.
 *
 * assembly.mjs prices three eviction policies and finds batching the only one
 * that wins -- 19% against keeping everything, where evicting each unit as it
 * dies costs 5.4x MORE because every drop re-writes the conversation behind it.
 * But its schedule is synthetic: forty equal units, one dying per turn, chosen
 * for arithmetic rather than measured. The ordering of the policies survives
 * that; the 19% does not.
 *
 * This replaces the schedule with the corpus. A unit is a line of a turn; it is
 * still live after turn t if a distinctive run of its words reappears in any
 * later turn. Its death turn is the last turn it is seen in, and a unit never
 * seen again after its own turn is droppable immediately -- which is the set a
 * batched policy is made of.
 *
 * WHAT THIS IS NOT. Textual recurrence is not the model attending to something,
 * and a unit the model read once and reasoned about silently looks dead here.
 * So this is a CEILING on the droppable set, not the droppable set, and the
 * honest figure for a policy is somewhere below it. Closing that gap needs the
 * proxy to record which units a response actually used, which nothing does yet
 * -- and this file exists partly to say how much that telemetry would be worth.
 *
 * MEASURED: 77.0% of units, 1,302 of 1,691, are never referenced again after
 * the turn they arrive in. That is far more than the synthetic schedule in
 * assembly.mjs assumed, so a batched drop has real material to work on.
 *
 * And the spread is the more useful half. search-results is 11.6% dead by count
 * and 7.0% by characters -- almost everything in it is referred to again --
 * while log-entries is 76.5% and several conversations exceed 90%. A single
 * global policy would either strand most of the saving on the log shapes or
 * drop live content out of the search shapes. The decision has to be per
 * conversation at least, and per unit ideally, which is the same conclusion the
 * cost decomposition reached from the other end.
 *
 * TWO FIXTURES ARE STILL NOT EVIDENCE. repeated-reads and sre-debugging report
 * two units each: their turns are neither JSON nor newline-separated, so this
 * file cannot find their grain and reports both units as dead by arithmetic.
 * They are counted in the total and should not be -- the honest reading of the
 * 77% excludes them, and finding their grain is the next correction.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(HERE, '..', '..', 'hr-corpus', 'natives-18.json');

/** Long enough that a coincidental match is unlikely, short enough to survive edits. */
const SHINGLE_WORDS = 6;
const MIN_LINE_CHARS = 40;

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
        .map((m) =>
          typeof m.content === 'string'
            ? m.content
            : JSON.stringify(m.content ?? m)
        ),
    }))
    .filter((entry) => entry.turns.length >= 2);
}

/**
 * The units of a turn.
 *
 * NEWLINES ARE NOT ENOUGH, and splitting on them alone made this file vacuous:
 * most turns in this corpus are serialised JSON on a single line, so a 300,000
 * character conversation came out as TWO units and "never referenced again" was
 * true of both by arithmetic. A measurement whose denominator is two is not a
 * measurement.
 *
 * A turn that parses as JSON is split into its elements or its entries -- the
 * grain a reader actually consumes -- and anything else is split on newlines.
 */
function unitsOf(turn) {
  const text = turn.trim();
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      const parts = Array.isArray(parsed)
        ? parsed
        : Object.values(parsed).flatMap((value) =>
            Array.isArray(value) ? value : [value]
          );
      if (parts.length > 1)
        return parts.map((part) =>
          typeof part === 'string' ? part : JSON.stringify(part)
        );
    } catch {
      // Not JSON after all; fall through to lines.
    }
  }
  return turn.split('\n');
}

/** The first distinctive shingle of a line, or null when it has none. */
function shingleOf(line) {
  const words = line.trim().split(/\s+/).filter(Boolean);
  if (words.length < SHINGLE_WORDS) return null;
  return words.slice(0, SHINGLE_WORDS).join(' ');
}

const rows = [];
for (const { name, turns } of conversations()) {
  // Index every turn once; a per-unit scan over every later turn would be
  // quadratic in the payload and these run to 300k characters.
  const later = turns.map((_, i) => turns.slice(i + 1).join('\n'));
  let units = 0;
  let deadAtBirth = 0;
  let chars = 0;
  let deadChars = 0;
  for (const [i, turn] of turns.entries()) {
    for (const line of unitsOf(turn)) {
      if (line.trim().length < MIN_LINE_CHARS) continue;
      const shingle = shingleOf(line);
      if (shingle === null) continue;
      units += 1;
      chars += line.length;
      if (!later[i].includes(shingle)) {
        deadAtBirth += 1;
        deadChars += line.length;
      }
    }
  }
  if (units > 0)
    rows.push({
      name,
      units,
      deadAtBirth,
      share: deadAtBirth / units,
      charShare: deadChars / chars,
    });
}

if (rows.length === 0) {
  console.log(
    'no multi-turn fixture vendored here; run with hr-corpus present'
  );
} else {
  rows.sort((a, b) => b.charShare - a.charShare);
  console.log('conversation'.padEnd(24) + '  units  dead  by count  by chars');
  for (const r of rows)
    console.log(
      `${r.name.padEnd(24)} ${String(r.units).padStart(6)} ${String(r.deadAtBirth).padStart(5)} ${(r.share * 100).toFixed(1).padStart(8)}% ${(r.charShare * 100).toFixed(1).padStart(8)}%`
    );
  const units = rows.reduce((s, r) => s + r.units, 0);
  const dead = rows.reduce((s, r) => s + r.deadAtBirth, 0);
  console.log(
    `\n${((dead / units) * 100).toFixed(1)}% of units are never referenced again after their own turn (${dead} of ${units}) -- a CEILING on what a batched drop could remove`
  );
}
