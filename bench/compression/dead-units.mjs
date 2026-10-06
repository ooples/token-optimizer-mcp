/**
 * HOW MUCH OF WHAT WE KEEP IS ALREADY DEAD.
 *
 * The gate is the subscription multiple: ours 1.61x against their 1.69x with
 * nothing fetched. Our arm is not losing because it drops too little -- it
 * drops 8,569 units against their 7,072, and ours need no fetch where every one
 * of theirs does. It loses because the 5,215 units it KEEPS cost 77.9 tokens
 * each against their 53.8.
 *
 * Our own preset arm already fixes that: 99.9% on codebase-exploration, 100% on
 * raw-build-log, matching or beating them on every contested workload. It is
 * unusable because it evicts to a store, which costs 61 round trips and makes
 * p=1 worse than doing nothing.
 *
 * Track 1 is the synthesis: evict what the preset evicts, but only where the
 * content is still reachable WITHOUT a fetch, so the round trips never happen.
 * The cleanest such case needs no policy at all -- a unit whose exact content
 * appears AGAIN later in the same payload is already dead when it is written,
 * because the later copy is in context and carries the content. Replacing the
 * earlier copy with a pointer FORWARD costs nothing to retrieve.
 *
 * That is the one thing a deferring engine structurally cannot do: their store
 * puts content outside the context, so every expansion is a trip. A forward
 * reference never leaves it.
 *
 * This measures the ceiling: the share of each payload that is a repeat of
 * something later in the same payload, counted in the currency the bill uses.
 *
 * THE ANSWER IS 4.3%, SO THIS IDEA IS NOT THE ONE. Exact-line duplication is
 * nowhere near the 82.5% that generic brotli takes off the same fixtures, and
 * 4.3% does not move a subscription multiple from 1.61x past 1.69x. Kept as the
 * standing refutation so the cheap version of Track 1 is not proposed again.
 *
 * It also says where the redundancy actually is. Brotli is not finding repeated
 * LINES -- it is finding repeated SHAPE: `[ts] INFO foo=1` and `[ts] INFO
 * foo=2` share a template and differ in two parameters, and an exact-match pass
 * sees nothing. That is what raw-build-log, grep-output, log-entries and
 * database-rows are made of, and it is where the 82% lives. Template
 * extraction, not deduplication, is the pass that closes the gap.
 *
 * Two caveats on the numbers below. `repeated-reads` reading 0.0% is suspicious
 * for a fixture of that name and is more likely my line extraction than the
 * truth -- a re-read that differs only in line numbering defeats exact match
 * entirely, which is itself the argument for templating. And `search-results`
 * reporting a 3-token total means this file is not finding its content at all,
 * so that row is not evidence about anything.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokens } from './currency.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(HERE, '..', '..', 'hr-corpus', 'natives-18.json');

/** A unit is a line: the grain our retention ledger already classifies by. */
const MIN_UNIT_CHARS = 24;

function fixtures() {
  if (!existsSync(CORPUS)) return [];
  const parsed = JSON.parse(readFileSync(CORPUS, 'utf-8'));
  const list = Array.isArray(parsed)
    ? parsed
    : Object.entries(parsed).map(([name, value]) => ({
        name,
        ...(typeof value === 'object' ? value : { text: value }),
      }));
  return list.map((entry) => ({
    name: entry.name,
    text: Object.keys(entry)
      .filter((key) => /^[0-9]+$/.test(key))
      .map((key) => entry[key])
      .map((message) =>
        typeof message.content === 'string'
          ? message.content
          : JSON.stringify(message.content ?? message)
      )
      .join('\n'),
  }));
}

const rows = [];
for (const { name, text } of fixtures()) {
  const lines = text.split('\n');
  // Count occurrences first, then walk forward: a line is dead at position i if
  // the same line occurs at some j > i. Short lines are excluded because a
  // pointer to one cannot be smaller than the line.
  const remaining = new Map();
  for (const line of lines) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  const dead = [];
  for (const line of lines) {
    const left = remaining.get(line) - 1;
    remaining.set(line, left);
    if (left > 0 && line.trim().length >= MIN_UNIT_CHARS) dead.push(line);
  }
  if (dead.length === 0) {
    rows.push({ name, share: 0, deadTokens: 0, total: tokens(text) });
    continue;
  }
  // Priced as text, not as a line count: a dead 400-character line is worth
  // more than ten dead short ones.
  const deadTokens = tokens(dead.join('\n'));
  const total = tokens(text);
  rows.push({ name, share: deadTokens / total, deadTokens, total });
}

if (rows.length === 0) {
  console.log(
    'no fixture corpus is vendored here; run with hr-corpus present to measure dead units'
  );
} else {
  rows.sort((a, b) => b.share - a.share);
  for (const row of rows)
    console.log(
      `${row.name.padEnd(24)} ${(row.share * 100).toFixed(1).padStart(6)}% dead  ${String(row.deadTokens).padStart(7)} of ${row.total} token(s)`
    );
  const deadAll = rows.reduce((sum, row) => sum + row.deadTokens, 0);
  const allTokens = rows.reduce((sum, row) => sum + row.total, 0);
  console.log(
    `\n${((deadAll / allTokens) * 100).toFixed(1)}% of the corpus is a repeat of something later in the same payload (${deadAll} of ${allTokens} tokens), reachable by a forward reference with no fetch`
  );
}
