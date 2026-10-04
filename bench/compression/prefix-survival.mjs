/**
 * HOW MUCH OF A REQUEST IS BYTE-IDENTICAL FROM ONE TURN TO THE NEXT.
 *
 * The session cost model prices a token at `W + R*N` when it is written fresh
 * and `R*(N+1)` when it sits in a cached prefix -- 7.6 against 5.7, a 25%
 * discount. It currently gives that discount to nobody: `cachedPrefix` is zero
 * for every arm, which the decomposition audit proves rather than assumes, since
 * both arms' p=0 totals are `handed * 7.6` exactly.
 *
 * That is not neutral between the arms. The referencing arm APPENDS: a tool
 * reply lands at the end of the transcript and the bytes before it do not move,
 * so a real cached prefix survives it. The proxy arm cannot -- head-to-head.mjs
 * measures its output sharing exactly 57 characters with its input on every row
 * that compresses, because it rebuilds the request with `JSON.stringify` -- and
 * a deferring engine rewrites context by withholding from it.
 *
 * So the credit is worth up to 430,610 tokens at p=0, enough to win the column
 * outright. It is claimable only for the prefix that is REALLY identical, which
 * is what this measures and nothing else did: compress the first i messages of a
 * conversation for each i, and see how much of turn i's output turn i+1 keeps
 * untouched at the front.
 *
 * A prefix-stable arm scores near 1. An arm that rewrites what it already sent
 * scores near 0 and has earned no discount.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compressBlock } from './ours-engine.mjs';
import { tokens } from './currency.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(HERE, '..', '..', 'hr-corpus', 'natives-18.json');

/** The longest shared opening run of two strings, in characters. */
function sharedPrefix(a, b) {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) i += 1;
  return i;
}

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
        .map((message) =>
          typeof message.content === 'string'
            ? message.content
            : JSON.stringify(message.content)
        ),
    }))
    .filter((entry) => entry.turns.length >= 2);
}

const rows = [];
for (const { name, turns } of conversations()) {
  // Turn i hands the model everything through message i. A prefix-stable arm
  // leaves turns 0..i-1 exactly as it rendered them before.
  let previous = null;
  let survived = 0;
  let total = 0;
  for (let i = 0; i < turns.length; i += 1) {
    const text = turns.slice(0, i + 1).join('\n');
    const out = compressBlock(text, { stamp: '100000001' }).text;
    if (previous !== null) {
      // IN TOKENS, NOT SCALED FROM CHARACTERS. The provider caches bytes, so
      // characters are the right unit for finding where the shared run ENDS --
      // but the discount is applied per token, and the two do not scale
      // together: a prefix that is 87% of the characters is not 87% of the
      // tokens, because a cut lands mid-token and because the tail that differs
      // is usually denser than the prose in front of it. So the shared run is
      // counted as text.
      const shared = previous.slice(0, sharedPrefix(previous, out));
      survived += tokens(shared);
      total += tokens(previous);
    }
    previous = out;
  }
  if (total > 0) rows.push({ name, share: survived / total, total });
}

if (rows.length === 0) {
  console.log(
    'no multi-turn fixture is vendored here; run with hr-corpus present to measure prefix survival'
  );
} else {
  for (const row of rows)
    console.log(
      `${row.name.padEnd(26)} ${(row.share * 100).toFixed(1).padStart(6)}% of ${row.total} prior token(s) survived`
    );
  const weighted =
    rows.reduce((sum, row) => sum + row.share * row.total, 0) /
    rows.reduce((sum, row) => sum + row.total, 0);
  console.log(
    `\nweighted prefix survival ${(weighted * 100).toFixed(1)}% over ${rows.length} conversation(s)`
  );
}
